// The plugin's MCP connections end to end, against the invented stdio server (test/fixtures/mcp-server.mjs)
// and an invented HTTP MCP server on localhost inside the test: listing with paging, the confirmed-list
// and still-read-only rules, refusals that never reach the server, time limits, lazy open and idle
// close, the exact environment, the bearer token read from the secure store, mcp sources through
// source_run, and dashboard_sources. No request leaves the machine.
import childProcess, { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { createPlugin, type PluginOptions } from "../server";
import { FIXTURE, TEST_PATH, clearTestService, memorySecrets, startHost } from "../test/host";
import { encryptedOrLocal } from "./connections";
import { createSecretStore, type SecretStore } from "./secrets";
import { MAX_OUTPUT_CHARS } from "./tools";

const dir = mkdtempSync(join(tmpdir(), "oa-mcp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let made = 0;
const tempFile = (name: string) => join(dir, `${made++}-${name}`);

const TOKEN = "invented-widget-token-7f3a9c";
const ALL_READ_ONLY = ["count_widgets", "list_orders", "shop_motto", "big_report", "slow_report"];
type Logged = { event: "start"; pid: number; env: string[]; argv: string[] } | { event: "call"; name: string; args: Record<string, unknown> };
const readLog = (path: string): Logged[] => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Logged) : []);
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

type Host = Awaited<ReturnType<typeof startHost>>;
const hosts: Host[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hosts.splice(0).map((h) => h.harness.lifecycle.dispose())); // closes every server the test started
});

async function host(options: PluginOptions = {}) {
  // Never the default store: that would be the plugin's real service in the login Keychain.
  const secrets = options.secrets ?? memorySecrets();
  const started = await startHost(async () => createPlugin({ ...options, secrets, toolPath: async () => TEST_PATH, timeouts: { connectMs: 5000, listMs: 3000, callMs: 3000, ...options.timeouts } }));
  hosts.push(started);
  return started;
}

/** A host with the fixture added as "widget-shop" (its token set), and its tools confirmed when asked. */
async function shop(options: { env?: Record<string, string>; timeouts?: PluginOptions["timeouts"]; secrets?: SecretStore; confirm?: string[] } = {}) {
  const log = tempFile("log.jsonl");
  const h = await host({ secrets: options.secrets, timeouts: options.timeouts });
  const config = { kind: "stdio", command: process.execPath, args: [FIXTURE], env: { FIXTURE_LOG: log, FIXTURE_PAGE: "2", ...options.env }, secretEnv: ["WIDGET_TOKEN"] };
  const added = await h.rpc("connection_add", { name: "widget-shop", config, secrets: { "env.WIDGET_TOKEN": TOKEN } });
  expect(added).toEqual({ ok: true, id: expect.stringMatching(/^[0-9a-f]{12}$/) });
  if (options.confirm) expect((await h.rpc("connection_confirm", { id: added.id, tools: options.confirm })).ok).toBe(true);
  const entries = () => readLog(log);
  return {
    ...h,
    id: added.id as string,
    entries,
    calls: () => entries().flatMap((e) => (e.event === "call" ? [e] : [])),
    starts: () => entries().flatMap((e) => (e.event === "start" ? [e] : [])),
    tryTool: (tool: string, args: Record<string, unknown> = {}) => h.call("dashboard_sources", { connection: "widget-shop", tool, args }),
  };
}

