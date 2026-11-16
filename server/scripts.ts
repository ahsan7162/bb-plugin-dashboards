// Script sources (PLAN section 7): approvals, the user's secrets for them, and the run itself.
// A script runs only while the user's approval for that dashboard and source name has the hash of exactly
// its runner, code and secret names. There is one approval per dashboard and name: approving a new hash
// replaces the old one, and a later version with the same hash carries it. Approving, withdrawing and
// setting secrets are RPCs from the panel (server.ts); no agent tool reaches them.
// A run happens on the bb server's own machine (never on Windows), in the origin thread's environment
// folder, in its own process group, so the time limit, the output cap, its own exit, withdrawing its approval
// and deleting its dashboard stop everything it started. Its environment is bb's tool path plus its secret
// variables; its args arrive as JSON on stdin.
// childProcess.spawn is called through the module object so tests can watch every spawn.
import childProcess, { type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { SecretStore } from "./secrets";
import { MAX_SCRIPT_OUTPUT, SCRIPT_TIMEOUT_MS, type Source } from "./sources";
import type { Origin } from "./store";

export type ScriptSource = Extract<Source, { kind: "script" }>;
export type Runner = ScriptSource["runner"];
export type Answer = { ok: true; data: unknown } | { ok: false; error: string };
type Failure = { ok: false; error: string };
type Db = ReturnType<BbPluginApi["storage"]["database"]>;
const fail = (error: string): Failure => ({ ok: false, error });
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** How each runner takes its code: as one argument, so standard input stays free for the args. */
const CODE_FLAG: Record<Runner, string> = { sh: "-c", bash: "-c", python3: "-c", node: "-e" };
/** At most this much of a failing script's error output is shown to the user; the agent never sees it. */
export const STDERR_TAIL = 300;

const secretNames = (s: Pick<ScriptSource, "secrets">) => [...new Set(s.secrets ?? [])].sort();
/** What an approval is for: everything that decides what runs. A secret's value is not part of it. */
export const scriptHash = (s: Pick<ScriptSource, "runner" | "code" | "secrets">) =>
  createHash("sha256").update(JSON.stringify([s.runner, s.code, secretNames(s)])).digest("hex");

/** Known secret values never appear in what the user is shown. */
const redact = (text: string, hidden: string[]) => hidden.reduce((t, secret) => (secret.length >= 4 ? t.split(secret).join("[secret]") : t), text);

export type RunOptions = { runner: Runner; code: string; cwd: string; env: Record<string, string>; input: unknown; timeoutMs?: number; maxOutputBytes?: number; hidden?: string[]; signal?: AbortSignal };

/** Runs one script: its args as JSON on standard input, one JSON value expected on standard output. Every failure is a value. */
export function runScript(o: RunOptions): Promise<Answer> {
  const { timeoutMs = SCRIPT_TIMEOUT_MS, maxOutputBytes = MAX_SCRIPT_OUTPUT, hidden = [] } = o;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      // detached: the script leads its own process group, so stopping the group stops what it started too
      // (a process that moves itself to another group, with setsid for example, escapes this).
      child = childProcess.spawn(o.runner, [CODE_FLAG[o.runner], o.code], { cwd: o.cwd, env: o.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (cause) {
      return resolve(fail(`The script could not start: ${message(cause)}`));
    }
    const out: Buffer[] = [];
    let size = 0;
    let errors = "";
    let stopped: string | null = null;
    let settled = false;
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // nothing of it is left
      }
    };
    const stop = (why: string) => {
      stopped ??= why;
      killGroup();
    };
    const timer = setTimeout(() => stop(`did not finish within ${timeoutMs / 1000} s and was stopped with everything it started`), timeoutMs);
    // A string reason says why (an approval withdrawn, a dashboard deleted); without one, the plugin stopped.
    const aborted = () => stop(typeof o.signal?.reason === "string" ? o.signal.reason : "was stopped with everything it started, because the plugin stopped or reloaded");
    o.signal?.addEventListener("abort", aborted, { once: true });
    if (o.signal?.aborted) aborted();
    const settle = (answer: Answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", aborted);
      killGroup();
      resolve(answer);
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutputBytes) stop(`printed more than ${maxOutputBytes / 1024 / 1024} MB and was stopped with everything it started; have it print less`);
      else if (stopped === null) out.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => (errors = (errors + chunk.toString("utf8")).slice(-4 * STDERR_TAIL)));
    child.stdin!.on("error", () => {}); // a script that exits without reading its input (EPIPE); unhandled, it would end the server
    child.on("error", (error: NodeJS.ErrnoException) =>
      settle(fail(error.code === "ENOENT" ? `${o.runner} was not found on bb's tool path, or the thread's folder is gone.` : `The script could not start (${error.code ?? error.message}).`)),
    );
    child.on("exit", killGroup); // what it left running in the background goes with it, which also closes its output
    child.on("close", (code, signal) => {
      const tail = redact(errors.trim(), hidden).slice(-STDERR_TAIL);
      const told = (text: string) => fail(tail === "" ? text : `${text} Its last error output: ${tail}`);
      if (stopped !== null) return settle(told(`The script ${stopped}.`));
      if (signal !== null) return settle(told(`The script was stopped by ${signal}.`));
      if (code !== 0) return settle(told(`The script exited with code ${code}.`));
      const text = Buffer.concat(out).toString("utf8");
      try {
        settle({ ok: true, data: JSON.parse(text) as unknown });
      } catch {
        settle(told(text.trim() === "" ? "The script printed nothing; it must print one JSON value." : "The script's output is not JSON; it must print one JSON value and nothing else."));
      }
    });
    child.stdin!.end(JSON.stringify(o.input));
  });
}

