// Script sources: the runner (stdin JSON in, JSON out, failures, the time limit with a grandchild, the
// output cap, EPIPE, the exact environment, refusal off the bb server's machine and on Windows), approval
// by hash through every path (restoring an old version included), withdrawing and deleting stopping a run,
// the caller gate on every RPC, script secrets, and secrets never leaving. Every script is invented and harmless: it prints JSON, sleeps or starts a sleeping
// child, and writes only inside its own temporary folder, which is removed afterwards.
import childProcess, { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { createPlugin, type PluginOptions } from "../server";
import { TEST_PATH, clearTestService, memorySecrets, startHost } from "../test/host";
import { runScript, scriptHash } from "./scripts";
import { createSecretStore } from "./secrets";
import { SCRIPT_MIN_REFRESH_SECONDS } from "./sources";
import { NEVER_APPROVE } from "./tools";

const root = mkdtempSync(join(tmpdir(), "oa-scripts-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let made = 0;
/** A fresh folder for one test, standing in for a thread's environment folder. */
const folder = () => {
  const dir = join(root, String(made++));
  mkdirSync(dir);
  return dir;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (check()) return true;
  return check();
};
const pidIn = (dir: string, file: string) => Number(readFileSync(join(dir, file), "utf8").trim());
const written = (dir: string, file: string) => existsSync(join(dir, file)) && readFileSync(join(dir, file), "utf8").trim() !== "";
/** A PATH with a node in it, found next to the Node running these tests. */
const NODE_PATH = `${dirname(process.execPath)}:${TEST_PATH}`;

type Host = Awaited<ReturnType<typeof startHost>>;
const hosts: Host[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(hosts.splice(0).map((h) => h.harness.lifecycle.dispose()));
});

/** Watches every spawn of a script runner (the secure store's own tool is left out). */
function watchRunners() {
  const real = childProcess.spawn.bind(childProcess);
  const calls: { command: string; args: string[]; env: Record<string, string>; detached: boolean }[] = [];
  vi.spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], options: childProcess.SpawnOptions) => {
    if (command !== "/usr/bin/security") calls.push({ command, args: [...args], env: options.env as Record<string, string>, detached: options.detached === true });
    return real(command, args, options);
  }) as never);
  return calls;
}

const program = (names: string[], interval = "") =>
  `root = Dashboard([main])\n${names.map((n) => `${n} = Query("${n}", {}, {rows: []}${interval})`).join("\n")}\nmain = Section("Jobs", [Kpis([${names.map((n) => `Kpi("${n}", @Count(${n}.rows), "number")`).join(", ")}])])`;
const script = (code: string, extra: Record<string, unknown> = {}) => ({ name: "jobs", kind: "script", runner: "sh", why: "Counts jobs in the invented queue", code, ...extra });
const MARKED = `touch ran.marker; printf '{"rows":[1,2]}'`;

async function host(options: PluginOptions & { folder?: string; hostId?: string } = {}) {
  const { folder: dir = folder(), hostId, ...rest } = options;
  const h = await startHost(async () => createPlugin({ secrets: memorySecrets(), toolPath: async () => TEST_PATH, ...rest }), {}, { folder: dir, hostId });
  hosts.push(h);
  const approve = async (id: string, source = "jobs") => {
    const view = await h.rpc("scripts", { id });
    const s = view.sources.find((x: { name: string }) => x.name === source);
    return h.rpc("script_approve", { id, source, hash: s.hash });
  };
  return { ...h, dir, approve };
}

