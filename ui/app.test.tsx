// @vitest-environment jsdom
// The card, the panel and the Dashboards page in bb's frontend harness, with their RPC answered by the
// real plugin server running in bb's fake host, and dashboards rendered through the same library and
// Renderer that ship.
import { createRequire } from "node:module";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { EXAMPLES } from "../server/generated";
import { PROGRAM, startHost } from "../test/host";
import { DashboardsPage } from "./gallery";
import { DashboardTab } from "./panel";

const app = await loadPluginApp(() => import("../app"));
const card = app.codeFenceRenderers[0]!;
const tab = { component: DashboardTab }; // app.tabs[0]'s registration union is wider than renderSlot takes
const page = app.navPanels[0]!;

beforeEach(() => localStorage.clear());

async function setup() {
  const host = await startHost(async () => (await import("../server")).default);
  const rpc = {
    read: (input: unknown) => host.harness.behavior.callRpc("read", input),
    list: (input: unknown) => host.harness.behavior.callRpc("list", input),
    delete: (input: unknown) => host.harness.behavior.callRpc("delete", input),
    restore: (input: unknown) => host.harness.behavior.callRpc("restore", input),
  } as never;
  const lastPing = () => host.harness.realtimeSignals.at(-1)!;
  return { ...host, rpc, lastPing };
}

const message = { id: "msg-1", threadId: "thread-1", turnId: "turn-1", projectId: "project-1" };
const fence = (code: string, status: "streaming" | "closed" = "closed") => ({ code, language: "bb-dashboard", status, index: 0, message, Original: () => <pre>raw fence</pre> });
const tabProps = (dashboardId: string) => ({ threadId: "thread-1", environment: null, params: { dashboardId } });
const chosenVersion = (slot: ReturnType<typeof renderSlot>) => (slot.getByLabelText("Version") as HTMLSelectElement).selectedOptions[0]!.textContent;
const card2 = (title: string) => `main = Section("Orders", [Row([Card("${title}", [KeyValues([KeyValue("Orders", 7, "number")])])])])`;

describe("registrations", () => {
  test("a fence renderer for bb-dashboard, a thread action tab and the Dashboards page", () => {
    expect(card.languages).toEqual(["bb-dashboard"]);
    expect(app.tabs).toHaveLength(1);
    expect(app.tabs[0]).toMatchObject({ id: "dashboard", context: { kind: "thread" }, availability: "action", component: DashboardTab });
    expect(app.navPanels).toEqual([expect.objectContaining({ id: "dashboards", title: "Dashboards", path: "dashboards", component: DashboardsPage })]);
  });
});

describe("card", () => {
  test("shows the dashboard's title and opens the side-panel tab with its id", async () => {
    const { save, rpc } = await setup();
    const { id } = await save({ title: "Corner shop sales", program: PROGRAM });
    const slot = renderSlot(card, fence(`${id}\n`), { rpc, experimental_panel: { openTab: () => true } });
    expect(await slot.findByText("Corner shop sales")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Open in side panel" }));
    expect(slot.inspection.experimental_panelCalls).toEqual([
      { method: "openTab", options: { tab: { id: "dashboard", context: { kind: "thread" }, availability: "action" }, params: { dashboardId: id }, title: "Corner shop sales" } },
    ]);
    expect(slot.queryByRole("status")).toBeNull();
  });

  test("when bb declines to open the panel, it says so and points to the Dashboards page", async () => {
    const { save, rpc } = await setup();
    const { id } = await save({ title: "Corner shop sales", program: PROGRAM });
    const slot = renderSlot(card, fence(id!), { rpc }); // no experimental_panel: every call declines
    await slot.findByText("Corner shop sales");
    fireEvent.click(slot.getByRole("button"));
    expect((await slot.findByRole("status")).textContent).toBe("The side panel is not available here. Open it from the Dashboards page.");
    fireEvent.click(slot.getByRole("button", { name: "Dashboards page" }));
    expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "dashboards", options: { subPath: id } });
  });

  test.each([
    ["still streaming", fence("0123456789ab", "streaming")],
    ["not a dashboard id", fence('<img src=x onerror="alert(1)">')],
  ])("stays bb's code block while %s", async (_, props) => {
    const { rpc } = await setup();
    const slot = renderSlot(card, props, { rpc });
    expect((await slot.findByText("raw fence")).tagName).toBe("PRE");
    expect(slot.queryByRole("button")).toBeNull();
    expect(slot.inspection.rpcCalls).toEqual([]);
  });

  test("an id with no dashboard says so", async () => {
    const { rpc } = await setup();
    const slot = renderSlot(card, fence("0123456789ab"), { rpc });
    expect(await slot.findByText("No dashboard with the id 0123456789ab.")).toBeTruthy();
  });
});

