// @vitest-environment jsdom
// Live data in the dashboard view, in bb's frontend harness with the real plugin server in its fake
// host: Query data on screen, timer re-runs, the hidden-tab pause, the refresh on showing again,
// failures, Freshness, RefreshButton, the agent-data ping, the mode label and old versions. Only the
// interval timers and the clock are faked; the server's 10-second floor runs on the same clock.
import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { FOLDER, PROGRAM, startHost, type FakeFiles } from "../test/host";
import { DashboardsPage } from "./gallery";
import { DashboardTab, DashboardView } from "./panel";
import { updatedAgo, refreshMessage } from "./components/live";

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-01-01T09:00:00Z"));
  vi.spyOn(console, "error").mockImplementation(() => {}); // the library logs a failing query
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ORDERS = `${FOLDER}/data/orders.json`;
const orders = (customer: string) => JSON.stringify({ rows: [{ id: "A-1001", customer, total: 42.5 }] });
const FILE = [{ name: "orders", kind: "file", path: "data/orders.json" }];
const program = (interval = "", extra = "") => `root = Dashboard([main])
orders = Query("orders", {}, {rows: []}${interval})
first = @First(orders.rows)
main = Section("Orders", [Row([Card("Latest order", [KeyValues([KeyValue("Customer", first.customer)])])]), Freshness("orders"), RefreshButton()${extra}])`;

async function setup(files: FakeFiles = { [ORDERS]: orders("Corner Bakery") }) {
  const host = await startHost(async () => (await import("../server")).default, files);
  const rpc = {
    read: (input: unknown) => host.harness.behavior.callRpc("read", input),
    list: (input: unknown) => host.harness.behavior.callRpc("list", input),
    source_run: (input: unknown) => host.harness.behavior.callRpc("source_run", input),
  } as never;
  const lastPing = () => host.harness.realtimeSignals.at(-1)!;
  return { ...host, rpc, lastPing };
}

type Slot = ReturnType<typeof renderSlot>;
const runs = (slot: Slot) => slot.inspection.rpcCalls.filter((c) => c.method === "source_run");
const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30))); // real time for stray calls to show
const view = (id: string, visible: boolean) => <DashboardView id={id} threadId="thread-1" visible={visible} />;

