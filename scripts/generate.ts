// Writes server/generated.ts and the plugin's skill (skills/dashboards/SKILL.md) from the
// merged library (ui/library.tsx): the parser schema; the core authoring guide, which is both the
// skill's body and what dashboard_get returns with no arguments; the detail topics dashboard_get serves
// by name; one signature line per component; and the theme token names. The server imports only
// generated.ts and lang-core, so it never loads React. Run `npm run generate` after upgrading
// @openuidev/* or editing a component or the text below; a test fails while either file is stale.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createLibrary, type Library } from "@openuidev/react-lang";
import { ThemeProvider, componentGroups, examples, promptOptions } from "@openuidev/dashboard-library";
// With their extension: `npm run generate` runs this file in plain Node, which needs one.
import { FONTS } from "../shared.ts";
import { MAX_AGENT_BYTES, MAX_MCP_ARGS, MAX_SCRIPT_CODE, MAX_SCRIPT_OUTPUT, MAX_SOURCES, MIN_REFRESH_SECONDS, RUNNERS, SCRIPT_MIN_REFRESH_SECONDS, SCRIPT_TIMEOUT_MS } from "../server/sources.ts";

const CORE = ["Dashboard", "Section", "Row", "Card"];

/** The skill's folder and frontmatter name; bb's configure selects it by this name. */
export const SKILL_NAME = "dashboards";
/**
 * The only always-on text about the plugin: it decides when an agent loads the skill. It draws the line
 * with inline UI in the reply: what the user keeps, reopens, changes later or wants refreshed is a dashboard.
 */
const SKILL_DESCRIPTION =
  "Use when the user wants to keep, reopen, come back to or change later what they ask for, or wants it to refresh: a dashboard, report, tracker or small tool, saved as a dashboard that opens in bb's side panel. A chart or table that only answers the current message stays in the reply.";

/** Exact replacement in stock text; throws when an upgrade changed that text, so it is reviewed again. */
function edit(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`stock text changed, review the guide: ${from}`);
  return text.replace(from, to);
}

/** One "## " section of the stock prompt, heading included; throws when an upgrade renamed it. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}\n`);
  if (start < 0) throw new Error(`stock prompt changed, review the guide: ${heading}`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end < 0 ? undefined : end).trim();
}

const PREAMBLE = [
  "A dashboard (also a report, tracker or small tool) is what the user keeps, reopens in bb's side panel and changes by asking again: one OpenUI Lang program under the Dashboard root, with its data written in or loaded from sources it declares (topic live-data).",
  "Save it with dashboard_save (title and program). The save checks the whole program; on any problem it stores nothing and lists the problems: fix them and save again. On success, put the card block it returns in your reply; it opens the dashboard.",
  "To change a dashboard, get its program with dashboard_get and its id, then save the id with a patch of only the new or changed statements (`name = null` removes one; statements root no longer reaches are dropped), or with program to replace it all.",
].join("\n\n");

// The stock syntax and built-in sections, condensed. generate() checks the stock text is the one this was
// written from (its hash) and that every stock built-in is named, so an upgrade that changes either fails.
const STOCK_SYNTAX_SHA256 = "8010662591fda217637f23c50cd9e8ca191b541d31c660e432bc958eaf79e9ad";
const SYNTAX = `## OpenUI Lang

- One statement per line, \`name = Expression\`, starting with \`root = Dashboard(...)\`.
- Expressions: "strings", numbers, true, false, null, [lists], {objects}, component calls \`Name(arg1, arg2)\` and built-ins. A name can be used before its statement.
- \`$name = default\` declares state; an argument marked \`$binding<type>\` takes a $variable and reads and writes it.
- Operators: + (also joins strings), -, *, /, %, ==, !=, >, <, >=, <=, &&, ||, !, \`cond ? a : b\`, parentheses. \`a.field\` reads a field; on a list, every item's field (a pluck); \`a[0]\` and \`a[key]\` index.`;
const BUILTINS = `## Built-ins

The only functions; never invent others, and compute values instead of writing results in: @Count(list), @First(list), @Last(list), @Sum(numbers), @Avg(numbers), @Min(numbers), @Max(numbers), @Round(n, decimals?), @Abs(n), @Floor(n), @Ceil(n) (n a number or a list), @Sort(list, field, "asc" | "desc"), @Filter(list, field, op, value) with op "==", "!=", ">", "<", ">=", "<=" or "contains", @Each(list, "t", template). They compose: @Count(@Filter(rows, "status", "==", "Late")), @Round(@Avg(rows.score), 1). @Each's loop variable exists only inside its template, so write the template inline, never as its own statement: @Each(rows, "t", Record(t.id, t.title)).`;

/**
 * Every stock rule is matched here or kept as it is in the core guide. text: null drops the rule (they forbid
 * tabs, text blocks and refresh buttons, or teach Query), a string rewrites it for data written into the
 * program; topic moves it out of the core guide into that topic.
 */