describe("runScript", () => {
  const run = (code: string, extra: Partial<Parameters<typeof runScript>[0]> = {}) => runScript({ runner: "sh", code, cwd: folder(), env: { PATH: TEST_PATH }, input: { state: "open" }, ...extra });

  test("the args arrive as JSON on standard input, never in the command line; the JSON it prints is the result", async () => {
    const calls = watchRunners();
    expect(await run(`printf '{"got":%s}' "$(cat)"`)).toEqual({ ok: true, data: { got: { state: "open" } } });
    expect(calls).toEqual([{ command: "sh", args: ["-c", `printf '{"got":%s}' "$(cat)"`], env: { PATH: TEST_PATH }, detached: true }]);
  });

  test("output that is not JSON, no output and a non-zero exit are failures; error output only as a short tail", async () => {
    expect(await run("echo hello")).toEqual({ ok: false, error: "The script's output is not JSON; it must print one JSON value and nothing else." });
    expect(await run("true")).toEqual({ ok: false, error: "The script printed nothing; it must print one JSON value." });
    const long = await run(`i=0; while [ $i -lt 200 ]; do echo "invented noise line $i" >&2; i=$((i+1)); done; echo "invented last words" >&2; exit 3`);
    expect(long.ok).toBe(false);
    const error = (long as { error: string }).error;
    expect(error).toMatch(/^The script exited with code 3\. Its last error output: /);
    expect(error).toContain("invented last words");
    expect(error.length).toBeLessThan(400);
  });

  test("the time limit stops the script and the child it started", async () => {
    const dir = folder();
    const started = Date.now();
    const answer = await run(`echo $$ > script.pid; sleep 30 & echo $! > child.pid; wait`, { cwd: dir, timeoutMs: 500 });
    expect(answer).toEqual({ ok: false, error: "The script did not finish within 0.5 s and was stopped with everything it started." });
    expect(Date.now() - started).toBeLessThan(3000);
    const [script, child] = [pidIn(dir, "script.pid"), pidIn(dir, "child.pid")];
    expect(await until(() => !alive(script) && !alive(child))).toBe(true);
  });

  test("a child left running in the background when the script exits is stopped too", async () => {
    const dir = folder();
    expect(await run(`sleep 30 & echo $! > child.pid; printf '{"ok":true}'`, { cwd: dir })).toEqual({ ok: true, data: { ok: true } });
    expect(await until(() => !alive(pidIn(dir, "child.pid")))).toBe(true);
  });

  test("more than 1 MB of output stops it", async () => {
    expect(await run("head -c 1200000 /dev/zero | tr '\\\\0' x")).toEqual({ ok: false, error: "The script printed more than 1 MB and was stopped with everything it started; have it print less." });
  });

  test("a script that exits without reading a large input (EPIPE) is no crash", async () => {
    expect(await run(`printf '{"ok":true}'`, { input: { blob: "x".repeat(2 * 1024 * 1024) } })).toEqual({ ok: true, data: { ok: true } });
  });

  test("each runner gets its code as one argument: -c, or -e for node; node is found on the PATH it is given", async () => {
    const calls = watchRunners();
    expect(await run(`process.stdout.write(JSON.stringify({ n: 42 }))`, { runner: "node", env: { PATH: NODE_PATH } })).toEqual({ ok: true, data: { n: 42 } });
    expect(await run(`printf '{"shell":"bash"}'`, { runner: "bash" })).toEqual({ ok: true, data: { shell: "bash" } });
    expect(calls.map((c) => [c.command, c.args[0]])).toEqual([["node", "-e"], ["bash", "-c"]]);
    expect(calls[0]!.command).not.toBe(process.execPath);
    // python3 is not started here (on macOS without developer tools it asks to install them); only its argument is checked.
    vi.restoreAllMocks();
    const seen: string[][] = [];
    vi.spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[]) => {
      seen.push([command, ...args]);
      throw new Error("not started in tests");
    }) as never);
    expect(await run("print('{}')", { runner: "python3" })).toEqual({ ok: false, error: "The script could not start: not started in tests" });
    expect(seen).toEqual([["python3", "-c", "print('{}')"]]);
  });

  test("a runner that is not on the PATH is a clear failure", async () => {
    expect(await run("x", { runner: "node", env: { PATH: "/nonexistent" } })).toEqual({ ok: false, error: "node was not found on bb's tool path, or the thread's folder is gone." });
  });
});

