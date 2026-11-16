// The read-only data sources a dashboard can declare (PLAN section 7): a JSON or CSV file in its origin
// thread's folders, that thread's git commits and changes and its pull request, data the agent stored,
// a confirmed read-only tool of one of the plugin's MCP connections (run by server/connections.ts
// through server/run.ts), and a script the user approved (server/scripts.ts, also through server/run.ts).
// Readers return values, never throw: { ok: true, data } or { ok: false, error }.
// Git and pull requests come from bb's own plugins (bb--git, bb--github-pr-status); only their read
// methods are called. The plugin itself makes no network call.
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { SCRIPT_MIN_REFRESH_SECONDS } from "../shared.ts"; // with its extension: scripts/generate.ts loads this file in plain Node

/** The shortest refresh interval, in seconds: refused below it at save, and source_run answers from its cache when asked sooner. */
export const MIN_REFRESH_SECONDS = 10;
/** The floor for script sources is higher (shared.ts, where the panel reads it too): each refresh starts a process on the user's machine. */
export { SCRIPT_MIN_REFRESH_SECONDS };
/** What a script source may run with; the code goes to it as one argument (-c, or -e for node). */
export const RUNNERS = ["sh", "bash", "python3", "node"] as const;
export const MAX_SCRIPT_CODE = 20_000;
/** Every script run: stopped with everything it started after this long; stopped when it prints more than this. */
export const SCRIPT_TIMEOUT_MS = 20_000;
export const MAX_SCRIPT_OUTPUT = 1024 * 1024;
export const MAX_SOURCES = 12;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_AGENT_BYTES = 256 * 1024;
export const MAX_COMMITS = 100;
export const MAX_CHANGED_FILES = 200;
export const MAX_MCP_ARGS = 2_000;

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, "a source name: a letter, then letters, digits or _ (40 at most)");
const relativePath = z
  .string()
  .min(1)
  .max(300)
  .refine((p) => !path.posix.isAbsolute(p) && !path.win32.isAbsolute(p) && !p.includes("\0") && !p.split(/[\\/]/).includes(".."), "a path relative to the folder, with no .. parts")
  .refine((p) => /\.(json|csv)$/i.test(p), "a .json or .csv file");

const unique = (names: string[]) => new Set(names).size === names.length;
/** Control, invisible and direction-changing characters: they could make the script the user reads differ from what runs. */
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F\u0085\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF]/; // U+2028/9 end a line for node, not for the dialog
const visible = (text: string) => !HIDDEN.test(text);
const VISIBLE = "no control, invisible or direction-changing characters (they could hide what runs); tabs and line breaks (\\n) only";
/** A secret variable a script gets. Names that change how a runner or the system loads code are refused. */
export const secretName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "a variable name: letters, digits and _, not starting with a digit")
  .refine((n) => !/^(PATH|ENV|IFS|PS4|SHELLOPTS|BASHOPTS|BASH_.*|NODE_.*|PYTHON.*|LD_.*|DYLD_.*)$/i.test(n), "a name that changes how code is loaded (PATH, BASH_*, NODE_*, PYTHON*, LD_*, DYLD_* and the like)");