const RULES: { match: RegExp; text?: string | null; topic?: string }[] = [
  { match: /Tabs or text and markdown blocks/, text: null },
  { match: /Never write a Mutation, a form or a refresh button/, text: null },
  { match: /^With a data tool, load every number with Query/, text: null },
  { match: /^Previous values are the same measure/, text: "Previous values are the same measure for the period before, in the same unit. When you don't have them, leave them out: never repeat the current values or invent a change." },
  { match: /^Without a data tool, write realistic/, text: "Without a source, write every value into the program as literals: the numbers you gathered, or invented ones only when the user asks for sample data." },
  { match: /^A Goal needs a target above 0/, topic: "metrics" },
  { match: /^A filter is connected only through its first argument/, topic: "filters" },
  {
    match: /^Add a filter only when something can follow it/,
    text: "Add a filter only when something can follow it: you have data for every option it offers. For current counts (open issues, a latest version) add no date filter, and show the previous period with previous values or a comparison card instead. A filter whose $variable nothing reads does nothing: leave it out, and with no filters leave the FilterBar out.",
    topic: "filters",
  },
  { match: /^Only one FilterBar is drawn/, topic: "filters" },
  { match: /^When a filter sets the period/, topic: "filters" },
  { match: /^Write the statements in this order/, text: "Write the statements in this order: root, $variables, Queries, the FilterBar and Sections, then written-in data last." },
];
/** The part of the stock "Without a data tool" rule about filters, for the filters topic. */
const WRITTEN_FILTERS =
  "Without a source, use only PeriodPicker, ChipFilter, SelectFilter and CompareToggle as filters, and give the data an entry for every option value, the default included. Leave out DateRangeFilter and MultiSelectFilter: neither written values nor the built-in sources can follow a free date range or several choices at once.";

/** The stock rules by where they go: "guide" (the core) or a topic name. */
function rules(): Record<string, string[]> {
  const used = new Set<RegExp>();
  const placed: Record<string, string[]> = { guide: [], filters: [WRITTEN_FILTERS] };
  for (const rule of promptOptions.additionalRules!) {
    const match = RULES.find((r) => r.match.test(rule));
    if (match) used.add(match.match);
    if (match?.text === null) continue;
    (placed[match?.topic ?? "guide"] ??= []).push(match?.text ?? rule);
  }
  const unused = RULES.filter((r) => !used.has(r.match));
  if (unused.length > 0) throw new Error(`stock rules changed, review the guide: ${unused.map((r) => r.match).join(", ")}`);
  return placed;
}

// Group notes, with their Query wording made about written-in rows.
const notes = (group: (typeof componentGroups)[number]) =>
  (group.notes ?? []).flatMap((note) => {
    // The core guide's syntax says what a pluck is; this note's version is about a tool's Query result.
    if (note.startsWith("A pluck reads one column")) return [];
    if (note.includes("that card's Query or data")) return edit(note, "that card's Query or data", "that card's data");
    return note;
  });

const structure = componentGroups.find((g) => g.name === "Structure")!;
/** The chart and filter groups; each is a topic named after it. */
const groups = componentGroups.filter((g) => g !== structure);
const topicOf = (group: (typeof componentGroups)[number]) => group.name.toLowerCase();

// The core guide's one example: static, invented data, the components every dashboard starts with.
const CORE_EXAMPLE = `root = Dashboard([lead, trends, detail])
lead = Section("", [Kpis([Kpi("Revenue", @Sum(revenue), "currency-compact", @Sum(previous)), Kpi("Orders", @Sum(orders), "number"), Kpi("Refunds", 12, "number", 15, "down")])])
trends = Section("Trends", [Row([Card("Revenue by week", [TimeSeries(weeks, [Series("Revenue", revenue, previous)], "area", "currency-compact")], "two-thirds", "USD"), Card("Orders by channel", [Donut(channels, orders, "number", "Orders")], "third")])])
detail = Section("Detail", [Row([Card("Channels", [Table([Column("Channel", channels, "primary"), Column("Orders", orders, "number", "number"), Column("Revenue", sales, "number", "currency")])], "full")])])
weeks = ["Week 1", "Week 2", "Week 3", "Week 4"]
revenue = [8240, 8610, 8910, 9420]
previous = [7980, 8250, 8370, 8640]
channels = ["Web shop", "Market stall", "Wholesale"]
orders = [590, 214, 80]
sales = [21460, 8940, 4780]`;