describe("approval", () => {
  test("an unapproved script never runs: not at save, not from dashboard_sources or dashboard_get, not from source_run", async () => {
    const calls = watchRunners();
    const h = await host();
    const saved = await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(MARKED)] });
    expect(saved.error, saved.text).toBe(false);
    expect(saved.text).toContain('Script sources "jobs" will not run until the user reads and approves each in the dashboard\'s panel.');
    expect(saved.text).toContain(NEVER_APPROVE);
    await h.call("dashboard_sources", { kind: "script" });
    await h.call("dashboard_sources", {});
    expect((await h.call("dashboard_get", { id: saved.id })).text).toContain("jobs: script (sh), waiting for the user's approval in the panel");
    expect(await h.run({ id: saved.id, version: 1, source: "jobs", args: {} })).toEqual({ ok: false, error: 'The script "jobs" is waiting for your approval. Review it in the panel.' });
    expect(calls).toEqual([]);
    expect(existsSync(join(h.dir, "ran.marker"))).toBe(false);
    expect((await h.rpc("scripts", { id: saved.id })).sources).toEqual([
      { name: "jobs", runner: "sh", code: MARKED, why: "Counts jobs in the invented queue", secrets: [], hash: scriptHash(script(MARKED) as never), approved: false, previous: null },
    ]);
  });

  test("approved, it runs in the thread's folder; the badge lists it; withdrawn, it stops at once", async () => {
    const h = await host();
    const { id } = await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(MARKED)] });
    expect(await h.approve(id!)).toEqual({ ok: true });
    expect(await h.run({ id, version: 1, source: "jobs", args: {} })).toEqual({ ok: true, data: { rows: [1, 2] }, fetchedAt: expect.any(Number) });
    expect(existsSync(join(h.dir, "ran.marker"))).toBe(true);
    const view = await h.rpc("scripts", { id });
    expect(view).toMatchObject({ blocked: null, folder: h.dir, latest: true, approved: [{ source: "jobs", runner: "sh", code: MARKED, secrets: [], approvedAt: expect.any(Number) }] });
    expect((await h.call("dashboard_get", { id })).text).toContain("jobs: script (sh), approved by the user");

    expect(await h.rpc("script_withdraw", { id, source: "jobs" })).toEqual({ ok: true });
    expect(await h.run({ id, version: 1, source: "jobs", args: {} })).toMatchObject({ ok: false, error: expect.stringContaining("waiting for your approval") }); // within the floor: no cached answer
    expect(await h.rpc("script_withdraw", { id, source: "jobs" })).toEqual({ ok: false, error: '"jobs" has no approval to withdraw.' });
  });

  test.each([
    ["the code", { code: `printf '{"rows":[]}'` }],
    ["the runner", { runner: "bash" }],
    ["a secret name added", { secrets: ["QUEUE_READ_TOKEN"] }],
  ])("changing %s means not approved; the panel gets the approved text to compare", async (_, change) => {
    const calls = watchRunners();
    const h = await host();
    const { id } = await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(MARKED)] });
    await h.approve(id!);
    const edited = await h.save({ id, sources: [script(MARKED, change)] });
    expect(edited.text).toContain("will not run until the user reads and approves");
    expect(await h.run({ id, version: 2, source: "jobs", args: {} })).toMatchObject({ ok: false, error: expect.stringContaining("waiting for your approval") });
    expect((await h.rpc("scripts", { id })).sources[0]).toMatchObject({ approved: false, previous: { runner: "sh", code: MARKED, secrets: [] } });
    expect(calls).toEqual([]);
  });

  test("an identical script carries its approval to a later version; an old version whose script is no longer approved does not run", async () => {
    const h = await host();
    const { id } = await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(MARKED)] });
    await h.approve(id!);
    const renamed = await h.save({ id, title: "Queue overview", program: program(["jobs"], ", 60") });
    expect(renamed.text).toContain('Script sources "jobs" keep the user\'s approval');
    expect((await h.run({ id, version: 2, source: "jobs", args: {} })).ok).toBe(true);

    await h.save({ id, sources: [script(`printf '{"rows":[3]}'`)] });
    await h.approve(id!); // the user approves version 3's script; versions 1 and 2 have the old one
    expect((await h.run({ id, version: 3, source: "jobs", args: {} })).data).toEqual({ rows: [3] });
    expect(await h.run({ id, version: 1, source: "jobs", args: { other: true } })).toMatchObject({ ok: false, error: expect.stringContaining("waiting for your approval") });
    expect(await h.rpc("scripts", { id, version: 1 })).toMatchObject({ latest: false, sources: [{ approved: false }] });
  });

  test("approval needs the hash the user read, a script of the latest version, and a place it can run", async () => {
    const h = await host();
    const { id } = await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(MARKED)] });
    const stale = scriptHash(script("echo old") as never);
    expect(await h.rpc("script_approve", { id, source: "jobs", hash: stale })).toEqual({ ok: false, error: "The script changed since you opened it. Review it again." });
    expect(await h.rpc("script_approve", { id, source: "other", hash: stale })).toEqual({ ok: false, error: '"other" is not a script source of this dashboard\'s latest version.' });
    expect(h.db().prepare("SELECT COUNT(*) AS n FROM script_approvals").get()).toEqual({ n: 0 });
  });

  test(`a script's refresh interval is at least ${SCRIPT_MIN_REFRESH_SECONDS} s at save, and the server answers from its cache within that floor`, async () => {
    const calls = watchRunners();
    const h = await host();
    const refused = await h.save({ title: "Queue", program: program(["jobs"], ", 15"), sources: [script(MARKED)] });
    expect(refused.text).toContain(`the minimum for "jobs" (a script source) is ${SCRIPT_MIN_REFRESH_SECONDS}`);
    const { id } = await h.save({ title: "Queue", program: program(["jobs"], `, ${SCRIPT_MIN_REFRESH_SECONDS}`), sources: [script(MARKED)] });
    await h.approve(id!);
    vi.useFakeTimers({ toFake: ["Date"] });
    const ask = () => h.run({ id, version: 1, source: "jobs", args: {} });
    await ask();
    vi.setSystemTime(Date.now() + SCRIPT_MIN_REFRESH_SECONDS * 1000 - 1);
    await ask();
    expect(calls).toHaveLength(1);
    vi.setSystemTime(Date.now() + 1);
    await ask();
    expect(calls).toHaveLength(2);
  });

  test("one run at a time per source: a second run while the first is going is refused, not queued", async () => {
    const calls = watchRunners();
    const h = await host();
    const { id } = await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(`sleep 1; printf '{"rows":%s}' "$(cat)"`)] });
    await h.approve(id!);
    const first = h.run({ id, version: 1, source: "jobs", args: { n: 1 } });
    await until(() => calls.length === 1);
    expect(await h.run({ id, version: 1, source: "jobs", args: { n: 2 } })).toEqual({ ok: false, error: 'The script "jobs" is still running; it runs one at a time. It runs again on the next refresh.' });
    expect((await first).data).toEqual({ rows: { n: 1 } });
    expect((await h.run({ id, version: 1, source: "jobs", args: { n: 2 } })).data).toEqual({ rows: { n: 2 } });
    expect(calls).toHaveLength(2);
  });

  test("the script's environment is bb's tool path and its secret variables, nothing else", async () => {
    const calls = watchRunners();
    const h = await host({ toolPath: async () => NODE_PATH });
    const code = "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))";
    const { id } = await h.save({ title: "Env", program: program(["jobs"]), sources: [script(code, { runner: "node", secrets: ["QUEUE_READ_TOKEN"] })] });
    await h.approve(id!);
    expect(await h.run({ id, version: 1, source: "jobs", args: {} })).toEqual({ ok: false, error: "The script needs QUEUE_READ_TOKEN, which is not set. Enter it in the panel." });
    expect(await h.rpc("script_secret", { id, name: "QUEUE_READ_TOKEN", value: "invented-queue-token-31d9" })).toEqual({ ok: true });
    const seen = await h.run({ id, version: 1, source: "jobs", args: {} });
    expect((seen.data as string[]).filter((n) => n !== "__CF_USER_TEXT_ENCODING")).toEqual(["PATH", "QUEUE_READ_TOKEN"]); // macOS adds that one name to every process
    expect(calls).toEqual([{ command: "node", args: ["-e", code], env: { PATH: NODE_PATH, QUEUE_READ_TOKEN: "invented-queue-token-31d9" }, detached: true }]);
  });

  test("an environment on another machine: scripts cannot run, approval is not offered and is refused", async () => {
    const calls = watchRunners();
    const h = await host({ hostId: "host-2" });
    const saved = await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(MARKED)] });
    const blocked = "Scripts cannot run here: the thread's environment is on another machine, and scripts run only on the machine bb's server runs on.";
    expect(saved.text).toContain(`Script sources "jobs" will not run: ${blocked}`);
    expect(await h.rpc("scripts", { id: saved.id })).toMatchObject({ blocked, folder: null });
    expect(await h.approve(saved.id!)).toEqual({ ok: false, error: blocked });
    // Even with an approval in the database, it does not run there.
    h.db().prepare("INSERT INTO script_approvals VALUES (?, 'jobs', ?, 'sh', ?, '[]', 0)").run(saved.id, scriptHash(script(MARKED) as never), MARKED);
    expect(await h.run({ id: saved.id, version: 1, source: "jobs", args: {} })).toEqual({ ok: false, error: blocked });
    expect(calls).toEqual([]);
  });

  test("on Windows scripts are not supported: approval is refused and nothing runs", async () => {
    const calls = watchRunners();
    const h = await host({ platform: "win32" });
    const { id } = await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(MARKED)] });
    const blocked = "Scripts are not supported on Windows in this version of the plugin.";
    expect((await h.rpc("scripts", { id })).blocked).toBe(blocked);
    expect(await h.approve(id!)).toEqual({ ok: false, error: blocked });
    expect(calls).toEqual([]);
  });

  test("a script source is checked at save: runner, one-line why, code size, secret names", async () => {
    const h = await host();
    const save = (extra: Record<string, unknown>) => h.call("dashboard_save", { title: "x", program: program(["jobs"]), sources: [script(MARKED, extra)] });
    // Refused inside dashboard_save, with the schema's message and the topic that has the shape.
    const refused = async (extra: Record<string, unknown>, message: RegExp) => {
      const { text, error } = await save(extra);
      expect(error).toBe(true);
      expect(text).toMatch(message);
      expect(text).toContain('The shapes are in dashboard_get with topic "scripts".');
    };
    await refused({ runner: "perl" }, /runner/);
    await refused({ why: "line one\nline two" }, /one line/);
    await refused({ code: "x".repeat(20_001) }, /code/);
    for (const name of ["PATH", "NODE_OPTIONS", "PYTHONPATH", "LD_PRELOAD", "BASH_ENV", "1TOKEN"]) await refused({ secrets: [name] }, /secrets/);
    await refused({ secrets: ["A", "A"] }, /each name once/);
    // Characters that would make the text the user reads differ from what runs.
    for (const hidden of ["\u202e", "\u2066", "\u200b", "\ufeff", "\u2028", "\u2029", "\u0085", "\r", "\u001b[2K"]) await refused({ code: `printf '{}' # ${hidden}x` }, /direction-changing/);
    await refused({ why: "Counts jobs \u202ein the queue" }, /direction-changing/);
    expect(h.db().prepare("SELECT COUNT(*) AS n FROM dashboards").get()).toEqual({ n: 0 }); // none of them stored anything
    expect((await save({ code: "printf '{}'\n\tprintf ''" })).error).toBe(false); // tabs and line breaks are fine
  });
});