/** A declared source, saved with each version. Only a file names anything, and that path is fixed here, never taken from the browser. */
export const sourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      name,
      kind: z.literal("file"),
      path: relativePath.describe('Relative to the thread\'s folder, e.g. "data/orders.json"'),
      root: z.enum(["environment", "storage"]).optional().describe('"environment" (default): the thread\'s working folder; "storage": its thread storage folder'),
    })
    .strict(),
  z.object({ name, kind: z.literal("git_commits") }).strict(),
  z.object({ name, kind: z.literal("git_changes") }).strict(),
  z.object({ name, kind: z.literal("pull_request") }).strict(),
  z.object({ name, kind: z.literal("agent"), description: z.string().trim().min(1).max(300).optional().describe("What you fetch for it and with which tool") }).strict(),
  z
    .object({
      name,
      kind: z.literal("mcp"),
      connection: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/, "a connection name from dashboard_sources"),
      tool: z.string().min(1).max(128).describe("One of the connection's confirmed read-only tools"),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .refine((args) => JSON.stringify(args ?? {}).length <= MAX_MCP_ARGS, `at most ${MAX_MCP_ARGS} characters of arguments`)
        .describe("Fixed arguments for the tool"),
      overridable: z.array(z.string().min(1).max(64)).max(20).optional().describe("Argument names a Query may set, over args"),
    })
    .strict(),
  z
    .object({
      name,
      kind: z.literal("script"),
      runner: z.enum(RUNNERS).describe("What runs the code"),
      code: z.string().min(1).max(MAX_SCRIPT_CODE).refine(visible, VISIBLE).describe("The whole script: reads the Query's args as JSON on standard input and prints one JSON value on standard output"),
      why: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .refine((w) => !/[\r\n]/.test(w), "one line")
        .refine(visible, VISIBLE)
        .describe("One line the user reads before approving: what the script fetches, from where"),
      secrets: z.array(secretName).max(10).refine(unique, "each name once").optional().describe("Names of environment variables the script needs; the user enters their values in the panel"),
    })
    .strict(),
]);
export type Source = z.infer<typeof sourceSchema>;
export type SourceKind = Source["kind"];
export const KINDS = ["file", "git_commits", "git_changes", "pull_request", "agent", "mcp", "script"] as const satisfies readonly SourceKind[];

/** A Query's args, per kind. Strict: nothing else, so the browser can never send a path or a thread. */
export const ARGS = {
  file: z.object({}).strict(),
  git_commits: z.object({ limit: z.number().int().min(1).max(MAX_COMMITS).optional() }).strict(),
  git_changes: z.object({ scope: z.enum(["branch", "uncommitted"]).optional() }).strict(),
  pull_request: z.object({}).strict(),
  agent: z.object({}).strict(),
  mcp: z.record(z.string(), z.unknown()), // only the declaration's overridable names; server/run.ts checks
  script: z.record(z.string(), z.unknown()), // any JSON object: it reaches the script on standard input, never its command line
} satisfies Record<SourceKind, z.ZodType>;

export type Answer = { ok: true; data: unknown } | { ok: false; error: string };
type Failure = { ok: false; error: string };
const fail = (error: string): Failure => ({ ok: false, error });
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
type Sdk = BbPluginApi["sdk"];

/** Runs a self-refreshing source for the thread; agent sources are read from the store by the caller. */
export async function runSource(sdk: Sdk, source: Source, args: Record<string, unknown>, threadId: string | null): Promise<Answer> {
  if (threadId === null) return fail("This dashboard does not know the thread it was made in.");
  try {
    switch (source.kind) {
      case "file":
        return await readFile(sdk, threadId, source);
      case "git_commits":
        return await readCommits(sdk, threadId, (args as z.infer<typeof ARGS.git_commits>).limit ?? 20);
      case "git_changes":
        return await readChanges(sdk, threadId, (args as z.infer<typeof ARGS.git_changes>).scope ?? "branch");
      case "pull_request":
        return await readPullRequest(sdk, threadId);
      case "agent":
        return fail("An agent source holds what the agent stored; there is nothing to run.");
      case "mcp":
        return fail("An mcp source runs through the plugin's connections."); // server/run.ts sends it there
      case "script":
        return fail("A script source runs only from the panel, after the user approved it."); // server/run.ts
    }
  } catch (cause) {
    return fail(`Could not read "${source.name}": ${message(cause)}`);
  }
}

// --- the thread and its folders

async function threadOf(sdk: Sdk, threadId: string) {
  try {
    const thread = await sdk.threads.get({ threadId, include: "environment" });
    if (thread.deletedAt !== null) return fail("The thread this dashboard was made in was deleted.");
    const environment = "environment" in thread ? thread.environment : null;
    return { ok: true as const, environmentId: environment?.id ?? thread.environmentId ?? null, environment };
  } catch {
    return fail("The thread this dashboard was made in no longer exists.");
  }
}

