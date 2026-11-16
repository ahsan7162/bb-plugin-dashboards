// The secure store (server/secrets.ts). On macOS: a real round trip through the login Keychain under an
// invented service used only by this file, every entry deleted afterwards and checked gone. The secret
// never appears in any spawned process's arguments (every spawn is watched). Windows and Linux cannot
// run here: their backends are checked by watching the spawn call (command, arguments, stdin) with a
// fake child, so they are unverified on real systems.
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { clearTestService } from "../test/host";
import { createSecretStore, MAX_SECRET_BYTES } from "./secrets";

const SERVICE = "bb-dashboards-test-secrets";
const ID = "0123456789ab";
afterEach(() => vi.restoreAllMocks());

type Spawned = { command: string; args: string[]; stdin: string };
type Reply = { code?: number; stdout?: string; stderr?: string; missing?: boolean };

/** Watches every spawn. Without `reply` the real process runs (its stdin recorded); with it a fake child answers. */
function watchSpawns(reply?: (call: Spawned) => Reply) {
  const calls: Spawned[] = [];
  const real = childProcess.spawn.bind(childProcess);
  vi.spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], options: childProcess.SpawnOptions) => {
    const call: Spawned = { command, args: [...args], stdin: "" };
    calls.push(call);
    if (reply === undefined) {
      const child = real(command, args, options);
      const end = child.stdin!.end.bind(child.stdin!) as (chunk?: unknown) => void;
      (child.stdin as { end: (chunk?: unknown) => void }).end = (chunk?: unknown) => {
        call.stdin += typeof chunk === "string" ? chunk : "";
        end(chunk);
      };
      return child;
    }
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin.on("data", (chunk) => (call.stdin += chunk));
    child.stdin.on("finish", () => {
      const r = reply(call);
      if (r.missing) return void setImmediate(() => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
      child.stdout.end(r.stdout ?? "");
      child.stderr.end(r.stderr ?? "");
      setImmediate(() => child.emit("close", r.code ?? 0));
    });
    return child;
  }) as never);
  return calls;
}

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
/** The secret in every form it could take on its way: as is, base64 (how it travels) and hex. */
const forms = (secret: string) => [secret, b64(secret), Buffer.from(secret, "utf8").toString("hex")];
const invented = () => `invented "token" with spaces \\ and 'quotes' ${randomUUID()}`;

describe.runIf(process.platform === "darwin")("macOS Keychain, for real, under an invented test service", () => {
  const accounts = ["token", "unicode", "longest", "too-long"].map((a) => `${ID}.${a}`);
  // None remain, even after a failed test: every entry of the test service is deleted, then a lookup by service alone finds nothing (exit 44).
  afterAll(() => expect(clearTestService(SERVICE)).toBe(true));

  test("set, read back, replace, delete; odd characters, non-ASCII and the longest allowed value survive", async () => {
    const store = createSecretStore({ service: SERVICE, platform: "darwin" });
    expect(await store.unavailable()).toBeNull();
    const spawns = watchSpawns();
    const secret = invented();
    const unicode = `ünïcødé 🔑 ${randomUUID()}`;
    const longest = "é".repeat(MAX_SECRET_BYTES / 2); // 2,048 UTF-8 bytes

    await store.set(accounts[0]!, secret);
    expect(await store.get(accounts[0]!)).toBe(secret);
    await store.set(accounts[0]!, `${secret} rotated`); // -U replaces in place
    expect(await store.get(accounts[0]!)).toBe(`${secret} rotated`);
    await store.set(accounts[1]!, unicode);
    expect(await store.get(accounts[1]!)).toBe(unicode);
    await store.set(accounts[2]!, longest);
    expect(await store.get(accounts[2]!)).toBe(longest);
    await expect(store.set(accounts[3]!, `${longest}x`)).rejects.toThrow(`A secret must be 1 to ${MAX_SECRET_BYTES} bytes.`);
    expect(await store.get(accounts[3]!)).toBeNull();

    for (const account of accounts.slice(0, 3)) await store.delete(account);
    for (const account of accounts.slice(0, 3)) expect(await store.get(account)).toBeNull();
    await store.delete(accounts[0]!); // no entry is not an error

    expect(spawns.length).toBeGreaterThan(10);
    expect(spawns.every((s) => s.command === "/usr/bin/security")).toBe(true);
    const argv = JSON.stringify(spawns.map((s) => s.args));
    for (const value of [secret, `${secret} rotated`, unicode, longest]) for (const form of forms(value)) expect(argv).not.toContain(form);
    expect(spawns.filter((s) => s.stdin !== "").every((s) => s.args.join(" ") === "-i")).toBe(true); // values only ever on security -i's stdin
  });
});

describe("macOS backend, watched", () => {
  test("a refused write reports a fixed sentence, never security's output, and removes what may be left", async () => {
    const store = createSecretStore({ service: SERVICE, platform: "darwin" });
    const secret = invented();
    const spawns = watchSpawns((call) => (call.args[0] === "-i" ? { code: 1, stderr: `security: unknown command "${b64(secret).slice(4)}"` } : { code: 0 }));
    const failure = await store.set(`${ID}.token`, secret).catch((e: Error) => e.message);
    expect(failure).toBe("Could not save the secret in the macOS Keychain.");
    expect(spawns.map((s) => s.args[0])).toEqual(["-i", "delete-generic-password"]);
    expect(spawns[0]!.stdin).toBe(`add-generic-password -U -s ${SERVICE} -a ${ID}.token -w ${b64(secret)}\n`);
  });

  test("names that could break security -i's command line are refused before anything runs", async () => {
    const spawns = watchSpawns(() => ({ code: 0 }));
    const store = createSecretStore({ service: SERVICE, platform: "darwin" });
    await expect(store.set("x -w leaked", "v")).rejects.toThrow(/account name/);
    expect(() => createSecretStore({ service: "a service; rm" })).toThrow(/service name/);
    expect(spawns).toEqual([]);
  });
});