/** Why a run in progress was stopped, as the user reads it after "The script ". */
const WITHDRAWN = "was stopped with everything it started, because its approval was withdrawn";
const DELETED = "was stopped with everything it started, because its dashboard was deleted";

type ApprovalRow = { source: string; hash: string; runner: Runner; code: string; secrets: string; approved_at: number };
export type Approval = { source: string; hash: string; runner: Runner; code: string; secrets: string[]; approvedAt: number };
export type Scripts = ReturnType<typeof createScripts>;

export function createScripts(o: { db: Db; sdk: BbPluginApi["sdk"]; secrets: SecretStore; toolPath: () => Promise<string>; platform?: NodeJS.Platform; timeoutMs?: number }) {
  const { db, sdk, secrets } = o;
  const platform = o.platform ?? process.platform;
  const unload = new AbortController(); // the plugin's dispose stops every script still running
  const runs = new Map<string, AbortController>(); // runs in progress, by `${dashboard id}\0${source name}`
  /** Stops the dashboard's run in progress of that source, or of every source when source is null. */
  const halt = (id: string, source: string | null, why: string) => {
    for (const [key, run] of runs) if (source === null ? key.startsWith(`${id}\0`) : key === `${id}\0${source}`) run.abort(why);
  };
  const approvalOf = db.prepare(`SELECT * FROM script_approvals WHERE dashboard_id = ? AND source = ?`);
  const approvalsOf = db.prepare(`SELECT * FROM script_approvals WHERE dashboard_id = ? ORDER BY source`);
  const upsert = db.prepare(
    `INSERT INTO script_approvals (dashboard_id, source, hash, runner, code, secrets, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (dashboard_id, source) DO UPDATE SET hash = excluded.hash, runner = excluded.runner, code = excluded.code, secrets = excluded.secrets, approved_at = excluded.approved_at`,
  );
  const removeApproval = db.prepare(`DELETE FROM script_approvals WHERE dashboard_id = ? AND source = ?`);
  const secretsOf = db.prepare(`SELECT name FROM script_secrets WHERE dashboard_id = ? ORDER BY name`);
  const addSecret = db.prepare(`INSERT OR IGNORE INTO script_secrets (dashboard_id, name) VALUES (?, ?)`);
  const removeSecret = db.prepare(`DELETE FROM script_secrets WHERE dashboard_id = ? AND name = ?`);

  const toApproval = (r: ApprovalRow): Approval => ({ source: r.source, hash: r.hash, runner: r.runner, code: r.code, secrets: JSON.parse(r.secrets) as string[], approvedAt: r.approved_at });
  const approval = (id: string, source: string) => {
    const row = approvalOf.get(id, source) as ApprovalRow | undefined;
    return row ? toApproval(row) : null;
  };
  const isApproved = (id: string, s: ScriptSource) => approval(id, s.name)?.hash === scriptHash(s);
  const account = (id: string, name: string) => `dashboard.${id}.${name}`;
  const secretsSet = (id: string) => (secretsOf.all(id) as { name: string }[]).map((r) => r.name);
  const forgetSecret = async (id: string, name: string) => {
    await secrets.delete(account(id, name));
    removeSecret.run(id, name);
  };

  /** The folder this dashboard's scripts run in, or why scripts cannot run for it (then approval is never offered). */
  async function folder(origin: Origin): Promise<{ ok: true; path: string } | Failure> {
    if (platform === "win32") return fail("Scripts are not supported on Windows in this version of the plugin.");
    if (origin.threadId === null) return fail("Scripts cannot run here: this dashboard does not know the thread it was made in.");
    try {
      const [thread, config] = await Promise.all([sdk.threads.get({ threadId: origin.threadId, include: "environment" }), sdk.system.config()]);
      const environment = "environment" in thread ? thread.environment : null;
      if (thread.deletedAt !== null || typeof environment?.path !== "string") return fail("Scripts cannot run here: the thread this dashboard was made in has no environment folder.");
      if (config.primaryHostId === null || environment.hostId !== config.primaryHostId) {
        return fail("Scripts cannot run here: the thread's environment is on another machine, and scripts run only on the machine bb's server runs on.");
      }
      return { ok: true, path: environment.path };
    } catch {
      return fail("Scripts cannot run here: the thread this dashboard was made in no longer exists.");
    }
  }

  return {
    /** Stops every running script and what it started; for the plugin's dispose. */
    stopAll: () => unload.abort(),
    folder,
    approval,
    approvals: (id: string) => (approvalsOf.all(id) as ApprovalRow[]).map(toApproval),
    isApproved,
    /** Records the user's approval of exactly this script, replacing an earlier one for the same name. */
    approve(id: string, s: ScriptSource) {
      upsert.run(id, s.name, scriptHash(s), s.runner, s.code, JSON.stringify(secretNames(s)), Date.now());
    },
    /** Withdraws one approval and stops that source's run in progress. */
    withdraw(id: string, source: string) {
      halt(id, source, WITHDRAWN);
      return removeApproval.run(id, source).changes > 0;
    },
    /** Withdraws the approvals of names that are no longer script sources, so no old version runs them unseen. */
    keepApprovals(id: string, names: readonly string[]) {
      for (const a of (approvalsOf.all(id) as ApprovalRow[])) {
        if (names.includes(a.source)) continue;
        halt(id, a.source, WITHDRAWN);
        removeApproval.run(id, a.source);
      }
    },
    /** Stops every run in progress of a dashboard that was deleted. */
    stopRuns: (id: string) => halt(id, null, DELETED),
    /** Names of the dashboard's script secrets that have a value; never a value. */
    secretsSet,
    /** Sets (or with null removes) one secret's value in the secure store; write-only. */
    async setSecret(id: string, name: string, value: string | null): Promise<{ ok: true } | Failure> {
      try {
        if (value === null) {
          await forgetSecret(id, name);
        } else {
          await secrets.set(account(id, name), value);
          addSecret.run(id, name);
        }
        return { ok: true };
      } catch (cause) {
        return fail(message(cause)); // fixed sentences from secrets.ts
      }
    },
    /** Removes the values of names the dashboard no longer declares; [] removes them all. */
    async prune(id: string, declared: readonly string[]): Promise<{ ok: true } | Failure> {
      try {
        for (const name of secretsSet(id)) if (!declared.includes(name)) await forgetSecret(id, name);
        return { ok: true };
      } catch (cause) {
        return fail(message(cause));
      }
    },
    /** Runs a script source of the dashboard if it is approved, can run here and has its secrets. */
    async run(id: string, origin: Origin, s: ScriptSource, args: Record<string, unknown>): Promise<Answer> {
      if (!isApproved(id, s)) return fail(`The script "${s.name}" is waiting for your approval.`);
      const where = await folder(origin);
      if (!where.ok) return where;
      const set = secretsSet(id);
      const missing = secretNames(s).filter((n) => !set.includes(n));
      if (missing.length > 0) return fail(`The script needs ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not set. Enter ${missing.length === 1 ? "it" : "them"} in the panel.`);
      const values: Record<string, string> = {};
      for (const name of secretNames(s)) {
        const value = await secrets.get(account(id, name)).catch((cause: unknown) => fail(message(cause)));
        if (value === null) return fail(`${name} is no longer in ${secrets.label}. Enter it again in the panel.`);
        if (typeof value !== "string") return value;
        values[name] = value;
      }
      const path = await o.toolPath();
      // Checked again with no await before the spawn: an approval withdrawn (or a dashboard deleted) while
      // the secrets were read means it does not start; from here on, either stops it.
      if (!isApproved(id, s)) return fail(`The script "${s.name}" is waiting for your approval.`);
      const key = `${id}\0${s.name}`;
      const run = new AbortController();
      runs.set(key, run);
      try {
        return await runScript({ runner: s.runner, code: s.code, cwd: where.path, env: { PATH: path, ...values }, input: args, timeoutMs: o.timeoutMs, hidden: Object.values(values), signal: AbortSignal.any([unload.signal, run.signal]) });
      } finally {
        if (runs.get(key) === run) runs.delete(key);
      }
    },
  };
}
