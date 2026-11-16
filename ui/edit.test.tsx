// @vitest-environment jsdom
// Edit mode in the dashboard view, in bb's frontend harness with the real plugin server in its fake host
// and dashboards rendered through the library that ships: picking a part (with the pointer, through the
// breadcrumbs, by keyboard), where it is in the program, the one message it sends and where it goes.
// jsdom lays nothing out, so every element is given a box here; which part the pointer hits is the
// browser's work (deeper parts sit higher), checked here through the z-index.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createPlugin } from "../server";
import { EXAMPLES } from "../server/generated";
import { FOLDER, TEST_PATH, memorySecrets, startHost } from "../test/host";
import { POPOVER, QUOTE_CAP, REQUEST_CAP, editable, placePopover } from "./edit";
import { CONTROL } from "./colours";
import { DashboardsPage } from "./gallery";
import { library } from "./library";
import { DashboardTab, DashboardView } from "./panel";

const TRENDS = `trends = Section("Trends", [Row([Card("Revenue by week", [TimeSeries(["W1", "W2", "W3"], [Series("Revenue", [820, 860, 910])])]), Card("Refunds", [Stat(12, "number")]), orders])])`;
const ORDERS = `orders = Card("Orders in " + $range, [Stat(42, "number")])`;
const PROGRAM = `root = Dashboard([filters, trends, queue, views, listed])
$range = "7d"
$picked = null
$tab = "Overview"
$open = false
filters = FilterBar([ChipFilter($range, [{value: "7d", label: "7D"}, {value: "30d", label: "30D"}])])
${TRENDS}
${ORDERS}
queue = Section("Queue", [Row([Card("Tickets", [KeyValues([KeyValue("Open tickets", @Count(tickets.rows), "number")]), RecordList([Record("T-1", "Refund not received", "Open")], $picked), LinkOut("Open the help desk", "https://helpdesk.example.com"), AskAgent("Explain", "Why is the queue long?"), RefreshButton("Refresh tickets", "tickets")])])])
tickets = Query("tickets", {}, {rows: []})
views = Section("Views", [Tabs([overview, Tab("Errors", [Row([Card("Error count", [Stat(0, "number")])])])], $tab), Toggle($open, "Only open")])
overview = Tab("Overview", [Row([Card("In a tab", [Stat(1, "number")])])])
listed = Section("Listed", [Row(cards)])
cards = [Card("From a list", [Stat(3, "number")])]`;
const TICKETS = { sources: [{ name: "tickets", kind: "agent" }], data: { tickets: { rows: [{ id: 1 }, { id: 2 }] } } };

const send = vi.fn(async () => ({ delivery: "sent" as const, ok: true as const }));
beforeEach(() => {
  localStorage.clear();
  send.mockClear();
  // No layout in jsdom: every element gets a box, so every part that draws something gets its button.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 20));
});
afterEach(() => vi.restoreAllMocks());

const FILES = { [`${FOLDER}/data/orders.json`]: JSON.stringify({ rows: [{ id: "A-1001", customer: "Corner Bakery" }] }) };
async function setup(program = PROGRAM, extra: object = TICKETS, title = "Shop sales") {
  const host = await startHost(async () => (await import("../server")).default, FILES);
  const saved = await host.save({ title, program, ...extra });
  expect(saved.error, saved.text).toBe(false);
  const rpc = Object.fromEntries(["read", "list", "source_run"].map((m) => [m, (input: unknown) => host.harness.behavior.callRpc(m, input)])) as never;
  return { ...host, id: saved.id!, rpc };
}

type Slot = ReturnType<typeof renderSlot>;
type Host = Awaited<ReturnType<typeof setup>>;
const inTab = (host: Host) => renderSlot({ component: DashboardTab }, { threadId: "thread-1", environment: null, params: { dashboardId: host.id } }, { rpc: host.rpc, sdk: { threads: { send } }, openUrl: () => true });
const editButton = (slot: Slot) => slot.getByRole("button", { name: "Edit" });
const content = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-dashboard-mode] > div > div")!;
const spot = (slot: Slot, name: string) => slot.getByRole("button", { name });
const popover = (slot: Slot) => slot.getByRole("dialog");
const pickedName = (slot: Slot) => popover(slot).getAttribute("aria-labelledby") && slot.getByRole("dialog").querySelector("p")!.textContent;
const runs = (slot: Slot) => slot.inspection.rpcCalls.filter((c) => c.method === "source_run").length;
const sent = () => (send.mock.calls as unknown as [{ threadId: string; input: { text: string }[] }][]).map(([args]) => ({ threadId: args.threadId, text: args.input[0]!.text }));