test("the built bundle (dist/server.js, which npm test builds first) runs an approved script the same way", async () => {
  const { createPlugin: built } = (await import(/* @vite-ignore */ join(process.cwd(), "dist/server.js"))) as { createPlugin: typeof createPlugin };
  const dir = folder();
  const h = await startHost(async () => built({ secrets: memorySecrets(), toolPath: async () => TEST_PATH }), {}, { folder: dir });
  hosts.push(h);
  const { id } = await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(`sleep 30 & echo $! > child.pid; printf '{"rows":[7]}'`)] });
  expect(await h.run({ id, version: 1, source: "jobs", args: {} })).toMatchObject({ ok: false, error: expect.stringContaining("waiting for your approval") });
  const view = await h.rpc("scripts", { id });
  expect(await h.rpc("script_approve", { id, source: "jobs", hash: view.sources[0].hash })).toEqual({ ok: true });
  expect((await h.run({ id, version: 1, source: "jobs", args: {} })).data).toEqual({ rows: [7] });
  expect(await until(() => !alive(pidIn(dir, "child.pid")))).toBe(true); // its own process group, stopped with the script
  await expect(h.harness.behavior.callRpc("script_withdraw", { id, source: "jobs" }, { experimental_caller: { kind: "plugin", pluginId: "invented-other-plugin" } })).rejects.toThrow(/Another plugin/);
});