describe("Windows backend (watched only: unverified on a real system)", () => {
  const script = (call: Spawned) => Buffer.from(call.args[3]!, "base64").toString("utf16le");

  test("PowerShell 5.1 by path with the Credential Manager vault; the secret only on stdin", async () => {
    const secret = invented();
    const stored = new Map<string, string>();
    const spawns = watchSpawns((call) => {
      const s = script(call);
      if (s.includes("$v.Add(")) return stored.set("entry", call.stdin), { code: 0 };
      if (s.includes("RetrievePassword")) return stored.has("entry") ? { code: 0, stdout: stored.get("entry") } : { code: 44 };
      if (s.includes("$v.Remove(")) return stored.delete("entry") ? { code: 0 } : { code: 44 };
      return { code: 0 }; // the probe: the vault type loads
    });
    const store = createSecretStore({ service: SERVICE, platform: "win32" });
    expect(store.label).toBe("Windows Credential Manager");
    expect(await store.unavailable()).toBeNull();
    await store.set(`${ID}.token`, secret);
    expect(await store.get(`${ID}.token`)).toBe(secret);
    await store.delete(`${ID}.token`);
    expect(await store.get(`${ID}.token`)).toBeNull();
    await store.delete(`${ID}.token`);

    for (const call of spawns) {
      expect(call.command).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
      expect(call.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
      expect(script(call)).toContain("Windows.Security.Credentials.PasswordVault");
      for (const form of forms(secret)) expect(call.args.join(" ") + script(call)).not.toContain(form);
    }
    const add = spawns.find((c) => script(c).includes("$v.Add("))!;
    expect(script(add)).toContain(`PasswordCredential('${SERVICE}','${ID}.token',[Console]::In.ReadToEnd().Trim())`);
    expect(add.stdin).toBe(b64(secret));
  });

  test("a vault that does not load makes the store unavailable", async () => {
    watchSpawns(() => ({ code: 1, stderr: "Unable to find type" }));
    const store = createSecretStore({ service: SERVICE, platform: "win32" });
    expect(await store.unavailable()).toBe("Windows PowerShell could not open the Credential Manager vault.");
    await expect(store.set(`${ID}.token`, "x")).rejects.toThrow("The secure store is not available");
  });
});

describe("Linux backend (watched only: unverified on a real system)", () => {
  test("secret-tool with service and account attributes; the secret only on stdin", async () => {
    const secret = invented();
    let stored: string | null = null;
    const spawns = watchSpawns((call) => {
      if (call.args[0] === "store") return (stored = call.stdin), { code: 0 };
      if (call.args[0] === "lookup") return stored !== null && call.args.at(-1) !== "probe" ? { code: 0, stdout: stored } : { code: 1 };
      return (stored = null), { code: 0 };
    });
    const store = createSecretStore({ service: SERVICE, platform: "linux" });
    expect(await store.unavailable()).toBeNull();
    await store.set(`${ID}.token`, secret);
    expect(await store.get(`${ID}.token`)).toBe(secret);
    await store.delete(`${ID}.token`);
    expect(await store.get(`${ID}.token`)).toBeNull();

    const attributes = ["service", SERVICE, "account", `${ID}.token`];
    expect(spawns.map((c) => [c.command, ...c.args])).toEqual([
      ["secret-tool", "lookup", "service", SERVICE, "account", "probe"],
      ["secret-tool", "store", "--label=bb Dashboards", ...attributes],
      ["secret-tool", "lookup", ...attributes],
      ["secret-tool", "clear", ...attributes],
      ["secret-tool", "lookup", ...attributes],
    ]);
    expect(spawns[1]!.stdin).toBe(b64(secret));
    for (const form of forms(secret)) expect(JSON.stringify(spawns.map((c) => c.args))).not.toContain(form);
  });

  test.each([
    ["secret-tool is not installed", { missing: true }, "secret-tool is not installed (it comes with libsecret)."],
    ["no keyring answers", { code: 1, stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" }, "No Secret Service keyring answered (for example GNOME Keyring or KWallet)."],
  ])("when %s, the store says so and there is no fallback", async (_, reply, why) => {
    watchSpawns(() => reply);
    const store = createSecretStore({ service: SERVICE, platform: "linux" });
    expect(await store.unavailable()).toBe(why);
    await expect(store.set(`${ID}.token`, "x")).rejects.toThrow(`The secure store is not available: ${why}`);
    await expect(store.get(`${ID}.token`)).rejects.toThrow("not available");
  });
});

test("a system with no known store is unavailable and runs nothing", async () => {
  const spawns = watchSpawns(() => ({ code: 0 }));
  const store = createSecretStore({ service: SERVICE, platform: "freebsd" });
  expect(await store.unavailable()).toBe("This plugin knows no secure store on freebsd.");
  await expect(store.set(`${ID}.token`, "x")).rejects.toThrow("not available");
  expect(spawns).toEqual([]);
});
