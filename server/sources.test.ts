// Live data through bb's fake plugin host: each source kind with its refusals, source_run's checks,
// cache floor and rate limit, dashboard_save's sources and data, dashboard_sources, and the CSV parser.
// Folders, files, commits and pull requests are invented; git and pull requests are stubbed answers
// from bb's built-in plugins, shaped like theirs.
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { FOLDER, STORAGE, startHost, type FakeFiles } from "../test/host";
import { RATE_LIMIT } from "./run";
import { MAX_AGENT_BYTES, MAX_FILE_BYTES, MIN_REFRESH_SECONDS, inside, parseCsv } from "./sources";
import { MAX_OUTPUT_CHARS } from "./tools";

const load = async () => (await import("../server")).default;
type Host = Awaited<ReturnType<typeof startHost>>;

afterEach(() => vi.useRealTimers());

/** A program reading each named source with a plain Query. */
const reading = (...names: string[]) =>
  `root = Dashboard([main])\n${names.map((n) => `${n} = Query("${n}", {}, {rows: []})`).join("\n")}\nmain = Section("Live", [Kpis([${names.map((n) => `Kpi("${n}", @Count(${n}.rows), "number")`).join(", ")}])])`;

async function withSources(files: FakeFiles, sources: unknown[], names = sources.map((s) => (s as { name: string }).name)) {
  const host = await startHost(load, files);
  const saved = await host.save({ title: "Corner shop", program: reading(...names), sources });
  expect(saved.error, saved.text).toBe(false);
  return { ...host, id: saved.id! };
}

const ORDERS_JSON = JSON.stringify({ rows: [{ id: "A-1001", customer: "Corner Bakery", total: 42.5 }] });

// bb--git and bb--github-pr-status answers, invented.
const COMMITS = [
  { sha: "1a2b3c4d5e", shortSha: "1a2b3c4", subject: "Add tax table", authorName: "Mina", authoredAt: 1_767_225_600_000 },
  { sha: "9f8e7d6c5b", shortSha: "9f8e7d6", subject: "Round tax per line", authorName: "Theo", authoredAt: 1_767_312_000_000 },
];
const workspace = (branch: string | null, base: string | null) => ({
  checkout: { kind: "branch", branchName: branch, headSha: "9f8e7d6c5b" },
  branch: { currentBranch: branch, defaultBranch: "main" },
  workingTree: { insertions: 3, deletions: 1, lineStatsComplete: true, fileCount: 1, files: [], hasUncommittedChanges: true, state: "dirty_uncommitted" },
  mergeBase: base === null ? null : { mergeBaseBranch: base, baseRef: null, aheadCount: 2, behindCount: 1, squashMergeCheckComplete: true, hasCommittedUnmergedChanges: true, commits: COMMITS, insertions: 30, deletions: 7, lineStatsComplete: true, fileCount: 2, files: [] },
  allChanges: { insertions: 33, deletions: 8, lineStatsComplete: true, fileCount: 3 },
});
const FILES = [
  { path: "src/tax.ts", previousPath: null, changeKind: "modified", additions: 24, deletions: 6, binary: false, origin: "tracked", loadMode: "auto", revision: "r1" },
  { path: "src/rates.json", previousPath: null, changeKind: "added", additions: 9, deletions: 0, binary: false, origin: "untracked", loadMode: "auto", revision: "r2" },
];
const PULL_REQUEST = {
  number: 128,
  title: "Round tax per line",
  url: "https://git.example.com/shop/pull/128",
  state: "open",
  baseRefName: "main",
  headRefName: "feature/checkout-tax",
  updatedAt: "2026-01-01T09:30:00Z",
  autoMerge: false,
  inMergeQueue: null,
  checks: { state: "failing", totalCount: 5, passedCount: 4, failedCount: 1, pendingCount: 0 },
  review: { state: "approved", reviewRequestCount: 0 },
  mergeability: { state: "mergeable", mergeStateStatus: "CLEAN", mergeable: "MERGEABLE" },
  attention: "checks_failed",
};

