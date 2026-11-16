// The agent's three tools: dashboard_save (create, replace or patch; sources; agent data), dashboard_get
// (guide, topics, signatures, current program) and dashboard_sources (what sources and connections exist;
// try one). None of them can add, change or remove a connection, and none shows a secret, a variable or
// an address. None of them can approve a script or run one: only the user approves, in the panel
// (server/scripts.ts). Their definitions are kept short because they stay in the agent's context once
// used; the guide lives in the plugin's skill and in dashboard_get, and configure (at the end) gives the
// tools and the skill to every thread.
import { randomBytes } from "node:crypto";
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { mergeStatements } from "@openuidev/lang-core";
import { z } from "zod";
import { DASHBOARD_DATA, DASHBOARD_SAVED, cardBlock } from "../shared";
import type { Connection, Connections } from "./connections";
import { GUIDE, SIGNATURES, SKILL_NAME, TOPICS } from "./generated";
import type { ScriptSource, Scripts } from "./scripts";
import { ARGS, KINDS, MAX_AGENT_BYTES, MAX_SOURCES, SCRIPT_MIN_REFRESH_SECONDS, SOURCES_HELP, runSource, sourceSchema, type Source } from "./sources";
import type { Dashboard, Origin, Store } from "./store";
import { themeSchema } from "./theme";
import { validateProgram } from "./validate";

export const MAX_PROGRAM = 100_000;
export const idSchema = z.string().regex(/^[0-9a-f]{12}$/, "a dashboard id: 12 characters, 0-9 and a-f");

/** Said by every tool's description: where the guide is when skills are and are not available. */
const SKILL_FIRST = `Load the ${SKILL_NAME} skill first (without skills: dashboard_get topic "guide").`;
export const TOOL_NAMES = ["dashboard_save", "dashboard_get", "dashboard_sources"];

/**
 * dashboard_save's input, checked first in execute: the same shapes and limits the tool always took. Only a
 * loose outline of it is advertised (SAVE_PARAMETERS); the details are in the guide's topics.
 */
