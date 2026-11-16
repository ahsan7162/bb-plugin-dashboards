// Store, tools and RPC through bb's fake plugin host, run twice: from server.ts and from
// dist/server.js, the bundle `bb plugin build` wrote (npm test builds first).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { FOLDER, PROGRAM, startHost, type Factory } from "../test/host";
import { GUIDE, SIGNATURES, SKILL_NAME, TOPICS } from "./generated";
import { saveInput, TOOL_NAMES } from "./tools";

const BUNDLE = join(fileURLToPath(new URL("../", import.meta.url)), "dist/server.js");
// Characters of each advertised tool definition (name, description, parameter schema): 893, 568 and 943 when set.
const [CEILING_SAVE, CEILING_GET, CEILING_SOURCES, CEILING_TOTAL] = [1_000, 650, 1_000, 2_600];
const builds: [string, () => Promise<Factory>][] = [
  ["server.ts", async () => (await import("../server")).default],
  ["dist/server.js", async () => (await import(/* @vite-ignore */ BUNDLE)).default],
];

describe.each(builds)("%s", (_, load) => {
  test("create stores version 1 with its origin, publishes the ping and returns the card block", async () => {
    const { save, harness, db } = await startHost(load);
    const { text, id, error } = await save({ title: "Shop orders", program: PROGRAM });
    expect(error).toBe(false);
    expect(text).toContain(`version 1`);
    expect(text).toContain("```bb-dashboard\n" + id + "\n```");
    expect(harness.realtimeSignals).toEqual([{ channel: "dashboard-saved", payload: { dashboardId: id, version: 1 } }]);
    expect(db().prepare("SELECT title, thread_id, environment_id, host_id FROM dashboards").all()).toEqual([
      { title: "Shop orders", thread_id: "thread-1", environment_id: "env-1", host_id: "host-1" },
    ]);
    expect(db().prepare("SELECT number, sources, theme FROM versions").all()).toEqual([{ number: 1, sources: "[]", theme: null }]);
  });

  test("patch merges named statements, replace swaps the program; every save is a new version", async () => {
    const { save, harness } = await startHost(load);
    const { id } = await save({ title: "Shop orders", program: PROGRAM });
    const patched = await save({ id, patch: `main = Section("Orders this week", [Row([Card("Week", [KeyValues([KeyValue("Orders", 310, "number")])])])])` });
    expect(patched.text).toContain("version 2");
    const replaced = await save({ id, title: "Shop overview", program: `root = Dashboard([Section("Overview", [Kpis([Kpi("Visitors", 1280, "number")])])])` });
    expect(replaced.text).toContain(`Saved "Shop overview" as dashboard ${id}, version 3`);

    const read = (version?: number) => harness.behavior.callRpc("read", { id, version }) as Promise<{ dashboard: { program: string; version: number; title: string } | null }>;
    expect((await read(1)).dashboard!.program).toBe(PROGRAM);
    expect((await read(2)).dashboard!.program).toBe(`root = Dashboard([main])\nmain = Section("Orders this week", [Row([Card("Week", [KeyValues([KeyValue("Orders", 310, "number")])])])])`);
    expect((await read()).dashboard).toMatchObject({ version: 3, title: "Shop overview" });
    expect((await read(4)).dashboard).toBeNull();
    expect(harness.realtimeSignals.map((s) => s.payload)).toEqual([1, 2, 3].map((version) => ({ dashboardId: id, version })));
    expect(await harness.behavior.callRpc("list", null)).toEqual({ dashboards: [{ id, title: "Shop overview", version: 3, versions: 3, updatedAt: expect.any(Number), threadId: "thread-1" }] });
  });

  test("a failed save stores nothing, publishes nothing and lists the problems", async () => {
    const { save, harness, db } = await startHost(load);
    const bad = await save({ title: "Broken", program: `root = Dashboard([Section("x", [Row([Bars(["a"], [Series("s", [1])])])])])\nm = Mutation("delete_order", {})` });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/^Not saved\. Fix these and save again:\n- /);
    expect(bad.text).toContain("Bars cannot go in Row.items");
    expect(bad.text).toContain("Mutation at line 2");

    const { id } = await save({ title: "Shop orders", program: PROGRAM });
    const badPatch = await save({ id, patch: `extra = Query("orders", {}, {rows: []})\nroot = Dashboard([main, extra])` });
    expect(badPatch.error).toBe(true);
    expect(badPatch.text).toContain('"orders" is not a declared source. No sources are declared.');
    expect(db().prepare("SELECT COUNT(*) AS n FROM versions").get()).toEqual({ n: 1 });
    expect(db().prepare("SELECT COUNT(*) AS n FROM dashboards").get()).toEqual({ n: 1 });
    expect(harness.realtimeSignals).toHaveLength(1);
  });

  test("wrong argument combinations and unknown ids are refused", async () => {
    const { save } = await startHost(load);
    expect((await save({ program: PROGRAM })).text).toContain("give title and program");
    expect((await save({ title: "x", patch: PROGRAM })).text).toContain("give title and program");
    const { id } = await save({ title: "Shop orders", program: PROGRAM });
    expect((await save({ id, program: PROGRAM, patch: PROGRAM })).text).toContain("either program (replace) or patch, not both");
    expect((await save({ id })).text).toContain("give its id and a program, patch, title, theme or sources; or its id and data alone");
    expect((await save({ id: "0123456789ab", program: PROGRAM })).text).toContain("There is no dashboard 0123456789ab");
  });

  test("theme: stored when given, kept when left out, cleared by null; url() and a font outside the choices are refused", async () => {
    const { save, harness, call, db } = await startHost(load);
    const theme = { light: { accent: "#1f6f43", series1: "oklch(70% 0.1 150)" }, font: "serif" };
    const { id } = await save({ title: "Green shop", program: PROGRAM, theme });
    const read = async () => ((await harness.behavior.callRpc("read", { id })) as { dashboard: { theme: unknown } }).dashboard.theme;
    expect(await read()).toEqual(theme);
    await save({ id, patch: `main = Section("Orders", [])` });
    expect(await read()).toEqual(theme);
    await save({ id, program: PROGRAM, theme: null });
    expect(await read()).toBeNull();
    // Refused inside dashboard_save with the schema's own messages, and the topic that has the shapes.
    const refused = async (theme: unknown, message: RegExp) => {
      const { text, error } = await call("dashboard_save", { id, program: PROGRAM, theme });
      expect(error).toBe(true);
      expect(text).toMatch(/^Not saved\. Fix these and save again:\n- /);
      expect(text).toMatch(message);
      expect(text).toContain('The shapes are in dashboard_get with topic "themes".');
    };
    await refused({ light: { page: "url(https://example.com/x.png)" } }, /theme.light.page: .*no url\(\)/);
    await refused({ light: { notAToken: "#fff" } }, /Unrecognized key: "notAToken"/);
    await refused({ font: "Comic Sans MS, cursive" }, /theme.font: .*"sans"\|"serif"\|"mono"/);
    expect(db().prepare("SELECT COUNT(*) AS n FROM versions").get()).toEqual({ n: 3 }); // nothing stored by the refusals
    expect(await read()).toBeNull();
  });

  test("a wrong shape anywhere is refused with every problem, before the program is looked at", async () => {
    const { call, db } = await startHost(load);
    const { text, error } = await call("dashboard_save", { title: "", program: 42, sources: [{ name: "x", kind: "script", runner: "perl", code: "true", why: "w" }, { name: "y", kind: "teleport" }] });
    expect(error).toBe(true);
    expect(text).toContain("- title: ");
    expect(text).toContain("- program: ");
    expect(text).toContain("- sources.0.runner: ");
    expect(text).toContain("- sources.1.kind: ");
    expect(text).toContain('The shapes are in dashboard_get with topic "guide" or "scripts" or "live-data".');
    expect(db().prepare("SELECT COUNT(*) AS n FROM dashboards").get()).toEqual({ n: 0 });
  });

  test("dashboard_get: the guide, topics, component signatures, a dashboard's current program", async () => {
    const { save, call } = await startHost(load);
    expect(await call("dashboard_get", {})).toEqual({ text: GUIDE, error: false });
    expect(await call("dashboard_get", { topic: "guide" })).toEqual({ text: GUIDE, error: false });
    expect(await call("dashboard_get", { topic: "themes" })).toEqual({ text: TOPICS.themes, error: false });
    expect(await call("dashboard_get", { topic: "constructor" })).toEqual({ text: `Unknown topic "constructor". Topics: ${Object.keys(TOPICS).join(", ")}.`, error: true });
    const both = await call("dashboard_get", { topic: "trends", components: ["Donut"] });
    expect(both.text).toBe(`${TOPICS.trends}\n\n${SIGNATURES.Donut}`);
    const sigs = await call("dashboard_get", { components: ["Bars", "Table", "Nope"] });
    expect(sigs.text).toContain(SIGNATURES.Bars!);
    expect(sigs.text).toContain(SIGNATURES.Table!);
    expect(sigs.text).toContain("Unknown components: Nope.");
    expect(sigs.error).toBe(true);
    const { id } = await save({ title: "Shop orders", program: PROGRAM });
    const got = await call("dashboard_get", { id });
    expect(got.text).toBe(`Dashboard ${id}: "Shop orders", version 1.\nTheme: none (follows bb's theme)\nSources: none\n\n\`\`\`openui-lang\n${PROGRAM}\n\`\`\``);
    expect((await call("dashboard_get", { id: "0123456789ab" })).error).toBe(true);
  });

  // The plugin's old name for a dashboard, built from two halves so a search of the repository for it finds nothing.
  const OLD_NAME = new RegExp(["arti", "fact"].join(""), "i");
  test("nothing an agent or a person reads uses the old name for a dashboard: the skill, the guide, every topic, the tools and the manifest", async () => {
    const { harness } = await startHost(load);
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const texts = {
      skill: `${SKILL_NAME}\n${read(`../skills/${SKILL_NAME}/SKILL.md`)}`,
      guide: GUIDE,
      ...Object.fromEntries(Object.entries(TOPICS).map(([name, text]) => [`topic ${name}`, text])),
      tools: JSON.stringify(harness.registrations.agentTools), // names, descriptions, parameter schemas, labels
      manifest: read("../package.json"),
    };
    for (const [where, text] of Object.entries(texts)) expect(text, where).not.toMatch(OLD_NAME);
  });

  test("three tools, no always-on instructions, and short definitions that point to the skill", async () => {
    const { harness } = await startHost(load);
    const tools = harness.registrations.agentTools;
    expect(tools.map((t) => t.name).sort()).toEqual(["dashboard_get", "dashboard_save", "dashboard_sources"]);
    expect(tools.map((t) => t.instructions)).toEqual([null, null, null]);
    expect(harness.registrations.instructionProvider).toBeNull();
    // What a provider is sent for each tool: name, description and parameter schema. Ceilings set from the
    // slimmed definitions (milestone 5 sent 7,244, 646 and 1,461 characters).
    const size = (t: (typeof tools)[number]) => t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
    const ceilings: Record<string, number> = { dashboard_save: CEILING_SAVE, dashboard_get: CEILING_GET, dashboard_sources: CEILING_SOURCES };
    for (const t of tools) expect(size(t), t.name).toBeLessThanOrEqual(ceilings[t.name]!);
    expect(tools.reduce((n, t) => n + size(t), 0)).toBeLessThanOrEqual(CEILING_TOTAL);
    for (const t of tools) expect(t.description).toContain(`Load the ${SKILL_NAME} skill first (without skills: dashboard_get topic "guide").`);
    // dashboard_save advertises every field it checks, and no other.
    const save = tools.find((t) => t.name === "dashboard_save")!;
    expect(Object.keys((save.inputSchema as { properties: object }).properties).sort()).toEqual(Object.keys(saveInput.shape).sort());
    expect(harness.registrations.rpcMethods.sort()).toEqual([
      "connection_add", "connection_check", "connection_confirm", "connection_remove", "connection_secret", "connections_list",
      "delete", "discover", "discover_import", "list", "read", "restore", "script_approve", "script_secret", "script_withdraw", "scripts", "source_run",
    ]);
    expect(harness.registrations.cli).toBeNull();
  });

  test("configure: the tools and the skill for every thread, workers and plugin-run threads included", async () => {
    const { harness } = await startHost(load);
    const context = (thread: Partial<PluginAgentConfigurationContext["thread"]>, origin: PluginAgentConfigurationContext["origin"], pluginMetadata = {}) =>
      ({
        pluginMetadata,
        thread: { id: "thread-2", title: null, parentThreadId: null, sourceThreadId: null, ...thread },
        project: { id: "project-1", kind: "standard", name: "Corner shop", gitRemoteUrl: null },
        environment: { id: "env-1", name: null, path: FOLDER, branchName: null, workspaceProvisionType: null },
        host: { id: "host-1", name: "This machine" },
        provider: { id: "claude-code", model: "a-model", capabilities: { supportsNativeUserQuestion: false } },
        origin,
      }) as PluginAgentConfigurationContext;
    const resolve = async (c: PluginAgentConfigurationContext) => {
      const { tools, skills, instructions } = await harness.behavior.resolveAgentConfiguration(c);
      return { tools: tools.map((t: { name: string }) => t.name), skills, instructions };
    };
    const all = { tools: TOOL_NAMES, skills: [SKILL_NAME], instructions: null };
    const person = { kind: null, pluginId: null };
    expect(await resolve(context({}, person))).toEqual(all); // a thread a person started
    expect(await resolve(context({ sourceThreadId: "thread-1" }, { kind: "fork", pluginId: null }))).toEqual(all); // a person's fork
    expect(await resolve(context({ sourceThreadId: "thread-1" }, { kind: "fork", pluginId: "side-chat" }))).toEqual(all); // a side chat
    expect(await resolve(context({ parentThreadId: "thread-1" }, person))).toEqual(all); // an agent's worker thread
    expect(await resolve(context({}, { kind: null, pluginId: "invented-workflows" }))).toEqual(all); // a thread another plugin runs
    expect(await resolve(context({ parentThreadId: "thread-1" }, { kind: "fork", pluginId: "invented-workflows" }, { audience: "agent" }))).toEqual(all); // any metadata
    expect(harness.logEntries.filter((e: { level: string }) => e.level === "warn")).toEqual([]); // the skill name is known: nothing failed closed
  });

  test("saving, reading and live data make no network call (lang-core's telemetry is off unless opted in)", async () => {
    expect(process.env.OPENUI_RUNTIME_TELEMETRY_ENABLED).toBeUndefined();
    // Recorded, never sent, and left in place for the rest of the file: a late send must not leave the machine.
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
    fetch.mockClear();
    const random = vi.spyOn(Math, "random").mockReturnValue(0); // the telemetry samples 1 in 10 parses: make every one count
    try {
      const { save, call, run, harness } = await startHost(load, { [`${FOLDER}/data/orders.json`]: '{"rows": [{"id": "A-1001"}]}', [`${FOLDER}/data/orders.csv`]: "id\nA-1001\n" });
      const sources = [{ name: "orders", kind: "file", path: "data/orders.json" }, { name: "pr", kind: "pull_request" }, { name: "incidents", kind: "agent" }];
      const live = `root = Dashboard([main])\norders = Query("orders", {}, {rows: []}, 30)\nmain = Section("Orders", [Kpis([Kpi("Orders", @Count(orders.rows), "number")])])`;
      harness.sdk.stub("plugins.callRpc", (async () => ({ "env-1": { outcome: "absent" } })) as never);
      for (let i = 0; i < 10; i++) {
        const { id } = await save({ title: `Shop ${i}`, program: PROGRAM });
        await save({ id, patch: `main = Section("Orders", [])` });
        await call("dashboard_get", { id });
        await harness.behavior.callRpc("read", { id });
        await harness.behavior.callRpc("read", { id, version: 1 });
        const { id: liveId } = await save({ title: `Live ${i}`, program: live, sources, data: { incidents: [] } });
        await save({ id: liveId, data: { incidents: [{ id: "INC-31" }] } });
        for (const source of ["orders", "pr", "incidents"]) expect((await run({ id: liveId, version: 1, source, args: {} })).ok).toBe(true);
        await call("dashboard_sources", { kind: "file", path: "data/orders.csv" });
      }
      await call("dashboard_sources", {});
      await call("dashboard_sources", { kind: "pull_request" });
      await harness.behavior.callRpc("list", null);
      await call("dashboard_get", {});
      await new Promise((resolve) => setTimeout(resolve, 1000)); // a send first waits on a git lookup and an import
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });
});