type Rpc = { pluginId: string; method: string; input: unknown; outputSchema: { parse(v: unknown): unknown } };
/** Answers bb's built-in plugins' read methods; anything else throws (and fails the test). */
function plugins(host: Host, answers: Record<string, (input: never) => unknown>) {
  host.harness.sdk.stub("plugins.callRpc", (async ({ pluginId, method, input, outputSchema }: Rpc) => {
    const answer = answers[`${pluginId}.${method}`];
    if (answer === undefined) throw new Error(`unexpected call ${pluginId}.${method}`);
    return outputSchema.parse(await answer(input as never));
  }) as never);
}
const gitAnswers = (branch: string | null = "feature/checkout-tax", base: string | null = "main") => ({
  "bb--git.status": () => ({ "env-1": { outcome: "available", workspace: workspace(branch, base) } }),
  "bb--git.files": () => ({ outcome: "available", files: FILES, truncated: false, shortstat: "", mergeBaseRef: null, initialPatches: [] }),
  "bb--github-pr-status.pullRequests": () => ({ "env-1": { outcome: "available", pullRequest: PULL_REQUEST } }),
});
const noEnvironment = (host: Host) =>
  host.harness.sdk.stub("threads.get", (async () => ({ ...makeThreadResponse({ id: "thread-1", environmentId: null }), environment: null })) as never);

describe("file source", () => {
  test("a JSON file in the thread's environment folder, read with that folder as bb's root", async () => {
    const host = await withSources({ [`${FOLDER}/data/orders.json`]: ORDERS_JSON }, [{ name: "orders", kind: "file", path: "data/orders.json" }]);
    expect(await host.run({ id: host.id, version: 1, source: "orders", args: {} })).toEqual({ ok: true, data: JSON.parse(ORDERS_JSON), fetchedAt: expect.any(Number) });
    expect(host.harness.sdk.callsTo("files.read")).toEqual([[{ path: `${FOLDER}/data/orders.json`, rootPath: FOLDER, hostId: "host-1" }]]);
  });

  test("a CSV file in the thread's storage folder becomes {rows}", async () => {
    const csv = 'id,customer,total\nA-1001,"Corner Bakery, Main St",42.5\nA-1002,Blue Kettle Cafe,007\n';
    const host = await withSources({ [`${STORAGE}/exports/orders.csv`]: csv }, [{ name: "orders", kind: "file", path: "exports/orders.csv", root: "storage" }]);
    const answer = await host.run({ id: host.id, version: 1, source: "orders", args: {} });
    expect(answer.data).toEqual({ rows: [{ id: "A-1001", customer: "Corner Bakery, Main St", total: 42.5 }, { id: "A-1002", customer: "Blue Kettle Cafe", total: "007" }] });
    expect(host.harness.sdk.callsTo("files.read")[0]).toEqual([{ path: `${STORAGE}/exports/orders.csv`, rootPath: STORAGE, hostId: "host-1" }]);
  });

  test.each([
    ["a .. part", "../secrets.json", "no .. parts"],
    ["a .. part in the middle", "data/../../x.json", "no .. parts"],
    ["an absolute path", "/etc/hosts.json", "relative to the folder"],
    ["a Windows absolute path", "C:\\data\\x.json", "relative to the folder"],
    ["another file type", "data/orders.txt", "a .json or .csv file"],
  ])("a path with %s is refused at save", async (_, path, message) => {
    const host = await startHost(load);
    const { text, error } = await host.call("dashboard_save", { title: "x", program: reading("orders"), sources: [{ name: "orders", kind: "file", path }] });
    expect(error).toBe(true);
    expect(text).toMatch(new RegExp(`- sources\\.0\\.path: .*${message}`));
    expect(text).toContain('The shapes are in dashboard_get with topic "live-data".');
    expect(host.db().prepare("SELECT COUNT(*) AS n FROM dashboards").get()).toEqual({ n: 0 });
  });

  test("the name check behind the save check: inside the folder or not", () => {
    expect(inside(FOLDER, `${FOLDER}/data/orders.json`)).toBe(true);
    expect(inside(FOLDER, `${FOLDER}/../corner-shop-2/x.json`)).toBe(false);
    expect(inside(FOLDER, "/etc/hosts")).toBe(false);
    expect(inside(FOLDER, `${FOLDER}/..data/x.json`)).toBe(true); // a name starting with two dots is still inside
  });

  test("a link out of the folder is refused (bb resolves links when given the root)", async () => {
    const host = await withSources({ [`${FOLDER}/data/orders.json`]: { escape: true } }, [{ name: "orders", kind: "file", path: "data/orders.json" }]);
    const answer = await host.run({ id: host.id, version: 1, source: "orders", args: {} });
    expect(answer).toEqual({ ok: false, error: "data/orders.json (in the thread's environment folder) leads outside its folder through a link; only files inside it can be read." });
  });

  test.each([
    ["too large", { size: MAX_FILE_BYTES + 1 }, "is 1025 KB, over the 1 MB limit"],
    ["not JSON", "{rows: [", "is not valid JSON"],
    ["missing", undefined, "data/orders.json (in the thread's environment folder) was not found."],
  ])("a file that is %s is a clear error value", async (_, file, message) => {
    const host = await withSources(file === undefined ? {} : { [`${FOLDER}/data/orders.json`]: file }, [{ name: "orders", kind: "file", path: "data/orders.json" }]);
    const answer = await host.run({ id: host.id, version: 1, source: "orders", args: {} });
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain(message);
  });

  test("a CSV with an unclosed quote is not valid CSV", async () => {
    const host = await withSources({ [`${FOLDER}/orders.csv`]: 'id,note\n1,"open' }, [{ name: "orders", kind: "file", path: "orders.csv" }]);
    expect((await host.run({ id: host.id, version: 1, source: "orders", args: {} })).error).toContain("is not valid CSV: a quoted field is not closed");
  });

  test("no environment folder, or the thread gone", async () => {
    const host = await withSources({}, [{ name: "orders", kind: "file", path: "data/orders.json" }]);
    noEnvironment(host);
    expect((await host.run({ id: host.id, version: 1, source: "orders", args: {} })).error).toBe("The thread this dashboard was made in has no environment folder.");
    host.harness.sdk.stub("threads.get", (async () => Promise.reject(new Error("no such thread"))) as never);
    expect((await host.run({ id: host.id, version: 1, source: "orders", args: {} })).error).toBe("The thread this dashboard was made in no longer exists.");
  });
});