describe("a connection's tools", () => {
  test("every page is listed; only read-only tools are offered; only what the user confirms is saved", async () => {
    const s = await shop();
    expect(await s.rpc("connection_check", { id: s.id })).toEqual({
      ok: true,
      readOnly: ALL_READ_ONLY.map((name) => ({ name, description: expect.any(String) })), // 7 tools over 4 pages of 2
      others: 2,
      confirmed: [],
    });
    for (const write of ["delete_widget", "restock_widgets", "no_such_tool"]) {
      expect(await s.rpc("connection_confirm", { id: s.id, tools: ["count_widgets", write] })).toEqual({ ok: false, error: `Not confirmed: "widget-shop" does not offer ${write} as read-only.` });
    }
    expect(s.db().prepare("SELECT tools FROM connections").get()).toEqual({ tools: null });
    expect(await s.rpc("connection_confirm", { id: s.id, tools: ["list_orders", "count_widgets"] })).toEqual({ ok: true, tools: ["count_widgets", "list_orders"] });
    const { connections } = await s.rpc("connections_list");
    expect(connections[0]).toMatchObject({ name: "widget-shop", kind: "stdio", tools: ["count_widgets", "list_orders"], secrets: [{ slot: "env.WIDGET_TOKEN", label: "WIDGET_TOKEN", required: true, set: true }] });
    expect(s.calls()).toEqual([]); // listing calls no tool
  });

  test("a call goes out only for a confirmed tool the server still marks read-only; a refused call never reaches the server", async () => {
    const flip = tempFile("flip");
    const s = await shop({ env: { FIXTURE_FLIP: flip }, confirm: ["count_widgets", "list_orders"] });
    const first = await s.tryTool("count_widgets", { colour: "teal" });
    expect(first.error).toBe(false);
    expect(JSON.parse(first.text)).toEqual({ colour: "teal", count: 42, tokenSet: true });

    expect((await s.tryTool("shop_motto")).text).toBe('The tool did not run: "shop_motto" is not a confirmed read-only tool of "widget-shop", so it is not called. The user confirms tools on the plugin\'s Connections page.');
    for (const tool of ["restock_widgets", "delete_widget", "no_such_tool"]) expect(await s.tryTool(tool)).toEqual({ text: expect.stringContaining("is not a confirmed read-only tool"), error: true });

    writeFileSync(flip, ""); // the server now marks count_widgets as a write tool
    expect((await s.tryTool("count_widgets", { colour: "red" })).text).toBe(
      'The tool did not run: "widget-shop" no longer marks "count_widgets" read-only, so it was not called. Confirm its tools again on the Connections page.',
    );
    expect(await s.rpc("connection_confirm", { id: s.id, tools: ["count_widgets"] })).toMatchObject({ ok: false });
    expect(s.calls()).toEqual([{ event: "call", name: "count_widgets", args: { colour: "teal" } }]);

    unlinkSync(flip); // marked read-only again: checked at every call, so it runs again
    expect((await s.tryTool("count_widgets", { colour: "red" })).error).toBe(false);
    expect(s.calls().map((c) => c.name)).toEqual(["count_widgets", "count_widgets"]);
  });

  test("a tool the server adds later is not callable until the user confirms it", async () => {
    const s = await shop({ confirm: ["count_widgets"] });
    expect((await s.tryTool("list_orders")).error).toBe(true);
    expect((await s.rpc("connection_check", { id: s.id })).confirmed).toEqual(["count_widgets"]);
    await s.rpc("connection_confirm", { id: s.id, tools: ["count_widgets", "list_orders"] });
    expect(JSON.parse((await s.tryTool("list_orders", { status: "open" })).text)).toEqual({
      rows: [
        { id: "W-101", customer: "Corner Bakery", status: "open", widgets: 12 },
        { id: "W-103", customer: "Hilltop Florist", status: "open", widgets: 30 },
      ],
    });
    expect(s.calls().map((c) => c.name)).toEqual(["list_orders"]);
  });
});

test("the built bundle (dist/server.js, which npm test builds first) does the same: list, confirm, call, refuse", async () => {
  const { createPlugin: built } = (await import(/* @vite-ignore */ join(process.cwd(), "dist/server.js"))) as { createPlugin: typeof createPlugin };
  const log = tempFile("log.jsonl");
  const h = await startHost(async () => built({ secrets: memorySecrets(), toolPath: async () => TEST_PATH }));
  hosts.push(h);
  const { id } = await h.rpc("connection_add", { name: "widget-shop", config: { kind: "stdio", command: process.execPath, args: [FIXTURE], env: { FIXTURE_LOG: log, FIXTURE_PAGE: "2" }, secretEnv: [] } });
  expect((await h.rpc("connection_check", { id })).readOnly.map((t: { name: string }) => t.name)).toEqual(ALL_READ_ONLY);
  await h.rpc("connection_confirm", { id, tools: ["count_widgets"] });
  expect(JSON.parse((await h.call("dashboard_sources", { connection: "widget-shop", tool: "count_widgets", args: { colour: "teal" } })).text).count).toBe(42);
  expect((await h.call("dashboard_sources", { connection: "widget-shop", tool: "delete_widget" })).error).toBe(true);
  expect(readLog(log).flatMap((e) => (e.event === "call" ? [e.name] : []))).toEqual(["count_widgets"]);
});

