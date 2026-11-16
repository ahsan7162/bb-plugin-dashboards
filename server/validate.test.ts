// The save check: one test per refusal, the guide's examples passing, and lang-core's token kinds pinned.
//
// Known parser leniency (lang-core 1.1.1), accepted on purpose rather than writing our own syntax
// checker; the last test below pins it. The parser reports no error, and validateProgram accepts, when:
// - a line that is not a statement follows a valid program (`this is not code`, `hello world = 3`): dropped;
// - there is an extra closing `)`: ignored;
// - a second expression follows the first on one line (`root = A(...) B(...)`): the second is dropped;
// - characters the tokenizer does not know appear (`^^^`): skipped;
// - a statement name is defined twice: the last definition wins.
// An unclosed bracket or string does set meta.incomplete, and that refuses the save.
import { describe, expect, it } from "vitest";
import { tokenize } from "@openuidev/lang-core";
import { examples } from "@openuidev/dashboard-library";
import { EXAMPLES, LIVE_EXAMPLE, SCRIPT_EXAMPLE } from "./generated";
import { MIN_REFRESH_SECONDS, SCRIPT_MIN_REFRESH_SECONDS, sourceSchema } from "./sources";
import { T, validateProgram } from "./validate";

const HEAD = `root = Dashboard([Section("Orders", [Row([Card("Total", [KeyValues([KeyValue("Orders", 42, "number")])])])])])\n`;
const ok = (program: string, sources: string[] = []) => expect(validateProgram(program, sources)).toEqual([]);
const refused = (program: string, sources: string[] = []) => validateProgram(program, sources).join("\n");

describe("validateProgram accepts", () => {
  it.each(EXAMPLES.map((e, i) => [i + 1, e]))("guide and topic example %i (static data)", (_, example) => ok(example));

  it("a small program", () => ok(HEAD));

  it("the original stock example 1 (live data) once its two sources are declared: no false placement or Query refusal", () => {
    expect(examples[0]).toContain(`Query("run_sql"`);
    ok(examples[0]!, ["run_sql", "sales_by_channel"]);
  });

  it("a component in a ternary or @Each when its slot allows it", () => {
    ok(`root = Dashboard([s])\n$wide = true\ns = Section("x", [Row([$wide ? Card("a", [], "full") : Card("b", [])])])`);
    ok(`root = Dashboard([s])\ns = Section("x", [Row(@Each(["A", "B"], "n", Card(n, [])))])`);
  });

  it("the word Mutation or Query in a string, a comment or a field name", () => {
    ok(`root = Dashboard([s])\ns = Section(t.mutation + "Mutation(\\"delete\\", {}) Query(\\"orders\\")", [])\nt = {mutation: "x"}\n# Mutation("delete", {})\n// Query("orders", {}, {rows: []})`);
  });

  it("a Query of a declared source written as its own statement, plain or @", () => {
    for (const call of ["Query", "@Query"]) {
      ok(`root = Dashboard([s])\norders = ${call}("orders", {}, {rows: []})\ns = Section("Orders", [Kpis([Kpi("Orders", @Count(orders.rows), "number")])])`, ["orders"]);
    }
  });

  it(`a refresh interval written in, at least ${MIN_REFRESH_SECONDS} seconds, or none; a constant statement counts as written in`, () => {
    const query = (interval: string, extra = "") => `root = Dashboard([s])\n$range = "7d"${extra}\norders = Query("orders", {range: $range}, {rows: []}${interval})\ns = Section("Orders", [Kpis([Kpi("Orders", @Count(orders.rows), "number")])])`;
    for (const interval of ["", `, ${MIN_REFRESH_SECONDS}`, ", 60", ", 12.5"]) ok(query(interval), ["orders"]);
    ok(query(", every", "\nevery = 30"), ["orders"]); // the parser inlines it as 30
  });

  it("the guide's live-data example, with its one source declared", () => ok(LIVE_EXAMPLE, ["orders"]));

  it("the guide's script example: its source declaration is valid and its program passes with the script floor", () => {
    expect(sourceSchema.parse(SCRIPT_EXAMPLE.source)).toEqual(SCRIPT_EXAMPLE.source);
    expect(validateProgram(SCRIPT_EXAMPLE.program, ["jobs"], { jobs: SCRIPT_MIN_REFRESH_SECONDS })).toEqual([]);
  });
});