describe("git and pull request sources", () => {
  const sources = [
    { name: "commits", kind: "git_commits" },
    { name: "changes", kind: "git_changes" },
    { name: "pr", kind: "pull_request" },
  ];

  test("git_commits: the branch's commits since its base, newest first, bounded by limit", async () => {
    const host = await withSources({}, sources);
    plugins(host, gitAnswers());
    expect((await host.run({ id: host.id, version: 1, source: "commits", args: { limit: 1 } })).data).toEqual({
      branch: "feature/checkout-tax",
      base: "main",
      ahead: 2,
      behind: 1,
      commits: [{ sha: "9f8e7d6c5b", shortSha: "9f8e7d6", subject: "Round tax per line", author: "Theo", authoredAt: 1_767_312_000_000 }],
      total: 2,
    });
    expect(host.harness.sdk.callsTo("plugins.callRpc").map(([c]) => [(c as Rpc).pluginId, (c as Rpc).method, (c as Rpc).input])).toEqual([["bb--git", "status", { keys: ["env-1"] }]]);
  });

  test("git_changes: the branch's files since its base by default, uncommitted when asked or on the base branch", async () => {
    const host = await withSources({}, sources);
    plugins(host, gitAnswers());
    const branch = await host.run({ id: host.id, version: 1, source: "changes", args: {} });
    expect(branch.data).toEqual({
      scope: "branch",
      branch: "feature/checkout-tax",
      base: "main",
      files: [
        { path: "src/tax.ts", previousPath: null, kind: "modified", additions: 24, deletions: 6, binary: false },
        { path: "src/rates.json", previousPath: null, kind: "added", additions: 9, deletions: 0, binary: false },
      ],
      totals: { files: 2, additions: 33, deletions: 6 },
      truncated: false,
    });
    await host.run({ id: host.id, version: 1, source: "changes", args: { scope: "uncommitted" } });
    const targets = host.harness.sdk.callsTo("plugins.callRpc").flatMap(([c]) => ((c as Rpc).method === "files" ? [((c as Rpc).input as { target: unknown }).target] : []));
    expect(targets).toEqual([{ type: "all", mergeBaseBranch: "main" }, { type: "uncommitted" }]);

    const onMain = await withSources({}, sources);
    plugins(onMain, gitAnswers("main", "main"));
    expect(((await onMain.run({ id: onMain.id, version: 1, source: "changes", args: {} })).data as { scope: string }).scope).toBe("uncommitted");
  });

  test("pull_request: checks, review and mergeability; a clear value when there is none; an error when bb cannot tell", async () => {
    const host = await withSources({}, sources);
    plugins(host, gitAnswers());
    expect((await host.run({ id: host.id, version: 1, source: "pr", args: {} })).data).toEqual({
      exists: true,
      number: 128,
      title: "Round tax per line",
      url: "https://git.example.com/shop/pull/128",
      state: "open",
      base: "main",
      head: "feature/checkout-tax",
      updatedAt: "2026-01-01T09:30:00Z",
      checks: { state: "failing", passed: 4, failed: 1, pending: 0, total: 5 },
      review: { state: "approved", requests: 0 },
      mergeability: "mergeable",
      attention: "checks_failed",
    });
    plugins(host, { "bb--github-pr-status.pullRequests": () => ({ "env-1": { outcome: "absent" } }) });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + MIN_REFRESH_SECONDS * 1000); // past the cache floor
    expect(await host.run({ id: host.id, version: 1, source: "pr", args: {} })).toEqual({ ok: true, data: { exists: false, message: "No pull request for this branch." }, fetchedAt: expect.any(Number) });
    plugins(host, { "bb--github-pr-status.pullRequests": () => ({ "env-1": { outcome: "unavailable", message: "GitHub CLI is not signed in" } }) });
    vi.setSystemTime(Date.now() + MIN_REFRESH_SECONDS * 1000);
    expect(await host.run({ id: host.id, version: 1, source: "pr", args: {} })).toEqual({ ok: false, error: "GitHub CLI is not signed in" });
  });

  test("not a git checkout, and no environment", async () => {
    const host = await withSources({}, sources);
    plugins(host, { "bb--git.status": () => ({ "env-1": { outcome: "not_applicable", reason: "non_git_environment", message: "Not a git repository" } }) });
    expect((await host.run({ id: host.id, version: 1, source: "commits", args: {} })).error).toBe("The thread's environment is not a git checkout.");
    expect((await host.run({ id: host.id, version: 1, source: "changes", args: {} })).error).toBe("The thread's environment is not a git checkout.");
    noEnvironment(host);
    for (const source of ["commits", "pr"]) expect((await host.run({ id: host.id, version: 1, source, args: {} })).error).toBe("The thread this dashboard was made in has no environment.");
  });
});

