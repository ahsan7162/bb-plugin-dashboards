// Secrets in the operating system's secure store (PLAN section 8), through each system's own tool:
// macOS `security`, Windows PowerShell with the Credential Manager vault, Linux `secret-tool`. A secret
// travels only on standard input, base64-encoded (so no quoting, newline or code page can change it), and
// comes back on standard output; arguments carry only the service and account names. Errors are fixed
// sentences: no tool's output is passed on, so a secret cannot ride along in one (`security -i` echoes
// part of an over-long input line on stderr). There is no file fallback: where no store works,
// unavailable() says why.
// childProcess.spawn is called through the module object so tests can watch every spawn.
import childProcess from "node:child_process";
import { existsSync } from "node:fs";

/** The fixed service name of this plugin's entries. */
export const SERVICE = "bb-dashboards";
/** UTF-8 bytes. `security -i` cuts input lines at 4,096 bytes; 2,048 bytes in base64 plus the command stays well under. */
export const MAX_SECRET_BYTES = 2048;
const MAX_SECURITY_LINE = 4000;
/** Service and account names: spliced into `security -i`'s command line and PowerShell's script, so nothing that needs quoting. */
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const TIMEOUT_MS = 15_000;

export type SecretStore = {
  /** What the store is called on this system, for messages. */
  label: string;
  /** null when this machine's secure store works, otherwise why not. Checked once. */
  unavailable(): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  /** The secret, or null when there is no such entry. */
  get(account: string): Promise<string | null>;
  /** Removes the entry; no entry is not an error. */
  delete(account: string): Promise<void>;
};

type Result = { code: number | null; stdout: string; stderr: string; missing: boolean };

function run(command: string, args: string[], stdin = ""): Promise<Result> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const done = (code: number | null, missing = false) => resolve({ code, stdout, stderr, missing });
    try {
      const child = childProcess.spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: TIMEOUT_MS, killSignal: "SIGKILL" });
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (error: NodeJS.ErrnoException) => done(null, error.code === "ENOENT"));
      child.on("close", (code) => done(code));
      child.stdin.on("error", () => {}); // a tool that exits without reading its input
      child.stdin.end(stdin);
    } catch {
      done(null);
    }
  });
}

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
const decode = (text: string) => (/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text) && text !== "" ? Buffer.from(text, "base64").toString("utf8") : null);

/** One system's tool. get: the stored text, null for no entry, undefined when the tool failed. */
type Backend = {
  label: string;
  probe(): Promise<string | null>;
  set(account: string, encoded: string): Promise<boolean>;
  get(account: string): Promise<string | null | undefined>;
  delete(account: string): Promise<boolean>;
};

const SECURITY = "/usr/bin/security";
const NOT_FOUND = 44; // security's exit code for no such item; the PowerShell scripts use it too

function macos(service: string): Backend {
  return {
    label: "the macOS Keychain",
    probe: async () => (existsSync(SECURITY) ? null : "macOS's security tool is missing."),
    // `security -i` reads commands on stdin, so the value never reaches an argument list.
    set: async (account, encoded) => {
      const line = `add-generic-password -U -s ${service} -a ${account} -w ${encoded}\n`;
      if (line.length > MAX_SECURITY_LINE) return false;
      const r = await run(SECURITY, ["-i"], line);
      return r.code === 0 && r.stderr === "";
    },
    get: async (account) => {
      const r = await run(SECURITY, ["find-generic-password", "-s", service, "-a", account, "-w"]);
      return r.code === 0 ? r.stdout.trim() : r.code === NOT_FOUND ? null : undefined;
    },
    delete: async (account) => [0, NOT_FOUND].includes((await run(SECURITY, ["delete-generic-password", "-s", service, "-a", account])).code ?? -1),
  };
}