describe("time limits and lifecycle", () => {
  test("a server that never answers fails with a clear error within the time limit, and is stopped", async () => {
    const real = childProcess.spawn.bind(childProcess);
    const children: childProcess.ChildProcess[] = [];
    vi.spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], options: object) => {
      const child = real(command, args, options);
      children.push(child);
      return child;
    }) as never);
    const s = await shop({ env: { FIXTURE_HANG: "1" }, timeouts: { connectMs: 400 } });
    const started = Date.now();
    expect(await s.rpc("connection_check", { id: s.id })).toEqual({ ok: false, error: '"widget-shop" did not answer in time.' });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(children).toHaveLength(1);
    expect(await until(() => children[0]!.exitCode !== null || children[0]!.signalCode !== null)).toBe(true); // stopped, not left running
  });

  test("a call that hangs ends in an error within the time limit; the next call starts a fresh server", async () => {
    const s = await shop({ confirm: ["slow_report", "count_widgets"], timeouts: { callMs: 300 } });
    const started = Date.now();
    expect((await s.tryTool("slow_report", { ms: 5000 })).text).toBe('The tool did not run: "widget-shop" did not answer in time.');
    expect(Date.now() - started).toBeLessThan(3000);
    expect((await s.tryTool("count_widgets", { colour: "teal" })).error).toBe(false);
    expect(s.starts()).toHaveLength(2);
    expect(await until(() => !alive(s.starts()[0]!.pid))).toBe(true);
  });

  test("opened on first use, reused, closed when idle and on dispose", async () => {
    const s = await shop({ timeouts: { idleMs: 300 } });
    expect(s.starts()).toEqual([]); // adding starts nothing
    await s.rpc("connection_confirm", { id: s.id, tools: ["count_widgets"] });
    await s.tryTool("count_widgets", { colour: "teal" });
    await s.tryTool("count_widgets", { colour: "red" });
    expect(s.starts()).toHaveLength(1); // one server for all three
    expect(await until(() => !alive(s.starts()[0]!.pid))).toBe(true); // idle: closed

    await s.tryTool("count_widgets", { colour: "teal" });
    const second = s.starts()[1]!;
    expect(alive(second.pid)).toBe(true);
    await s.harness.lifecycle.dispose();
    expect(await until(() => !alive(second.pid))).toBe(true);
  });

  test("a command that is not there, a server that exits at once and a missing secret are clear errors", async () => {
    const h = await host();
    const add = async (name: string, command: string, args: string[], secretEnv: string[] = []) =>
      (await h.rpc("connection_add", { name, config: { kind: "stdio", command, args, env: {}, secretEnv } })).id as string;
    expect(await h.rpc("connection_check", { id: await add("missing", "/nonexistent/widget-server", []) })).toEqual({ ok: false, error: '"missing" could not start: the command was not found.' });
    expect(await h.rpc("connection_check", { id: await add("quitter", process.execPath, ["-e", "process.exit(3)"]) })).toEqual({
      ok: false,
      error: '"quitter" closed the connection. Check its command, arguments and variables.',
    });
    expect(await h.rpc("connection_check", { id: await add("unset", process.execPath, [FIXTURE], ["WIDGET_TOKEN"]) })).toEqual({
      ok: false,
      error: 'WIDGET_TOKEN of "unset" is not set. Set it on the Connections page.',
    });
  });

  test("the server gets PATH and the connection's own variables, nothing else, and no secret in its arguments", async () => {
    const real = childProcess.spawn.bind(childProcess);
    const spawns: { command: string; args: readonly string[]; env: Record<string, string> }[] = [];
    vi.spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], options: { env: Record<string, string> }) => {
      spawns.push({ command, args, env: options.env });
      return real(command, args, options);
    }) as never);
    const s = await shop();
    await s.rpc("connection_check", { id: s.id });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.command).toBe(process.execPath);
    expect(spawns[0]!.args).toEqual([FIXTURE]);
    expect(spawns[0]!.env).toEqual({ PATH: TEST_PATH, FIXTURE_LOG: expect.any(String), FIXTURE_PAGE: "2", WIDGET_TOKEN: TOKEN });
    // What the server itself saw: the same, plus the one name macOS adds to every process.
    const seen = s.starts()[0]!;
    expect(seen.argv).toEqual([]);
    expect(seen.env.filter((name) => name !== "__CF_USER_TEXT_ENCODING")).toEqual(["FIXTURE_LOG", "FIXTURE_PAGE", "PATH", "WIDGET_TOKEN"]);
  });
});