describe("agent source", () => {
  test("answers with what the agent stored and when; a clear error before anything is stored", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T09:00:00Z"));
    const host = await withSources({}, [{ name: "incidents", kind: "agent", description: "Open incidents from the help desk tool" }]);
    expect(await host.run({ id: host.id, version: 1, source: "incidents", args: {} })).toEqual({ ok: false, error: expect.stringContaining('No data stored yet for "incidents"') });
    const stored = await host.save({ id: host.id, data: { incidents: { rows: [{ id: "INC-31", severity: "high" }] } } });
    expect(stored.text).toBe(`Stored data for incidents in dashboard ${host.id}; still version 1, no new version. Open panels show it now; no card is needed.`);
    expect(await host.run({ id: host.id, version: 1, source: "incidents", args: {} })).toEqual({ ok: true, data: { rows: [{ id: "INC-31", severity: "high" }] }, fetchedAt: Date.parse("2026-01-01T09:00:00Z") });
  });
});

describe("source_run", () => {
  const ORDERS = [{ name: "orders", kind: "file", path: "data/orders.json" }];

  test("refuses a name the version does not declare, a version that does not exist, and wrong args", async () => {
    const host = await withSources({ [`${FOLDER}/data/orders.json`]: ORDERS_JSON }, [...ORDERS, { name: "commits", kind: "git_commits" }]);
    expect(await host.run({ id: host.id, version: 1, source: "customers", args: {} })).toEqual({ ok: false, error: '"customers" is not a source of version 1 of this dashboard.' });
    expect(await host.run({ id: host.id, version: 2, source: "orders", args: {} })).toEqual({ ok: false, error: `There is no version 2 of dashboard ${host.id}.` });
    expect((await host.run({ id: host.id, version: 1, source: "commits", args: { limit: 1000 } })).error).toContain('Wrong arguments for "commits" (git_commits)');
    expect(host.harness.sdk.callsTo("files.read")).toEqual([]);
  });

  test("nothing the browser sends can change the path or the thread", async () => {
    const host = await withSources({ [`${FOLDER}/data/orders.json`]: ORDERS_JSON, "/etc/passwd": "root" }, ORDERS);
    const tries = [{ path: "/etc/passwd" }, { root: "storage" }, { threadId: "thread-2" }, { file: "../../etc/passwd" }];
    for (const args of tries) expect((await host.run({ id: host.id, version: 1, source: "orders", args })).error).toContain('Wrong arguments for "orders" (file)');
    await expect(host.run({ id: host.id, version: 1, source: "orders", args: {}, threadId: "thread-2" })).rejects.toThrow();
    await expect(host.run({ id: host.id, version: 1, source: "orders", args: {}, path: "/etc/passwd" })).rejects.toThrow();
    await host.run({ id: host.id, version: 1, source: "orders", args: {} });
    expect(host.harness.sdk.callsTo("files.read")).toEqual([[{ path: `${FOLDER}/data/orders.json`, rootPath: FOLDER, hostId: "host-1" }]]);
    expect(host.harness.sdk.callsTo("threads.get").every(([a]) => (a as { threadId: string }).threadId === "thread-1")).toBe(true);
  });

  test("an old version reads with its own declared sources", async () => {
    const host = await withSources({ [`${FOLDER}/a.json`]: '{"rows": [1]}', [`${FOLDER}/b.json`]: '{"rows": [1, 2]}' }, [{ name: "orders", kind: "file", path: "a.json" }]);
    const v2 = await host.save({ id: host.id, sources: [{ name: "orders", kind: "file", path: "b.json" }] });
    expect(v2.text).toContain("version 2");
    expect((await host.run({ id: host.id, version: 1, source: "orders", args: {} })).data).toEqual({ rows: [1] });
    expect((await host.run({ id: host.id, version: 2, source: "orders", args: {} })).data).toEqual({ rows: [1, 2] });
  });

  test(`asked again within ${MIN_REFRESH_SECONDS} s, it answers from its cache; failures are not cached`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T09:00:00Z"));
    const files: FakeFiles = { [`${FOLDER}/data/orders.json`]: ORDERS_JSON };
    const host = await withSources(files, ORDERS);
    const reads = () => host.harness.sdk.callsTo("files.read").length;
    const first = await host.run({ id: host.id, version: 1, source: "orders", args: {} });
    vi.setSystemTime(Date.now() + MIN_REFRESH_SECONDS * 1000 - 1);
    expect(await host.run({ id: host.id, version: 1, source: "orders", args: {} })).toEqual(first); // same fetchedAt
    expect(reads()).toBe(1);
    vi.setSystemTime(Date.now() + 1);
    const third = await host.run({ id: host.id, version: 1, source: "orders", args: {} });
    expect(reads()).toBe(2);
    expect(third.fetchedAt).toBeGreaterThan(first.fetchedAt!);

    delete files[`${FOLDER}/data/orders.json`];
    vi.setSystemTime(Date.now() + MIN_REFRESH_SECONDS * 1000);
    expect((await host.run({ id: host.id, version: 1, source: "orders", args: {} })).ok).toBe(false);
    files[`${FOLDER}/data/orders.json`] = ORDERS_JSON;
    expect((await host.run({ id: host.id, version: 1, source: "orders", args: {} })).ok).toBe(true); // retried at once
    expect(reads()).toBe(4);
  });

  test(`at most ${RATE_LIMIT.runs} real runs a minute per dashboard and source`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T09:00:00Z"));
    const host = await withSources({}, [{ name: "commits", kind: "git_commits" }, { name: "changes", kind: "git_changes" }]);
    plugins(host, gitAnswers());
    for (let limit = 1; limit <= RATE_LIMIT.runs; limit++) expect((await host.run({ id: host.id, version: 1, source: "commits", args: { limit } })).ok).toBe(true);
    const refused = await host.run({ id: host.id, version: 1, source: "commits", args: { limit: 99 } });
    expect(refused).toEqual({ ok: false, error: `"commits" refreshed too often: at most ${RATE_LIMIT.runs} times a minute. Try again in 60 s.` });
    expect((await host.run({ id: host.id, version: 1, source: "commits", args: { limit: 1 } })).ok).toBe(true); // a cache answer is not a run
    expect((await host.run({ id: host.id, version: 1, source: "changes", args: {} })).ok).toBe(true); // another source has its own count
    vi.setSystemTime(Date.now() + RATE_LIMIT.windowMs);
    expect((await host.run({ id: host.id, version: 1, source: "commits", args: { limit: 99 } })).ok).toBe(true);
  });
});