function windows(service: string): Backend {
  // Windows PowerShell 5.1 by path: the WinRT PasswordVault type does not load in PowerShell 7.
  const exe = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const vault =
    "$ErrorActionPreference='Stop';[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];$v=New-Object Windows.Security.Credentials.PasswordVault;";
  const ps = (script: string, stdin = "") => run(exe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(vault + script, "utf16le").toString("base64")], stdin);
  const entry = (account: string) => `'${service}','${account}'`;
  return {
    label: "Windows Credential Manager",
    probe: async () => ((await ps("")).code === 0 ? null : "Windows PowerShell could not open the Credential Manager vault."),
    set: async (account, encoded) =>
      (await ps(`$v.Add((New-Object Windows.Security.Credentials.PasswordCredential(${entry(account)},[Console]::In.ReadToEnd().Trim())))`, encoded)).code === 0,
    get: async (account) => {
      const r = await ps(`try{$c=$v.Retrieve(${entry(account)})}catch{exit ${NOT_FOUND}};$c.RetrievePassword();[Console]::Out.Write($c.Password)`);
      return r.code === 0 ? r.stdout.trim() : r.code === NOT_FOUND ? null : undefined;
    },
    delete: async (account) => [0, NOT_FOUND].includes((await ps(`try{$v.Remove($v.Retrieve(${entry(account)}))}catch{exit ${NOT_FOUND}}`)).code ?? -1),
  };
}

function linux(service: string): Backend {
  const attributes = (account: string) => ["service", service, "account", account];
  // secret-tool exits 1 both for "no such entry" and for "no keyring"; only the second writes to stderr.
  const absent = (r: Result) => r.code === 1 && r.stderr.trim() === "";
  return {
    label: "the Secret Service keyring",
    probe: async () => {
      const r = await run("secret-tool", ["lookup", ...attributes("probe")]);
      if (r.missing) return "secret-tool is not installed (it comes with libsecret).";
      return r.code === 0 || absent(r) ? null : "No Secret Service keyring answered (for example GNOME Keyring or KWallet).";
    },
    set: async (account, encoded) => (await run("secret-tool", ["store", "--label=bb Dashboards", ...attributes(account)], encoded)).code === 0,
    get: async (account) => {
      const r = await run("secret-tool", ["lookup", ...attributes(account)]);
      return r.code === 0 ? r.stdout.trim() : absent(r) ? null : undefined;
    },
    delete: async (account) => {
      const r = await run("secret-tool", ["clear", ...attributes(account)]);
      return r.code === 0 || absent(r);
    },
  };
}

export function createSecretStore({ service = SERVICE, platform = process.platform }: { service?: string; platform?: NodeJS.Platform } = {}): SecretStore {
  if (!NAME.test(service)) throw new Error("A secure-store service name may hold only letters, digits, _ . and -.");
  const backend = platform === "darwin" ? macos(service) : platform === "win32" ? windows(service) : platform === "linux" ? linux(service) : null;
  let checked: Promise<string | null> | undefined;
  const unavailable = () => (checked ??= backend ? backend.probe() : Promise.resolve(`This plugin knows no secure store on ${platform}.`));
  const ready = async (account: string) => {
    if (!NAME.test(account)) throw new Error("A secret's account name may hold only letters, digits, _ . and -.");
    const why = await unavailable();
    if (why !== null || backend === null) throw new Error(`The secure store is not available: ${why}`);
    return backend;
  };
  return {
    label: backend?.label ?? "no secure store",
    unavailable,
    async set(account, value) {
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes === 0 || bytes > MAX_SECRET_BYTES) throw new Error(`A secret must be 1 to ${MAX_SECRET_BYTES} bytes.`);
      const store = await ready(account);
      if (!(await store.set(account, encode(value)))) {
        await store.delete(account); // a failed write may have left part of the value behind
        throw new Error(`Could not save the secret in ${store.label}.`);
      }
    },
    async get(account) {
      const store = await ready(account);
      const text = await store.get(account);
      if (text === undefined) throw new Error(`Could not read a secret from ${store.label}.`);
      if (text === null) return null;
      const value = decode(text);
      if (value === null) throw new Error(`A secret in ${store.label} is not in the form this plugin writes; set it again.`);
      return value;
    },
    async delete(account) {
      const store = await ready(account);
      if (!(await store.delete(account))) throw new Error(`Could not remove a secret from ${store.label}.`);
    },
  };
}