describe("only the user's side may call the plugin: another plugin is refused on every function, reads included", () => {
  const OTHER = { experimental_caller: { kind: "plugin" as const, pluginId: "invented-other-plugin" } };
  const REFUSED = "Another plugin (invented-other-plugin) cannot read or change this plugin's dashboards, scripts, secrets or connections.";

  /** A dashboard with a script that takes a secret, and a connection, then a snapshot of everything a gated method could change. */
  async function world() {
    const h = await host({ claudeConfig: join(root, "no-such-config.json") });
    const id = (await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(MARKED, { secrets: ["QUEUE_READ_TOKEN"] })] })).id!;
    const hash = (await h.rpc("scripts", { id })).sources[0].hash as string;
    const conn = (await h.rpc("connection_add", { name: "widget-shop", config: { kind: "http", url: "http://127.0.0.1:9/mcp", secretHeaders: [] } })).id as string;
    const tables = ["dashboards", "versions", "script_approvals", "script_secrets", "connections"];
    const snapshot = () => Object.fromEntries(tables.map((t) => [t, h.db().prepare(`SELECT * FROM ${t}`).all()]));
    return { h, id, hash, conn, snapshot };
  }

  type World = Awaited<ReturnType<typeof world>>;
  /** A valid input for every function, so a refusal is the gate's and not the input check's. A function missing here fails the test. */
  const INPUTS: Record<string, (w: World) => unknown> = {
    read: (w) => ({ id: w.id }),
    list: () => null,
    delete: (w) => ({ id: w.id }),
    restore: (w) => ({ id: w.id, version: 1 }),
    source_run: (w) => ({ id: w.id, version: 1, source: "jobs", args: {} }),
    scripts: (w) => ({ id: w.id }),
    script_approve: (w) => ({ id: w.id, source: "jobs", hash: w.hash }),
    script_withdraw: (w) => ({ id: w.id, source: "jobs" }),
    script_secret: (w) => ({ id: w.id, name: "QUEUE_READ_TOKEN", value: "invented-other-token" }),
    connections_list: () => null,
    connection_add: () => ({ name: "other-shop", config: { kind: "http", url: "http://127.0.0.1:9/mcp", secretHeaders: [] } }),
    connection_secret: (w) => ({ id: w.conn, slot: "token", value: "invented-other-token" }),
    connection_check: (w) => ({ id: w.conn }),
    connection_confirm: (w) => ({ id: w.conn, tools: [] }),
    connection_remove: (w) => ({ id: w.conn }),
    discover: () => ({ folder: null }),
    discover_import: () => ({ source: "user", folder: null, name: "anything" }),
  };

  test("every registered function refuses another plugin, runs nothing and changes nothing", async () => {
    const calls = watchRunners();
    const w = await world();
    await w.h.approve(w.id); // something to run and to withdraw
    await w.h.rpc("script_secret", { id: w.id, name: "QUEUE_READ_TOKEN", value: "invented-queue-token" });
    const methods = [...w.h.harness.registrations.rpcMethods].sort();
    expect(Object.keys(INPUTS).sort()).toEqual(methods); // driven by what is registered: a new function cannot be missed
    const before = w.snapshot();
    for (const method of methods) await expect(w.h.harness.behavior.callRpc(method, INPUTS[method]!(w), OTHER), method).rejects.toThrow(REFUSED);
    expect(w.snapshot()).toEqual(before);
    expect(calls).toEqual([]); // not even the approved script
    expect((await w.h.run({ id: w.id, version: 1, source: "jobs", args: {} })).ok).toBe(true); // the same input from a client runs it
  });

  test("a client caller (bb's app, and equally its command line or an agent) passes the gate", async () => {
    const w = await world();
    for (const method of ["list", "connections_list"]) await expect(w.h.harness.behavior.callRpc(method, null)).resolves.toBeTruthy();
    await expect(w.h.harness.behavior.callRpc("scripts", { id: w.id })).resolves.toMatchObject({ sources: [{ approved: false }] });
    expect(await w.h.rpc("script_approve", { id: w.id, source: "jobs", hash: w.hash })).toEqual({ ok: true }); // the SDK cannot tell who clicked
  });
});