export const saveInput = z.object({
  id: idSchema.optional(),
  title: z.string().trim().min(1).max(120).optional(),
  program: z.string().min(1).max(MAX_PROGRAM).optional(),
  patch: z.string().min(1).max(MAX_PROGRAM).optional(),
  theme: themeSchema.nullable().optional(),
  sources: z.array(sourceSchema).max(MAX_SOURCES).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
/** What the agent is shown of saveInput: a plain JSON schema, so the host passes the input through for saveInput to check. */
const SAVE_PARAMETERS = {
  type: "object",
  properties: {
    id: { type: "string", description: "Dashboard to change; omit to create" },
    title: { type: "string" },
    program: { type: "string", description: "Whole OpenUI Lang program" },
    patch: { type: "string", description: "Only new or changed statements" },
    theme: { anyOf: [{ type: "object" }, { type: "null" }], description: "Topic themes; null follows bb" },
    sources: { type: "array", items: { type: "object" }, description: "Topic live-data; [] removes all" },
    data: { type: "object", description: "Agent source results by name; with only id, no new version" },
  },
} satisfies { type: "object"; properties: Record<keyof z.infer<typeof saveInput>, unknown> };

/** Each problem as `path: message`, as bb's host words a refused tool argument, then the topic that has the shapes. */
function shapeProblems(error: z.ZodError, raw: unknown): string[] {
  const kindAt = (index: unknown) => {
    const sources = typeof raw === "object" && raw !== null ? (raw as { sources?: unknown }).sources : undefined;
    const source = Array.isArray(sources) && typeof index === "number" ? (sources[index] as unknown) : undefined;
    return typeof source === "object" && source !== null ? (source as { kind?: unknown }).kind : undefined;
  };
  const topicOf = ([field, index]: PropertyKey[]) => {
    if (field === "theme") return "themes";
    if (field === "sources") return kindAt(index) === "mcp" ? "mcp" : kindAt(index) === "script" ? "scripts" : "live-data";
    return field === "data" ? "live-data" : "guide";
  };
  const topics = [...new Set(error.issues.map((issue) => topicOf(issue.path)))].map((t) => `"${t}"`);
  return [
    ...error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(input)"}: ${issue.message}`),
    `The shapes are in dashboard_get with topic ${topics.join(" or ")}.`,
  ];
}

const fail = (problems: string[]): PluginAgentToolResult => ({
  content: [{ type: "text", text: `Not saved. Fix these and save again:\n${problems.map((p) => `- ${p}`).join("\n")}` }],
  isError: true,
});

async function originOf(sdk: BbPluginApi["sdk"], threadId: string): Promise<Origin> {
  try {
    const thread = await sdk.threads.get({ threadId, include: "environment" });
    const environment = "environment" in thread ? thread.environment : null;
    return { threadId, environmentId: environment?.id ?? thread.environmentId ?? null, hostId: environment?.hostId ?? null };
  } catch {
    return { threadId, environmentId: null, hostId: null }; // origin is recorded when known
  }
}

/** Every dashboard_sources answer is cut to this many characters, note included; the agent needs the shape, not every row. */
export const MAX_OUTPUT_CHARS = 6_000;

/** The text, or its start and a note that says it was cut and how to ask for less. */
export function capped(text: string, narrow: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const note = `\n… cut: ${text.length} characters in all, ${MAX_OUTPUT_CHARS} shown. ${narrow}`.trimEnd();
  return text.slice(0, MAX_OUTPUT_CHARS - note.length) + note;
}

/** Connections for the agent: name, kind and confirmed tools with description and input schema. Never a command, address, variable or secret. */
function describeConnections(list: Connection[]): string {
  if (list.length === 0) return "Connections: none. The user adds MCP connections on the plugin's Connections page; until then, use the other kinds.";
  const lines = list.map((c) => {
    const head = `- ${c.name} (${c.config.kind === "stdio" ? "local command" : "web server"})`;
    if (c.tools === null) return `${head}: its tools are not confirmed yet; the user confirms them on the Connections page.`;
    if (c.tools.length === 0) return `${head}: no confirmed tools.`;
    return `${head}, confirmed read-only tools:\n${c.tools.map((t) => `  - ${t.name}: ${t.description || "no description"} Input schema: ${JSON.stringify(t.inputSchema)}`).join("\n")}`;
  });
  return `Connections (MCP servers the user added; only these confirmed read-only tools can be called):\n${lines.join("\n")}`;
}

type ScriptState = Pick<Scripts, "isApproved">;

function describeSources(a: Dashboard, stored: Record<string, number>, scripts: ScriptState): string {
  if (a.sources.length === 0) return "Sources: none";
  const line = (s: Source) => {
    if (s.kind === "file") return `${s.name}: file ${s.path}${s.root === "storage" ? " (thread storage folder)" : ""}`;
    if (s.kind === "script") {
      const state = scripts.isApproved(a.id, s) ? "approved by the user" : "waiting for the user's approval in the panel";
      return `${s.name}: script (${s.runner}), ${state}${s.secrets?.length ? `; secret variables ${s.secrets.join(", ")}` : ""}. Why: ${s.why}\n  Code:\n\`\`\`\n${s.code}\n\`\`\``;
    }
    if (s.kind !== "agent") return `${s.name}: ${s.kind}`;
    const when = stored[s.name];
    return `${s.name}: agent${s.description ? `, ${s.description}` : ""}; ${when ? `data stored ${new Date(when).toISOString()}` : "no data stored yet"}`;
  };
  return `Sources:\n${a.sources.map((s) => `- ${line(s)}`).join("\n")}`;
}

const describe = (a: Dashboard, stored: Record<string, number>, scripts: ScriptState) =>
  `Dashboard ${a.id}: "${a.title}", version ${a.version}.\nTheme: ${a.theme ? JSON.stringify(a.theme) : "none (follows bb's theme)"}\n${describeSources(a, stored, scripts)}\n\n\`\`\`openui-lang\n${a.program}\n\`\`\``;

const isScript = (s: Source): s is ScriptSource => s.kind === "script";
/** Never approve: said after every save that declares a script source. */
export const NEVER_APPROVE =
  "You cannot approve a script and must never try, by any route: no tool, no parameter, not bb's command line, not the plugin's RPC or its database. Tell the user to read and approve it in the dashboard's panel.";

/** Said after a save with script sources: which wait for the user's approval, which carried theirs, and what cannot run. */
async function scriptNote(id: string, origin: Origin, sources: readonly Source[], scripts: Pick<Scripts, "isApproved" | "folder">): Promise<string> {
  const list = sources.filter(isScript);
  if (list.length === 0) return "";
  const quote = (l: ScriptSource[]) => l.map((s) => `"${s.name}"`).join(", ");
  const where = await scripts.folder(origin);
  const waiting = list.filter((s) => !scripts.isApproved(id, s));
  const approved = list.filter((s) => scripts.isApproved(id, s));
  const secrets = [...new Set(list.flatMap((s) => s.secrets ?? []))];
  const lines = [
    !where.ok && `Script sources ${quote(list)} will not run: ${where.error}`,
    where.ok && waiting.length > 0 && `Script sources ${quote(waiting)} will not run until the user reads and approves each in the dashboard's panel. Until then each shows "waiting for your approval" and the rest of the dashboard works.`,
    approved.length > 0 && `Script sources ${quote(approved)} keep the user's approval: runner, code and secret names are unchanged.`,
    secrets.length > 0 && `The user enters the values of ${secrets.join(", ")} in the panel; never put a secret in the code.`,
    NEVER_APPROVE,
  ];
  return `\n\n${lines.filter(Boolean).join(" ")}`;
}

/** Problems with data for agent sources, judged against the sources this save leaves in effect. */
function dataProblems(data: Record<string, unknown>, sources: readonly Source[]): string[] {
  return Object.entries(data).flatMap(([name, value]) => {
    const source = sources.find((s) => s.name === name);
    if (source === undefined) return [`data.${name}: "${name}" is not a declared source. Declare it in sources as {name: "${name}", kind: "agent"}.`];
    if (source.kind !== "agent") return [`data.${name}: "${name}" is a ${source.kind} source, which reads its own data; only agent sources take data.`];
    const bytes = Buffer.byteLength(JSON.stringify(value ?? null));
    return bytes > MAX_AGENT_BYTES ? [`data.${name} is ${Math.ceil(bytes / 1024)} KB; the limit is ${MAX_AGENT_BYTES / 1024} KB per source. Store fewer rows or fields.`] : [];
  });
}

function sourceProblems(sources: readonly Source[]): string[] {
  const names = sources.map((s) => s.name);
  const twice = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  return twice.length > 0 ? [`Source names must be unique; declared more than once: ${twice.join(", ")}.`] : [];
}

/** An mcp source must name a connection and one of its confirmed read-only tools. */
function mcpProblems(sources: readonly Source[], connections: Pick<Connections, "byName">): string[] {
  return sources.flatMap((s) => {
    if (s.kind !== "mcp") return [];
    const c = connections.byName(s.connection);
    if (c === null) return [`Source ${s.name}: there is no connection named "${s.connection}". dashboard_sources lists the connections.`];
    if (!(c.tools ?? []).some((t) => t.name === s.tool)) return [`Source ${s.name}: "${s.tool}" is not a confirmed read-only tool of "${s.connection}". dashboard_sources with connection: "${s.connection}" lists its tools.`];
    return [];
  });
}

/**
 * The save check on a whole result, for dashboard_save and the panel's restore alike. mcp declarations are
 * checked only when connections is given (sources given), so a later patch does not fail because a connection went away.
 */
export function saveProblems(program: string, sources: readonly Source[], data: Record<string, unknown>, connections: Pick<Connections, "byName"> | null): string[] {
  if (program.length > MAX_PROGRAM) return [`The program is ${program.length} characters; the limit is ${MAX_PROGRAM}.`];
  const floors = Object.fromEntries(sources.filter(isScript).map((s) => [s.name, SCRIPT_MIN_REFRESH_SECONDS]));
  const declaredNow = connections === null ? [] : mcpProblems(sources, connections);
  return [...sourceProblems(sources), ...declaredNow, ...validateProgram(program, sources.map((s) => s.name), floors), ...dataProblems(data, sources)];
}

/** After a new version is stored: the ping that moves open views forward, then approvals and script secrets cut to its scripts. */
export async function afterSave(bb: Pick<BbPluginApi, "realtime" | "log">, scripts: Pick<Scripts, "keepApprovals" | "prune">, id: string, version: number, sources: readonly Source[], created: boolean) {
  bb.realtime.publish(DASHBOARD_SAVED, { dashboardId: id, version });
  // A source that is no longer a script loses its approval; a secret no script names loses its value
  // (a failure to remove one leaves it for the next save or the dashboard's delete).
  scripts.keepApprovals(id, sources.filter(isScript).map((s) => s.name));
  const pruned = created ? { ok: true } : await scripts.prune(id, sources.filter(isScript).flatMap((s) => s.secrets ?? []));
  if (!pruned.ok) bb.log.warn(`dashboard ${id}: a script secret no longer declared could not be removed yet`);
}

/** Said after a save with agent sources while a connection has confirmed tools; nothing is guessed or switched. */
function connectionHint(sources: readonly Source[], connections: Pick<Connections, "list">): string {
  const agent = sources.filter((s) => s.kind === "agent").map((s) => `"${s.name}"`);
  const ready = connections.list().filter((c) => (c.tools?.length ?? 0) > 0).map((c) => c.name);
  if (agent.length === 0 || ready.length === 0) return "";
  return `\n\nThis dashboard has agent sources (${agent.join(", ")}), and the plugin holds connections with confirmed read-only tools (${ready.join(", ")}). If one of those tools serves that data, an mcp source would refresh without you: check with dashboard_sources before changing anything. Nothing was switched.`;
}

export function registerTools(bb: BbPluginApi, store: Store, connections: Pick<Connections, "list" | "byName" | "call">, scripts: Pick<Scripts, "isApproved" | "folder" | "prune" | "keepApprovals">) {
  bb.agents.registerTool({
    name: "dashboard_save",
    description: `Checks and saves an OpenUI Lang dashboard the user reopens in bb's side panel; returns the card block for your reply. Create: title and program. Change: id and a patch, program, title, theme or sources (each a new version). ${SKILL_FIRST}`,
    presentation: { label: { pending: "Saving dashboard", completed: "Saved dashboard" } },
    parameters: SAVE_PARAMETERS,
    async execute(raw, ctx) {
      const parsed = saveInput.safeParse(raw);
      if (!parsed.success) return fail(shapeProblems(parsed.error, raw));
      const input = parsed.data;
      if (input.id === undefined && (input.title === undefined || input.program === undefined || input.patch !== undefined)) {
        return fail(["To create a dashboard give title and program (a patch needs an id)."]);
      }
      if (input.id !== undefined && input.program !== undefined && input.patch !== undefined) {
        return fail(["To change a dashboard give its id and either program (replace) or patch, not both."]);
      }
      const changes = [input.program, input.patch, input.title, input.theme, input.sources].some((v) => v !== undefined);
      if (input.id !== undefined && !changes && input.data === undefined) {
        return fail(["To change a dashboard give its id and a program, patch, title, theme or sources; or its id and data alone to store agent results."]);
      }
      const current = input.id === undefined ? null : store.get(input.id);
      if (input.id !== undefined && current === null) return fail([`There is no dashboard ${input.id}. Leave id out to create a new one.`]);
      const now = Date.now();

      if (current !== null && !changes) {
        // Data alone: the agent's refresh of its sources. The program and its versions stay as they are.
        const problems = dataProblems(input.data!, current.sources);
        if (problems.length > 0) return fail(problems);
        store.storeData(current.id, input.data!, now);
        const names = Object.keys(input.data!);
        bb.realtime.publish(DASHBOARD_DATA, { dashboardId: current.id, sources: names });
        return `Stored data for ${names.join(", ")} in dashboard ${current.id}; still version ${current.version}, no new version. Open panels show it now; no card is needed.`;
      }

      const program = current !== null && input.patch !== undefined ? mergeStatements(current.program, input.patch) : (input.program ?? current!.program);
      const sources = input.sources ?? current?.sources ?? [];
      const problems = saveProblems(program, sources, input.data ?? {}, input.sources === undefined ? null : connections);
      if (problems.length > 0) return fail(problems);

      const title = input.title ?? current!.title;
      const theme = input.theme === undefined ? (current?.theme ?? null) : input.theme;
      const id = current?.id ?? randomBytes(6).toString("hex");
      const origin = current?.origin ?? (await originOf(bb.sdk, ctx.threadId));
      const version = current
        ? store.addVersion({ id, title, program, theme, sources, data: input.data, now })
        : store.create({ id, title, program, theme, sources, data: input.data, now, origin });
      await afterSave(bb, scripts, id, version, sources, current === null);
      if (input.data !== undefined) bb.realtime.publish(DASHBOARD_DATA, { dashboardId: id, sources: Object.keys(input.data) });
      const card = `Saved "${title}" as dashboard ${id}, version ${version}. Put this block in your reply exactly as written; it shows a card that opens the dashboard:\n\n${cardBlock(id)}`;
      return `${card}${connectionHint(sources, connections)}${await scriptNote(id, origin, sources, scripts)}`;
    },
  });

  bb.agents.registerTool({
    name: "dashboard_get",
    description: `No arguments: the dashboard authoring guide (the skill's text). topic: a detail topic the guide names. components: their signatures. id: a dashboard's current program, theme and sources, for editing. ${SKILL_FIRST}`,
    presentation: { label: { pending: "Reading dashboard docs", completed: "Read dashboard docs" }, suppress: true },
    parameters: z.object({
      topic: z.string().optional(),
      components: z.array(z.string().min(1).max(40)).min(1).max(20).optional(),
      id: idSchema.optional(),
    }),
    async execute({ id, components, topic }) {
      if (id === undefined && components === undefined && topic === undefined) return GUIDE;
      const parts: string[] = [];
      let isError = false;
      if (topic !== undefined) {
        const text = Object.hasOwn(TOPICS, topic) ? TOPICS[topic] : undefined;
        if (text === undefined) isError = true;
        parts.push(text ?? `Unknown topic "${topic}". Topics: ${Object.keys(TOPICS).join(", ")}.`);
      }
      if (id !== undefined) {
        const dashboard = store.get(id);
        if (dashboard === null) isError = true;
        parts.push(dashboard ? describe(dashboard, store.dataTimes(id), scripts) : `There is no dashboard ${id}.`);
      }
      if (components !== undefined) {
        const unknown = components.filter((name) => !(name in SIGNATURES));
        parts.push(...components.filter((name) => name in SIGNATURES).map((name) => SIGNATURES[name]!));
        if (unknown.length > 0) {
          isError = true;
          parts.push(`Unknown components: ${unknown.join(", ")}. Available: ${Object.keys(SIGNATURES).join(", ")}.`);
        }
      }
      return { content: [{ type: "text", text: parts.join("\n\n") }], isError };
    },
  });

  bb.agents.registerTool({
    name: "dashboard_sources",
    description: `No arguments: the source kinds a dashboard can declare, with samples, and the user's MCP connections with their read-only tools. kind (path for a file) or connection and tool: runs one once for this thread; connection alone: its tools. Cut at 6,000 characters. ${SKILL_FIRST}`,
    presentation: { label: { pending: "Reading dashboard sources", completed: "Read dashboard sources" } },
    parameters: z.object({
      kind: z.enum(KINDS).optional(),
      path: z.string().min(1).max(300).optional().describe("File path, relative"),
      root: z.enum(["environment", "storage"]).optional(),
      args: z.record(z.string(), z.unknown()).optional().describe("Query args, or the tool's"),
      connection: z.string().min(1).max(40).optional(),
      tool: z.string().min(1).max(128).optional(),
    }),
    async execute({ kind, path, root, args, connection, tool }, ctx) {
      const answer = (text: string, narrow: string, isError = false): PluginAgentToolResult => ({ content: [{ type: "text", text: capped(text, narrow) }], isError });
      const error = (text: string) => answer(text, "", true);
      const fewer = "Pass args that return less, such as a smaller limit or a filter. The panel gets the whole result.";

      if (connection !== undefined || tool !== undefined || kind === "mcp") {
        if (path !== undefined || root !== undefined) return error("path and root are for file sources.");
        if (connection === undefined) return tool === undefined && args === undefined ? answer(describeConnections(connections.list()), "Call with connection for one connection's tools.") : error("Give connection, a name from the list, with tool.");
        const found = connections.byName(connection);
        if (found === null) return error(`There is no connection named "${connection}". ${describeConnections(connections.list())}`);
        if (tool === undefined) return args === undefined ? answer(describeConnections([found]), "Call with tool to run one of them.") : error("Give tool with its args.");
        const result = await connections.call(connection, tool, args ?? {});
        return result.ok ? answer(JSON.stringify(result.data, null, 2) ?? "null", fewer) : error(`The tool did not run: ${result.error}`);
      }
      if (kind === undefined) {
        if (path !== undefined || root !== undefined || args !== undefined) return error("Give kind to try a source.");
        return answer(`${SOURCES_HELP}\n\n${describeConnections(connections.list())}`, "Call with kind for one kind, or with connection for one connection's tools.");
      }
      if (kind === "agent") return answer("An agent source holds what you store with dashboard_save data; there is nothing to run. Fetch the data with your own tools and look at it there.", "");
      if (kind === "script") {
        if (path !== undefined || root !== undefined || args !== undefined) return error("A script source is never run from here; declare it in dashboard_save's sources.");
        return answer(`${SOURCES_HELP.split("\n").find((l) => l.startsWith("- script"))}\ndashboard_sources never runs a script, and neither does dashboard_save: a script runs only from the panel, after the user approved it there. ${NEVER_APPROVE}`, "");
      }
      const declared = sourceSchema.safeParse({ name: "trial", kind, ...(path !== undefined && { path }), ...(root !== undefined && { root }) });
      if (!declared.success) return error(`Not a valid ${kind} source: ${z.prettifyError(declared.error)}`);
      const parsed = ARGS[kind].safeParse(args ?? {});
      if (!parsed.success) return error(`Wrong args for ${kind}: ${z.prettifyError(parsed.error)}`);
      const result = await runSource(bb.sdk, declared.data, parsed.data, ctx.threadId);
      return result.ok ? answer(JSON.stringify(result.data, null, 2) ?? "null", fewer) : error(`The ${kind} source failed: ${result.error}`);
    },
  });

  // Every thread, workers and plugin-run threads included: a dashboard made in a helper thread stays
  // refreshable and changeable from there. The same as having no configure; kept so the selection is explicit.
  bb.agents.configure(() => ({ tools: TOOL_NAMES, skills: [SKILL_NAME] }));
}
