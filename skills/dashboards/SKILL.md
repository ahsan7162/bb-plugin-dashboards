---
name: dashboards
description: "Use when the user wants to keep, reopen, come back to or change later what they ask for, or wants it to refresh: a dashboard, report, tracker or small tool, saved as a dashboard that opens in bb's side panel. A chart or table that only answers the current message stays in the reply."
---

A dashboard (also a report, tracker or small tool) is what the user keeps, reopens in bb's side panel and changes by asking again: one OpenUI Lang program under the Dashboard root, with its data written in or loaded from sources it declares (topic live-data).

Save it with dashboard_save (title and program). The save checks the whole program; on any problem it stores nothing and lists the problems: fix them and save again. On success, put the card block it returns in your reply; it opens the dashboard.

To change a dashboard, get its program with dashboard_get and its id, then save the id with a patch of only the new or changed statements (`name = null` removes one; statements root no longer reaches are dropped), or with program to replace it all.

## OpenUI Lang

- One statement per line, `name = Expression`, starting with `root = Dashboard(...)`.
- Expressions: "strings", numbers, true, false, null, [lists], {objects}, component calls `Name(arg1, arg2)` and built-ins. A name can be used before its statement.
- `$name = default` declares state; an argument marked `$binding<type>` takes a $variable and reads and writes it.
- Operators: + (also joins strings), -, *, /, %, ==, !=, >, <, >=, <=, &&, ||, !, `cond ? a : b`, parentheses. `a.field` reads a field; on a list, every item's field (a pluck); `a[0]` and `a[key]` index.

## Layout components

Arguments marked ? are optional.
Dashboard(children: (FilterBar | Section)[]) — The root.
Section(title: string, rows: (Kpis | Row | Tabs | Drawer | SearchBox | Toggle | Slider | Markdown | Callout | Empty | Frame | AskAgent | Freshness | RefreshButton)[], description?: string) — A titled group of Kpis strips and Rows of Cards. Pass "" as title for the lead KPI section.
Row(items: Card[], height?: 240 | 320 | 400 | 480 | 560 | 640) — Cards side by side on a 12-column grid; their widths add up to a full row. Every card in a row is the same height, one of 240, 320, 400, 480, 560 or 640 px, and its chart stretches to fill it. Leave height out and the row picks one from its content: 400 for charts, 560 for tables, GeoMap and Flow, 480 for PointMap and Cohorts, 320 for summaries (Stat, KeyValues, SegmentedBar).
Card(title: string, content: (Stat | TimeSeries | SmallMultiples | Bars | Dumbbell | Distribution | Donut | Treemap | Waterfall | Intervals | StatusTimeline | Flow | Scatter | GeoMap | PointMap | Funnel | Cohorts | Heatmap | Table | Leaderboard | Goal | SegmentedBar | KeyValues | Drawer | SearchBox | Toggle | Slider | Markdown | Callout | Empty | Frame | AskAgent | Freshness | RefreshButton | RecordList | Badge | LinkOut)[], width?: Width, subtitle?: string, controls?: (ChipFilter | SelectFilter)[]) — content stacks top to bottom, usually [Stat?, one visual]. Default width "half". title says what is plotted; subtitle gives units, period or source ("Weekly · USD"). controls are this card's own switches, shown in its header: a ChipFilter or SelectFilter for what the card is broken down by or which metric it plots, e.g. Card("Top sources", [Leaderboard(...)], "half", "Visitors", [ChipFilter($sourceBy, [{value: "channel", label: "Channel"}, {value: "domain", label: "Domain"}])]).
Shared argument types: Format = "number" | "compact" | "currency" | "currency-compact" | "currency-precise" | "percent" | "ratio" | "multiplier" | "duration" | "ms" | "days", or {type, currency?, decimals?, prefix?, suffix?} to override, e.g. {type: "number", suffix: " seats"}. Width = "quarter" | "third" | "half" | "two-thirds" | "three-quarters" | "full". GoodWhen = "up" | "down" | "neutral": which direction of change is good news.
Numbers are raw with a Format; never formatted strings like "$1.2K" or "12%". percent values are already percentages (18.4 = 18.4%); ratio is for fractions; duration is seconds, ms milliseconds, days days. A Kpi's text value is for words (a plan, a status, a version), never a number.
To skip an optional argument before one you need, pass null: Kpi("Signups", 2227, "number", null, null, "New accounts").
Story order: a lead Section with one Kpis strip of 3–6 headline numbers, then trends, then breakdowns, then detail tables. Don't size Kpis: the strip lays them out. A number that needs a chart beside it is a Card with a Stat.
Charts are grouped below by the question they answer: Trends (over time), Comparison (across categories), Composition (part of a whole), Flow (between stages), Relationships (two measures or axes), Maps (by place). Pick the group by the question, then the chart. One unit per chart (no dual axes); split different units into separate charts.

## Built-ins

The only functions; never invent others, and compute values instead of writing results in: @Count(list), @First(list), @Last(list), @Sum(numbers), @Avg(numbers), @Min(numbers), @Max(numbers), @Round(n, decimals?), @Abs(n), @Floor(n), @Ceil(n) (n a number or a list), @Sort(list, field, "asc" | "desc"), @Filter(list, field, op, value) with op "==", "!=", ">", "<", ">=", "<=" or "contains", @Each(list, "t", template). They compose: @Count(@Filter(rows, "status", "==", "Late")), @Round(@Avg(rows.score), 1). @Each's loop variable exists only inside its template, so write the template inline, never as its own statement: @Each(rows, "t", Record(t.id, t.title)).