describe("a Query in the panel", () => {
  test("renders its source's data, and its interval re-runs it", async () => {
    const { save, rpc, files } = await setup();
    const { id } = await save({ title: "Orders", program: program(", 60"), sources: FILE });
    const slot = renderSlot({ component: DashboardView }, { id: id!, threadId: "thread-1", visible: true }, { rpc });
    expect(await slot.findByText("Corner Bakery")).toBeTruthy();
    expect(runs(slot)).toEqual([{ method: "source_run", input: { id, version: 1, source: "orders", args: {} } }]);

    files[ORDERS] = orders("Blue Kettle Cafe");
    await advance(59_000);
    expect(runs(slot)).toHaveLength(1);
    await advance(1_000);
    expect(await slot.findByText("Blue Kettle Cafe")).toBeTruthy();
    expect(runs(slot)).toHaveLength(2);
  });

  test("while the tab is hidden it fetches nothing and keeps the data; shown again, it refreshes once", async () => {
    const { save, rpc, files } = await setup();
    const { id } = await save({ title: "Orders", program: program(", 30"), sources: FILE });
    const slot = renderSlot({ component: DashboardView }, { id: id!, threadId: "thread-1", visible: true }, { rpc });
    await slot.findByText("Corner Bakery");

    slot.lifecycle.rerender(view(id!, false));
    files[ORDERS] = orders("Blue Kettle Cafe");
    await advance(180_000); // six timer ticks, each answered from the last result
    await settle();
    expect(runs(slot)).toHaveLength(1);
    expect(slot.getByText("Corner Bakery")).toBeTruthy();

    slot.lifecycle.rerender(view(id!, true));
    expect(await slot.findByText("Blue Kettle Cafe")).toBeTruthy();
    await settle();
    expect(runs(slot)).toHaveLength(2);
  });

  test("mounted hidden, it fetches nothing until shown, then once", async () => {
    const { save, rpc } = await setup();
    const { id } = await save({ title: "Orders", program: program(", 30"), sources: FILE });
    const slot = renderSlot({ component: DashboardView }, { id: id!, threadId: "thread-1", visible: false }, { rpc });
    await slot.findByText("Latest order");
    await settle();
    expect(runs(slot)).toEqual([]);
    slot.lifecycle.rerender(view(id!, true));
    expect(await slot.findByText("Corner Bakery")).toBeTruthy();
    await settle();
    expect(runs(slot)).toHaveLength(1);
  });

  test("the side-panel tab passes its visibility; the Dashboards page counts as visible", async () => {
    const { save, rpc } = await setup();
    const { id } = await save({ title: "Orders", program: program(), sources: FILE });
    const hidden = renderSlot({ component: DashboardTab }, { threadId: "thread-1", environment: null, params: { dashboardId: id! } }, { rpc, tabVisible: false });
    await hidden.findByText("Latest order");
    await settle();
    expect(runs(hidden)).toEqual([]);
    hidden.lifecycle.unmount();

    const page = renderSlot({ component: DashboardsPage }, { subPath: id! }, { rpc, sdk: { threads: { list: async () => [] as never } } });
    expect(await page.findByText("Corner Bakery")).toBeTruthy();
  });

  test("a failure shows the library's notice and a line naming the source and the reason; the dashboard stays", async () => {
    const { save, rpc } = await setup({});
    const { id } = await save({ title: "Orders", program: program(), sources: FILE });
    const slot = renderSlot({ component: DashboardView }, { id: id!, threadId: "thread-1", visible: true }, { rpc });
    expect(await slot.findByText("Some live data didn’t load")).toBeTruthy();
    expect(slot.getByText("Source orders did not load: data/orders.json (in the thread's environment folder) was not found.")).toBeTruthy();
    expect(slot.getByText("Latest order").closest("[hidden]")).toBeNull();
    expect(slot.getByRole("button", { name: "Refresh" })).toBeTruthy(); // reachable by role: nothing hides it
  });

  test("an old version reads with its own declared sources", async () => {
    const { save, rpc } = await setup({ [`${FOLDER}/a.json`]: orders("Corner Bakery"), [`${FOLDER}/b.json`]: orders("Hilltop Florist") });
    const { id } = await save({ title: "Orders", program: program(), sources: [{ name: "orders", kind: "file", path: "a.json" }] });
    await save({ id, sources: [{ name: "orders", kind: "file", path: "b.json" }] });
    const slot = renderSlot({ component: DashboardView }, { id: id!, threadId: "thread-1", visible: true }, { rpc });
    expect(await slot.findByText("Hilltop Florist")).toBeTruthy();
    fireEvent.change(slot.getByLabelText("Version"), { target: { value: "1" } });
    expect(await slot.findByText("Corner Bakery")).toBeTruthy();
    expect(runs(slot).at(-1)!.input).toEqual({ id, version: 1, source: "orders", args: {} });
  });

  test("a new version with a changed source re-reads it in the open view", async () => {
    const { save, rpc, lastPing } = await setup({ [`${FOLDER}/a.json`]: orders("Corner Bakery"), [`${FOLDER}/b.json`]: orders("Hilltop Florist") });
    const { id } = await save({ title: "Orders", program: program(), sources: [{ name: "orders", kind: "file", path: "a.json" }] });
    const slot = renderSlot({ component: DashboardView }, { id: id!, threadId: "thread-1", visible: true }, { rpc });
    await slot.findByText("Corner Bakery");
    await save({ id, sources: [{ name: "orders", kind: "file", path: "b.json" }] });
    await slot.behavior.emitRealtime(lastPing().channel, lastPing().payload);
    expect(await slot.findByText("Hilltop Florist")).toBeTruthy();
  });
});