describe("withdrawing an approval or deleting the dashboard stops a run in progress", () => {
  const SLOW = `printf '{"rows":[1]}'; echo $$ > script.pid; sleep 30 & echo $! > child.pid; wait`; // prints its JSON first, then waits

  test("withdrawn: the run and what it started stop at once; what it printed is neither data nor cached", async () => {
    const calls = watchRunners();
    const h = await host();
    const { id } = await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(SLOW)] });
    await h.approve(id!);
    const started = Date.now();
    const running = h.run({ id, version: 1, source: "jobs", args: {} });
    expect(await until(() => written(h.dir, "child.pid"))).toBe(true);
    expect(await h.rpc("script_withdraw", { id, source: "jobs" })).toEqual({ ok: true });
    expect(await running).toEqual({ ok: false, error: "The script was stopped with everything it started, because its approval was withdrawn." });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await until(() => !alive(pidIn(h.dir, "script.pid")) && !alive(pidIn(h.dir, "child.pid")))).toBe(true);
    expect(await h.run({ id, version: 1, source: "jobs", args: {} })).toMatchObject({ ok: false, error: expect.stringContaining("waiting for your approval") });

    // Approved again within the 30-second floor: nothing of the stopped run was kept, so it starts anew.
    await h.approve(id!);
    const again = h.run({ id, version: 1, source: "jobs", args: {} });
    expect(await until(() => calls.length === 2)).toBe(true);
    await h.rpc("script_withdraw", { id, source: "jobs" });
    expect((await again).ok).toBe(false);
  });

  test("deleted: its running script and what it started stop", async () => {
    const h = await host();
    const { id } = await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(SLOW)] });
    await h.approve(id!);
    const running = h.run({ id, version: 1, source: "jobs", args: {} });
    expect(await until(() => written(h.dir, "child.pid"))).toBe(true);
    expect(await h.rpc("delete", { id })).toEqual({ deleted: true });
    expect(await running).toEqual({ ok: false, error: "The script was stopped with everything it started, because its dashboard was deleted." });
    expect(await until(() => !alive(pidIn(h.dir, "script.pid")) && !alive(pidIn(h.dir, "child.pid")))).toBe(true);
  });
});