// What the stock final checks asked for, condensed; the save check refuses a program that breaks them.
const BEFORE_SAVE = `## Before you save

- root = Dashboard(...) is the first statement, and each statement is on its own line.
- Every name you use is defined, and every statement is reached from root; an unreached one never renders.
- Arguments are positional, never name: value; leave optional ones off the end, or pass null to skip one.
- Strings use double quotes, with a backslash before a quote or a backslash inside.
- Each $variable is declared with its starting value and read by something.`;

// Where a dashboard ends and inline UI in the reply begins, for chats that also draw UI in the reply.
const INLINE = `## With inline UI in the same reply

If the chat can draw inline UI, the dashboard's card is still its own code block, with the language bb-dashboard, exactly as dashboard_save returns it; never put it inside an openui-lang block. The reply may sum up in plain text or a small inline block, but does not repeat the whole dashboard inline. When the user asks to change something already saved as a dashboard, change the dashboard instead of drawing a new inline chart.`;

const SAFE = `## Read-only and safe

A dashboard only shows data: nothing in it writes anywhere. It gets data only from the program itself or from the sources it declares, each read with its own top-level statement: name = Query("source", {args}, {defaults}, seconds) (topic live-data). Links open only http and https addresses. Never put a secret, token or password in a program. You cannot add a connection or approve a script: only the user does, in bb, and you never try by any route (topic scripts).`;

// Stock example 1 builds SQL strings for Query; this one has the same layout with invented shop data written in.
const SHOP = `root = Dashboard([filters, lead, trends, detail])
$range = "30d"
filters = FilterBar([PeriodPicker($range, [{value: "7d", label: "7D"}, {value: "30d", label: "30D"}]), CompareToggle("Previous period", true)])
lead = Section("", [Kpis([Kpi("Revenue", k[$range].revenue, "currency-compact", k[$range].revenuePrev), Kpi("Orders", k[$range].orders, "number", k[$range].ordersPrev)])])
trends = Section("Trends", [Row([Card("Revenue", [TimeSeries(t[$range].labels, [Series("Revenue", t[$range].values, t[$range].previous)], "area", "currency-compact")], "full", "USD")])])
detail = Section("Detail", [Row([Card("Channels", [Table([Column("Channel", ["Web shop", "Market stall", "Wholesale"], "primary"), Column("Revenue", c[$range].revenue, "number", "currency"), Column("Orders", c[$range].orders, "number", "number")], 10, false)], "full")])])
k = {"7d": {revenue: 8420, revenuePrev: 7960, orders: 212, ordersPrev: 198}, "30d": {revenue: 35180, revenuePrev: 33240, orders: 884, ordersPrev: 851}}
t = {"7d": {labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], values: [980, 1040, 1110, 1190, 1320, 1610, 1170], previous: [930, 1010, 1060, 1150, 1240, 1480, 1090]}, "30d": {labels: ["Week 1", "Week 2", "Week 3", "Week 4"], values: [8240, 8610, 8910, 9420], previous: [7980, 8250, 8370, 8640]}}
c = {"7d": {revenue: [5130, 2210, 1080], orders: [141, 52, 19]}, "30d": {revenue: [21460, 8940, 4780], orders: [590, 214, 80]}}`;

