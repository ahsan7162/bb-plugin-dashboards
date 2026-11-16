// bb-plugin-dashboards backend: agents save dashboards written in OpenUI Lang (server/tools.ts),
// stored with their newest versions in the plugin's SQLite database (server/store.ts); the browser reads them
// over RPC and redraws on the realtime ping each save publishes. Live data reaches the browser only
// through source_run (server/run.ts), which runs a source the dashboard version declared. The plugin's
// own MCP connections (server/connections.ts) are managed from the Connections page; their secrets go
// from the page straight to the OS secure store and are never sent back. Script sources (server/scripts.ts)
// run only after the user approved them in the panel.
// Every method refuses another plugin as its caller, reads included. The SDK reports bb's app, its
// command line and agents alike as "client", so those cannot be told apart and are all accepted:
// an agent allowed to run shell commands could call these too (the panel and the guide say so).
import { homedir } from "node:os";
import path from "node:path";
import {
  defineRpcContract,
  experimental_PluginRpcRefusal,
  type BbPluginApi,
  type ExperimentalPluginRpcHandlerContext,
  type ExperimentalPluginRpcHandlersWithContext,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { configSchema, connectionName, createConnections, slotsOf, type Connection, type Timeouts } from "./server/connections";
import { discover, draftFor } from "./server/discover";
import { hostPath } from "./server/mcp";
import { createSourceRun } from "./server/run";
import { createSecretStore, MAX_SECRET_BYTES, type SecretStore } from "./server/secrets";
import { createScripts, scriptHash, type ScriptSource } from "./server/scripts";
import { KINDS, secretName, type Source } from "./server/sources";
import { openStore } from "./server/store";
import { themeSchema } from "./server/theme";
import { afterSave, idSchema, registerTools, saveProblems } from "./server/tools";

/** source_run's args: a Query's evaluated args object, small. */
const MAX_ARGS_JSON = 1_000;

const dashboardSchema = z.object({
  id: z.string(),
  title: z.string(),
  version: z.number(),
  program: z.string(),
  theme: themeSchema.nullable(),
  /** Declared sources, name and kind only: the browser never sees a path. */
  sources: z.array(z.object({ name: z.string(), kind: z.enum(KINDS) })),
  createdAt: z.number(),
  updatedAt: z.number(),
});
/** A dashboard as the browser receives it. */
export type Dashboard = z.infer<typeof dashboardSchema>;

const connectionId = z.string().regex(/^[0-9a-f]{12}$/, "a connection id");
const slot = z.string().regex(/^(token|env\.[A-Za-z_][A-Za-z0-9_]{0,63}|header\.[A-Za-z0-9-]{1,64})$/, "a secret slot");
const secretValue = z.string().min(1).max(MAX_SECRET_BYTES);
const folder = z.string().min(1).max(1000).refine((f) => path.isAbsolute(f) && !f.includes("\0"), "an absolute folder path").nullable();
const failure = z.object({ ok: z.literal(false), error: z.string() });
const done = z.union([z.object({ ok: z.literal(true) }), failure]);

/** A connection as the page sees it: settings it may show, and for each secret only whether it is set. */
const connectionView = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["stdio", "http"]),
  target: z.string(),
  variables: z.array(z.object({ name: z.string(), value: z.string() })),
  secrets: z.array(z.object({ slot: z.string(), label: z.string(), required: z.boolean(), set: z.boolean() })),
  tools: z.array(z.string()).nullable(),
});
export type ConnectionView = z.infer<typeof connectionView>;

const secretStates = z.array(z.object({ name: z.string(), set: z.boolean() }));
/** A script source as the panel's approval dialog shows it. previous: the approved text it no longer matches, if any. */
const scriptView = z.object({
  name: z.string(),
  runner: z.string(),
  code: z.string(),
  why: z.string(),
  secrets: secretStates,
  hash: z.string(),
  approved: z.boolean(),
  previous: z.object({ runner: z.string(), code: z.string(), secrets: z.array(z.string()) }).nullable(),
});
const scriptsView = z.object({
  /** Why scripts cannot run for this dashboard (then approval is never offered), or null. */
  blocked: z.string().nullable(),
  /** The folder its scripts run in. */
  folder: z.string().nullable(),
  /** Whether the version asked for is the latest; approval is offered only there. */
  latest: z.boolean(),
  sources: z.array(scriptView),
  /** Every approval of the dashboard, for the "runs a script" badge. */
  approved: z.array(z.object({ source: z.string(), runner: z.string(), code: z.string(), secrets: secretStates, approvedAt: z.number() })),
});
export type ScriptsView = z.infer<typeof scriptsView>;
const isScript = (s: Source): s is ScriptSource => s.kind === "script";
const view = (c: Connection): ConnectionView => ({
  id: c.id,
  name: c.name,
  kind: c.config.kind,
  target: c.config.kind === "stdio" ? [c.config.command, ...c.config.args].join(" ") : c.config.url,
  variables: c.config.kind === "stdio" ? Object.entries(c.config.env).map(([name, value]) => ({ name, value })) : [],
  secrets: slotsOf(c.config).map((s) => ({ ...s, set: c.secretsSet.includes(s.slot) })),
  tools: c.tools?.map((t) => t.name) ?? null,
});