describe("dashboard_save with sources and data", () => {
  const INCIDENTS = { name: "incidents", kind: "agent" };

  test("a declared Query passes; sources are saved with the version and kept when left out", async () => {
    const host = await withSources({}, [INCIDENTS]);
    await host.save({ id: host.id, patch: `main = Section("Incidents", [Kpis([Kpi("Open", @Count(incidents.rows), "number")])])` });
    const rows = host.db().prepare("SELECT number, sources FROM versions ORDER BY number").all() as { number: number; sources: string }[];
    expect(rows.map((r) => [r.number, JSON.parse(r.sources)])).toEqual([
      [1, [INCIDENTS]],
      [2, [INCIDENTS]],
    ]);
    const read = (await host.harness.behavior.callRpc("read", { id: host.id })) as { dashboard: { sources: unknown } };
    expect(read.dashboard.sources).toEqual([{ name: "incidents", kind: "agent" }]);
  });

  test("storing data alone adds no version and publishes a data ping, not a save ping", async () => {
    const host = await withSources({}, [INCIDENTS]);
    const signals = host.harness.realtimeSignals.length;
    await host.save({ id: host.id, data: { incidents: { rows: [] } } });
    expect(host.db().prepare("SELECT COUNT(*) AS n FROM versions").get()).toEqual({ n: 1 });
    expect(host.harness.realtimeSignals.slice(signals)).toEqual([{ channel: "dashboard-data", payload: { dashboardId: host.id, sources: ["incidents"] } }]);
    expect(((await host.harness.behavior.callRpc("list", null)) as { dashboards: { version: number }[] }).dashboards[0]!.version).toBe(1);
  });

  test("data with a new program is stored with that version", async () => {
    const host = await startHost(load);
    const saved = await host.save({ title: "Incidents", program: reading("incidents"), sources: [INCIDENTS], data: { incidents: { rows: [{ id: "INC-31" }] } } });
    expect(saved.error).toBe(false);
    expect((await host.run({ id: saved.id, version: 1, source: "incidents", args: {} })).data).toEqual({ rows: [{ id: "INC-31" }] });
    expect(host.harness.realtimeSignals.map((s) => s.channel)).toEqual(["dashboard-saved", "dashboard-data"]);
  });

  test("data for a source that is not an agent source, undeclared, or over the cap is refused, and nothing is stored", async () => {
    const host = await withSources({}, [INCIDENTS, { name: "commits", kind: "git_commits" }]);
    const big = { rows: "x".repeat(MAX_AGENT_BYTES) };
    const refused = await host.save({ id: host.id, data: { commits: [], customers: [], incidents: big } });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain('data.commits: "commits" is a git_commits source, which reads its own data; only agent sources take data.');
    expect(refused.text).toContain('data.customers: "customers" is not a declared source.');
    expect(refused.text).toContain("data.incidents is 257 KB; the limit is 256 KB per source.");
    expect(host.db().prepare("SELECT COUNT(*) AS n FROM agent_data").get()).toEqual({ n: 0 });
    const withProgram = await host.save({ id: host.id, patch: `main = Section("x", [])`, data: { incidents: big } });
    expect(withProgram.error).toBe(true);
    expect(host.db().prepare("SELECT COUNT(*) AS n FROM versions").get()).toEqual({ n: 1 });
  });

  test("an undeclared Query, a duplicate source name, and a Query left behind when its source goes are refused", async () => {
    const host = await startHost(load);
    expect((await host.save({ title: "x", program: reading("orders"), sources: [INCIDENTS] })).text).toContain('Query("orders") at line 2: "orders" is not a declared source. Declared: incidents.');
    expect((await host.save({ title: "x", program: reading("incidents"), sources: [INCIDENTS, INCIDENTS] })).text).toContain("Source names must be unique; declared more than once: incidents.");
    const { id } = await host.save({ title: "x", program: reading("incidents"), sources: [INCIDENTS] });
    expect((await host.save({ id, sources: [] })).text).toContain('"incidents" is not a declared source. No sources are declared.');
  });

  test("deleting the dashboard deletes its stored data", async () => {
    const host = await withSources({}, [INCIDENTS]);
    await host.save({ id: host.id, data: { incidents: [] } });
    await host.harness.behavior.callRpc("delete", { id: host.id });
    expect(host.db().prepare("SELECT COUNT(*) AS n FROM agent_data").get()).toEqual({ n: 0 });
  });

  test("dashboard_get shows the sources and when agent data was stored", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T09:00:00Z"));
    const host = await withSources({}, [{ name: "orders", kind: "file", path: "data/orders.json" }, { ...INCIDENTS, description: "Open incidents from the help desk tool" }, { name: "pr", kind: "pull_request" }]);
    expect((await host.call("dashboard_get", { id: host.id })).text).toContain(
      "Sources:\n- orders: file data/orders.json\n- incidents: agent, Open incidents from the help desk tool; no data stored yet\n- pr: pull_request",
    );
    await host.save({ id: host.id, data: { incidents: [] } });
    expect((await host.call("dashboard_get", { id: host.id })).text).toContain("- incidents: agent, Open incidents from the help desk tool; data stored 2026-01-01T09:00:00.000Z");
  });
});