describe("panel", () => {
  test("renders the saved dashboard and redraws on its own ping", async () => {
    const { save, rpc, lastPing } = await setup();
    const { id } = await save({ title: "Corner shop sales", program: PROGRAM });
    const slot = renderSlot(tab, tabProps(id!), { rpc });
    expect(await slot.findByText("Today")).toBeTruthy(); // a Card title from the program
    expect(slot.getByText("Corner shop sales")).toBeTruthy();
    expect(chosenVersion(slot)).toBe("Latest: version 1");

    await save({ id, patch: `main = Section("Orders", [Row([Card("This week", [KeyValues([KeyValue("Orders", 310, "number")])])])])` });
    await slot.behavior.emitRealtime(lastPing().channel, lastPing().payload);
    expect(await slot.findByText("This week")).toBeTruthy();
    expect(chosenVersion(slot)).toBe("Latest: version 2");
    expect(slot.queryByText("Today")).toBeNull();
  });

  test("ignores another dashboard's ping", async () => {
    const { save, rpc, lastPing } = await setup();
    const { id } = await save({ title: "Corner shop sales", program: PROGRAM });
    await save({ title: "Other", program: PROGRAM });
    const slot = renderSlot(tab, tabProps(id!), { rpc });
    await slot.findByText("Today");
    const calls = slot.inspection.rpcCalls.length;
    await slot.behavior.emitRealtime(lastPing().channel, lastPing().payload); // the second dashboard's ping
    expect(slot.inspection.rpcCalls).toHaveLength(calls);
  });

  test("reloads when the realtime connection comes back (missed pings are not replayed)", async () => {
    const { save, rpc } = await setup();
    const { id } = await save({ title: "Corner shop sales", program: PROGRAM });
    const slot = renderSlot(tab, tabProps(id!), { rpc });
    await slot.findByText("Today");
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await save({ id, patch: `main = Section("Orders", [Row([Card("Saved while offline", [KeyValues([KeyValue("Orders", 7, "number")])])])])` });
    expect(slot.queryByText("Saved while offline")).toBeNull();
    await slot.behavior.setRealtimeConnectionState("connected");
    expect(await slot.findByText("Saved while offline")).toBeTruthy();
  });

  test("an unknown id gets a clear message", async () => {
    const { rpc } = await setup();
    const slot = renderSlot(tab, tabProps("0123456789ab"), { rpc });
    expect((await slot.findByRole("alert")).textContent).toContain("There is no dashboard with the id 0123456789ab.");
  });

  test.each([
    [1, ["Channels", "Web shop", "Revenue"]],
    [2, ["Revenue by channel", "Average order"]],
    [3, ["Where tickets come from", "Priya", "Slowest queues"]],
    [5, ["Revenue by week", "Market stall", "Orders by channel"]],
  ])("renders guide example %i (static data: the shop, the stock examples, the core guide's) through the shipped library", async (n, texts) => {
    const { save, rpc } = await setup();
    const { id, error } = await save({ title: `Example ${n}`, program: EXAMPLES[n - 1] });
    expect(error).toBe(false);
    const slot = renderSlot(tab, tabProps(id!), { rpc });
    for (const text of texts) await waitFor(() => expect(slot.getAllByText(text).length).toBeGreaterThan(0));
  });

  test("the library under test uses the katex stand-in that ships (stubs/katex)", () => {
    const fromComponents = createRequire(createRequire(import.meta.url).resolve("@openuidev/react-components"));
    expect(fromComponents.resolve("katex").replaceAll("\\", "/")).toMatch(/\/stubs\/katex\/index\.cjs$/);
  });
});