// The plugin's own components (ui/components): when to use each, where each goes, the drill-down
// pattern, and one invented-data example that uses Tabs, RecordList and Drawer.
const TICKETS = `root = Dashboard([lead, queue])
$tab = "Open"
$selected = null
$q = ""
lead = Section("", [Kpis([Kpi("Open tickets", @Count(open), "number"), Kpi("Waiting on customer", @Count(@Filter(open, "status", "==", "Waiting")), "number", null, "down")])])
queue = Section("Support queue", [Tabs([Tab("Open", [Row([Card("Open tickets", [SearchBox($q, "Search titles"), RecordList(@Each(@Filter(open, "title", "contains", $q), "t", Record(t.id, t.title, t.status, t.owner, t.age, t.link)), $selected, tones)], "full")])]), Tab("Solved", [Row([Card("Solved this week", [RecordList(@Each(@Filter(tickets, "state", "==", "Solved"), "t", Record(t.id, t.title, t.status, t.owner, t.age, t.link)), $selected, tones)], "full")])])], $tab), details])
details = Drawer(picked.id + " · " + picked.title, $selected, [KeyValues([KeyValue("Customer", picked.customer), KeyValue("Owner", picked.owner), KeyValue("Opened", picked.age)]), Markdown(picked.summary), LinkOut("Open in the help desk", picked.link)])
open = @Filter(tickets, "state", "==", "Open")
picked = @First(@Filter(tickets, "id", "==", $selected))
tones = {"New": "info", "Waiting": "warning", "Escalated": "bad", "Solved": "good"}
tickets = [{id: "T-1042", title: "Refund not received after return", state: "Open", status: "Escalated", owner: "Mina", customer: "Corner Bakery", age: "3d", link: "https://helpdesk.example.com/T-1042", summary: "Return arrived on **Monday**; the refund is still pending in the payment step."}, {id: "T-1047", title: "Cannot change delivery address", state: "Open", status: "Waiting", owner: "Theo", customer: "Blue Kettle Cafe", age: "1d", link: "https://helpdesk.example.com/T-1047", summary: "Asked the customer for the new postcode."}, {id: "T-1051", title: "Invoice shows the wrong tax rate", state: "Open", status: "New", owner: "Mina", customer: "Hilltop Florist", age: "5 h", link: "https://helpdesk.example.com/T-1051", summary: "The rate on the invoice is 19%; the shop's rate is 7%."}, {id: "T-1038", title: "Order arrived damaged", state: "Solved", status: "Solved", owner: "Theo", customer: "Corner Bakery", age: "6d", link: "https://helpdesk.example.com/T-1038", summary: "Replacement sent; the courier opened a claim."}]`;

// Signatures of these are in the views topic; Frame, Freshness and RefreshButton have their own topics.
const VIEWS = ["Tabs", "Tab", "RecordList", "Record", "Drawer", "SearchBox", "Toggle", "Slider", "Badge", "LinkOut", "Markdown", "Callout", "Empty", "AskAgent"];
const FRAME_LINE =
  "Frame: your own HTML, CSS and JS, only for what no component can draw. It has no network: nothing loads from outside, images only as data: URLs. The HTML is one string: use single quotes inside it.";

const OWN = `## Views, drill-down and free content

These components are this plugin's own.
- Tabs, each Tab one view (Overview, Errors, Slow pages), one shown at a time. A Tab holds what a Section holds. Bind Tabs to a $variable ($tab = "Overview") only when something else reads it.
- RecordList of Record items: things from a system (issues, incidents, orders) with title, status, owner, age and link. Picking one writes its id to a $variable.
- Drawer: the details of what was picked, shown while its $variable holds a value; its close button clears it. It holds what a Card holds.
- SearchBox (text), Toggle (on/off) and Slider (a number) set a $variable that filters or limits what others show. Like the filters, they take the $variable first.
- Badge: a coloured status word. LinkOut: a link to the item in its home system (http or https only). Markdown: written explanation. Callout: a note that must not be missed (info, warning, error, success). Empty: what to show, and why, when a list or chart would be empty.
- ${FRAME_LINE} (topic frame)
- AskAgent: a button that asks you about what is on screen. Every click costs a model call, so use it only for questions the page cannot answer itself.
Where they go: Tabs only in a Section's rows. RecordList, Badge and LinkOut only in a Card's or Drawer's content. The rest in a Card's or Drawer's content, or straight in a Section's or Tab's rows (full width). Nothing new goes in a Row: a Row holds Cards only.

Drill-down: RecordList writes the picked Record's id to $selected, the Drawer reads $selected, and its values are looked up from the rows with the filter builtins: picked = @First(@Filter(rows, "id", "==", $selected)), then picked.owner. Declare $selected = null. A SearchBox narrows a list the same way: @Filter(rows, "title", "contains", $q) (case-sensitive; an empty $q keeps every row), or pass $q as a Table's search.`;

// Frame: free HTML for what no component draws, and one invented example that reads its data.
const FRAME_EXAMPLE = `root = Dashboard([main])
main = Section("Floor", [Row([Card("Tables now", [Frame("Floor plan", "<div id='plan'></div><style>span{display:inline-block;margin:4px;padding:8px 12px;border:1px solid var(--border);border-radius:6px;color:var(--ink)}.busy{background:var(--accent);color:var(--surface)}</style><script>function draw(d){document.getElementById('plan').innerHTML=d.map(function(t){return '<span class='+(t.busy?'busy':'free')+'>'+t.name+'</span>'}).join('')}if(window.frameData)draw(window.frameData);addEventListener('framedata',function(e){draw(e.detail)})</script>", tables, 120)], "full")])])
tables = [{name: "T1", busy: true}, {name: "T2", busy: false}, {name: "T3", busy: true}, {name: "T4", busy: false}]`;