test("restoring approves nothing: a restored script runs only while exactly that script is approved now", async () => {
  const calls = watchRunners();
  const h = await host();
  const { id } = await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(MARKED)] });
  await h.approve(id!);
  await h.save({ id, sources: [script(`printf '{"rows":[3]}'`)] }); // version 2: another script, never approved
  // Version 1's script is the one approved: restored as version 3, it runs.
  expect(await h.rpc("restore", { id, version: 1 })).toEqual({ ok: true, version: 3 });
  expect((await h.run({ id, version: 3, source: "jobs", args: {} })).data).toEqual({ rows: [1, 2] });
  // Its approval withdrawn, version 1 restored again: still waiting for approval, and it does not run.
  await h.rpc("script_withdraw", { id, source: "jobs" });
  expect(await h.rpc("restore", { id, version: 1 })).toEqual({ ok: true, version: 4 });
  expect(await h.run({ id, version: 4, source: "jobs", args: { again: true } })).toMatchObject({ ok: false, error: expect.stringContaining("waiting for your approval") });
  expect(await h.rpc("scripts", { id })).toMatchObject({ latest: true, sources: [{ name: "jobs", approved: false }], approved: [] });
  expect(calls).toHaveLength(1);
});

test("the plugin's dispose stops a running script and what it started", async () => {
  const h = await host();
  const { id } = await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(`echo $$ > script.pid; sleep 30 & echo $! > child.pid; wait`)] });
  await h.approve(id!);
  const running = h.run({ id, version: 1, source: "jobs", args: {} });
  expect(await until(() => existsSync(join(h.dir, "child.pid")) && readFileSync(join(h.dir, "child.pid"), "utf8").trim() !== "")).toBe(true);
  await h.harness.lifecycle.dispose();
  hosts.splice(hosts.indexOf(h), 1);
  expect(await running).toEqual({ ok: false, error: "The script was stopped with everything it started, because the plugin stopped or reloaded." });
  expect(await until(() => !alive(pidIn(h.dir, "script.pid")) && !alive(pidIn(h.dir, "child.pid")))).toBe(true);
});

test("a source that is no longer a script loses its approval, so no old version runs it unseen", async () => {
  const h = await host();
  const { id } = await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(MARKED)] });
  await h.approve(id!);
  await h.save({ id, program: program(["jobs"]), sources: [{ name: "jobs", kind: "agent" }] });
  expect(h.db().prepare("SELECT COUNT(*) AS n FROM script_approvals").get()).toEqual({ n: 0 });
  expect(await h.run({ id, version: 1, source: "jobs", args: {} })).toMatchObject({ ok: false, error: expect.stringContaining("waiting for your approval") });
});

describe("script secrets", () => {
  test("set only for a declared name, write-only; removed when no longer declared, and with the dashboard", async () => {
    const secrets = memorySecrets();
    const h = await host({ secrets });
    const { id } = await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(MARKED, { secrets: ["QUEUE_READ_TOKEN", "QUEUE_REGION"] })] });
    expect(await h.rpc("script_secret", { id, name: "OTHER_TOKEN", value: "x1y2" })).toEqual({ ok: false, error: "No script of this dashboard's latest version takes OTHER_TOKEN." });
    await h.rpc("script_secret", { id, name: "QUEUE_READ_TOKEN", value: "invented-token-a" });
    await h.rpc("script_secret", { id, name: "QUEUE_REGION", value: "invented-region-b" });
    expect([...secrets.entries.keys()].sort()).toEqual([`dashboard.${id}.QUEUE_READ_TOKEN`, `dashboard.${id}.QUEUE_REGION`]);
    expect((await h.rpc("scripts", { id })).sources[0].secrets).toEqual([{ name: "QUEUE_READ_TOKEN", set: true }, { name: "QUEUE_REGION", set: true }]);

    await h.save({ id, sources: [script(MARKED, { secrets: ["QUEUE_READ_TOKEN"] })] }); // QUEUE_REGION is no longer declared
    expect([...secrets.entries.keys()]).toEqual([`dashboard.${id}.QUEUE_READ_TOKEN`]);
    await h.approve(id!);
    expect(await h.rpc("delete", { id })).toEqual({ deleted: true });
    expect(secrets.entries.size).toBe(0);
    expect(h.db().prepare("SELECT (SELECT COUNT(*) FROM script_secrets) + (SELECT COUNT(*) FROM script_approvals) AS n").get()).toEqual({ n: 0 });
  });

  test("changing a secret's value keeps the approval; the script gets the new value", async () => {
    const h = await host();
    const code = `printf '{"length":%s}' "$(printf %s "$QUEUE_READ_TOKEN" | wc -c | tr -d ' ')"`;
    const { id } = await h.save({ title: "Queue", program: program(["jobs"]), sources: [script(code, { secrets: ["QUEUE_READ_TOKEN"] })] });
    await h.approve(id!);
    await h.rpc("script_secret", { id, name: "QUEUE_READ_TOKEN", value: "abcd" });
    expect((await h.run({ id, version: 1, source: "jobs", args: {} })).data).toEqual({ length: 4 });
    await h.rpc("script_secret", { id, name: "QUEUE_READ_TOKEN", value: "abcdefgh" });
    expect((await h.rpc("scripts", { id })).sources[0].approved).toBe(true);
    expect((await h.run({ id, version: 1, source: "jobs", args: { again: 1 } })).data).toEqual({ length: 8 });
  });
});