describe("theme", () => {
  /** The view's font and the --openui-dashboard-* variables ThemeProvider put on its wrapper. */
  const looks = (slot: ReturnType<typeof renderSlot>) => {
    const wrapper = slot.container.querySelector<HTMLElement>("[data-dashboard-mode]")!;
    const token = (name: string) => wrapper.style.getPropertyValue(`--openui-dashboard-${name}`);
    return { font: wrapper.closest<HTMLElement>("[style*='font-family']")!.style.fontFamily, token };
  };

  test("without a theme: bb's variables, the chart palette's first four on bb's hues, bb's font", async () => {
    const { save, rpc } = await setup();
    const { id } = await save({ title: "Corner shop sales", program: PROGRAM });
    const slot = renderSlot(tab, tabProps(id!), { rpc });
    await slot.findByText("Today");
    const { font, token } = looks(slot);
    expect(font).toBe("var(--font-sans)");
    expect([token("page"), token("accent"), token("series-1"), token("series-2"), token("series-3"), token("series-4")]).toEqual([
      "var(--background)",
      "var(--primary)",
      "var(--primary)",
      "var(--timeline-accent)",
      "var(--pr-merged)",
      "var(--attention)",
    ]);
    expect(token("series-5")).toBe("#3894ff"); // the library's own
  });

  test("a stored theme overrides bb's mapping and sets the font, in light and in dark mode", async () => {
    const { save, rpc } = await setup();
    const theme = { light: { page: "#fdf6e3", accent: "#1f6f43", series1: "#2a9d8f" }, font: "serif" };
    const { id } = await save({ title: "Green shop", program: PROGRAM, theme });
    const light = renderSlot(tab, tabProps(id!), { rpc });
    await light.findByText("Today");
    expect(looks(light).font).toBe("ui-serif, serif");
    expect(["page", "accent", "series-1", "ink"].map(looks(light).token)).toEqual(["#fdf6e3", "#1f6f43", "#2a9d8f", "var(--foreground)"]);
    light.lifecycle.unmount();

    const dark = renderSlot(tab, tabProps(id!), { rpc, codeTheme: { mode: "dark" } });
    await dark.findByText("Today");
    expect(dark.container.querySelector<HTMLElement>("[data-dashboard-mode]")!.dataset.dashboardMode).toBe("dark");
    expect(looks(dark).token("accent")).toBe("#1f6f43"); // no dark overrides: light's apply to both
    dark.lifecycle.unmount();

    await save({ id, patch: card2("Today"), theme: { ...theme, dark: { accent: "#0b3d2e" }, font: "mono" } });
    const darkOwn = renderSlot(tab, tabProps(id!), { rpc, codeTheme: { mode: "dark" } });
    await darkOwn.findByText("Today");
    expect(looks(darkOwn).token("accent")).toBe("#0b3d2e");
    expect(looks(darkOwn).token("page")).toBe("var(--background)");
    expect(looks(darkOwn).font).toBe("ui-monospace, monospace");
  });
});