export const rpcContract = defineRpcContract({
  /** The latest version, or the given one (null when there is no such dashboard or version), and every kept version, newest first. */
  read: {
    input: z.object({ id: idSchema, version: z.number().int().positive().optional() }).strict(),
    output: z.object({ dashboard: dashboardSchema.nullable(), versions: z.array(z.object({ version: z.number(), createdAt: z.number() })) }),
  },
  /** Every dashboard, last changed first; version is the latest, versions how many are kept. threadId is the thread it was made in. */
  list: {
    input: z.null(),
    output: z.object({
      dashboards: z.array(z.object({ id: z.string(), title: z.string(), version: z.number(), versions: z.number(), updatedAt: z.number(), threadId: z.string().nullable() })),
    }),
  },
  /** Removes the dashboard and its versions from the plugin's database, and its script secrets from the secure store; stops its running scripts. */
  delete: {
    input: z.object({ id: idSchema }).strict(),
    output: z.object({ deleted: z.boolean() }),
  },
  /** Saves an old version's program, theme and sources as a new latest version, through the save check. It approves nothing. */
  restore: {
    input: z.object({ id: idSchema, version: z.number().int().positive() }).strict(),
    output: z.union([z.object({ ok: z.literal(true), version: z.number() }), failure]),
  },
  /** Runs one declared source of one dashboard version for its origin thread; failures are values. */
  source_run: {
    input: z
      .object({
        id: idSchema,
        version: z.number().int().positive(),
        source: z.string().min(1).max(40),
        args: z.record(z.string(), z.unknown()).refine((args) => JSON.stringify(args).length <= MAX_ARGS_JSON, `at most ${MAX_ARGS_JSON} characters of arguments`),
      })
      .strict(),
    output: z.union([z.object({ ok: z.literal(true), data: z.unknown(), fetchedAt: z.number() }), z.object({ ok: z.literal(false), error: z.string() })]),
  },
  /** The script sources of one version (the latest by default), whether each is approved, and the dashboard's approvals. */
  scripts: {
    input: z.object({ id: idSchema, version: z.number().int().positive().optional() }).strict(),
    output: scriptsView,
  },
  /** The user's approval of one script source of the latest version, for the hash they read; refused when the script changed since. */
  script_approve: {
    input: z.object({ id: idSchema, source: z.string().min(1).max(40), hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    output: done,
  },
  /** Withdraws the approval of one script source. */
  script_withdraw: {
    input: z.object({ id: idSchema, source: z.string().min(1).max(40) }).strict(),
    output: done,
  },
  /** Sets (or with null removes) one script secret of the dashboard; write-only, never read back. */
  script_secret: {
    input: z.object({ id: idSchema, name: secretName, value: secretValue.nullable() }).strict(),
    output: done,
  },
  /** The plugin's connections, and whether this machine's secure store works. */
  connections_list: {
    input: z.null(),
    output: z.object({ store: z.object({ label: z.string(), unavailable: z.string().nullable() }), connections: z.array(connectionView) }),
  },
  /** Adds a connection; secrets given go straight to the secure store. Its tools are confirmed next. */
  connection_add: {
    input: z.object({ name: connectionName, config: configSchema, secrets: z.record(slot, secretValue).optional() }).strict(),
    output: z.union([z.object({ ok: z.literal(true), id: z.string() }), failure]),
  },
  /** Sets (or with null removes) one secret; write-only, it is never read back. */
  connection_secret: {
    input: z.object({ id: connectionId, slot, value: secretValue.nullable() }).strict(),
    output: done,
  },
  /** Lists the server's tools now: the read-only ones, and how many others there are (never callable). */
  connection_check: {
    input: z.object({ id: connectionId }).strict(),
    output: z.union([
      z.object({ ok: z.literal(true), readOnly: z.array(z.object({ name: z.string(), description: z.string() })), others: z.number(), confirmed: z.array(z.string()) }),
      failure,
    ]),
  },
  /** Saves the read-only tools the user confirmed; each must still be offered as read-only. */
  connection_confirm: {
    input: z.object({ id: connectionId, tools: z.array(z.string().min(1).max(128)).max(200) }).strict(),
    output: z.union([z.object({ ok: z.literal(true), tools: z.array(z.string()) }), failure]),
  },
  /** Removes a connection and its secrets. */
  connection_remove: {
    input: z.object({ id: connectionId }).strict(),
    output: done,
  },
  /** Reads Claude Code's user config and, given a folder, its .mcp.json; names and kinds only. */
  discover: {
    input: z.object({ folder }).strict(),
    output: z.object({
      servers: z.array(z.object({ source: z.enum(["user", "project"]), name: z.string(), kind: z.string(), importable: z.boolean(), reason: z.string().nullable() })),
      notes: z.array(z.string()),
    }),
  },
  /** Imports one server found by discover as a connection; its secret values go straight to the secure store. */
  discover_import: {
    input: z.object({ source: z.enum(["user", "project"]), folder, name: z.string().min(1).max(200) }).strict(),
    output: z.union([z.object({ ok: z.literal(true), id: z.string() }), failure]),
  },
});

/** For tests: an invented secure-store service, fixture config files, a fixed PATH, short time limits, another platform. */
export type PluginOptions = { secrets?: SecretStore; claudeConfig?: string; toolPath?: () => Promise<string>; timeouts?: Partial<Timeouts>; platform?: NodeJS.Platform; scriptTimeoutMs?: number };

const refuse = (code: "forbidden" | "conflict", message: string) => new experimental_PluginRpcRefusal({ code, message });
/**
 * Every method, reads included: another plugin is refused, since a read can run an approved script or a
 * confirmed MCP tool. bb's app, its command line and agents all arrive as "client" and pass.
 */
function userOnly(handlers: PluginRpcHandlers<typeof rpcContract>): ExperimentalPluginRpcHandlersWithContext<typeof rpcContract> {
  const gated = Object.entries(handlers).map(([method, handler]) => [
    method,
    (input: unknown, { experimental_caller: caller }: ExperimentalPluginRpcHandlerContext) => {
      if (caller.kind === "plugin") throw refuse("forbidden", `Another plugin (${caller.pluginId}) cannot read or change this plugin's dashboards, scripts, secrets or connections.`);
      return (handler as (input: unknown) => unknown)(input);
    },
  ]);
  return Object.fromEntries(gated) as ExperimentalPluginRpcHandlersWithContext<typeof rpcContract>;
}
const succeeded = { ok: true as const };
const failed = (error: string) => ({ ok: false as const, error });

export function createPlugin(options: PluginOptions = {}) {
  return function plugin(bb: BbPluginApi) {
    const store = openStore(bb);
    // Nothing here touches the secure store or any config file until a request needs it.
    const secrets = options.secrets ?? createSecretStore();
    const connections = createConnections({ db: store.db, secrets, toolPath: options.toolPath ?? hostPath, timeouts: options.timeouts });
    /** A script source of the latest version, or why there is none. */
    const latestScript = (id: string, source: string) => {
      const dashboard = store.get(id);
      const script = dashboard?.sources.filter(isScript).find((s) => s.name === source);
      return dashboard && script ? { dashboard, script } : null;
    };
    const toolPath = options.toolPath ?? hostPath;
    const scripts = createScripts({ db: store.db, sdk: bb.sdk, secrets, toolPath, platform: options.platform, timeoutMs: options.scriptTimeoutMs });
    bb.onDispose(() => {
      scripts.stopAll(); // a running script and what it started do not outlive the plugin
      return connections.closeAll();
    });
    registerTools(bb, store, connections, scripts);
    const sourceRun = createSourceRun(bb, store, connections, scripts);
    const userConfig = options.claudeConfig ?? path.join(homedir(), ".claude.json");
    const projectConfig = (dir: string | null) => (dir === null ? null : path.join(dir, ".mcp.json"));
    bb.rpc.register(rpcContract, userOnly({
      read({ id, version }) {
        const dashboard = store.get(id, version);
        const versions = store.versions(id);
        if (dashboard === null) return { dashboard: null, versions };
        const { sources, origin: _origin, ...shown } = dashboard; // the panel needs no origin
        return { dashboard: { ...shown, sources: sources.map(({ name, kind }) => ({ name, kind })) }, versions };
      },
      list: () => ({ dashboards: store.list() }),
      async delete({ id }) {
        const removed = await scripts.prune(id, []); // its script secrets' values first, while their names are still known
        if (!removed.ok) throw refuse("conflict", `${removed.error} The dashboard is kept so that its script secrets can be removed later.`);
        scripts.stopRuns(id); // its approvals go with it, and so does a run in progress
        return { deleted: store.delete(id) };
      },
      // The old version's sources are declared again, so its mcp sources are checked as a save that gives sources.
      // Approvals stay tied to a script's hash: a restored script runs only if exactly that text is approved now.
      async restore({ id, version }) {
        const old = store.get(id, version);
        const current = store.get(id);
        if (old === null || current === null) return failed(`There is no version ${version} of this dashboard.`);
        const problems = saveProblems(old.program, old.sources, {}, connections);
        if (problems.length > 0) return failed(`Version ${version} cannot be restored: it no longer passes the save check. ${problems.join(" ")}`);
        const restored = store.addVersion({ id, title: current.title, program: old.program, theme: old.theme, sources: old.sources, now: Date.now() });
        await afterSave(bb, scripts, id, restored, old.sources, false);
        return { ok: true as const, version: restored };
      },
      source_run: (input) => sourceRun(input),
      async scripts({ id, version }) {
        const dashboard = store.get(id, version);
        const latest = store.get(id);
        if (dashboard === null || latest === null) return { blocked: null, folder: null, latest: false, sources: [], approved: [] };
        const list = dashboard.sources.filter(isScript);
        const approvals = scripts.approvals(id);
        const set = scripts.secretsSet(id);
        const where = list.length > 0 || approvals.length > 0 ? await scripts.folder(dashboard.origin) : null;
        const states = (names: string[]) => names.map((name) => ({ name, set: set.includes(name) }));
        return {
          blocked: where !== null && !where.ok ? where.error : null,
          folder: where?.ok ? where.path : null,
          latest: dashboard.version === latest.version,
          sources: list.map((s) => {
            const approval = scripts.approval(id, s.name);
            const hash = scriptHash(s);
            const approved = approval?.hash === hash;
            const previous = approval !== null && !approved ? { runner: approval.runner, code: approval.code, secrets: approval.secrets } : null;
            return { name: s.name, runner: s.runner, code: s.code, why: s.why, secrets: states(s.secrets ?? []), hash, approved, previous };
          }),
          approved: approvals.map((a) => ({ source: a.source, runner: a.runner, code: a.code, secrets: states(a.secrets), approvedAt: a.approvedAt })),
        };
      },
      async script_approve({ id, source, hash }) {
        const found = latestScript(id, source);
        if (found === null) return failed(`"${source}" is not a script source of this dashboard's latest version.`);
        if (scriptHash(found.script) !== hash) return failed("The script changed since you opened it. Review it again.");
        const where = await scripts.folder(found.dashboard.origin);
        if (!where.ok) return failed(where.error);
        scripts.approve(id, found.script);
        return succeeded;
      },
      script_withdraw: ({ id, source }) => (scripts.withdraw(id, source) ? succeeded : failed(`"${source}" has no approval to withdraw.`)),
      async script_secret({ id, name, value }) {
        const dashboard = store.get(id);
        if (dashboard === null) return failed("There is no such dashboard.");
        const declared = dashboard.sources.filter(isScript).some((s) => s.secrets?.includes(name));
        if (value !== null && !declared) return failed(`No script of this dashboard's latest version takes ${name}.`);
        return scripts.setSecret(id, name, value);
      },
      connections_list: async () => ({ store: { label: secrets.label, unavailable: await secrets.unavailable() }, connections: connections.list().map(view) }),
      connection_add: (input) => connections.add(input),
      connection_secret: ({ id, slot, value }) => connections.setSecret(id, slot, value),
      connection_check: ({ id }) => connections.check(id),
      connection_confirm: ({ id, tools }) => connections.confirm(id, tools),
      connection_remove: ({ id }) => connections.remove(id),
      discover: ({ folder }) => discover({ user: userConfig, project: projectConfig(folder) }, (name) => connections.byName(name) !== null),
      async discover_import({ source, folder, name }) {
        const file = source === "user" ? userConfig : projectConfig(folder);
        if (file === null) return { ok: false as const, error: "Give the folder the server was found in." };
        const found = await draftFor(file, name);
        return found.ok ? connections.add(found.draft) : found;
      },
    }));
  };
}

export default createPlugin();