describe("Freshness and RefreshButton", () => {
  test("Freshness says when the source answered and moves on without fetching", async () => {
    const { save, rpc } = await setup();
    const { id } = await save({ title: "Orders", program: program(), sources: FILE });
    const slot = renderSlot({ component: DashboardView }, { id: id!, threadId: "thread-1", visible: true }, { rpc });
    expect(await slot.findByText("Updated just now · refreshes itself")).toBeTruthy();
    await advance(120_000);
    expect(await slot.findByText("Updated 2 minutes ago · refreshes itself")).toBeTruthy();
    expect(runs(slot)).toHaveLength(1);
  });

  test("RefreshButton re-runs a self-refreshing source now", async () => {
    const { save, rpc, files } = await setup();
    const { id } = await save({ title: "Orders", program: program(), sources: FILE });
    const slot = renderSlot({ component: DashboardView }, { id: id!, threadId: "thread-1", visible: true }, { rpc });
    await slot.findByText("Corner Bakery");
    files[ORDERS] = orders("Blue Kettle Cafe");
    await advance(11_000); // past the server's floor
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    expect(await slot.findByText("Blue Kettle Cafe")).toBeTruthy();
    expect(runs(slot)).toHaveLength(2);
    expect(slot.getByText("Updated just now · refreshes itself")).toBeTruthy();
    expect(slot.inspection.sdkCalls).toEqual([]); // no agent turn
  });

  test("for an agent source, RefreshButton asks the agent in the thread instead of fetching; stored data then shows without a new version", async () => {
    const send = vi.fn(async () => ({ delivery: "sent" as const, ok: true as const }));
    const { save, rpc, lastPing } = await setup({});
    const agentProgram = `root = Dashboard([main])
incidents = Query("incidents", {}, {rows: []})
main = Section("Incidents", [Row([Card("Open", [KeyValues([KeyValue("Open incidents", @Count(incidents.rows), "number")])])]), Freshness("incidents"), RefreshButton("Refresh incidents", "incidents")])`;
    const { id } = await save({ title: "Help desk", program: agentProgram, sources: [{ name: "incidents", kind: "agent" }], data: { incidents: { rows: [{ id: "INC-31" }] } } });
    const slot = renderSlot({ component: DashboardView }, { id: id!, threadId: "thread-1", visible: true }, { rpc, sdk: { threads: { send } } });
    expect(await slot.findByText("Updated just now · refresh asks the agent")).toBeTruthy();
    expect(slot.getByText("Refresh asks the agent")).toBeTruthy(); // the mode label
    const before = runs(slot).length;

    fireEvent.click(slot.getByRole("button", { name: "Refresh incidents" }));
    expect(await slot.findByText("Sent to the dashboard's thread.")).toBeTruthy();
    expect(send).toHaveBeenCalledWith({ threadId: "thread-1", mode: "queue-if-active", input: [{ type: "text", text: `About dashboard "Help desk" (${id}): ${refreshMessage(["incidents"])}`, mentions: [] }] });
    expect(runs(slot)).toHaveLength(before);

    await advance(180_000);
    await save({ id, data: { incidents: { rows: [{ id: "INC-31" }, { id: "INC-32" }, { id: "INC-33" }] } } });
    await slot.behavior.emitRealtime(lastPing().channel, lastPing().payload);
    await waitFor(() => expect(slot.getByText("Open incidents").closest("div")!.parentElement!.textContent).toContain("3"));
    expect(runs(slot)).toHaveLength(before + 1);
    expect(slot.getByText("Updated just now · refresh asks the agent")).toBeTruthy();
    expect((slot.getByLabelText("Version") as HTMLSelectElement).selectedOptions[0]!.textContent).toBe("Latest: version 1");
  });

  test("updatedAgo words", () => {
    const t = Date.parse("2026-01-01T09:00:00Z");
    expect([0, 59_999, 60_000, 119_999, 3_600_000, 7_200_000, 86_400_000, 3 * 86_400_000].map((ms) => updatedAgo(t, t + ms))).toEqual([
      "Updated just now",
      "Updated just now",
      "Updated 1 minute ago",
      "Updated 1 minute ago",
      "Updated 1 hour ago",
      "Updated 2 hours ago",
      "Updated 1 day ago",
      "Updated 3 days ago",
    ]);
    expect(updatedAgo(t + 5_000, t)).toBe("Updated just now"); // a clock a little behind
  });
});

describe("the mode label", () => {
  test.each([
    ["no sources", [], PROGRAM, null],
    ["only self-refreshing sources", [...FILE, { name: "pr", kind: "pull_request" }], program(), "Refreshes itself"],
    ["an agent source", [...FILE, { name: "incidents", kind: "agent" }], program(), "Refresh asks the agent"],
  ])("with %s", async (_, sources, body, label) => {
    const { save, rpc } = await setup();
    const { id } = await save({ title: "Shop", program: body, sources });
    const slot = renderSlot({ component: DashboardView }, { id: id!, threadId: "thread-1", visible: true }, { rpc });
    await slot.findByRole("heading", { name: "Shop" });
    expect(slot.container.querySelector("header")!.textContent).toBe(`Shop${label ?? ""}EditColoursLatest: version 1`); // the Edit and Colours buttons sit before the versions
  });
});