describe("versions", () => {
  const select = (slot: ReturnType<typeof renderSlot>, value: string) => fireEvent.change(slot.getByLabelText("Version"), { target: { value } });

  test("an old version is a read-only view, with a way back to the latest", async () => {
    const { save, rpc } = await setup();
    const { id } = await save({ title: "Corner shop sales", program: PROGRAM });
    await save({ id, patch: card2("Version two") });
    await save({ id, patch: card2("Version three") });
    const slot = renderSlot(tab, tabProps(id!), { rpc });
    await slot.findByText("Version three");
    expect(Array.from((slot.getByLabelText("Version") as HTMLSelectElement).options, (o) => o.textContent)).toEqual([
      "Latest: version 3",
      expect.stringMatching(/^Version 2, /),
      expect.stringMatching(/^Version 1, /),
    ]);

    select(slot, "1");
    expect(await slot.findByText("Today")).toBeTruthy();
    expect(slot.queryByText("Version three")).toBeNull();
    expect(slot.getByText("Version 1 of 3, read-only.")).toBeTruthy();
    expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "read", input: { id, version: 1 } });

    fireEvent.click(slot.getByRole("button", { name: "Back to latest" }));
    expect(await slot.findByText("Version three")).toBeTruthy();
    expect(slot.queryByText(/read-only/)).toBeNull();
    expect(chosenVersion(slot)).toBe("Latest: version 3");
  });

  test("a ping moves a view on the latest forward, and only adds a notice to a view on an old version", async () => {
    const { save, rpc, lastPing } = await setup();
    const { id } = await save({ title: "Corner shop sales", program: PROGRAM });
    await save({ id, patch: card2("Version two") });
    const slot = renderSlot(tab, tabProps(id!), { rpc });
    await slot.findByText("Version two");

    await save({ id, patch: card2("Version three") });
    await slot.behavior.emitRealtime(lastPing().channel, lastPing().payload);
    expect(await slot.findByText("Version three")).toBeTruthy();

    select(slot, "1");
    await slot.findByText("Today");
    await save({ id, patch: card2("Version four") });
    await slot.behavior.emitRealtime(lastPing().channel, lastPing().payload);
    expect(await slot.findByText("Version 1 of 4, read-only. Version 4 was saved while you were viewing this one.")).toBeTruthy();
    expect(slot.getByText("Today")).toBeTruthy();
    expect(slot.queryByText("Version four")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Back to latest" }));
    expect(await slot.findByText("Version four")).toBeTruthy();
  });

  test("Restore this version saves the old one as the latest, and the view follows it", async () => {
    const { save, rpc } = await setup();
    const { id } = await save({ title: "Corner shop sales", program: PROGRAM });
    await save({ id, patch: card2("Version two") });
    const slot = renderSlot(tab, tabProps(id!), { rpc });
    await slot.findByText("Version two");
    select(slot, "1");
    await slot.findByText("Version 1 of 2, read-only.");

    const button = slot.getByRole("button", { name: "Restore this version" });
    button.focus(); // a plain button: reached with Tab, pressed with Enter or Space
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(await slot.findByText("Version 1 restored as version 3.")).toBeTruthy();
    await waitFor(() => expect(chosenVersion(slot)).toBe("Latest: version 3"));
    expect(await slot.findByText("Today")).toBeTruthy();
    expect(slot.queryByText(/read-only/)).toBeNull();
    expect(slot.inspection.rpcCalls).toContainEqual({ method: "restore", input: { id, version: 1 } });
  });

  test("a view on a version a later save deleted (only the newest are kept) moves to the latest and says why", async () => {
    const { save, rpc, lastPing, db } = await setup();
    const { id } = await save({ title: "Corner shop sales", program: PROGRAM });
    await save({ id, patch: card2("Version two") });
    const slot = renderSlot(tab, tabProps(id!), { rpc });
    await slot.findByText("Version two");
    select(slot, "1");
    await slot.findByText("Version 1 of 2, read-only.");
    db().prepare("DELETE FROM versions WHERE dashboard_id = ? AND number = 1").run(id); // as a save past the newest 100 does
    await save({ id, patch: card2("Version three") });
    await slot.behavior.emitRealtime(lastPing().channel, lastPing().payload);
    expect(await slot.findByText("Version 1 is no longer kept, so the latest version is shown.")).toBeTruthy();
    expect(await slot.findByText("Version three")).toBeTruthy();
    expect(chosenVersion(slot)).toBe("Latest: version 3");
  });
});