async function environmentId(sdk: Sdk, threadId: string) {
  const thread = await threadOf(sdk, threadId);
  if (!thread.ok) return thread;
  return thread.environmentId === null ? fail("The thread this dashboard was made in has no environment.") : { ok: true as const, id: thread.environmentId };
}

type Folder = { ok: true; path: string; hostId: string };

async function folderOf(sdk: Sdk, threadId: string, root: "environment" | "storage"): Promise<Folder | Failure> {
  const thread = await threadOf(sdk, threadId);
  if (!thread.ok) return thread;
  if (root === "storage") {
    try {
      const storage = await sdk.threads.storageLocation({ threadId });
      return { ok: true, path: storage.storageRootPath, hostId: storage.hostId };
    } catch {
      return fail("The thread this dashboard was made in has no storage folder.");
    }
  }
  const { environment } = thread;
  if (typeof environment?.path !== "string" || typeof environment.hostId !== "string") return fail("The thread this dashboard was made in has no environment folder.");
  return { ok: true, path: environment.path, hostId: environment.hostId };
}

/** True when target is root or inside it, by name; bb's own check (rootPath below) also follows symlinks. */
export function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const prop = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined);

async function readFile(sdk: Sdk, threadId: string, source: Extract<Source, { kind: "file" }>): Promise<Answer> {
  const root = source.root ?? "environment";
  const folder = await folderOf(sdk, threadId, root);
  if (!folder.ok) return folder;
  const where = `${source.path} (in the thread's ${root === "storage" ? "storage" : "environment"} folder)`;
  const target = path.resolve(folder.path, source.path);
  if (!inside(folder.path, target)) return fail(`${where} is outside its folder.`);
  let file: Awaited<ReturnType<Sdk["files"]["read"]>>;
  try {
    // rootPath makes bb resolve links in both paths and refuse a file that ends up outside the folder.
    file = await sdk.files.read({ path: target, rootPath: folder.path, hostId: folder.hostId });
  } catch (cause) {
    const text = message(cause);
    const code = prop(cause, "code");
    if (/escapes read root/i.test(text)) return fail(`${where} leads outside its folder through a link; only files inside it can be read.`);
    if (code === "ENOENT" || prop(cause, "status") === 404 || /does not exist|not found|ENOENT/i.test(text)) return fail(`${where} was not found.`);
    if (code === "file_too_large" || /exceeds the .*limit/i.test(text)) return fail(`${where} is over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`);
    return fail(`${where} could not be read: ${text}`);
  }
  if (!("content" in file)) return fail(`${where} could not be read.`);
  if (file.sizeBytes > MAX_FILE_BYTES) return fail(`${where} is ${Math.ceil(file.sizeBytes / 1024)} KB, over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`);
  const text = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
  if (/\.csv$/i.test(source.path)) {
    const csv = parseCsv(text);
    return csv.ok ? { ok: true, data: { rows: csv.rows } } : fail(`${where} is not valid CSV: ${csv.error}.`);
  }
  try {
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch (cause) {
    return fail(`${where} is not valid JSON: ${message(cause)}`);
  }
}

/**
 * Comma-separated text with a header line: one object per later line, keyed by the header. A field in
 * double quotes may hold commas, newlines and "" for a quote. A field becomes a number only when it is
 * exactly how JavaScript writes that number ("42", "-3.5"); "007", "1e3", "12.50" and "" stay strings.
 */
export function parseCsv(text: string): { ok: true; rows: Record<string, string | number>[] } | Failure {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let start = true; // at the start of a field, where a quote opens a quoted field
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (src[i + 1] === '"') (field += '"'), i++;
      else quoted = false;
    } else if (c === '"' && start) {
      quoted = true;
      start = false;
    } else if (c === ",") {
      record.push(field);
      field = "";
      start = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      start = true;
    } else {
      field += c;
      start = false;
    }
  }
  if (quoted) return fail("a quoted field is not closed");
  if (field !== "" || record.length > 0) record.push(field), records.push(record);
  const lines = records.filter((r) => r.length > 1 || r[0] !== ""); // blank lines
  const [header, ...rows] = lines;
  if (header === undefined) return { ok: true, rows: [] };
  const value = (s: string) => (s !== "" && String(Number(s)) === s ? Number(s) : s);
  return { ok: true, rows: rows.map((r) => Object.fromEntries(header.map((column, i) => [column, value(r[i] ?? "")]))) };
}