// Live data: declared sources, Query, Freshness and RefreshButton, and one invented example over a JSON file.
const LIVE_EXAMPLE = `root = Dashboard([lead, list])
orders = Query("orders", {}, {rows: []}, 60)
lead = Section("", [Kpis([Kpi("Orders", @Count(orders.rows), "number"), Kpi("Revenue", @Sum(orders.rows.total), "currency"), Kpi("Late", @Count(@Filter(orders.rows, "status", "==", "Late")), "number", null, "down")]), Freshness("orders")])
list = Section("Orders", [Row([Card("All orders", [Table([Column("Order", orders.rows.id, "primary"), Column("Customer", orders.rows.customer), Column("Status", orders.rows.status), Column("Total", orders.rows.total, "number", "currency")]), RefreshButton()], "full")])])`;

type Sig = (names: string[]) => string;
const live = (sig: Sig) => `## Live data

A dashboard can load its data instead of having it written in. Declare its sources in dashboard_save's sources, a list saved with each version (left out, the current list stays; [] removes them). Each source is {name, kind, ...}: name is a letter, then letters, digits or _ (40 at most), each name once, at most ${MAX_SOURCES} sources. dashboard_sources with no arguments lists every kind with its parameters and a sample result; with a kind (and a path) it runs that source once so you see the real result before you bind fields.
- file: a JSON or CSV file in this thread's folder: {name: "orders", kind: "file", path: "data/orders.json"}, a relative path with no .. parts ending in .json or .csv; add root: "storage" for the thread's storage folder. A CSV arrives as {rows: [...]}, one object per line keyed by the header.
- git_commits: this branch's commits since it left its base branch, newest first; none on the base branch itself. Args {limit} (1 to 100, default 20).
- git_changes: changed files with lines added and deleted. Args {scope}: "branch" (default: everything since the base branch, uncommitted work included; on the base branch itself, or with no base branch, only the uncommitted work) or "uncommitted".
- pull_request: this branch's pull request with its checks, review and mergeability; exists is false when there is none.
- agent: data you get with your own tools and hand over: {name: "incidents", kind: "agent", description: "Open incidents from the help desk tool, last 7 days"} (description optional, 300 characters at most). Store each result with dashboard_save's data: {incidents: <JSON>}, at most ${MAX_AGENT_BYTES / 1024} KB per source. Saving only id and data stores it and adds no version.
- script: a script the user approved, for data nothing else reaches (topic scripts).
- mcp: a read-only tool of an MCP connection the user added and confirmed on the plugin's Connections page (topic mcp). You cannot add or change a connection: when none serves the data, use an agent source or a script source.

Read a source with its own top-level statement: name = Query("source", {args}, {defaults}, seconds). defaults is what shows until the first answer, in the result's shape with empty lists and no made-up numbers ({rows: []}). seconds is optional and written in: leave it out to load on open and whenever a $variable in args changes, or give at least ${MIN_REFRESH_SECONDS} to reload on a timer too. Read fields with a pluck and the built-ins: orders.rows.total, @Sum(orders.rows.total). A failing source shows a notice and keeps its defaults.

When a source holds the data, keep the data out of the program: no copied rows or numbers, only the Query and what is computed from it. file, git, pull_request and mcp sources refresh themselves; an agent source changes only when you store new data, so the panel says "Refresh asks the agent".
- Freshness("orders") shows when a source last answered and how it refreshes. Put one near what it feeds.
- RefreshButton() re-runs every query now; RefreshButton("Refresh incidents", "incidents") one source. For an agent source it asks you in this thread to get the data again: do that with your tools and save only id and data, never a new program.
Both go where Markdown goes.

${sig(["Freshness", "RefreshButton"])}

Example with invented data, saved with sources: [{name: "orders", kind: "file", path: "data/orders.json"}], where the file holds {"rows": [{"id": "A-1001", "customer": "Corner Bakery", "status": "Late", "total": 42.5}, ...]}:
${LIVE_EXAMPLE}`;

const MCP = `## MCP connection sources

An mcp source reads a read-only tool of an MCP connection the user added and confirmed on the plugin's Connections page: {name: "stock", kind: "mcp", connection: "widget-shop", tool: "count_widgets", args: {colour: "teal"}, overridable: ["colour"]}. args are fixed (${MAX_MCP_ARGS} characters of JSON at most); a Query's args may set only the names in overridable (20 at most). The result is the tool's structured content, else its text parsed as JSON, else the text. It refreshes itself, with no model call; read it with Query like any source (topic live-data).
dashboard_sources lists the connections with each tool's description and input schema; with connection and tool (and args) it runs one once so you see the real shape. Only the tools the user confirmed as read-only can be called. You cannot add or change a connection: when none serves the data, use an agent source or a script source (topic scripts).`;

