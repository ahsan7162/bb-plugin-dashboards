// The generated file and the skill are current, cover the merged library, and the guide and its topics
// say only what is built.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { library as dashboard } from "@openuidev/dashboard-library";
import { EXAMPLES, GUIDE, LIVE_EXAMPLE, SCHEMA, SCRIPT_EXAMPLE, SIGNATURES, SKILL_NAME, THEME_TOKENS, TOPICS } from "../server/generated";
import { MIN_REFRESH_SECONDS, SCRIPT_MIN_REFRESH_SECONDS } from "../server/sources";
import { library } from "../ui/library";
import manifest from "../package.json";
import { generate, SKILL_FILE } from "./generate";

// The plugin's own components (PLAN section 5): the first release's and live data's (milestone 3).
const OWN = ["Tabs", "Tab", "Drawer", "SearchBox", "Toggle", "Slider", "RecordList", "Record", "Badge", "LinkOut", "Markdown", "Callout", "Empty", "Frame", "AskAgent"];
const LIVE = ["Freshness", "RefreshButton"];

describe("server/generated.ts", () => {
  it("matches what `npm run generate` writes now, and so does the skill", () => {
    const { server, skill } = generate(library);
    expect(readFileSync(new URL("../server/generated.ts", import.meta.url), "utf8")).toBe(server);
    expect(readFileSync(SKILL_FILE, "utf8")).toBe(skill);
  });

  it("covers the merged library: the 45 dashboard components plus the plugin's 17, root Dashboard, 88 theme tokens", () => {
    expect(Object.keys(dashboard.components)).toHaveLength(45);
    expect(Object.keys(SIGNATURES).sort()).toEqual([...Object.keys(dashboard.components), ...OWN, ...LIVE].sort());
    expect(Object.keys(SCHEMA.$defs!)).toEqual(expect.arrayContaining(Object.keys(SIGNATURES)));
    expect(SIGNATURES.Dashboard).toBe("Dashboard(children: (FilterBar | Section)[]) — The root.");
    expect(THEME_TOKENS).toHaveLength(88);
    expect(THEME_TOKENS).toContain("accent");
  });

  it("puts the new components in Card.content and Section.rows (and Drawer.content, Tab.rows), never in a Row", () => {
    const rows = SIGNATURES.Section!.split(" — ")[0]!;
    const content = SIGNATURES.Card!.split(" — ")[0]!;
    expect(SIGNATURES.Row).toMatch(/^Row\(items: Card\[\]/);
    expect(rows).toContain("rows: (Kpis | Row | Tabs | Drawer | SearchBox | Toggle | Slider | Markdown | Callout | Empty | Frame | AskAgent | Freshness | RefreshButton)[]");
    expect(content).toContain("| KeyValues | Drawer | SearchBox | Toggle | Slider | Markdown | Callout | Empty | Frame | AskAgent | Freshness | RefreshButton | RecordList | Badge | LinkOut)[]");
    expect(SIGNATURES.Tab).toContain("rows: (Kpis | Row | Drawer |");
    expect(SIGNATURES.Drawer).toContain("| KeyValues | SearchBox |");
    expect(SIGNATURES.Drawer).not.toMatch(/content: \([^)]*\bDrawer\b/);
  });
});

// Everything an agent can be shown: the core guide (the skill's body) and every topic.
const ALL = [GUIDE, ...Object.values(TOPICS)].join("\n\n");

describe("the skill", () => {
  it("is the manifest's one skill: its folder and frontmatter name are the name configure selects, its body is the guide", () => {
    expect(manifest.bb.skills).toEqual(["skills"]);
    expect(SKILL_FILE.pathname.endsWith(`/skills/${SKILL_NAME}/SKILL.md`)).toBe(true);
    const [, frontmatter, body] = readFileSync(SKILL_FILE, "utf8").match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)\n$/)!;
    expect(frontmatter!.split("\n")[0]).toBe(`name: ${SKILL_NAME}`);
    expect(body).toBe(GUIDE);
    expect(TOPICS.guide).toBe(GUIDE);
  });

  it("has a two-sentence description that leads with keeping and refreshing and leaves answers to this message in the reply", () => {
    const description = JSON.parse(readFileSync(SKILL_FILE, "utf8").match(/^description: (".*")$/m)![1]!) as string;
    expect(description.length).toBeLessThanOrEqual(300);
    const [first, second, ...more] = description.split(/(?<=\.) /);
    expect(more).toEqual([]);
    for (const word of ["keep", "reopen", "come back to", "change later", "refresh", "dashboard", "report", "tracker", "small tool", "side panel"]) expect(first).toContain(word);
    expect(second).toBe("A chart or table that only answers the current message stays in the reply.");
  });
});