describe("remembered $variable values", () => {
  const FILTERED = `root = Dashboard([filters, main])
$range = "7d"
filters = FilterBar([PeriodPicker($range, [{value: "7d", label: "7D"}, {value: "30d", label: "30D"}])])
main = Section("Orders", [Row([Card("Orders in " + $range, [KeyValues([KeyValue("Orders", 42, "number")])])])])`;
  const key = (id: string) => `test-plugin:remembered:${id}`;

  test("survive a new version and reopening, kept in this browser", async () => {
    const { save, rpc, lastPing } = await setup();
    const { id } = await save({ title: "Orders", program: FILTERED });
    const slot = renderSlot(tab, tabProps(id!), { rpc });
    expect(await slot.findByText("Orders in 7d")).toBeTruthy();
    fireEvent.click(slot.getAllByRole("radio", { name: "30D" })[0]!);
    expect(await slot.findByText("Orders in 30d")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(key(id!))!)).toEqual({ $range: "30d" });

    // The new version declares another $variable too: the Renderer then re-applies its initial state.
    await save({ id, patch: `main = Section("Orders", [Row([Card("Orders over " + $range, [KeyValues([KeyValue($label, 42, "number")])])])])\n$label = "Orders placed"` });
    await slot.behavior.emitRealtime(lastPing().channel, lastPing().payload);
    expect(await slot.findByText("Orders placed")).toBeTruthy();
    expect(slot.getByText("Orders over 30d")).toBeTruthy();
    slot.lifecycle.unmount();

    const reopened = renderSlot(tab, tabProps(id!), { rpc });
    expect(await reopened.findByText("Orders over 30d")).toBeTruthy();
    fireEvent.click(reopened.getAllByRole("radio", { name: "7D" })[0]!);
    await reopened.findByText("Orders over 7d");
    expect(JSON.parse(localStorage.getItem(key(id!))!)).toEqual({}); // back on the default: nothing to remember
  });

  test("a value a new version no longer fits gives way to the new default", async () => {
    const { save, rpc, lastPing } = await setup();
    const { id } = await save({ title: "Orders", program: FILTERED });
    const slot = renderSlot(tab, tabProps(id!), { rpc });
    await slot.findByText("Orders in 7d");
    fireEvent.click(slot.getAllByRole("radio", { name: "30D" })[0]!);
    await slot.findByText("Orders in 30d");

    await save({ id, program: `root = Dashboard([main])\n$range = 14\nmain = Section("Orders", [Row([Card("Last " + $range + " days", [KeyValues([KeyValue("Orders", 42, "number")])])])])` });
    await slot.behavior.emitRealtime(lastPing().channel, lastPing().payload);
    expect(await slot.findByText("Last 14 days")).toBeTruthy();
  });

  test.each([
    ["not JSON", "{oops"],
    ["not an object", "[1, 2]"],
    ["wrong types", JSON.stringify({ $range: 42, $unknown: "x" })],
    ["null", "null"],
  ])("junk in storage (%s) does not break rendering", async (_, junk) => {
    const { save, rpc } = await setup();
    const { id } = await save({ title: "Orders", program: FILTERED });
    localStorage.setItem(key(id!), junk);
    const slot = renderSlot(tab, tabProps(id!), { rpc });
    expect(await slot.findByText("Orders in 7d")).toBeTruthy();
  });
});