// Script sources: when to use one, how to write it, the approval rule, and one invented example.
const SCRIPT_SOURCE = {
  name: "jobs",
  kind: "script",
  runner: "python3",
  why: "Jobs per state from the shop's job queue tool (queuectl, with a read-only token)",
  secrets: ["QUEUE_READ_TOKEN"],
  code: 'import json, subprocess, sys\nargs = json.load(sys.stdin)\nout = subprocess.run(["queuectl", "jobs", "--state", args.get("state", "open"), "--json"], capture_output=True, text=True, check=True).stdout\nprint(json.dumps({"rows": json.loads(out)}))',
};
const SCRIPT_EXAMPLE = `root = Dashboard([filters, main])
$state = "open"
filters = FilterBar([ChipFilter($state, [{value: "open", label: "Open"}, {value: "failed", label: "Failed"}])])
jobs = Query("jobs", {state: $state}, {rows: []}, 60)
main = Section("Jobs", [Row([Card("Jobs", [Table([Column("Job", jobs.rows.id, "primary"), Column("State", jobs.rows.state), Column("Age", jobs.rows.age)])], "full")]), Freshness("jobs")])`;

const SCRIPTS = `## Script sources

Use a script source only when no connection and no built-in source reaches the data. It runs on the user's computer, so it never runs until the user has read and approved it in the dashboard's panel.
- Declare it in sources with name, kind: "script", runner (${RUNNERS.join(", ")}), code (the whole script), why (one line the user reads before approving: what it fetches, from where) and, when it needs any, secrets (names of environment variables).
- The script reads the Query's args as JSON on standard input and prints one JSON value on standard output, nothing else. You never see its error output.
- It runs in this thread's folder on the machine bb's server runs on (not on Windows, not for an environment on another machine), with only bb's tool path and the secret variables it names. Each run gets ${SCRIPT_TIMEOUT_MS / 1000} s and ${MAX_SCRIPT_OUTPUT / 1024 / 1024} MB of output, one at a time; a refresh interval, when given, is at least ${SCRIPT_MIN_REFRESH_SECONDS}.
- Only read-only commands and read-only credentials: never write, delete, send, install or start anything that keeps running. Never put a secret in the code: name it in secrets and read it from the environment; the user enters its value in the panel.
- After the save the source shows "waiting for your approval" and the rest of the dashboard works. Tell the user to read and approve the script in the panel. Never approve a script yourself, by any route: not with a tool, not with bb's command line, not through the plugin's RPC or its database. Changing its runner, code or secret names needs the user's approval again.
- dashboard_sources and dashboard_save never run a script. Check the commands it runs with your own tools where you can, then write the script around them.
- Checked at save: code at most ${MAX_SCRIPT_CODE} characters; why one line of at most 200; at most 10 secret names, each once, made of letters, digits and _ and not starting with a digit, never PATH, BASH_*, NODE_*, PYTHON*, LD_*, DYLD_* or another name that changes how code is loaded; no control, invisible or direction-changing characters in code or why (tabs and line breaks are fine).
- Read it with Query like any source (topic live-data).

Example with an invented queue tool, saved with sources: [${JSON.stringify(SCRIPT_SOURCE)}]:
${SCRIPT_EXAMPLE}`;

const frame = (sig: Sig) => `## Frame

${FRAME_LINE} It goes in a Card's or Drawer's content, or straight in a Section's or Tab's rows (full width).

${sig(["Frame"])}

Example with invented data:
${FRAME_EXAMPLE}`;

/** Theme tokens the themes topic names on their own; generate() checks each is still a token. */
const COMMON_TOKENS = ["accent", "series1", "series8", "page", "surface", "ink", "radius"];
const themes = (tokens: string[]) => `## Themes

dashboard_save's theme gives a dashboard its own look: {light: {token: value, ...}, dark: {token: value, ...}, font: "serif"}. Every part is optional. light applies to both modes when dark is left out. font is sans (system sans-serif), serif or mono (monospace); left out, bb's own font. Left out of a save, the current theme is kept; null follows bb's theme again. Without a theme a dashboard follows bb's colours.
A value is a CSS colour, length or shadow of at most 120 characters: letters, digits, spaces and #%(),./- only, no url(). A name that is not a token is refused.
Example: {light: {accent: "#1f6f43", series1: "#2a9d8f", radius: "6px"}, dark: {accent: "#5fd39a"}, font: "serif"}
Most looks need only accent, series1 to series8 (chart colours), page, surface, ink and radius.
The ${tokens.length} tokens: ${tokens.join(", ")}.`;