describe("validateProgram refuses", () => {
  it("a program cut off mid-way (parse error)", () => {
    expect(refused(`root = Dashboard([Section("x", [`)).toContain("cut off");
  });

  it("an unknown component and a wrong argument type", () => {
    expect(refused(`root = Dashboard([Foo("x")])`)).toContain("unknown-component");
    expect(refused(`root = Dashboard([Section(42, [])])`)).toContain("type-mismatch");
  });

  it("undefined names and statements root does not reach", () => {
    expect(refused(`root = Dashboard([main])`)).toContain("Undefined names: main");
    expect(refused(HEAD + `extra = Section("Never shown", [])`)).toContain("Statements root does not reach (they would not render): extra");
  });

  it("a program without a Dashboard root", () => {
    expect(refused(``)).toContain("needs a root statement");
    expect(refused(`root = Section("x", [])`)).toContain("needs a root statement");
    expect(refused(`main = Dashboard([])`)).toMatch(/no-root/);
  });

  it.each([
    ["straight in its parent", `root = Dashboard([Section("x", [Row([Bars(["a"], [Series("s", [1])])])])])`, "Bars cannot go in Row.items; it takes Card"],
    ["in a ternary", `root = Dashboard([s])\n$on = true\ns = Section("x", [Row([$on ? Bars(["a"], [Series("s", [1])]) : Card("c", [])])])`, "Bars cannot go in Row.items"],
    ["in @Each", `root = Dashboard([s])\ns = Section("x", [Row(@Each(["a"], "n", Bars([n], [Series("s", [1])])))])`, "Bars cannot go in Row.items"],
    ["where data belongs", `root = Dashboard([Section("x", [Row([Card("c", [KeyValues([KeyValue("a", Card("in", []))])])])])])`, "Card cannot go in KeyValue.value, which takes data"],
    ["at the top", `root = Dashboard([Kpis([Kpi("n", 1, "number")])])`, "Kpis cannot go in Dashboard.children; it takes FilterBar | Section"],
  ])("a misplaced component %s", (_, program, message) => {
    expect(refused(program)).toContain(message);
  });

  it.each([
    ["a top-level statement", `m = Mutation("delete_order", {id: 1})`, 2],
    ["run by @Run in an action", `m = Mutation("delete_order", {})\na = Action([@Run(m)])`, 2],
    ["inline in a component", `s = Section("x", [Mutation("delete_order", {})])`, 2],
    ["inside a ternary", `$on = true\nm = $on ? Mutation("delete_order", {}) : null`, 3],
    ["inside an object", `cfg = {go: Mutation("delete_order", {})}`, 2],
    ["inside @Each", `x = @Each([1, 2], "r", Mutation("delete_order", {id: r}))`, 2],
    ["as a builtin call, @Mutation", `m = @Mutation("delete_order", {})`, 2],
    ["as an inline @Mutation", `s = Section("x", [@Mutation("delete_order", {})])`, 2],
  ])("Mutation %s", (_, body, line) => {
    expect(refused(HEAD + body)).toContain(`Mutation at line ${line}: dashboards are read-only`);
  });

  it("a protocol marker, which would let the renderer show text this check never saw", () => {
    const sneaky = `root = Dashboard([Section(note, [])])\nnote = "harmless\n]]>openui:content\nroot = Dashboard([Section("x", [])])\nm = Mutation('delete_order', {})\n"`;
    expect(refused(sneaky)).toContain(`Protocol marker "]]>openui:" at line 3`);
  });

  it("a well-formed Query of a source that is not declared", () => {
    const program = `root = Dashboard([s])\norders = Query("orders", {}, {rows: []})\ns = Section("Orders", [Kpis([Kpi("Orders", @Count(orders.rows), "number")])])`;
    expect(refused(program)).toContain(`Query("orders") at line 2: "orders" is not a declared source. No sources are declared. Declare it in dashboard_save's sources, or write the values into the program.`);
    expect(refused(program, ["customers"])).toContain(`"orders" is not a declared source. Declared: customers.`);
  });

  it.each([
    ["below the minimum", "5", `Query orders: refreshes every 5 seconds; the minimum is ${MIN_REFRESH_SECONDS}.`],
    ["just below the minimum", String(MIN_REFRESH_SECONDS - 0.5), `refreshes every ${MIN_REFRESH_SECONDS - 0.5} seconds`],
    ["zero", "0", "refreshes every 0 seconds"],
    ["negative", "-30", "refreshes every -30 seconds"],
    ["a $variable", "$every", "the refresh interval must be a number of seconds written in"],
    ["arithmetic", "5 * 6", "the refresh interval must be a number of seconds written in"],
    ["a string", '"30"', "the refresh interval must be a number of seconds written in"],
  ])("a refresh interval that is %s", (_, interval, message) => {
    const program = `root = Dashboard([s])\n$every = 30\norders = Query("orders", {}, {rows: []}, ${interval})\ns = Section("Orders", [Kpis([Kpi("Orders", @Count(orders.rows), "number")])])`;
    expect(refused(program, ["orders"])).toContain(message);
  });

  it(`a script source's refresh interval below its own floor, ${SCRIPT_MIN_REFRESH_SECONDS} seconds; other sources keep theirs`, () => {
    const program = (seconds: number) =>
      `root = Dashboard([s])\njobs = Query("jobs", {}, {rows: []}, ${seconds})\norders = Query("orders", {}, {rows: []}, ${seconds})\ns = Section("Jobs", [Kpis([Kpi("Jobs", @Count(jobs.rows), "number"), Kpi("Orders", @Count(orders.rows), "number")])])`;
    const floors = { jobs: SCRIPT_MIN_REFRESH_SECONDS };
    expect(validateProgram(program(SCRIPT_MIN_REFRESH_SECONDS - 1), ["jobs", "orders"], floors)).toEqual([
      `Query jobs: refreshes every ${SCRIPT_MIN_REFRESH_SECONDS - 1} seconds; the minimum for "jobs" (a script source) is ${SCRIPT_MIN_REFRESH_SECONDS}. Use ${SCRIPT_MIN_REFRESH_SECONDS} or more, or leave it out to load only on open and when its arguments change.`,
    ]);
    expect(validateProgram(program(SCRIPT_MIN_REFRESH_SECONDS), ["jobs", "orders"], floors)).toEqual([]);
  });

  it.each([
    ["as @Query inside a component", `s = Section("x", [Kpis([Kpi("n", @Count(@Query("orders", {}, {rows: []}).rows), "number")])])`],
    ["inside a ternary", `$on = true\nq = $on ? Query("orders", {}, {rows: []}) : null`],
    ["inside an object", `cfg = {data: Query("orders", {}, {rows: []})}`],
    ["inside @Each", `x = @Each(["a"], "r", Query("orders", {id: r}, {rows: []}))`],
    ["inline in a component", `s = Section("x", [Kpis([Kpi("n", @Count(Query("orders", {}, {rows: []}).rows), "number")])])`],
    ["with a computed source name", `src = "orders"\nq = Query(src, {}, {rows: []})`],
    ["with more after the call", `q = Query("orders", {}, {rows: []}).rows`],
  ])("Query %s, even for a declared source, with how to write it", (_, body) => {
    expect(refused(HEAD + body, ["orders"])).toContain('write it as its own statement, name = Query("source", {args}, {defaults}, seconds), with the source name in quotes');
  });
});