describe("the authoring guide and its topics", () => {
  it("keep the core guide under 10,500 characters and name every topic in it, so each can be asked for", () => {
    expect(GUIDE.length).toBeLessThanOrEqual(10_500);
    for (const topic of Object.keys(TOPICS)) expect(GUIDE).toContain(`\n- ${topic}: `);
    for (const [, topic] of ALL.matchAll(/\(topic ([a-z-]+)\)/g)) expect(Object.keys(TOPICS)).toContain(topic);
  });

  it("drop the stock rules against tabs, text blocks and refresh buttons", () => {
    expect(ALL).not.toContain("Tabs or text and markdown blocks");
    expect(ALL).not.toContain("refresh button");
  });

  it("teach no Mutation and no SQL-building example; Query only over declared sources", () => {
    expect(ALL).not.toMatch(/Mutation|run_sql|SELECT /);
    expect(GUIDE).toContain('name = Query("source", {args}, {defaults}, seconds)');
    expect(ALL.match(/Query\(/g)!.length).toBe(ALL.match(/Query\("(source|orders|jobs)"/g)!.length);
  });

  it("keep the checks before a save in the core guide, without the stock streaming text", () => {
    const before = GUIDE.slice(GUIDE.indexOf("## Before you save"));
    for (const rule of ["root = Dashboard(...) is the first statement", "each statement is on its own line", "Every name you use is defined, and every statement is reached from root", "Arguments are positional", "Strings use double quotes"]) expect(before).toContain(rule);
    expect(before.slice(0, before.indexOf("\n## ")).length).toBeLessThanOrEqual(600);
    expect(GUIDE).not.toMatch(/stream/i);
  });

  it("say how a dashboard sits beside inline UI in the same reply, naming no other plugin", () => {
    const inline = GUIDE.slice(GUIDE.indexOf("## With inline UI in the same reply"));
    expect(inline).toContain("If the chat can draw inline UI, the dashboard's card is still its own code block, with the language bb-dashboard, exactly as dashboard_save returns it; never put it inside an openui-lang block.");
    expect(inline).toContain("does not repeat the whole dashboard inline");
    expect(inline).toContain("When the user asks to change something already saved as a dashboard, change the dashboard instead of drawing a new inline chart.");
    expect(ALL).not.toMatch(/Live Replies/i);
  });

  it("keep the read-only and never-approve rules in the core guide", () => {
    expect(GUIDE).toContain("A dashboard only shows data: nothing in it writes anywhere.");
    expect(GUIDE).toContain("You cannot add a connection or approve a script: only the user does, in bb, and you never try by any route");
    expect(GUIDE).toContain("Never put a secret, token or password in a program.");
  });

  it("explain live data: sources, the minimum interval, Freshness, RefreshButton, agent refresh, and a JSON-file example", () => {
    const live = TOPICS["live-data"]!;
    for (const kind of ["file", "git_commits", "git_changes", "pull_request", "agent", "mcp"]) expect(live).toContain(`- ${kind}:`);
    expect(live).toContain("on the base branch itself, or with no base branch, only the uncommitted work"); // what readChanges does there
    expect(live).toContain("file, git, pull_request and mcp sources refresh themselves");
    expect(live).toContain("You cannot add or change a connection");
    expect(live).toContain(`at least ${MIN_REFRESH_SECONDS}`);
    expect(live).toContain("keep the data out of the program");
    expect(live).toContain("save only id and data, never a new program");
    for (const name of LIVE) expect(live).toContain(SIGNATURES[name]);
    expect(live).toContain('sources: [{name: "orders", kind: "file", path: "data/orders.json"}]');
    expect(live).toContain(LIVE_EXAMPLE);
  });

  it("explain mcp sources: the declaration, fixed and overridable args, and that a connection cannot be added", () => {
    expect(TOPICS.mcp).toContain('{name: "stock", kind: "mcp", connection: "widget-shop", tool: "count_widgets", args: {colour: "teal"}, overridable: ["colour"]}');
    expect(TOPICS.mcp).toContain("a Query's args may set only the names in overridable");
    expect(TOPICS.mcp).toContain("You cannot add or change a connection");
  });

  it("explain the theme: its shape, the value rule and all 88 token names", () => {
    expect(TOPICS.themes).toContain("no url()");
    expect(TOPICS.themes).toContain("sans (system sans-serif), serif or mono (monospace)");
    expect(TOPICS.themes).toContain(`The 88 tokens: ${THEME_TOKENS.join(", ")}.`);
  });

  it("explain script sources: when to use one, how to write it, that only the user approves it, and an invented example", () => {
    const scripts = TOPICS.scripts!;
    expect(scripts).toContain("only when no connection and no built-in source reaches the data");
    expect(scripts).toContain("reads the Query's args as JSON on standard input and prints one JSON value on standard output");
    expect(scripts).toContain("Only read-only commands and read-only credentials");
    expect(scripts).toContain("Never put a secret in the code");
    expect(scripts).toContain("Tell the user to read and approve the script in the panel");
    expect(scripts).toContain("Never approve a script yourself, by any route: not with a tool, not with bb's command line, not through the plugin's RPC or its database");
    expect(scripts).toContain(`at least ${SCRIPT_MIN_REFRESH_SECONDS}`);
    expect(scripts).toContain("not on Windows");
    expect(scripts).toContain(JSON.stringify(SCRIPT_EXAMPLE.source));
    expect(scripts).toContain(SCRIPT_EXAMPLE.program);
  });

  it("show the static examples where they belong: the core one in the guide, the shop with the filters, the stock ones with their charts, Frame's with Frame", () => {
    expect(GUIDE).toContain(EXAMPLES[4]);
    expect(TOPICS.filters).toContain(EXAMPLES[0]);
    expect(TOPICS.filters).toContain(`Column("Channel", ["Web shop", "Market stall", "Wholesale"], "primary")`);
    expect(TOPICS.composition).toContain(EXAMPLES[1]);
    expect(TOPICS.composition).toContain("Revenue by channel");
    expect(TOPICS.comparison).toContain(EXAMPLES[2]);
    expect(TOPICS.comparison).toContain("Where tickets come from");
    expect(TOPICS.frame).toContain(EXAMPLES[5]);
    expect(EXAMPLES[5]).toContain("Frame(");
  });

  it("move the filter and Goal rules to their topics, with each group's advice and every signature in it", () => {
    expect(TOPICS.filters).toContain("A filter is connected only through its first argument");
    expect(TOPICS.filters).toContain("Leave out DateRangeFilter and MultiSelectFilter");
    expect(TOPICS.metrics).toContain("A Goal needs a target above 0");
    for (const group of dashboard.componentGroups!.filter((g) => g.name !== "Structure")) {
      for (const name of group.components) expect(TOPICS[group.name.toLowerCase()]).toContain(SIGNATURES[name]);
    }
  });

  it("explain the new components and the drill-down, with an example using Tabs, RecordList and Drawer", () => {
    const views = TOPICS.views!;
    expect(views).toContain("## Views, drill-down and free content");
    expect(views).toContain('picked = @First(@Filter(rows, "id", "==", $selected))');
    expect(views).toContain("Nothing new goes in a Row");
    const example = EXAMPLES[3]!;
    expect(views).toContain(example);
    for (const call of ["Tabs([", "Tab(", "RecordList(", "Record(", "Drawer(", "$selected"]) expect(example).toContain(call);
    for (const name of OWN.filter((n) => n !== "Frame")) expect(views).toContain(SIGNATURES[name]);
    expect(TOPICS.frame).toContain(SIGNATURES.Frame);
  });

  it("name every component in the core guide and how to get its signature", () => {
    for (const name of Object.keys(SIGNATURES)) expect(GUIDE).toMatch(new RegExp(`\\b${name}\\b`));
    expect(GUIDE).toContain('dashboard_get with components: ["Bars", "Table"]');
  });

  it("name no network call the bundle checks forbid (the guide and topics ship in server.js)", () => {
    expect(ALL + JSON.stringify(SIGNATURES)).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
  });
});