// --- git and the pull request, through bb's built-in plugins

const GIT = "bb--git";
const PULL_REQUESTS = "bb--github-pr-status";

const commitSchema = z.object({ sha: z.string(), shortSha: z.string(), subject: z.string(), authorName: z.string(), authoredAt: z.number() });
const workspaceSchema = z.object({
  branch: z.object({ currentBranch: z.string().nullable() }),
  mergeBase: z.object({ mergeBaseBranch: z.string(), aheadCount: z.number(), behindCount: z.number(), commits: z.array(commitSchema) }).nullable(),
});
const notRead = z.object({ outcome: z.string(), message: z.string().optional(), failure: z.object({ code: z.string(), message: z.string() }).optional() });
const statusRow = z.union([z.object({ outcome: z.literal("available"), workspace: workspaceSchema }), notRead]);
const filesAnswer = z.union([
  z.object({
    outcome: z.literal("available"),
    truncated: z.boolean(),
    files: z.array(z.object({ path: z.string(), previousPath: z.string().nullable(), changeKind: z.string(), additions: z.number(), deletions: z.number(), binary: z.boolean() })),
  }),
  notRead,
]);
const pullRequestRow = z.union([
  z.object({
    outcome: z.literal("available"),
    pullRequest: z.object({
      number: z.number(),
      title: z.string(),
      url: z.string(),
      state: z.string(),
      baseRefName: z.string(),
      headRefName: z.string(),
      updatedAt: z.string().optional(),
      checks: z.object({ state: z.string(), totalCount: z.number(), passedCount: z.number(), failedCount: z.number(), pendingCount: z.number() }),
      review: z.object({ state: z.string(), reviewRequestCount: z.number() }),
      mergeability: z.object({ state: z.string() }),
      attention: z.string(),
    }),
  }),
  z.object({ outcome: z.literal("absent") }),
  z.object({ outcome: z.literal("unavailable"), message: z.string() }),
]);

function notReadMessage(answer: z.infer<typeof notRead>): string {
  const code = answer.failure?.code;
  if (answer.outcome === "not_applicable" || code === "not_git_repo" || code === "workspace_type_mismatch") return "The thread's environment is not a git checkout.";
  if (code === "path_not_found") return "The thread's environment folder is gone.";
  return answer.failure?.message ?? answer.message ?? "bb could not read the git checkout.";
}

async function workspaceOf(sdk: Sdk, threadId: string) {
  const env = await environmentId(sdk, threadId);
  if (!env.ok) return env;
  const rows = await sdk.plugins.callRpc({ pluginId: GIT, method: "status", input: { keys: [env.id] }, outputSchema: z.record(z.string(), statusRow) });
  const row = rows[env.id];
  if (row === undefined) return fail("bb's Git plugin returned no status.");
  if (row.outcome !== "available" || !("workspace" in row)) return fail(notReadMessage(row as z.infer<typeof notRead>));
  return { ok: true as const, environmentId: env.id, workspace: row.workspace };
}

async function readCommits(sdk: Sdk, threadId: string, limit: number): Promise<Answer> {
  const status = await workspaceOf(sdk, threadId);
  if (!status.ok) return status;
  const base = status.workspace.mergeBase;
  const commits = [...(base?.commits ?? [])].reverse(); // bb--git lists them oldest first
  return {
    ok: true,
    data: {
      branch: status.workspace.branch.currentBranch,
      base: base?.mergeBaseBranch ?? null,
      ahead: base?.aheadCount ?? 0,
      behind: base?.behindCount ?? 0,
      commits: commits.slice(0, limit).map((c) => ({ sha: c.sha, shortSha: c.shortSha, subject: c.subject, author: c.authorName, authoredAt: c.authoredAt })),
      total: commits.length,
    },
  };
}