/** An invented MCP server over streamable HTTP on localhost: JSON answers, one read-only tool, 401 without the right token. */
async function notesServer(token: string) {
  const requests: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    requests.push(req.headers);
    if (req.method !== "POST") return void res.writeHead(405).end(); // no server-sent event stream
    if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401, { "content-type": "application/json" }).end('{"error":"invalid_token"}');
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (message.id === undefined) return void res.writeHead(202).end();
      const results: Record<string, unknown> = {
        initialize: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "invented-notes", version: "0.0.1" } },
        "tools/list": { tools: [{ name: "list_notes", description: "Lists the shop's notes.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] },
        "tools/call": { content: [{ type: "text", text: '{"notes":["Order more teal widgets"]}' }] },
      };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: results[message.method] ?? {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: `${origin}/mcp`, origin, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe("a web server's address: https, or plain http only on this machine", () => {
  test.each([
    ["https://notes.example.com/mcp", true],
    ["http://localhost:8123/mcp", true],
    ["http://LOCALHOST/mcp", true],
    ["http://127.0.0.1:9/mcp", true],
    ["http://127.31.2.200/mcp", true],
    ["http://0x7f000001/mcp", true], // the URL parser reads it as 127.0.0.1
    ["http://[::1]:8123/mcp", true],
    ["http://notes.example.com/mcp", false],
    ["http://localhost.example.com/mcp", false],
    ["http://127.0.0.1.example.com/mcp", false],
    ["http://127.0.0.1%2eexample.com/mcp", false],
    ["http://localhost@example.com/mcp", false],
    ["http://example.com#@localhost", false],
    ["http://notes.localhost/mcp", false],
    ["http://localhost./mcp", false],
    ["http://[::ffff:127.0.0.1]/mcp", false],
    ["http://10.0.0.7/mcp", false],
    ["ftp://localhost/mcp", false],
    ["not an address", false],
  ])("%s: %s", (url, allowed) => expect(encryptedOrLocal(url)).toBe(allowed));

  test("adding one with plain http to another machine is refused with the reason, and nothing is kept; this machine's is added", async () => {
    const secrets = memorySecrets();
    const h = await host({ secrets });
    const add = (url: string) => h.rpc("connection_add", { name: "notes", config: { kind: "http", url, secretHeaders: [] }, secrets: { token: TOKEN } });
    expect(await add("http://notes.example.com/mcp")).toEqual({
      ok: false,
      error: "The address must start with https://. Plain http:// is accepted only for this machine (localhost, 127.0.0.1 or [::1]): to another machine, the token would travel unencrypted.",
    });
    expect(h.db().prepare("SELECT COUNT(*) AS n FROM connections").get()).toEqual({ n: 0 });
    expect(secrets.entries.size).toBe(0);
    expect(await add("http://localhost:8123/mcp")).toMatchObject({ ok: true });
  });

  test("one stored with plain http to another machine (before this check) is refused at use: its token is not read and nothing is sent", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
    const secrets = memorySecrets();
    const h = await host({ secrets });
    const id = "0123456789ab";
    h.db()
      .prepare("INSERT INTO connections (id, name, config, secrets, tools, created_at, updated_at) VALUES (?, 'notes', ?, '[\"token\"]', ?, 0, 0)")
      .run(id, JSON.stringify({ kind: "http", url: "http://notes.example.com/mcp", secretHeaders: [] }), JSON.stringify([{ name: "list_notes", description: "Lists notes.", inputSchema: { type: "object" } }]));
    await secrets.set(`${id}.token`, TOKEN);
    const get = vi.spyOn(secrets, "get");
    const refused = '"notes" has a plain http address on another machine, where its token would travel unencrypted, so it was not contacted. Remove it and add it again with an https address.';

    expect(await h.rpc("connection_check", { id })).toEqual({ ok: false, error: refused });
    expect(await h.call("dashboard_sources", { connection: "notes", tool: "list_notes" })).toEqual({ text: `The tool did not run: ${refused}`, error: true });
    const program = `root = Dashboard([main])\nnotes = Query("notes", {}, {notes: []})\nmain = Section("Notes", [Kpis([Kpi("Notes", @Count(notes.notes), "number")])])`;
    const saved = await h.save({ title: "Notes", program, sources: [{ name: "notes", kind: "mcp", connection: "notes", tool: "list_notes" }] });
    expect(await h.run({ id: saved.id, version: 1, source: "notes", args: {} })).toEqual({ ok: false, error: refused });
    expect(get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("a web server", () => {
  const SERVICE = "bb-dashboards-test-connections";
  afterAll(() => expect(clearTestService(SERVICE)).toBe(true)); // none remain, even after a failed test

  test("the token is read from the secure store and sent as a bearer header; a secret header too; nothing leaves the machine", async () => {
    const notes = await notesServer(TOKEN);
    const fetches: string[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => (fetches.push(String(input instanceof Request ? input.url : input)), realFetch(input, init)));
    // The real login Keychain on macOS (an invented test service), the test store elsewhere.
    const secrets = process.platform === "darwin" ? createSecretStore({ service: SERVICE }) : memorySecrets();
    const get = vi.spyOn(secrets, "get");
    try {
      const h = await host({ secrets });
      const added = await h.rpc("connection_add", { name: "notes", config: { kind: "http", url: notes.url, secretHeaders: ["X-Shop-Key"] }, secrets: { token: TOKEN, "header.X-Shop-Key": "invented-shop-key" } });
      expect(await h.rpc("connection_check", { id: added.id })).toEqual({ ok: true, readOnly: [{ name: "list_notes", description: "Lists the shop's notes." }], others: 0, confirmed: [] });
      expect(get.mock.calls.map(([account]) => account).sort()).toEqual([`${added.id}.header.X-Shop-Key`, `${added.id}.token`]);
      expect(notes.requests.filter((r) => r.authorization !== undefined).every((r) => r.authorization === `Bearer ${TOKEN}` && r["x-shop-key"] === "invented-shop-key")).toBe(true);
      await h.rpc("connection_confirm", { id: added.id, tools: ["list_notes"] });
      expect(JSON.parse((await h.call("dashboard_sources", { connection: "notes", tool: "list_notes" })).text)).toEqual({ notes: ["Order more teal widgets"] });

      expect(await h.rpc("connection_secret", { id: added.id, slot: "token", value: null })).toEqual({ ok: true });
      expect(await h.rpc("connection_check", { id: added.id })).toEqual({
        ok: false,
        error: '"notes" asks for sign-in (HTTP 401). Browser sign-in is not supported; if the server takes a token, set it on the Connections page.',
      });
      expect(await h.rpc("connection_remove", { id: added.id })).toEqual({ ok: true });
      expect(await secrets.get(`${added.id}.header.X-Shop-Key`)).toBeNull();
      expect(fetches.length).toBeGreaterThan(0);
      expect(fetches.every((url) => url.startsWith(`${notes.origin}/`))).toBe(true);
    } finally {
      await notes.close();
    }
  });
});

describe("mcp sources", () => {
  const program = (names: string[]) =>
    `root = Dashboard([main])\n${names.map((n) => `${n} = Query("${n}", {}, {rows: []})`).join("\n")}\nmain = Section("Shop", [Kpis([${names.map((n) => `Kpi("${n}", @Count(${n}.rows), "number")`).join(", ")}])])`;
  const SOURCES = [
    { name: "stock", kind: "mcp", connection: "widget-shop", tool: "count_widgets", args: { colour: "red" }, overridable: ["colour"] },
    { name: "orders", kind: "mcp", connection: "widget-shop", tool: "list_orders", args: { status: "open" } },
    { name: "motto", kind: "mcp", connection: "widget-shop", tool: "shop_motto" },
    { name: "big", kind: "mcp", connection: "widget-shop", tool: "big_report", args: { kb: 1100 } },
  ];

  test("source_run runs the declared tool with its fixed args; a Query may set only overridable names; results are capped", async () => {
    const s = await shop({ confirm: ["count_widgets", "list_orders", "shop_motto", "big_report"] });
    const saved = await s.save({ title: "Widget shop", program: program(SOURCES.map((x) => x.name)), sources: SOURCES });
    expect(saved.error, saved.text).toBe(false);
    const run = (source: string, args: Record<string, unknown> = {}) => s.run({ id: saved.id, version: 1, source, args });

    const stock = await run("stock");
    expect(stock).toEqual({ ok: true, data: { colour: "red", count: 7, tokenSet: true }, fetchedAt: expect.any(Number) });
    expect((await run("stock", { colour: "teal" })).data).toEqual({ colour: "teal", count: 42, tokenSet: true });
    expect(await run("stock")).toEqual(stock); // within the floor: the cache answers
    expect(await run("orders", { status: "packed" })).toEqual({ ok: false, error: 'Wrong arguments for "orders" (mcp): status cannot be set by the Query; none can.' });
    expect(await run("stock", { colour: "teal", limit: 3 })).toEqual({ ok: false, error: 'Wrong arguments for "stock" (mcp): limit cannot be set by the Query; only colour can.' });
    expect((await run("orders")).data).toEqual({ rows: [expect.objectContaining({ id: "W-101" }), expect.objectContaining({ id: "W-103" })] }); // structured content
    expect((await run("motto")).data).toBe("Every widget, every colour."); // plain text
    expect(await run("big")).toEqual({ ok: false, error: '"big_report" returned more than 1 MB. Ask it for less: fewer rows or fields.' });
    expect(s.calls().map((c) => [c.name, c.args])).toEqual([
      ["count_widgets", { colour: "red" }],
      ["count_widgets", { colour: "teal" }],
      ["list_orders", { status: "open" }],
      ["shop_motto", {}],
      ["big_report", { kb: 1100 }],
    ]);
    // The browser learns each source's name and kind, not its connection, tool or args.
    expect((await s.rpc("read", { id: saved.id })).dashboard.sources).toEqual(SOURCES.map(({ name }) => ({ name, kind: "mcp" })));
  });

  test("a version keeps working only while its tool is confirmed: refused at run time once it is not", async () => {
    const s = await shop({ confirm: ["count_widgets"] });
    const saved = await s.save({ title: "Stock", program: program(["stock"]), sources: [SOURCES[0]] });
    await s.rpc("connection_confirm", { id: s.id, tools: [] });
    expect((await s.run({ id: saved.id, version: 1, source: "stock", args: {} })).error).toContain('"count_widgets" is not a confirmed read-only tool of "widget-shop"');
    expect(s.calls()).toEqual([]);
  });

  test("saving an mcp source needs the connection and a confirmed tool; agent sources get a note, and nothing is switched", async () => {
    const s = await shop({ confirm: ["count_widgets"] });
    const unconfirmed = await s.save({ title: "x", program: program(["motto"]), sources: [SOURCES[2]] });
    expect(unconfirmed.text).toContain('Source motto: "shop_motto" is not a confirmed read-only tool of "widget-shop". dashboard_sources with connection: "widget-shop" lists its tools.');
    const unknown = await s.save({ title: "x", program: program(["stock"]), sources: [{ ...SOURCES[0], connection: "other-shop" }] });
    expect(unknown.text).toContain('Source stock: there is no connection named "other-shop".');

    const agent = await s.save({ title: "Incidents", program: program(["incidents"]), sources: [{ name: "incidents", kind: "agent" }] });
    expect(agent.error).toBe(false);
    expect(agent.text).toMatch(/```\n\nThis dashboard has agent sources \("incidents"\), and the plugin holds connections with confirmed read-only tools \(widget-shop\)\. .* Nothing was switched\.$/);
    expect(JSON.parse((s.db().prepare("SELECT sources FROM versions WHERE dashboard_id = ?").get(agent.id) as { sources: string }).sources)).toEqual([{ name: "incidents", kind: "agent" }]);

    const none = await host();
    expect((await none.save({ title: "Incidents", program: program(["incidents"]), sources: [{ name: "incidents", kind: "agent" }] })).text).not.toContain("connections");
  });
});

describe("dashboard_sources and connections", () => {
  test("lists connections and their confirmed tools with schemas; never a command, address, variable or secret", async () => {
    const s = await shop({ confirm: ["count_widgets"] });
    await s.rpc("connection_add", { name: "notes", config: { kind: "http", url: "http://127.0.0.1:9/mcp", secretHeaders: [] }, secrets: { token: "invented-notes-token" } });
    const list = await s.call("dashboard_sources", {});
    expect(list.text).toContain('- mcp (refreshes itself). Declare: {name: "stock", kind: "mcp", connection: "widget-shop"');
    expect(list.text).toContain(
      '- widget-shop (local command), confirmed read-only tools:\n  - count_widgets: Counts the widgets of one colour in stock. Input schema: {"type":"object","properties":{"colour":{"type":"string"}},"required":["colour"]}',
    );
    expect(list.text).toContain("- notes (web server): its tools are not confirmed yet; the user confirms them on the Connections page.");
    const one = await s.call("dashboard_sources", { connection: "widget-shop" });
    expect(one.text).not.toContain("notes");
    for (const text of [list.text, one.text]) for (const hidden of [FIXTURE, process.execPath, "FIXTURE_LOG", "WIDGET_TOKEN", TOKEN, "127.0.0.1", "invented-notes-token"]) expect(text).not.toContain(hidden);

    expect(await s.call("dashboard_sources", { connection: "nope" })).toEqual({ text: expect.stringContaining('There is no connection named "nope".'), error: true });
    expect(await s.call("dashboard_sources", { tool: "count_widgets" })).toEqual({ text: "Give connection, a name from the list, with tool.", error: true });
    expect(await s.call("dashboard_sources", { kind: "mcp" })).toEqual({ text: expect.stringContaining("- widget-shop (local command)"), error: false });
    expect(s.calls()).toEqual([]);
  });

  test("every form of its answer is cut at 6,000 characters and says how to narrow the call", async () => {
    const s = await shop({ confirm: ["big_report"] });
    const tools = [
      { name: "big_report", description: "A report.", inputSchema: { type: "object" } },
      ...Array.from({ length: 40 }, (_, i) => ({ name: `invented_tool_${i}`, description: "Reads widgets. ".repeat(20), inputSchema: { type: "object", properties: { colour: { type: "string" } } } })),
    ];
    s.db().prepare("UPDATE connections SET tools = ?").run(JSON.stringify(tools));
    for (let i = 0; i < 60; i++) await s.rpc("connection_add", { name: `invented-shop-${i}`, config: { kind: "http", url: "http://127.0.0.1:9/mcp", secretHeaders: [] } });

    const forms = [
      [await s.call("dashboard_sources", {}), "Call with kind for one kind, or with connection for one connection's tools."],
      [await s.call("dashboard_sources", { kind: "mcp" }), "Call with connection for one connection's tools."],
      [await s.call("dashboard_sources", { connection: "widget-shop" }), "Call with tool to run one of them."],
      [await s.tryTool("big_report", { kb: 20 }), "Pass args that return less, such as a smaller limit or a filter. The panel gets the whole result."],
      [await s.call("dashboard_sources", { connection: "nope" }), ""],
    ] as const;
    for (const [answer, narrow] of forms) {
      expect(answer.text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
      expect(answer.text).toMatch(new RegExp(`\\n… cut: \\d+ characters in all, 6000 shown\\.${narrow ? ` ${narrow.replace(/[.,']/g, "\\$&")}` : ""}$`));
    }
  });
});

describe("secrets never leave", () => {
  const SERVICE = "bb-dashboards-test-cycle";
  afterAll(() => expect(clearTestService(SERVICE)).toBe(true)); // none remain, even after a failed test
  const SECRETS = ["invented-cycle-secret-one-5b1e", "invented-cycle-secret-two-9d4c", "invented-cycle-secret-three-2a7f", "invented-cycle-token-four-6e0d"];
  /** A secret as is, in base64 (how it travels to the store) and in hex. */
  const forms = (secret: string) => [secret, Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("hex")];

  test("a full add, confirm, run, import and remove cycle: the invented secrets appear in no RPC result, tool result, realtime payload, database row, log line or spawn argument", async () => {
    const seen: unknown[] = [];
    const real = childProcess.spawn.bind(childProcess);
    vi.spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], options: object) => (seen.push({ spawn: [command, ...args] }), real(command, args, options))) as never);
    // The real login Keychain on macOS (an invented test service), the test store elsewhere.
    const secrets = process.platform === "darwin" ? createSecretStore({ service: SERVICE }) : memorySecrets();
    const claudeConfig = tempFile("claude.json");
    writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { "imported-shop": { command: process.execPath, args: [FIXTURE], env: { WIDGET_TOKEN: SECRETS[2] } } } }));
    const notes = await notesServer(SECRETS[3]!);
    try {
      const h = await host({ secrets, claudeConfig });
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

      const log = tempFile("log.jsonl");
      const shopConfig = { kind: "stdio", command: process.execPath, args: [FIXTURE], env: { FIXTURE_LOG: log }, secretEnv: ["WIDGET_TOKEN"] };
      const shop = await rpc("connection_add", { name: "widget-shop", config: shopConfig, secrets: { "env.WIDGET_TOKEN": SECRETS[0] } });
      await rpc("connections_list");
      await rpc("connection_secret", { id: shop.id, slot: "env.WIDGET_TOKEN", value: SECRETS[1] });
      await rpc("connection_check", { id: shop.id });
      await rpc("connection_confirm", { id: shop.id, tools: ["count_widgets"] });
      const web = await rpc("connection_add", { name: "notes", config: { kind: "http", url: notes.url, secretHeaders: [] }, secrets: { token: SECRETS[3] } });
      await rpc("connection_check", { id: web.id });
      await rpc("connection_confirm", { id: web.id, tools: ["list_notes"] });
      await rpc("discover", { folder: null });
      const imported = await rpc("discover_import", { source: "user", folder: null, name: "imported-shop" });
      await rpc("connection_check", { id: imported.id });
      await rpc("connections_list");

      const sources = [
        { name: "stock", kind: "mcp", connection: "widget-shop", tool: "count_widgets", args: { colour: "teal" } },
        { name: "notes", kind: "mcp", connection: "notes", tool: "list_notes" },
        { name: "incidents", kind: "agent" },
      ];
      const program = `root = Dashboard([main])\nstock = Query("stock", {}, {count: 0})\nnotes = Query("notes", {}, {notes: []})\nincidents = Query("incidents", {}, {rows: []})\nmain = Section("Shop", [Kpis([Kpi("Teal", stock.count, "number"), Kpi("Notes", @Count(notes.notes), "number"), Kpi("Incidents", @Count(incidents.rows), "number")])])`;
      const saved = await tool("dashboard_save", { title: "Widget shop", program, sources });
      const id = saved.text.match(/dashboard ([0-9a-f]{12})/)![1];
      const stock = await rpc("source_run", { id, version: 1, source: "stock", args: {} });
      await rpc("source_run", { id, version: 1, source: "notes", args: {} });
      await tool("dashboard_sources", {});
      await tool("dashboard_sources", { connection: "widget-shop", tool: "count_widgets", args: { colour: "red" } });
      await tool("dashboard_sources", { connection: "notes" });
      await tool("dashboard_get", { id });
      await rpc("read", { id });
      await rpc("list");
      seen.push({ database: dump() });

      for (const c of [shop, web, imported]) expect(await rpc("connection_remove", { id: c.id })).toEqual({ ok: true });
      await rpc("connections_list");
      seen.push({ database: dump(), realtime: h.harness.realtimeSignals, logs: h.harness.logEntries, fixtureLog: readFileSync(log, "utf8") });

      const everything = JSON.stringify(seen);
      for (const secret of SECRETS) for (const form of forms(secret)) expect(everything).not.toContain(form);
      // The walk saw the whole cycle, and the secrets did their job: the servers got them.
      expect(seen.filter((s) => "rpc" in (s as object))).toHaveLength(20);
      expect(stock.data).toEqual({ colour: "teal", count: 42, tokenSet: true });
      expect(notes.requests.some((r) => r.authorization === `Bearer ${SECRETS[3]}`)).toBe(true);
      if (process.platform === "darwin") expect(spawnSync("/usr/bin/security", ["find-generic-password", "-s", SERVICE]).status).toBe(44); // removed with their connections
    } finally {
      await notes.close();
    }
  });
});