async function opened(host: Host) {
  const slot = inTab(host);
  await slot.findByText("Revenue by week");
  await waitFor(() => expect(runs(slot)).toBe(1)); // the tickets query answered
  fireEvent.click(editButton(slot));
  return slot;
}
async function request(slot: Slot, part: string, text: string) {
  fireEvent.click(spot(slot, part));
  fireEvent.change(slot.getByLabelText("What should change?"), { target: { value: text } });
  fireEvent.click(slot.getByRole("button", { name: "Send" }));
  await slot.findByText("Change request sent to the dashboard's thread.");
}

describe("the Edit toggle", () => {
  test("turns Edit mode on and off: pressed state, the hint, the inert dashboard and one button per part", async () => {
    const host = await setup();
    const slot = await opened(host);
    expect(editButton(slot).getAttribute("aria-pressed")).toBe("true");
    const hint = slot.getByText("Edit mode: click a part of the dashboard, or Tab to it and press Enter, then say what should change. Escape leaves.");
    expect(hint.getAttribute("aria-live")).toBe("polite"); // there all along, so the change is announced
    expect(content(slot).hasAttribute("inert")).toBe(true);
    const names = Array.from(slot.container.querySelectorAll(".bbd-spot"), (b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "FilterBar",
      'ChipFilter "7D / 30D"',
      'Section "Trends"',
      'Card "Revenue by week"',
      'TimeSeries "Revenue"',
      'Card "Refunds"',
      "Stat",
      'Card "Orders in 7d"',
      "Stat",
      'Section "Queue"',
      'Card "Tickets"',
      'KeyValues',
      "RecordList",
      'LinkOut "Open the help desk"',
      'AskAgent "Explain"',
      'RefreshButton "Refresh tickets"',
      'Section "Views"',
      'Tabs "Overview / Errors"',
      'Card "In a tab"',
      "Stat",
      'Toggle "Only open"',
      'Section "Listed"',
      'Card "From a list"',
      "Stat",
    ]); // in page order; no Dashboard, Row or Tab, which the user does not see as a thing

    fireEvent.click(editButton(slot));
    expect(editButton(slot).getAttribute("aria-pressed")).toBe("false");
    expect(hint.textContent).toBe("");
    expect(content(slot).hasAttribute("inert")).toBe(false);
    expect(slot.container.querySelector(".bbd-spot")).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  test("Edit, Colours and the version list sit together in one group, in that order, in one shared box, pressed or not", async () => {
    const host = await setup();
    const onPage = () => renderSlot({ component: DashboardsPage }, { subPath: host.id }, { rpc: host.rpc, sdk: { threads: { send, list: async () => [] as never } } });
    for (const render of [() => inTab(host), onPage]) {
      const slot = render(); // the tab, then the Dashboards page: one view, one header
      await slot.findByText("Revenue by week");
      const group = slot.getByRole("group", { name: "View controls" });
      const controls = Array.from(group.querySelectorAll("button, select"));
      expect(controls).toEqual([editButton(slot), slot.getByRole("button", { name: "Colours" }), slot.getByLabelText("Version")]);
      for (const control of controls) expect(control.className.startsWith(`${CONTROL}`)).toBe(true);
      expect(group.parentElement!.tagName).toBe("HEADER");
      const before = editButton(slot).className;
      fireEvent.click(editButton(slot));
      expect(editButton(slot).className).toBe(before); // aria-pressed:bg-accent fills it; the box stays
      slot.lifecycle.unmount();
    }
  });

  test("toggling it neither remounts the Renderer nor fetches the data again", async () => {
    const program = `root = Dashboard([main])\norders = Query("orders", {}, {rows: []})\nfirst = @First(orders.rows)\nmain = Section("Orders", [Row([Card("Latest order", [KeyValues([KeyValue("Customer", first.customer)])])])])`;
    const host = await setup(program, { sources: [{ name: "orders", kind: "file", path: "data/orders.json" }] });
    const slot = renderSlot({ component: DashboardView }, { id: host.id, threadId: "thread-1", visible: true }, { rpc: host.rpc });
    const shown = await slot.findByText("Corner Bakery");
    expect(runs(slot)).toBe(1);
    for (let i = 0; i < 4; i++) fireEvent.click(editButton(slot));
    fireEvent.click(editButton(slot));
    fireEvent.click(spot(slot, 'Card "Latest order"'));
    fireEvent.keyDown(slot.getByLabelText("What should change?"), { key: "Escape" });
    fireEvent.click(editButton(slot));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(slot.getByText("Corner Bakery")).toBe(shown); // the same element: nothing was drawn anew
    expect(runs(slot)).toBe(1);
  });

  test("is off on an old version, with the reason, and an old version turns it off", async () => {
    const host = await setup();
    await host.save({ id: host.id, patch: `orders = Card("Orders now", [Stat(43, "number")])` });
    const slot = inTab(host);
    await slot.findByText("Orders now");
    fireEvent.click(editButton(slot));
    fireEvent.change(slot.getByLabelText("Version"), { target: { value: "1" } });
    await slot.findByText("Version 1 of 2, read-only.");
    expect(editButton(slot)).toHaveProperty("disabled", true);
    expect(editButton(slot).getAttribute("aria-pressed")).toBe("false");
    expect(editButton(slot).title).toBe("Old versions are read-only: go back to the latest to request a change");
    expect(slot.container.querySelector(".bbd-spot")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Back to latest" }));
    await slot.findByText("Orders now");
    expect(editButton(slot)).toHaveProperty("disabled", false);
  });
});

describe("picking a part", () => {
  test("the pointer outlines the part under it; deeper parts sit higher, so the innermost is the one hit", async () => {
    const host = await setup();
    const slot = await opened(host);
    const [section, card, chart] = ['Section "Trends"', 'Card "Revenue by week"', 'TimeSeries "Revenue"'].map((name) => spot(slot, name));
    fireEvent.pointerOver(chart!);
    expect([section, card, chart].map((b) => b!.hasAttribute("data-hover"))).toEqual([false, false, true]);
    expect([section, card, chart].map((b) => Number(b!.style.zIndex))).toEqual([2, 4, 5]); // Dashboard 0, Section 1, Row 2, Card 3, TimeSeries 4, plus one
    fireEvent.pointerOver(card!);
    expect([section, card, chart].map((b) => b!.hasAttribute("data-hover"))).toEqual([false, true, false]);
    fireEvent.pointerLeave(slot.container.querySelector(".bbd-edit-layer")!);
    expect(slot.container.querySelector("[data-hover]")).toBeNull();
  });

  test.each([
    ["a filter chip", (s: Slot) => s.getAllByRole("radio", { name: "30D" })[0]!, 'ChipFilter "7D / 30D"'],
    ["a LinkOut", (s: Slot) => s.getByText("Open the help desk"), 'LinkOut "Open the help desk"'],
    ["a Record pick", (s: Slot) => s.getByText("Refund not received"), "RecordList"],
    ["AskAgent", (s: Slot) => s.getByText("Explain"), 'AskAgent "Explain"'],
    ["RefreshButton", (s: Slot) => s.getByText("Refresh tickets"), 'RefreshButton "Refresh tickets"'],
    ["a tab", (s: Slot) => s.getByRole("tab", { name: "Errors" }), 'Tabs "Overview / Errors"'],
    ["a Toggle", (s: Slot) => s.getByRole("switch", { name: "Only open" }), 'Toggle "Only open"'],
  ])("a click that reaches %s picks it and does nothing else", async (_, target, picked) => {
    const host = await setup();
    const slot = await opened(host);
    fireEvent.click(target(slot));
    expect(pickedName(slot)).toBe(picked);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(send).not.toHaveBeenCalled(); // AskAgent and the agent refresh send nothing
    expect(slot.inspection.navigateCalls).toEqual([]); // the link opens nothing
    expect(runs(slot)).toBe(1); // nothing refreshed
    expect(slot.getByText("Orders in 7d")).toBeTruthy(); // the chip did not change $range
    expect(slot.getByText("Refund not received").closest("button")!.getAttribute("aria-pressed")).toBe("false"); // nor the record $picked
    expect(slot.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true"); // nor $tab
    expect(slot.getByRole("switch", { name: "Only open" }).getAttribute("aria-checked")).toBe("false"); // nor $open
    // The same component with Edit off still acts.
    fireEvent.click(editButton(slot));
    fireEvent.click(slot.getAllByRole("radio", { name: "30D" })[0]!);
    expect(await slot.findByText("Orders in 30d")).toBeTruthy();
  });

  test("a click on a part's button picks it; the breadcrumbs pick a container and keep the text", async () => {
    const host = await setup();
    const slot = await opened(host);
    fireEvent.click(spot(slot, 'TimeSeries "Revenue"'));
    expect(pickedName(slot)).toBe('TimeSeries "Revenue"');
    expect(spot(slot, 'TimeSeries "Revenue"').getAttribute("aria-expanded")).toBe("true");
    const crumbs = within(popover(slot)).getByRole("navigation", { name: "Where it is" });
    expect(Array.from(crumbs.querySelectorAll("li"), (li) => li.textContent)).toEqual(['Section "Trends"', '›Card "Revenue by week"', '›TimeSeries "Revenue"']);
    expect(within(crumbs).getByText('TimeSeries "Revenue"').getAttribute("aria-current")).toBe("location");
    fireEvent.change(slot.getByLabelText("What should change?"), { target: { value: "Compare with last year" } });
    fireEvent.click(within(crumbs).getByRole("button", { name: 'Card "Revenue by week"' }));
    expect(pickedName(slot)).toBe('Card "Revenue by week"');
    expect(spot(slot, 'Card "Revenue by week"').getAttribute("aria-expanded")).toBe("true");
    expect((slot.getByLabelText("What should change?") as HTMLTextAreaElement).value).toBe("Compare with last year");
    fireEvent.click(within(popover(slot)).getByRole("button", { name: 'Section "Trends"' }));
    expect(pickedName(slot)).toBe('Section "Trends"');
  });

  test("keyboard: the parts are buttons in page order, picking one moves focus to the text, Escape returns it, a second Escape leaves", async () => {
    const host = await setup();
    const slot = await opened(host);
    const spots = Array.from(slot.container.querySelectorAll<HTMLElement>(".bbd-spot"));
    expect(spots.every((b) => b.tagName === "BUTTON" && b.tabIndex === 0)).toBe(true); // Tab reaches each, in this order
    expect(spots.indexOf(spot(slot, 'Section "Trends"'))).toBeLessThan(spots.indexOf(spot(slot, 'Card "Revenue by week"')));
    const card = spot(slot, 'Card "Refunds"');
    card.focus();
    fireEvent.click(card); // what Enter does on a focused button
    await waitFor(() => expect(document.activeElement).toBe(slot.getByLabelText("What should change?")));
    spot(slot, 'Card "Revenue by week"').focus(); // Shift+Tab out of the popover, back to the parts
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(card); // back to the part it was opened for
    expect(editButton(slot).getAttribute("aria-pressed")).toBe("true"); // the first Escape only closed the popover
    fireEvent.keyDown(card, { key: "Escape" });
    expect(editButton(slot).getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(editButton(slot));
    expect(slot.container.querySelector(".bbd-spot")).toBeNull();
  });

  test("Cancel closes the popover and forgets the text; Edit mode stays on", async () => {
    const host = await setup();
    const slot = await opened(host);
    fireEvent.click(spot(slot, 'Card "Refunds"'));
    fireEvent.change(slot.getByLabelText("What should change?"), { target: { value: "Show it per week" } });
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(slot.queryByRole("dialog")).toBeNull();
    fireEvent.click(spot(slot, 'Card "Refunds"'));
    fireEvent.keyDown(slot.getByLabelText("What should change?"), { key: "Escape" }); // Escape in the text is Cancel too
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(editButton(slot).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(spot(slot, 'Card "Refunds"'));
    expect((slot.getByLabelText("What should change?") as HTMLTextAreaElement).value).toBe("");
    expect(send).not.toHaveBeenCalled();
  });

  test("the core example: each KPI tile, the chart, the donut and the table are parts of their own", async () => {
    const host = await setup(EXAMPLES[4], {});
    const slot = inTab(host);
    await slot.findByText("Revenue by week");
    fireEvent.click(editButton(slot));
    const names = Array.from(slot.container.querySelectorAll(".bbd-spot"), (b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Section",
      'Kpis "Revenue / Orders / Refunds"',
      'Kpi "Revenue"',
      'Kpi "Orders"',
      'Kpi "Refunds"',
      'Section "Trends"',
      'Card "Revenue by week"',
      'TimeSeries "Revenue"',
      'Card "Orders by channel"',
      "Donut",
      'Section "Detail"',
      'Card "Channels"',
      'Table "Channel / Orders / Revenue"',
    ]);
    await request(slot, 'Kpi "Orders"', "Show it per channel.");
    expect(sent()[0]!.text.split("\n")[1]).toBe('Target: Kpi "Orders" in Section > Kpis "Revenue / Orders / Refunds", written inline in statement lead (Kpi 2 of 3 there).');
  });

  test("a Frame is one part, and a click on the frame picks it", async () => {
    const program = `root = Dashboard([main])\nmain = Section("Floor", [Frame("Floor plan", "<p>T1 T2</p>", null, 120)])`;
    const host = await setup(program, {});
    const slot = inTab(host);
    const frame = await slot.findByTitle("Floor plan");
    fireEvent.click(editButton(slot));
    expect(Array.from(slot.container.querySelectorAll(".bbd-spot"), (b) => b.getAttribute("aria-label"))).toEqual(['Section "Floor"', 'Frame "Floor plan"']);
    expect(content(slot).hasAttribute("data-editing")).toBe(true); // [data-editing] iframe takes no pointer events (styles.css)
    fireEvent.click(frame);
    expect(pickedName(slot)).toBe('Frame "Floor plan"');
  });
});

describe("the message", () => {
  test("for a part that is a named statement: the dashboard, version, target, its source and the request, to the tab's thread", async () => {
    const host = await setup();
    const slot = await opened(host);
    await request(slot, 'Card "Orders in 7d"', "  Show the orders as a number with a trend.  ");
    expect(sent()).toEqual([
      {
        threadId: "thread-1",
        text: [
          `Change request for dashboard "Shop sales" (id ${host.id}), version 1.`,
          `Target: Card "Orders in 7d", the statement orders.`,
          "Source of orders:",
          "```openui",
          ORDERS,
          "```",
          "Requested change:",
          "```text",
          "Show the orders as a number with a trend.",
          "```",
          "Change only this with a dashboard_save patch of orders; leave the rest unchanged.",
        ].join("\n"),
      },
    ]);
    // Sent: the popover closes, a status says so, Edit mode is off and focus is back on its button.
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(editButton(slot).getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(editButton(slot));
    expect(content(slot).hasAttribute("inert")).toBe(false);
  });

  test("for an inline part: its containers, the statement it is written in and its place among the same kind there", async () => {
    const host = await setup();
    const slot = await opened(host);
    await request(slot, 'Card "Revenue by week"', "Show the previous period as a dashed line.");
    expect(sent()[0]!.text).toBe(
      [
        `Change request for dashboard "Shop sales" (id ${host.id}), version 1.`,
        `Target: Card "Revenue by week" in Section "Trends", written inline in statement trends (Card 1 of 2 there).`,
        "Source of trends:",
        "```openui",
        TRENDS,
        "```",
        "Requested change:",
        "```text",
        "Show the previous period as a dashed line.",
        "```",
        "Change only this with a dashboard_save patch of trends; leave the rest unchanged.",
      ].join("\n"),
    );
  });

  test.each([
    ["inside a named Tab, which draws nothing itself", 'Card "In a tab"', `Target: Card "In a tab" in Section "Views" > Tabs "Overview / Errors", written inline in statement overview.`, "overview"],
    ["from a list statement another one uses", 'Card "From a list"', `Target: Card "From a list" in Section "Listed", written inline in statement cards, which listed uses.`, "cards"],
    ["deep inside a card", 'TimeSeries "Revenue"', `Target: TimeSeries "Revenue" in Section "Trends" > Card "Revenue by week", written inline in statement trends.`, "trends"],
  ])("an inline part %s maps to the statement that holds its text", async (_, part, target, statement) => {
    const host = await setup();
    const slot = await opened(host);
    await request(slot, part, "Make it taller.");
    const lines = sent()[0]!.text.split("\n");
    expect(lines[1]).toBe(target);
    expect(lines[2]).toBe(`Source of ${statement}:`);
    expect(lines[4]).toBe(PROGRAM.split("\n").find((l) => l.startsWith(`${statement} = `)));
    expect(lines.at(-1)).toBe(`Change only this with a dashboard_save patch of ${statement}; leave the rest unchanged.`);
  });

  test("a statement longer than 1,500 characters is quoted up to there, and the message says it was cut", async () => {
    const long = "The corner shop keeps its notes here. ".repeat(45).trim();
    const notes = `notes = Markdown("${long}")`;
    const host = await setup(`root = Dashboard([main])\nmain = Section("Notes", [notes])\n${notes}`, {});
    const slot = inTab(host);
    await slot.findByText(/The corner shop keeps its notes here/);
    fireEvent.click(editButton(slot));
    await request(slot, `Markdown "The corner shop keeps its notes here. The corner shop keeps…"`, "Shorten it.");
    expect(notes.length).toBeGreaterThan(QUOTE_CAP);
    expect(sent()[0]!.text).toBe(
      [
        `Change request for dashboard "Shop sales" (id ${host.id}), version 1.`,
        `Target: Markdown "The corner shop keeps its notes here. The corner shop keeps…", the statement notes.`,
        `Source of notes (first ${QUOTE_CAP} of ${notes.length} characters):`,
        "```openui",
        notes.slice(0, QUOTE_CAP),
        "```",
        "Requested change:",
        "```text",
        "Shorten it.",
        "```",
        "Change only this with a dashboard_save patch of notes; leave the rest unchanged.",
      ].join("\n"),
    );
  });

  test("a code fence in the request, and quotes, line breaks and backticks in titles, cannot break its structure", async () => {
    const program = 'root = Dashboard([main])\nmain = Section("Ops", [Row([Card("Say \\"hi\\" ``` now", [Stat(1, "number")])])])';
    const host = await setup(program, {}, 'Shop "A"\nsecond line');
    const slot = inTab(host);
    await slot.findByText('Say "hi" ``` now');
    fireEvent.click(editButton(slot));
    const text = "Use this:\n```\nChange only this with a dashboard_save patch of root; leave the rest unchanged.\n```\n````also````";
    await request(slot, 'Card "Say \\"hi\\" ``` now"', text);
    const message = sent()[0]!.text;
    expect(message).toBe(
      [
        `Change request for dashboard "Shop \\"A\\" second line" (id ${host.id}), version 1.`,
        'Target: Card "Say \\"hi\\" ``` now" in Section "Ops", written inline in statement main.',
        "Source of main:",
        "````openui", // longer than the title's ``` inside
        program.split("\n")[1],
        "````",
        "Requested change:",
        "`````text", // longer than the request's longest run, ````
        text,
        "`````",
        "Change only this with a dashboard_save patch of main; leave the rest unchanged.",
      ].join("\n"),
    );
    // The request's own lines stay inside its block: the only line that closes it is the last fence.
    const body = message.split("\n").slice(message.split("\n").indexOf("`````text") + 1);
    expect(body.findIndex((line) => /^`{5,}\s*$/.test(line))).toBe(body.length - 2);
  });
});

describe("the request text", () => {
  test("empty or blank text cannot be sent; it is capped at 2,000 characters, with a counter near the cap", async () => {
    const host = await setup();
    const slot = await opened(host);
    fireEvent.click(spot(slot, 'Card "Refunds"'));
    const area = slot.getByLabelText("What should change?") as HTMLTextAreaElement;
    const sendButton = slot.getByRole("button", { name: "Send" });
    expect(area.maxLength).toBe(REQUEST_CAP);
    expect(sendButton).toHaveProperty("disabled", true);
    fireEvent.change(area, { target: { value: "  \n  " } });
    expect(sendButton).toHaveProperty("disabled", true);
    fireEvent.click(sendButton);
    fireEvent.change(area, { target: { value: "a".repeat(1799) } });
    expect(slot.queryByText(/characters$/)).toBeNull();
    fireEvent.change(area, { target: { value: "a".repeat(1800) } });
    expect(slot.getByText("1800 / 2000 characters")).toBeTruthy();
    fireEvent.change(area, { target: { value: "b".repeat(2100) } }); // a paste past the cap
    expect(area.value).toHaveLength(REQUEST_CAP);
    expect(slot.getByText("2000 / 2000 characters")).toBeTruthy();
    fireEvent.click(sendButton);
    await slot.findByText("Change request sent to the dashboard's thread.");
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.text).toContain(`\`\`\`text\n${"b".repeat(REQUEST_CAP)}\n\`\`\``);
  });
});

describe("where it goes", () => {
  const onPage = (host: Host, found: { id: string; title: string }[]) =>
    renderSlot({ component: DashboardsPage }, { subPath: host.id }, { rpc: host.rpc, sdk: { threads: { send, list: async () => found as never } } });

  test("from the Dashboards page: to the dashboard's origin thread while it exists", async () => {
    const host = await setup();
    const slot = onPage(host, [{ id: "thread-1", title: "Shop numbers" }]);
    await slot.findByText("Revenue by week");
    await vi.waitFor(() => expect(slot.inspection.sdkCalls.map((c) => c.method)).toEqual(["threads.list"]));
    fireEvent.click(editButton(slot));
    await request(slot, 'Card "Refunds"', "Split refunds by reason.");
    expect(sent()).toEqual([{ threadId: "thread-1", text: expect.stringContaining("Target: Card \"Refunds\"") }]);
  });

  test("from the Dashboards page with the origin thread gone: it explains why, keeps the text and sends nothing", async () => {
    const host = await setup();
    const slot = onPage(host, []);
    await slot.findByText("Revenue by week");
    await vi.waitFor(() => expect(slot.inspection.sdkCalls.map((c) => c.method)).toEqual(["threads.list"]));
    fireEvent.click(editButton(slot));
    fireEvent.click(spot(slot, 'Card "Refunds"'));
    fireEvent.change(slot.getByLabelText("What should change?"), { target: { value: "Split refunds by reason." } });
    fireEvent.click(slot.getByRole("button", { name: "Send" }));
    expect((await within(popover(slot)).findByRole("alert")).textContent).toBe("Not sent: the thread this dashboard was made in no longer exists. Ask in any thread and name the dashboard.");
    expect((slot.getByLabelText("What should change?") as HTMLTextAreaElement).value).toBe("Split refunds by reason.");
    expect(editButton(slot).getAttribute("aria-pressed")).toBe("true");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("with a script source waiting for approval", () => {
  const dir = mkdtempSync(join(tmpdir(), "oa-ui-edit-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("Edit mode still works, and nothing runs the script", async () => {
    const host = await startHost(async () => createPlugin({ secrets: memorySecrets(), toolPath: async () => TEST_PATH }), {}, { folder: mkdtempSync(join(dir, "env-")) });
    const program = `root = Dashboard([main])\njobs = Query("jobs", {}, {rows: []})\nmain = Section("Queue", [Row([Card("Jobs", [KeyValues([KeyValue("Queued", @Count(jobs.rows), "number")])])])])`;
    const saved = await host.save({ title: "Job queue", program, sources: [{ name: "jobs", kind: "script", runner: "sh", why: "Counts jobs in the invented queue", code: `printf '{"rows":[1,2]}'` }] });
    expect(saved.error, saved.text).toBe(false);
    const rpc = Object.fromEntries(["read", "list", "source_run", "scripts"].map((m) => [m, (input: unknown) => host.harness.behavior.callRpc(m, input)])) as never;
    const slot = renderSlot({ component: DashboardTab }, { threadId: "thread-1", environment: null, params: { dashboardId: saved.id } }, { rpc, sdk: { threads: { send } } });
    await slot.findByText(/Script "jobs" is waiting for your approval/);
    await slot.findByText("Queued");
    fireEvent.click(editButton(slot));
    await request(slot, 'Card "Jobs"', "Show the oldest job too.");
    expect(sent()[0]!.text.split("\n")[1]).toBe('Target: Card "Jobs" in Section "Queue", written inline in statement main.');
    expect(slot.inspection.rpcCalls.filter((c) => c.method === "source_run")).toEqual([]);
    await host.harness.lifecycle.dispose();
  });
});

describe("the agent's side is unchanged", () => {
  test("the library the view renders with has the shipped library's schema and prompt, so the generated files do not change", () => {
    expect(editable.toJSONSchema()).toEqual(library.toJSONSchema());
    expect(editable.prompt()).toBe(library.prompt());
    expect(editable.root).toBe(library.root);
    expect(Object.keys(editable.components)).toEqual(Object.keys(library.components));
    for (const [name, c] of Object.entries(editable.components)) expect(c.props).toBe(library.components[name]!.props);
  });
});

describe("where the popover goes", () => {
  const size = { width: POPOVER.width, height: 250 };
  const view = { top: 0, left: 0, width: 800, height: 800 };
  const box = (top: number, height: number, left = 40, width = 300) => ({ top, left, width, height });

  test.each([
    ["fits below the part", box(100, 200), view, { top: 306, left: 40, width: 320, height: 250, maxHeight: 784 }],
    ["does not fit below: above it", box(500, 200), view, { top: 244, left: 40, width: 320, height: 250, maxHeight: 784 }],
    ["fits neither (a part taller than the view): inside, at the nearer edge", box(100, 2000), view, { top: 8, left: 40, width: 320, height: 250, maxHeight: 784 }],
    ["fits neither, the part reaching past the bottom: at the bottom edge", box(-500, 1250), view, { top: 542, left: 40, width: 320, height: 250, maxHeight: 784 }],
    ["near the right edge: moved left to stay inside", box(100, 200, 700), view, { top: 306, left: 472, width: 320, height: 250, maxHeight: 784 }],
    ["a narrow panel: narrower than normal, inside both sides", box(100, 200, 1010, 200), { top: 0, left: 1000, width: 280, height: 800 }, { top: 306, left: 1008, width: 264, height: 250, maxHeight: 784 }],
    ["a short panel: its height capped, its content scrolls", box(20, 30), { top: 0, left: 0, width: 800, height: 200 }, { top: 8, left: 40, width: 320, height: 184, maxHeight: 184 }],
    ["the part partly scrolled out above: below what is left of it", box(40, 120), { top: 100, left: 0, width: 800, height: 600 }, { top: 166, left: 40, width: 320, height: 250, maxHeight: 584 }],
    ["the part partly scrolled out below: above it", box(550, 300), { top: 100, left: 0, width: 800, height: 600 }, { top: 294, left: 40, width: 320, height: 250, maxHeight: 584 }],
    ["the part scrolled out of view: at the edge it left by", box(-400, 200), view, { top: 8, left: 40, width: 320, height: 250, maxHeight: 784 }],
  ])("%s", (_, part, visible, expected) => {
    const at = placePopover(part, size, visible);
    expect(at).toEqual(expected);
    expect(at.top).toBeGreaterThanOrEqual(visible.top);
    expect(at.top + at.height).toBeLessThanOrEqual(visible.top + visible.height); // Send and Cancel, at its bottom, are in view
    expect(at.left).toBeGreaterThanOrEqual(visible.left);
    expect(at.left + at.width).toBeLessThanOrEqual(visible.left + visible.width);
  });

  test("the popover is placed when a part is picked, and again when the panel scrolls and the window resizes", async () => {
    let layerTop = 0;
    // The layer at layerTop in the window; every part 100 px below its top, 300 x 200; the popover 250 px tall.
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
      return this.classList.contains("bbd-edit-layer") ? new DOMRect(0, layerTop, 400, 2000) : new DOMRect(0, layerTop + 100, 300, 200);
    });
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: function (this: HTMLElement) { return this.getAttribute("role") === "dialog" ? 250 : 0; } });
    const height = innerHeight;
    try {
      const host = await setup();
      const slot = await opened(host);
      fireEvent.click(spot(slot, 'Card "Refunds"')); // the keyboard path picks with the same click
      const pop = popover(slot);
      const style = () => [pop.style.top, pop.style.left, pop.style.width, pop.style.maxHeight];
      expect(style()).toEqual(["306px", "8px", "320px", `${innerHeight - 16}px`]); // under the part

      layerTop = -400; // the panel scrolled the part up out of view
      fireEvent.scroll(slot.container);
      expect(style()).toEqual(["408px", "8px", "320px", `${innerHeight - 16}px`]); // pinned 8 px below the window's top

      layerTop = 0;
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
      fireEvent(window, new Event("resize"));
      expect(style()).toEqual(["242px", "8px", "320px", "484px"]); // no room under or over: inside, at the bottom edge
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
    }
  });
});