describe("Dashboards page", () => {
  const threads = (...found: { id: string; title: string }[]) => ({ threads: { list: async () => found as never } });

  test("lists every dashboard with its last change, version count and origin thread", async () => {
    const { save, rpc } = await setup();
    const { id: first } = await save({ title: "Corner shop sales", program: PROGRAM });
    await save({ id: first, patch: card2("This week") });
    await new Promise((resolve) => setTimeout(resolve, 5)); // last changed first: give the second a later time
    await save({ title: "Support queue", program: PROGRAM });
    const slot = renderSlot(page, { subPath: "" }, { rpc, sdk: threads({ id: "thread-1", title: "Shop numbers" }) });
    const rows = await slot.findAllByRole("listitem");
    expect(rows.map((row) => within(row).getAllByRole("button")[0]!.textContent)).toEqual(["Support queue", "Corner shop sales"]);
    expect(rows[1]!.textContent).toMatch(/Changed .+ · 2 versions · Shop numbers/);
    expect(rows[0]!.textContent).toContain("1 version ·");
    expect(slot.inspection.sdkCalls).toEqual([{ method: "threads.list", args: [{ threadIds: ["thread-1"], includeHidden: true }] }]);

    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Shop numbers" }));
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Corner shop sales" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thread-1" },
      { method: "toPluginPanel", path: "dashboards", options: { subPath: first } },
    ]);
  });

  test("an origin thread that no longer exists has no link", async () => {
    const { save, rpc } = await setup();
    await save({ title: "Corner shop sales", program: PROGRAM });
    const slot = renderSlot(page, { subPath: "" }, { rpc, sdk: threads() });
    expect((await slot.findByRole("listitem")).textContent).toContain("its thread no longer exists");
  });

  test("a selected dashboard shows in the side panel's own view, with a way back", async () => {
    const { save, rpc } = await setup();
    const { id } = await save({ title: "Corner shop sales", program: PROGRAM });
    const slot = renderSlot(page, { subPath: id! }, { rpc, sdk: threads() });
    expect(await slot.findByText("Today")).toBeTruthy();
    expect(chosenVersion(slot)).toBe("Latest: version 1");
    fireEvent.click(slot.getByRole("button", { name: "All dashboards" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "dashboards", options: { subPath: "" } }]);
  });

  test("delete asks first, then removes the dashboard, its versions and its remembered values", async () => {
    const { save, rpc, db } = await setup();
    const { id } = await save({ title: "Corner shop sales", program: PROGRAM });
    await save({ id, patch: card2("This week") });
    await save({ title: "Support queue", program: PROGRAM });
    localStorage.setItem(`test-plugin:remembered:${id}`, JSON.stringify({ $range: "30d" }));
    const slot = renderSlot(page, { subPath: "" }, { rpc, sdk: threads() });
    await slot.findByText("Corner shop sales");

    fireEvent.click(slot.getByRole("button", { name: "Delete Corner shop sales" }));
    const confirm = slot.getByRole("group", { name: "Confirm deleting Corner shop sales" });
    expect(confirm.textContent).toContain("Delete it and all 2 versions? This cannot be undone.");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(slot.queryByRole("group")).toBeNull();
    expect(slot.inspection.rpcCalls.map((c) => c.method)).not.toContain("delete");

    fireEvent.click(slot.getByRole("button", { name: "Delete Corner shop sales" }));
    fireEvent.click(within(slot.getByRole("group")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(slot.queryByText("Corner shop sales")).toBeNull());
    expect(slot.getByText("Support queue")).toBeTruthy();
    expect(db().prepare("SELECT COUNT(*) AS n FROM versions WHERE dashboard_id = ?").get(id)).toEqual({ n: 0 });
    expect(localStorage.getItem(`test-plugin:remembered:${id}`)).toBeNull();

    const card = renderSlot(app.codeFenceRenderers[0]!, fence(id!), { rpc });
    expect(await card.findByText(`No dashboard with the id ${id}.`)).toBeTruthy();
  });

  test("with no dashboards, it explains how to make one", async () => {
    const { rpc } = await setup();
    const slot = renderSlot(page, { subPath: "" }, { rpc, sdk: threads() });
    expect(await slot.findByText("No dashboards yet")).toBeTruthy();
    expect(slot.getByText(/Ask an agent in any thread for a dashboard/)).toBeTruthy();
    expect(slot.inspection.sdkCalls).toEqual([]); // no threads to look up
  });

  test("a new dashboard appears on its ping", async () => {
    const { save, rpc, lastPing } = await setup();
    const slot = renderSlot(page, { subPath: "" }, { rpc, sdk: threads() });
    await slot.findByText("No dashboards yet");
    await save({ title: "Corner shop sales", program: PROGRAM });
    await slot.behavior.emitRealtime(lastPing().channel, lastPing().payload);
    expect(await slot.findByText("Corner shop sales")).toBeTruthy();
  });
});