describe("script secrets never leave", () => {
  const SERVICE = "bb-dashboards-test-script-cycle";
  afterAll(() => expect(clearTestService(SERVICE)).toBe(true)); // none remain, even after a failed test
  const SECRETS = ["invented-script-secret-one-8c2e", "invented-script-secret-two-4f7a"];
  const forms = (secret: string) => [secret, Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("hex")];

  test("set, approve, run, fail, read, edit and delete: the secrets appear in no RPC result, tool result, realtime payload, database row, log line, spawn argument or error shown", async () => {
    const seen: unknown[] = [];
    const real = childProcess.spawn.bind(childProcess);
    vi.spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], options: object) => (seen.push({ spawn: [command, ...args] }), real(command, args, options))) as never);
    // The real login Keychain on macOS (an invented test service), the test store elsewhere.
    const secrets = process.platform === "darwin" ? createSecretStore({ service: SERVICE }) : memorySecrets();
    const h = await host({ secrets });
    const rpc = async (method: string, input: unknown = null) => {
      const result = await h.rpc(method, input);
      seen.push({ rpc: method, result });
      return result;
    };
    const tool = async (name: string, input: unknown) => {
      const result = await h.call(name, input);
      seen.push({ tool: name, result });
      return result;
    };
    const dump = () => {
      const tables = (h.db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
      return Object.fromEntries(tables.map((t) => [t, h.db().prepare(`SELECT * FROM "${t}"`).all()]));
    };

    const uses = `printf '{"lengths":[%s,%s]}' "$(printf %s "$QUEUE_READ_TOKEN" | wc -c | tr -d ' ')" "$(printf %s "$QUEUE_REGION" | wc -c | tr -d ' ')"`;
    const leaks = `echo "token is $QUEUE_READ_TOKEN" >&2; exit 1`; // a careless script: its error output is redacted
    const sources = [script(uses, { secrets: ["QUEUE_READ_TOKEN", "QUEUE_REGION"] }), script(leaks, { name: "careless", secrets: ["QUEUE_READ_TOKEN"] })];
    const saved = await tool("dashboard_save", { title: "Queue", program: program(["jobs", "careless"]), sources });
    const id = saved.text.match(/dashboard ([0-9a-f]{12})/)![1];
    await rpc("script_secret", { id, name: "QUEUE_READ_TOKEN", value: SECRETS[0] });
    await rpc("script_secret", { id, name: "QUEUE_REGION", value: SECRETS[1] });
    const view = await rpc("scripts", { id });
    for (const s of view.sources) await rpc("script_approve", { id, source: s.name, hash: s.hash });
    const ran = await rpc("source_run", { id, version: 1, source: "jobs", args: {} });
    const careless = await rpc("source_run", { id, version: 1, source: "careless", args: {} });
    await tool("dashboard_get", { id });
    await tool("dashboard_sources", {});
    await tool("dashboard_sources", { kind: "script" });
    await rpc("scripts", { id });
    await rpc("read", { id });
    await rpc("list");
    seen.push({ database: dump() });

    await tool("dashboard_save", { id, sources: [sources[1]], program: program(["careless"]) }); // QUEUE_REGION is no longer declared
    const regionGone = (await secrets.get(`dashboard.${id}.QUEUE_REGION`)) === null;
    await rpc("delete", { id });
    seen.push({ database: dump(), realtime: h.harness.realtimeSignals, logs: h.harness.logEntries });

    const everything = JSON.stringify(seen);
    for (const secret of SECRETS) for (const form of forms(secret)) expect(everything).not.toContain(form);
    // The walk saw the whole cycle, and the secrets did their job.
    expect(ran.data).toEqual({ lengths: [SECRETS[0]!.length, SECRETS[1]!.length] });
    expect(careless).toEqual({ ok: false, error: "The script exited with code 1. Its last error output: token is [secret]" });
    expect(regionGone).toBe(true);
    expect(await secrets.get(`dashboard.${id}.QUEUE_READ_TOKEN`)).toBeNull(); // removed with the dashboard
    if (process.platform === "darwin") expect(spawnSync("/usr/bin/security", ["find-generic-password", "-s", SERVICE]).status).toBe(44);
  });
});