/** The text of server/generated.ts and of the skill's SKILL.md for this library. */
export function generate(library: Library): { server: string; skill: string } {
  if (!examples[0]!.includes("run_sql") || examples.slice(1).some((e) => e.includes("Query("))) throw new Error("stock examples changed, review the guide");
  if (Object.keys(FONTS).join() !== "sans,serif,mono") throw new Error("font choices changed, review the themes topic");

  const lines = library.prompt({ examples: [] }).split("\n");
  const signatures = Object.fromEntries(
    Object.keys(library.components).map((name) => {
      const line = lines.find((l) => l.startsWith(`${name}(`));
      if (!line) throw new Error(`no signature for ${name}`);
      return [name, line];
    }),
  );
  const sig: Sig = (names) => names.map((name) => signatures[name]!).join("\n");

  // The tokens ThemeProvider sets, as the camelCase keys its lightTheme/darkTheme props take.
  const css = renderToStaticMarkup(createElement(ThemeProvider));
  const tokens = [...css.matchAll(/--openui-dashboard-([a-z0-9-]+):/g)].map((m) => m[1]!.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()));
  const missing = COMMON_TOKENS.filter((t) => !tokens.includes(t));
  if (missing.length > 0) throw new Error(`theme tokens changed, review the themes topic: ${missing.join(", ")}`);

  // The core guide: the language and built-ins (condensed from the stock sections), the four layout
  // components, the rules every program needs, one example, and where the rest is. The stock sections on
  // streaming, examples and final checks are left out: a saved program does not stream, and the save
  // check reports what the final checks would find.
  const core = createLibrary({
    root: library.root,
    components: CORE.map((name) => library.components[name]!),
    componentGroups: [{ ...structure, notes: notes(structure) }],
  });
  const stock = core.prompt({ bindings: promptOptions.bindings, examples: [] });
  const syntaxSha = createHash("sha256").update(section(stock, "Syntax Rules")).digest("hex");
  if (syntaxSha !== STOCK_SYNTAX_SHA256) throw new Error(`stock syntax rules changed (${syntaxSha}), review SYNTAX`);
  const unnamed = [...section(stock, "Built-in Functions").matchAll(/^(@\w+)\(/gm)].map((m) => m[1]!).filter((name) => !BUILTINS.includes(`${name}(`));
  if (unnamed.length > 0) throw new Error(`stock built-ins changed, review BUILTINS: ${unnamed.join(", ")}`);
  const layout = edit(
    section(stock, "Component Signatures"),
    "## Component Signatures\n\nArguments marked with ? are optional. Sub-components can be inline or referenced; prefer references for better streaming.\nProps marked `$binding<type>` accept a `$variable` reference for two-way binding.\n\n### Structure",
    "## Layout components\n\nArguments marked ? are optional.",
  );
  const placed = rules();
  const bullets = (list: string[] = []) => list.map((rule) => `- ${rule}`).join("\n");
  const more = [
    ...groups.map((g) => `- ${topicOf(g)}: ${g.components.join(", ")}`),
    `- views: ${VIEWS.join(", ")}: this plugin's own, for tabs, drill-down, search and notes.`,
    "- frame: Frame, your own HTML, CSS and JS for what no component can draw.",
    "- live-data: loading data from sources with Query: files, git, the pull request, data you fetch yourself; Freshness and RefreshButton.",
    "- mcp: sources from MCP connections the user added.",
    "- scripts: script sources, which only the user can approve.",
    "- themes: a dashboard's own colours, radius, spacing and font (dashboard_save's theme).",
    "- guide: this text.",
  ];
  const guide = [
    PREAMBLE,
    SYNTAX,
    layout,
    BUILTINS,
    `## Rules\n\n${bullets(placed.guide)}`,
    SAFE,
    INLINE,
    `## Example\n\nA static dashboard with invented data:\n${CORE_EXAMPLE}`,
    BEFORE_SAVE,
    `## More components and detail\n\nGet a signature before you use a component beyond these four: dashboard_get with components: ["Bars", "Table"] (several per call), or topic: a group below, for all its signatures, which one to pick and an example. Read a topic before you use what it covers.\n${more.join("\n")}`,
  ].join("\n\n");

  // Every static example shown, by topic: the filters, composition and comparison groups (the shop and the
  // two static stock examples), views, the core guide and frame. EXAMPLES keeps that order.
  const groupExamples: Record<string, string> = { filters: SHOP, composition: examples[1]!, comparison: examples[2]! };
  const groupTopic = (g: (typeof groups)[number]) => {
    const topic = topicOf(g);
    const advice = [notes(g).join(" "), bullets(placed[topic])].filter(Boolean).join("\n");
    const example = groupExamples[topic] ? `\n\nExample with invented data:\n${groupExamples[topic]}` : "";
    return [topic, `## ${g.name}\n\n${advice}\n\n${sig(g.components)}${example}`];
  };
  const topics: Record<string, string> = {
    guide,
    ...Object.fromEntries(groups.map(groupTopic)),
    views: `${OWN}\n\n${sig(VIEWS)}\n\nExample with invented data:\n${TICKETS}`,
    frame: frame(sig),
    "live-data": live(sig),
    mcp: MCP,
    scripts: SCRIPTS,
    themes: themes(tokens),
  };
  const unplaced = Object.keys(placed).filter((topic) => !(topic in topics));
  if (unplaced.length > 0) throw new Error(`rules for unknown topics: ${unplaced.join(", ")}`);

  const server = [
    "// Generated by scripts/generate.ts from ui/library.tsx. Do not edit: run `npm run generate`.",
    'import type { LibraryJSONSchema } from "@openuidev/lang-core";',
    "",
    `export const ROOT = ${JSON.stringify(library.root)};`,
    `export const SCHEMA: LibraryJSONSchema = JSON.parse(${JSON.stringify(JSON.stringify(library.toJSONSchema()))});`,
    "/** The plugin's one skill (skills/<name>/SKILL.md); its body is GUIDE. */",
    `export const SKILL_NAME = ${JSON.stringify(SKILL_NAME)};`,
    "/** The core authoring guide: the skill's body, and dashboard_get's answer with no arguments. */",
    `export const GUIDE = ${JSON.stringify(guide)};`,
    "/** The detail topics dashboard_get serves by name, guide included; the guide names every one. */",
    `export const TOPICS: Record<string, string> = { guide: GUIDE, ...${JSON.stringify({ ...topics, guide: undefined }, null, 2)} };`,
    "/** Every static example the guide and its topics show: filters, composition, comparison, views, the guide, frame. */",
    `export const EXAMPLES: string[] = ${JSON.stringify([SHOP, examples[1]!, examples[2]!, TICKETS, CORE_EXAMPLE, FRAME_EXAMPLE], null, 2)};`,
    "/** The live-data topic's example; it declares one source, orders. */",
    `export const LIVE_EXAMPLE = ${JSON.stringify(LIVE_EXAMPLE)};`,
    "/** The scripts topic's example: the source it declares and its program. */",
    `export const SCRIPT_EXAMPLE = ${JSON.stringify({ source: SCRIPT_SOURCE, program: SCRIPT_EXAMPLE })};`,
    `export const SIGNATURES: Record<string, string> = ${JSON.stringify(signatures, null, 2)};`,
    `export const THEME_TOKENS = ${JSON.stringify(tokens)} as const;`,
    "",
  ].join("\n");
  // JSON-quoted, so the YAML frontmatter cannot break on a colon in the description.
  const skill = `---\nname: ${SKILL_NAME}\ndescription: ${JSON.stringify(SKILL_DESCRIPTION)}\n---\n\n${guide}\n`;
  return { server, skill };
}