## Rules

- Dashboard holds an optional FilterBar first, then Sections. A Section holds Kpis strips and Rows. A Row holds Cards. Every chart, map, Table, Stat, Goal and KeyValues goes inside a Card's content, never straight into a Row or a Section.
- Arrays that go together have the same length and order: labels with values, a Series' values with its previous, every Column of one Table. Never write null for a value a component requires, such as a KeyValue's value: leave that row or item out.
- Previous values are the same measure for the period before, in the same unit. When you don't have them, leave them out: never repeat the current values or invent a change.
- Without a source, write every value into the program as literals: the numbers you gathered, or invented ones only when the user asks for sample data.
- A pluck on a list of rows gives one value per row. @Filter(pkgs.rows, "name", "==", "react").downloads is a list holding that row's list, not its numbers, so @Sum of it is 0 and a chart of it is empty. To read one row, take it first, then its fields: react = @First(@Filter(pkgs.rows, "name", "==", "react")), then react.downloads. The same for a result of one row: totals = @First(sales.rows), then Kpi("Revenue", totals.revenue, "currency-compact").
- Write the statements in this order: root, $variables, Queries, the FilterBar and Sections, then written-in data last.

## Read-only and safe

A dashboard only shows data: nothing in it writes anywhere. It gets data only from the program itself or from the sources it declares, each read with its own top-level statement: name = Query("source", {args}, {defaults}, seconds) (topic live-data). Links open only http and https addresses. Never put a secret, token or password in a program. You cannot add a connection or approve a script: only the user does, in bb, and you never try by any route (topic scripts).

## With inline UI in the same reply

If the chat can draw inline UI, the dashboard's card is still its own code block, with the language bb-dashboard, exactly as dashboard_save returns it; never put it inside an openui-lang block. The reply may sum up in plain text or a small inline block, but does not repeat the whole dashboard inline. When the user asks to change something already saved as a dashboard, change the dashboard instead of drawing a new inline chart.

## Example

A static dashboard with invented data:
root = Dashboard([lead, trends, detail])
lead = Section("", [Kpis([Kpi("Revenue", @Sum(revenue), "currency-compact", @Sum(previous)), Kpi("Orders", @Sum(orders), "number"), Kpi("Refunds", 12, "number", 15, "down")])])
trends = Section("Trends", [Row([Card("Revenue by week", [TimeSeries(weeks, [Series("Revenue", revenue, previous)], "area", "currency-compact")], "two-thirds", "USD"), Card("Orders by channel", [Donut(channels, orders, "number", "Orders")], "third")])])
detail = Section("Detail", [Row([Card("Channels", [Table([Column("Channel", channels, "primary"), Column("Orders", orders, "number", "number"), Column("Revenue", sales, "number", "currency")])], "full")])])
weeks = ["Week 1", "Week 2", "Week 3", "Week 4"]
revenue = [8240, 8610, 8910, 9420]
previous = [7980, 8250, 8370, 8640]
channels = ["Web shop", "Market stall", "Wholesale"]
orders = [590, 214, 80]
sales = [21460, 8940, 4780]

## Before you save

- root = Dashboard(...) is the first statement, and each statement is on its own line.
- Every name you use is defined, and every statement is reached from root; an unreached one never renders.
- Arguments are positional, never name: value; leave optional ones off the end, or pass null to skip one.
- Strings use double quotes, with a backslash before a quote or a backslash inside.
- Each $variable is declared with its starting value and read by something.

## More components and detail

Get a signature before you use a component beyond these four: dashboard_get with components: ["Bars", "Table"] (several per call), or topic: a group below, for all its signatures, which one to pick and an example. Read a topic before you use what it covers.
- filters: FilterBar, PeriodPicker, DateRangeFilter, ChipFilter, SelectFilter, MultiSelectFilter, CompareToggle
- metrics: Kpis, Kpi, Trend, Progress, Split, States, Stat, KeyValues, KeyValue, Goal
- tables: Table, Column
- trends: TimeSeries, Series, Reference, Marker, SmallMultiples, StatusTimeline
- comparison: Bars, Leaderboard, Dumbbell, Distribution, Intervals
- composition: Donut, SegmentedBar, Treemap, Waterfall
- flow: Funnel, Flow
- relationships: Scatter, Heatmap, Cohorts
- maps: GeoMap, PointMap
- views: Tabs, Tab, RecordList, Record, Drawer, SearchBox, Toggle, Slider, Badge, LinkOut, Markdown, Callout, Empty, AskAgent: this plugin's own, for tabs, drill-down, search and notes.
- frame: Frame, your own HTML, CSS and JS for what no component can draw.
- live-data: loading data from sources with Query: files, git, the pull request, data you fetch yourself; Freshness and RefreshButton.
- mcp: sources from MCP connections the user added.
- scripts: script sources, which only the user can approve.
- themes: a dashboard's own colours, radius, spacing and font (dashboard_save's theme).
- guide: this text.
