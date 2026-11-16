// @vitest-environment jsdom
// The view's two agent actions. No stock component fires an action, and the save check refuses
// components outside the shipped library, so here the library gains a test-only button and the
// dashboard comes from a fake read instead of the plugin server.
import { fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DashboardsPage } from "./gallery";
import { DashboardTab } from "./panel";

vi.mock("./library", async () => {
  const { library } = await import("@openuidev/dashboard-library");
  const { defineComponent, useTriggerAction } = await import("@openuidev/react-lang");
  const { z } = await import("zod");
  const Fire = defineComponent({
    name: "Fire",
    props: z.object({ label: z.string(), action: z.any() }),
    description: "Test only: a button that fires its action.",
    component: ({ props }) => {
      const trigger = useTriggerAction();
      return (
        <button type="button" onClick={() => void trigger(props.label, undefined, props.action)}>
          {props.label}
        </button>
      );
    },
  });
  return { library: library.extend({ components: { add: [{ component: Fire, slots: ["Card.content"] }] } }) };
});

const ID = "0123456789ab";
const PROGRAM = `root = Dashboard([Section("Help", [Row([Card("Ask", [
  Fire("Explain", @ToAssistant("Explain the dip on Tuesday")),
  Fire("Docs", @OpenUrl("https://example.com/docs")),
  Fire("Script", @OpenUrl("javascript:alert(1)")),
  Fire("Local file", @OpenUrl("file:///etc/hosts")),
  Fire("Data", @OpenUrl("data:text/html,hi")),
  Fire("Other", {type: "download", params: {file: "orders.csv"}})
])])])])`;

const dashboard = (version: number) => ({ id: ID, title: "Help desk", version, program: PROGRAM, theme: null, sources: [], createdAt: 1, updatedAt: 2 });
const versions = [2, 1].map((version) => ({ version, createdAt: version }));
const rpc = {
  read: ({ version }: { version?: number }) => ({ dashboard: dashboard(version ?? 2), versions }),
  list: () => ({ dashboards: [{ id: ID, title: "Help desk", version: 2, versions: 2, updatedAt: 2, threadId: "thread-7" }] }),
} as never;
const send = vi.fn(async () => ({ delivery: "sent" as const, ok: true as const }));

beforeEach(() => {
  localStorage.clear();
  send.mockClear();
});

const inTab = () => renderSlot({ component: DashboardTab }, { threadId: "thread-1", environment: null, params: { dashboardId: ID } }, { rpc, sdk: { threads: { send } }, openUrl: () => true });
const message = (threadId: string) => ({
  method: "threads.send",
  args: [{ threadId, mode: "queue-if-active", input: [{ type: "text", text: `About dashboard "Help desk" (${ID}): Explain the dip on Tuesday`, mentions: [] }] }],
});

describe("in the side-panel tab", () => {
  test("continue-conversation sends its text to the tab's thread, prefixed with the dashboard's title and id", async () => {
    const slot = inTab();
    fireEvent.click(await slot.findByRole("button", { name: "Explain" }));
    expect(await slot.findByText("Sent to the dashboard's thread.")).toBeTruthy();
    expect(slot.inspection.sdkCalls).toEqual([message("thread-1")]);
  });

  test("open-url opens http and https links through bb's navigation, and refuses every other scheme", async () => {
    const slot = inTab();
    fireEvent.click(await slot.findByRole("button", { name: "Docs" }));
    for (const name of ["Script", "Local file", "Data"]) fireEvent.click(slot.getByRole("button", { name }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "openUrl", url: "https://example.com/docs" }]);
    expect(slot.getByText("Only http and https links open from a dashboard.")).toBeTruthy();
    expect(slot.inspection.sdkCalls).toEqual([]);
  });

  test("any other kind of action is ignored", async () => {
    const slot = inTab();
    fireEvent.click(await slot.findByRole("button", { name: "Other" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(slot.inspection.sdkCalls).toEqual([]);
    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(slot.queryByRole("status")).toBeNull();
  });

  test("an old version sends nothing", async () => {
    const slot = inTab();
    await slot.findByRole("button", { name: "Explain" });
    fireEvent.change(slot.getByLabelText("Version"), { target: { value: "1" } });
    await slot.findByText("Version 1 of 2, read-only.");
    fireEvent.click(await slot.findByRole("button", { name: "Explain" }));
    expect(await slot.findByText("Old versions are read-only. Go back to the latest version to ask the agent.")).toBeTruthy();
    expect(slot.inspection.sdkCalls).toEqual([]);
  });
});

describe("on the Dashboards page", () => {
  const onPage = (found: { id: string; title: string }[]) =>
    renderSlot({ component: DashboardsPage }, { subPath: ID }, { rpc, sdk: { threads: { send, list: async () => found as never } } });

  test("continue-conversation goes to the dashboard's origin thread while it exists", async () => {
    const slot = onPage([{ id: "thread-7", title: "Help desk numbers" }]);
    await slot.findByRole("button", { name: "Explain" });
    await vi.waitFor(() => expect(slot.inspection.sdkCalls.map((c) => c.method)).toEqual(["threads.list"]));
    fireEvent.click(slot.getByRole("button", { name: "Explain" }));
    expect(await slot.findByText("Sent to the dashboard's thread.")).toBeTruthy();
    expect(slot.inspection.sdkCalls.at(-1)).toEqual(message("thread-7"));
  });

  test("with the origin thread gone, it explains why nothing was sent", async () => {
    const slot = onPage([]);
    await slot.findByRole("button", { name: "Explain" });
    await vi.waitFor(() => expect(slot.inspection.sdkCalls.map((c) => c.method)).toEqual(["threads.list"]));
    fireEvent.click(slot.getByRole("button", { name: "Explain" }));
    expect(await slot.findByText(/^Not sent: the thread this dashboard was made in no longer exists\./)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });
});