describe("dashboard_sources", () => {
  test("with no arguments: every kind with its parameters and an invented sample", async () => {
    const host = await startHost(load);
    const { text, error } = await host.call("dashboard_sources", {});
    expect(error).toBe(false);
    for (const kind of ["file", "git_commits", "git_changes", "pull_request", "agent", "mcp"]) expect(text).toContain(`- ${kind} (`);
    expect(text).toContain("on the base branch itself, or with no base branch, only the uncommitted work");
    expect(text).toContain("Connections: none.");
    expect(text).toContain(`at least ${MIN_REFRESH_SECONDS}`);
    expect(text).toContain('"customer":"Corner Bakery"');
    expect(host.harness.sdk.calls).toEqual([]); // ran nothing
  });

  test("with a kind: runs it once for the calling thread and returns the real result, shortened", async () => {
    const big = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ id: `A-${1000 + i}`, customer: "Corner Bakery" })) });
    const host = await startHost(load, { [`${FOLDER}/data/orders.json`]: ORDERS_JSON, [`${FOLDER}/data/big.json`]: big });
    plugins(host, gitAnswers());
    expect((await host.call("dashboard_sources", { kind: "file", path: "data/orders.json" })).text).toBe(JSON.stringify(JSON.parse(ORDERS_JSON), null, 2));
    expect(JSON.parse((await host.call("dashboard_sources", { kind: "git_commits", args: { limit: 1 } })).text).commits).toHaveLength(1);
    expect(JSON.parse((await host.call("dashboard_sources", { kind: "pull_request" })).text).number).toBe(128);
    const shortened = (await host.call("dashboard_sources", { kind: "file", path: "data/big.json" })).text;
    expect(shortened.length).toBeLessThan(MAX_OUTPUT_CHARS + 1);
    expect(shortened).toMatch(/… cut: \d+ characters in all, 6000 shown\. Pass args that return less/);
  });

  test("a long changed-file list is cut to 6,000 characters too, with how to ask for less", async () => {
    const host = await startHost(load);
    const many = Array.from({ length: 450 }, (_, i) => ({ ...FILES[0]!, path: `src/module-${i}/component-${i}.tsx` }));
    plugins(host, { ...gitAnswers(), "bb--git.files": () => ({ outcome: "available", files: many, truncated: false, shortstat: "", mergeBaseRef: null, initialPatches: [] }) });
    const { text } = await host.call("dashboard_sources", { kind: "git_changes" });
    expect(text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(text).toMatch(/\n… cut: \d{5} characters in all, 6000 shown\. Pass args that return less, such as a smaller limit or a filter\. The panel gets the whole result\.$/);
  });

  test("refuses a bad path, bad args and a failing source with the reason; an agent source has nothing to run", async () => {
    const host = await startHost(load);
    expect(await host.call("dashboard_sources", { kind: "file", path: "../x.json" })).toEqual({ text: expect.stringContaining("no .. parts"), error: true });
    expect(await host.call("dashboard_sources", { kind: "git_commits", args: { since: "yesterday" } })).toEqual({ text: expect.stringContaining("Wrong args for git_commits"), error: true });
    expect(await host.call("dashboard_sources", { kind: "file", path: "missing.json" })).toEqual({ text: expect.stringContaining("was not found"), error: true });
    expect((await host.call("dashboard_sources", { kind: "agent" })).text).toContain("there is nothing to run");
    const script = await host.call("dashboard_sources", { kind: "script" }); // the kind and its rules; nothing runs
    expect(script.error).toBe(false);
    expect(script.text).toContain("dashboard_sources never runs a script");
    expect(script.text).toContain("You cannot approve a script and must never try");
  });
});