/** The skill's file, relative to this one. */
export const SKILL_FILE = new URL(`../skills/${SKILL_NAME}/SKILL.md`, import.meta.url);

if (import.meta.main) {
  // Node loads neither .tsx nor .css, so ui/library.tsx comes through Vite's module runner. Its
  // dependencies stay external (Node's own copies), the same instances this file uses. Styles are
  // stubbed: the schema and prompt don't need them, and Vite's CSS plugin fails under runnerImport.
  const { runnerImport } = await import("vite");
  const entry = fileURLToPath(new URL("../ui/library.tsx", import.meta.url));
  const noCss = { name: "no-css", enforce: "pre" as const, resolveId: (id: string) => (id.endsWith(".css") ? "\0no-css" : null), load: (id: string) => (id === "\0no-css" ? "export {}" : null) };
  const { module } = await runnerImport<typeof import("../ui/library")>(entry, { configFile: false, logLevel: "warn", plugins: [noCss] });
  const { server, skill } = generate(module.library);
  writeFileSync(new URL("../server/generated.ts", import.meta.url), server);
  mkdirSync(new URL(".", SKILL_FILE), { recursive: true });
  writeFileSync(SKILL_FILE, skill);
  console.log(`server/generated.ts and skills/${SKILL_NAME}/SKILL.md written; guide ${skill.length} chars with its frontmatter`);
}