describe("lang-core assumptions", () => {
  it("token kind numbers match lang-core's tokenizer (the Mutation and Query scans depend on them)", () => {
    const kinds = tokenize(`a = Card("s", [x], {k: 1})\n@Each(`).map((t) => t.t);
    const { Newline, LParen, RParen, LBrack, RBrack, LBrace, RBrace, Equals, EOF, Str, Ident, Type, BuiltinCall } = T;
    expect(kinds).toEqual([Ident, Equals, Type, LParen, Str, 7, LBrack, Ident, RBrack, 7, LBrace, Ident, 8, 15, RBrace, RParen, Newline, BuiltinCall, LParen, EOF]);
    expect(tokenize(`@Query(`)[0]).toEqual({ t: BuiltinCall, v: "Query" });
    expect(tokenize(`Mutation(`)[0]).toMatchObject({ t: Type, v: "Mutation" });
  });

  it("known leniency: these parse clean and are accepted (see the top of this file)", () => {
    for (const junk of [`\nthis is not code`, `\nhello world = 3`, `)`, ` Dashboard([])`, ` ^^^`]) ok(HEAD.trimEnd() + junk);
    ok(HEAD + `root = Dashboard([Section("Second root wins", [])])`);
  });
});

describe("the plugin's own components", () => {
  // Every new component in a slot that allows it: Card.content, Drawer.content, Section.rows, Tab.rows.
  const EVERY = `root = Dashboard([main])
$tab = "Overview"
$q = ""
$on = false
$top = 5
$sel = ""
main = Section("Ops", [Tabs([Tab("Overview", [Row([card]), Callout("Numbers are invented.", "info"), Markdown("**Read me**"), SearchBox($q, "Search"), Toggle($on, "Only failing"), Slider($top, "Top", 1, 10), Empty("Nothing here", "No data yet"), Frame("Chart", "<p class='x'>hi</p>", {a: 1}), AskAgent("Explain", "Why?"), side]), Tab("Other", [Row([Card("Second", [Badge("Live", "good")])])])], $tab), side2])
card = Card("Items", [RecordList([Record("A-1", "First", "Open", "Kim", "2d", "https://example.com/A-1"), Record(2, "Second")], $sel, {"Open": "warning"}), Badge("New"), LinkOut("Home", "https://example.com"), drawer, SearchBox($q), Toggle($on, "On"), Slider($top, "Top", 1, 9, 2), Markdown("x"), Callout("y"), Empty("z"), Frame("f", "<b>f</b>"), AskAgent("a", "b")], "full")
drawer = Drawer("Details", $sel, [KeyValues([KeyValue("Owner", "Kim")]), RecordList([Record("B", "b")]), Badge("x"), LinkOut("y", "http://example.com/y"), SearchBox($q), Toggle($on, "t"), Slider($top, "s", 0, 1), Markdown("m"), Callout("c", "error", "Title"), Empty("e"), Frame("f", ""), AskAgent("a", "b")])
side = Drawer("In a tab", $sel, [Markdown("details")])
side2 = Drawer("In a section", $sel, [Markdown("details")])`;

  it("passes with each of them in every slot it is allowed in", () => ok(EVERY));

  it.each([
    ["Tabs in a Card", `root = Dashboard([Section("x", [Row([Card("c", [Tabs([Tab("a", [])])])])])])`, "Tabs cannot go in Card.content"],
    ["a Row straight in Tabs", `root = Dashboard([Section("x", [Tabs([Row([Card("c", [])])])])])`, "Row cannot go in Tabs.tabs; it takes Tab"],
    ["a Tab outside Tabs", `root = Dashboard([Section("x", [Tab("a", [])])])`, "Tab cannot go in Section.rows"],
    ["RecordList straight in a Section", `root = Dashboard([Section("x", [RecordList([Record("a", "b")])])])`, "RecordList cannot go in Section.rows"],
    ["a Record outside RecordList", `root = Dashboard([Section("x", [Row([Card("c", [Record("a", "b")])])])])`, "Record cannot go in Card.content"],
    ["a Badge in a Row", `root = Dashboard([Section("x", [Row([Badge("Live")])])])`, "Badge cannot go in Row.items; it takes Card"],
    ["a Callout at the top", `root = Dashboard([Callout("x")])`, "Callout cannot go in Dashboard.children"],
    ["a Drawer in a Drawer", `root = Dashboard([Section("x", [Drawer("a", $s, [Drawer("b", $s, [])])])])`, "Drawer cannot go in Drawer.content"],
    ["a Row in a Drawer", `root = Dashboard([Section("x", [Drawer("a", $s, [Row([Card("c", [])])])])])`, "Row cannot go in Drawer.content"],
    ["Tabs in a Tab", `root = Dashboard([Section("x", [Tabs([Tab("a", [Tabs([Tab("b", [])])])])])])`, "Tabs cannot go in Tab.rows"],
    ["a Badge in a RecordList, through @Each", `root = Dashboard([Section("x", [Row([Card("c", [RecordList(@Each(["a"], "n", Badge(n)))])])])])`, "Badge cannot go in RecordList.records; it takes Record"],
  ])("refuses %s", (_, program, message) => {
    expect(refused(program)).toContain(message);
  });

  it("Frame's HTML is a string: Mutation and Query written in it are not tokens", () => {
    ok(`root = Dashboard([Section("x", [Frame("f", "<script>const Mutation = 1; Query('orders'); Mutation('delete_order', {})</script>")])])`);
  });

  it("a protocol marker cannot hide in Frame's HTML", () => {
    const program = `root = Dashboard([Section("x", [Frame("f", "<p>]]>openui:content\\nroot = Dashboard([])</p>")])])`;
    expect(refused(program)).toContain(`Protocol marker "]]>openui:"`);
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["javascript: in capitals, with spaces", "  JavaScript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["file:", "file:///etc/hosts"],
    ["a relative path", "/admin"],
    ["a bare word", "example"],
  ])("refuses a written-in %s link in LinkOut and Record", (_, url) => {
    const at = (body: string) => refused(`root = Dashboard([Section("x", [Row([Card("c", [${body}])])])])`);
    expect(at(`LinkOut("Open", ${JSON.stringify(url)})`)).toContain(`LinkOut.url ${JSON.stringify(url.slice(0, 60))}: only http and https links can open`);
    expect(at(`RecordList([Record("a", "b", null, null, null, ${JSON.stringify(url)})])`)).toContain("Record.link");
    expect(at(`RecordList(@Each([1], "n", Record(n, "b", null, null, null, ${JSON.stringify(url)})))`)).toContain("Record.link");
  });

  it("refuses a bad link written in a statement of its own (the parser inlines it); one computed from parts passes, and renders as text", () => {
    const body = (url: string) => `root = Dashboard([Section("x", [Row([Card("c", [LinkOut("a", u)])])])])\nu = ${url}`;
    expect(refused(body(`"javascript:alert(1)"`))).toContain("LinkOut.url");
    ok(body(`"java" + "script:alert(1)"`)); // computed: only the render guard sees it (components.test.tsx)
  });

  it("accepts http and https links, and links that come from data (the components check those when they render)", () => {
    ok(`root = Dashboard([Section("x", [Row([Card("c", [LinkOut("a", "https://example.com/a?b=1"), LinkOut("b", "http://example.com"), RecordList(@Each(rows, "r", Record(r.id, r.title, null, null, null, r.link)))])])])])\nrows = [{id: 1, title: "t", link: "javascript:alert(1)"}]`);
  });
});