describe("parseCsv", () => {
  const rows = (text: string) => {
    const result = parseCsv(text);
    if (!result.ok) throw new Error(result.error);
    return result.rows;
  };

  test("a header line names the columns; quoted fields hold commas, newlines and doubled quotes", () => {
    expect(rows('name,note\n"Corner Bakery, Main St","said ""hi""\nthen left"\n')).toEqual([{ name: "Corner Bakery, Main St", note: 'said "hi"\nthen left' }]);
  });

  test("numbers only when they parse cleanly", () => {
    expect(rows("a,b,c,d,e,f,g,h\n42,-3.5,007,1e3,12.50, 5,,0\n")).toEqual([{ a: 42, b: -3.5, c: "007", d: "1e3", e: "12.50", f: " 5", g: "", h: 0 }]);
  });

  test("CRLF line ends, a byte order mark, blank lines, short and long rows, no trailing newline", () => {
    expect(rows("\uFEFFid,qty\r\n1,2\r\n\r\n3\r\n4,5,6")).toEqual([
      { id: 1, qty: 2 },
      { id: 3, qty: "" },
      { id: 4, qty: 5 },
    ]);
  });

  test("an empty file or a header alone has no rows; an unclosed quote is an error", () => {
    expect(rows("")).toEqual([]);
    expect(rows("id,qty\n")).toEqual([]);
    expect(parseCsv('id\n"1')).toEqual({ ok: false, error: "a quoted field is not closed" });
  });

  test("a quote inside an unquoted field is kept as it is", () => {
    expect(rows('size\n12" pizza\n')).toEqual([{ size: '12" pizza' }]);
  });
});