async function readChanges(sdk: Sdk, threadId: string, scope: "branch" | "uncommitted"): Promise<Answer> {
  const status = await workspaceOf(sdk, threadId);
  if (!status.ok) return status;
  const branch = status.workspace.branch.currentBranch;
  const base = status.workspace.mergeBase?.mergeBaseBranch ?? null;
  // On the base branch itself, or with no base, the branch's work is its uncommitted work.
  const target: { type: "all"; mergeBaseBranch: string } | { type: "uncommitted" } =
    scope === "branch" && base !== null && branch !== null && branch !== base ? { type: "all", mergeBaseBranch: base } : { type: "uncommitted" };
  const answer = await sdk.plugins.callRpc({ pluginId: GIT, method: "files", input: { environmentId: status.environmentId, target, ignoreWhitespace: false }, outputSchema: filesAnswer });
  if (answer.outcome !== "available" || !("files" in answer)) return fail(notReadMessage(answer as z.infer<typeof notRead>));
  const files = answer.files;
  return {
    ok: true,
    data: {
      scope: target.type === "all" ? "branch" : "uncommitted",
      branch,
      base: target.type === "all" ? target.mergeBaseBranch : null,
      files: files.slice(0, MAX_CHANGED_FILES).map((f) => ({ path: f.path, previousPath: f.previousPath, kind: f.changeKind, additions: f.additions, deletions: f.deletions, binary: f.binary })),
      totals: { files: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) },
      truncated: answer.truncated || files.length > MAX_CHANGED_FILES,
    },
  };
}

async function readPullRequest(sdk: Sdk, threadId: string): Promise<Answer> {
  const env = await environmentId(sdk, threadId);
  if (!env.ok) return env;
  const rows = await sdk.plugins.callRpc({ pluginId: PULL_REQUESTS, method: "pullRequests", input: { keys: [env.id] }, outputSchema: z.record(z.string(), pullRequestRow) });
  const row = rows[env.id];
  if (row?.outcome === "unavailable") return fail(row.message);
  if (row?.outcome !== "available") return { ok: true, data: { exists: false, message: "No pull request for this branch." } };
  const pr = row.pullRequest;
  return {
    ok: true,
    data: {
      exists: true,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      base: pr.baseRefName,
      head: pr.headRefName,
      updatedAt: pr.updatedAt ?? null,
      checks: { state: pr.checks.state, passed: pr.checks.passedCount, failed: pr.checks.failedCount, pending: pr.checks.pendingCount, total: pr.checks.totalCount },
      review: { state: pr.review.state, requests: pr.review.reviewRequestCount },
      mergeability: pr.mergeability.state,
      attention: pr.attention,
    },
  };
}

// --- what dashboard_sources lists, with invented samples

const SAMPLES: Record<SourceKind, { declare: string; args: string; refresh: string; sample: unknown }> = {
  file: {
    declare: '{name: "orders", kind: "file", path: "data/orders.json"}; path is relative to the thread\'s folder; add root: "storage" for its thread storage folder. A .json file comes as written; a .csv file as {rows: [...]}, one object per line keyed by the header. Up to 1 MB.',
    args: "none",
    refresh: "refreshes itself",
    sample: { rows: [{ id: "A-1001", customer: "Corner Bakery", status: "Late", total: 42.5 }, { id: "A-1002", customer: "Blue Kettle Cafe", status: "Packed", total: 18 }] },
  },
  git_commits: {
    declare: '{name: "commits", kind: "git_commits"}: the branch\'s commits since it left its base branch, newest first. There are none on the base branch itself.',
    args: `{limit}: 1 to ${MAX_COMMITS}, default 20`,
    refresh: "refreshes itself",
    sample: { branch: "feature/checkout-tax", base: "main", ahead: 2, behind: 0, commits: [{ sha: "9f2c1e7a4b", shortSha: "9f2c1e7", subject: "Round tax per line", author: "Mina", authoredAt: 1767225600000 }], total: 2 },
  },
  git_changes: {
    declare: '{name: "changes", kind: "git_changes"}: changed files with lines added and deleted.',
    args: '{scope}: "branch" (default: everything since the base branch, uncommitted work included; on the base branch itself, or with no base branch, only the uncommitted work) or "uncommitted"',
    refresh: "refreshes itself",
    sample: { scope: "branch", branch: "feature/checkout-tax", base: "main", files: [{ path: "src/tax.ts", previousPath: null, kind: "modified", additions: 24, deletions: 6, binary: false }], totals: { files: 1, additions: 24, deletions: 6 }, truncated: false },
  },
  pull_request: {
    declare: '{name: "pr", kind: "pull_request"}: the branch\'s pull request with checks, review and mergeability.',
    args: "none",
    refresh: "refreshes itself",
    sample: { exists: true, number: 128, title: "Round tax per line", url: "https://git.example.com/shop/pull/128", state: "open", base: "main", head: "feature/checkout-tax", updatedAt: "2026-01-01T09:30:00Z", checks: { state: "passing", passed: 6, failed: 0, pending: 0, total: 6 }, review: { state: "approved", requests: 0 }, mergeability: "mergeable", attention: "ready_to_merge" },
  },
  agent: {
    declare: '{name: "incidents", kind: "agent", description: "Open incidents from the help desk tool, last 7 days"}: data you fetch with your own tools. Store each result with dashboard_save data: {incidents: <JSON>}, at most 256 KB per source; id and data alone add no version.',
    args: "none",
    refresh: "refresh asks the agent (one model call)",
    sample: { rows: [{ id: "INC-31", title: "Checkout slow for card payments", severity: "high", opened: "2026-01-01" }] },
  },
  mcp: {
    declare:
      '{name: "stock", kind: "mcp", connection: "widget-shop", tool: "count_widgets", args: {colour: "teal"}, overridable: ["colour"]}: a confirmed read-only tool of a connection the user added on the plugin\'s Connections page (the list below). args are fixed; a Query may set only the names in overridable, over them. The result is the tool\'s structured content, else its text parsed as JSON, else the text; up to 1 MB.',
    args: "only the names in overridable",
    refresh: "refreshes itself",
    sample: { colour: "teal", count: 42 },
  },
  script: {
    declare: `{name: "jobs", kind: "script", runner: "python3", why: "Open jobs per state from the shop's job queue tool", code: "<the whole script>", secrets: ["QUEUE_READ_TOKEN"]}: a script run on the bb server's own machine in the thread's environment folder, only after the user read and approved it in the panel (never on Windows, never for an environment on another machine). runner is one of ${RUNNERS.join(", ")}; code at most ${MAX_SCRIPT_CODE} characters. It gets the Query's args as JSON on standard input and must print one JSON value on standard output; its environment holds only bb's tool path and the secret variables named, whose values the user enters in the panel. Up to 1 MB of output, ${SCRIPT_TIMEOUT_MS / 1000} s per run, one run at a time, a refresh interval of at least ${SCRIPT_MIN_REFRESH_SECONDS} s. Any change to runner, code or secret names needs the user's approval again. dashboard_sources never runs a script.`,
    args: "any JSON object, given to the script on standard input",
    refresh: "refreshes itself once the user approves it",
    sample: { rows: [{ state: "queued", jobs: 4 }, { state: "running", jobs: 2 }, { state: "failed", jobs: 1 }] },
  },
};

export const SOURCES_HELP = [
  `Sources a dashboard can declare. Pass them as dashboard_save's sources (saved with each version; left out, the current list stays). Read one with its own statement: name = Query("name", {args}, {defaults}, seconds). seconds is optional and written in, at least ${MIN_REFRESH_SECONDS} (${SCRIPT_MIN_REFRESH_SECONDS} for a script source). Failures come back as a message, never as made-up data.`,
  ...KINDS.map((kind) => {
    const s = SAMPLES[kind];
    return `- ${kind} (${s.refresh}). Declare: ${s.declare} Args: ${s.args}. Sample result (invented): ${JSON.stringify(s.sample)}`;
  }),
  "To see the real result before you write the program, call dashboard_sources with kind (and path, root for a file; args for options). It runs that source once for this thread. For an mcp source call it with connection and tool (and args for the tool) instead.",
].join("\n");
