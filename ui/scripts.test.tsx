// @vitest-environment jsdom
// Script sources in the dashboard view, in bb's frontend harness with the real plugin server in its fake
// host and a temporary folder as the thread's environment: the waiting line and mode label, the approval
// dialog (banner, the whole script, flagged lines, scroll to the end, the default button, Escape, what
// changed), the "Runs a script" badge with reading again and withdrawing, and a script secret. Scripts are
// invented and harmless: they print JSON. jsdom lays nothing out, so the script region's heights are set here.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createPlugin } from "../server";
import { TEST_PATH, memorySecrets, startHost } from "../test/host";
import { CANNOT_RUN, WAITING } from "./live";
import { DashboardView, refreshMode } from "./panel";
import { CONTROL } from "./colours";
import { BANNER, LIMIT, lineDiff } from "./scripts";

const dir = mkdtempSync(join(tmpdir(), "oa-ui-scripts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Host = Awaited<ReturnType<typeof startHost>>;
const hosts: Host[] = [];
afterEach(async () => void (await Promise.all(hosts.splice(0).map((h) => h.harness.lifecycle.dispose()))));

// The script region is 200 px high and its text 1,000 px: it must be scrolled to reach the end.
const region = (el: Element) => el.getAttribute("role") === "region";
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {}); // the library logs a query that does not load
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: function (this: HTMLElement) { return region(this) ? 1000 : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: function (this: HTMLElement) { return region(this) ? 200 : 0; } });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

const METHODS = ["read", "list", "source_run", "scripts", "script_approve", "script_withdraw", "script_secret"];
const PROGRAM = `root = Dashboard([main])
jobs = Query("jobs", {}, {rows: []})
incidents = Query("incidents", {}, {rows: []})
main = Section("Queue", [Row([Card("Now", [KeyValues([KeyValue("Queued jobs", @Count(jobs.rows), "number"), KeyValue("Open incidents", @Count(incidents.rows), "number")])])]), Freshness("jobs")])`;
const CLEAN = `printf '{"rows":[1,2,3,4,5]}'`;
const FLAGGED = `# sudo is not needed for this\nprintf '{"rows":[1,2,3,4,5]}'`;
const jobs = (code: string, extra: Record<string, unknown> = {}) => ({ name: "jobs", kind: "script", runner: "sh", why: "Counts jobs in the invented queue", code, ...extra });

async function setup(code: string, extra: Record<string, unknown> = {}) {
  const host = await startHost(async () => createPlugin({ secrets: memorySecrets(), toolPath: async () => TEST_PATH }), {}, { folder: mkdtempSync(join(dir, "env-")) });
  hosts.push(host);
  const saved = await host.save({ title: "Job queue", program: PROGRAM, sources: [jobs(code, extra), { name: "incidents", kind: "agent" }], data: { incidents: { rows: [1, 2] } } });
  expect(saved.error, saved.text).toBe(false);
  const rpc = Object.fromEntries(METHODS.map((m) => [m, (input: unknown) => host.harness.behavior.callRpc(m, input)])) as never;
  const approveOnServer = async () => {
    const view = await host.rpc("scripts", { id: saved.id });
    expect(await host.rpc("script_approve", { id: saved.id, source: "jobs", hash: view.sources[0].hash })).toEqual({ ok: true });
  };
  const render = () => renderSlot({ component: DashboardView }, { id: saved.id!, threadId: "thread-1", visible: true }, { rpc });
  return { host, id: saved.id!, rpc, render, approveOnServer };
}

type Slot = ReturnType<typeof renderSlot>;
const header = (slot: Slot) => slot.container.querySelector("header")!.textContent;
const value = (slot: Slot, label: string) => slot.getByText(label).closest("div")!.parentElement!.textContent;
const scriptRuns = (slot: Slot) => slot.inspection.rpcCalls.filter((c) => c.method === "source_run" && (c.input as { source: string }).source === "jobs");

test("unapproved: the rest of the dashboard works, the script waits and never runs; the dialog opens on Don't run with the banner, and Escape means Don't run", async () => {
  const { render } = await setup(CLEAN);
  const slot = render();
  await waitFor(() => expect(value(slot, "Open incidents")).toContain("2")); // the agent source works
  expect(header(slot)).toContain("Needs your approval");
  expect(slot.getByText(/Script "jobs" is waiting for your approval/)).toBeTruthy();
  expect(slot.getByText("Not loaded yet · waiting for your approval")).toBeTruthy(); // Freshness
  expect(scriptRuns(slot)).toEqual([]);

  fireEvent.click(slot.getByRole("button", { name: 'Review script "jobs"' }));
  const dialog = slot.getByRole("dialog", { name: 'Run the script "jobs"?' });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  const banner = within(dialog).getByRole("note");
  expect(banner.textContent).toBe(BANNER + LIMIT);
  expect(BANNER).toBe("This script will run on your computer every time this dashboard refreshes. The plugin cannot limit what it does. Read it before you approve.");
  expect(dialog.getAttribute("aria-describedby")).toBe(banner.id);
  expect(dialog.textContent).toContain("Counts jobs in the invented queue");
  expect(dialog.textContent).toContain('Asked for by the dashboard "Job queue"');
  expect(dialog.textContent).toContain("No secret variables.");
  expect(within(dialog).getByRole("region", { name: "The whole script" }).textContent).toContain(CLEAN);
  expect(dialog.textContent).toContain("No lines are flagged. The check is a help: it looks for risky patterns. No flags does not mean the script is safe.");
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Don't run" }));
  expect((within(dialog).getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(slot.queryByRole("dialog")).toBeNull();
  expect(slot.inspection.rpcCalls.map((c) => c.method)).not.toContain("script_approve");
  expect(scriptRuns(slot)).toEqual([]);
});

test("Approve stays off until the script is scrolled to its end and the flagged lines are confirmed; then the script runs and the label says it refreshes itself", async () => {
  const { render } = await setup(FLAGGED);
  const slot = render();
  fireEvent.click(await slot.findByRole("button", { name: 'Review script "jobs"' }));
  const dialog = slot.getByRole("dialog");
  const approve = within(dialog).getByRole("button", { name: "Approve" }) as HTMLButtonElement;
  expect(dialog.textContent).toContain("Flagged, line 1: asks for elevated rights");
  expect(dialog.textContent).toContain("1 line is flagged.");
  expect(dialog.textContent).toContain("Scroll to the end of the script to approve it.");

  // Tab stays inside the dialog: from its last control (Don't run, while Approve is off) to its first (the script), and back.
  const dontRun = within(dialog).getByRole("button", { name: "Don't run" });
  expect(document.activeElement).toBe(dontRun);
  fireEvent.keyDown(dialog, { key: "Tab" });
  expect(document.activeElement).toBe(within(dialog).getByRole("region", { name: "The whole script" }));
  fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(dontRun);

  const scroller = within(dialog).getByRole("region", { name: "The whole script" });
  fireEvent.scroll(scroller, { target: { scrollTop: 400 } });
  expect(approve.disabled).toBe(true); // not at the end yet
  fireEvent.scroll(scroller, { target: { scrollTop: 800 } });
  expect(approve.disabled).toBe(true); // at the end, but the flagged line is not confirmed
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "I have read the flagged lines" }));
  expect(approve.disabled).toBe(false);
  fireEvent.click(approve);

  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(value(slot, "Queued jobs")).toContain("5"), { timeout: 5000 });
  expect(header(slot)).toContain("Refresh asks the agent"); // no longer "Needs your approval"; the agent source decides the rest
  expect(slot.getByText(/Updated just now · refreshes itself/)).toBeTruthy(); // Freshness of the script source
  expect(slot.getByRole("button", { name: "Runs a script" })).toBeTruthy();
  // With the other header controls, in their shared box, before Edit.
  const controls = Array.from(slot.getByRole("group", { name: "View controls" }).querySelectorAll("button, select"), (c) => c.getAttribute("aria-label") ?? c.textContent);
  expect(controls.slice(0, 3)).toEqual(["Runs a script", "Edit", "Colours"]);
  expect(slot.getByRole("button", { name: "Runs a script" }).className.startsWith(CONTROL)).toBe(true);
  expect(slot.queryByText(/waiting for your approval/)).toBeNull();
  expect(scriptRuns(slot).length).toBeGreaterThan(0);
});

test("a save while the dialog is open does not change what Approve approves: it is refused as changed", async () => {
  const { host, id, render } = await setup(CLEAN);
  const slot = render();
  fireEvent.click(await slot.findByRole("button", { name: 'Review script "jobs"' }));
  fireEvent.scroll(within(slot.getByRole("dialog")).getByRole("region", { name: "The whole script" }), { target: { scrollTop: 800 } });
  await host.save({ id, sources: [jobs(`printf '{"rows":[9,9,9]}'`), { name: "incidents", kind: "agent" }] });
  const ping = host.harness.realtimeSignals.at(-1)!;
  await slot.behavior.emitRealtime(ping.channel, ping.payload);
  await waitFor(() => expect(slot.inspection.rpcCalls.filter((c) => c.method === "scripts").length).toBeGreaterThan(1)); // the panel reloaded
  const dialog = slot.getByRole("dialog");
  expect(within(dialog).getByRole("region", { name: "The whole script" }).textContent).toContain(CLEAN); // still the text the user read
  fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe("The script changed since you opened it. Review it again.");
  expect(host.db().prepare("SELECT COUNT(*) AS n FROM script_approvals").get()).toEqual({ n: 0 });
});

test("where scripts cannot run, the source says so and no approval is offered", async () => {
  const host = await startHost(async () => createPlugin({ secrets: memorySecrets(), toolPath: async () => TEST_PATH }), {}, { folder: dir, hostId: "host-2" });
  hosts.push(host);
  const { id } = await host.save({ title: "Job queue", program: PROGRAM, sources: [jobs(CLEAN), { name: "incidents", kind: "agent" }] });
  const rpc = Object.fromEntries(METHODS.map((m) => [m, (input: unknown) => host.harness.behavior.callRpc(m, input)])) as never;
  const slot = renderSlot({ component: DashboardView }, { id: id!, threadId: "thread-1", visible: true }, { rpc });
  expect(await slot.findByText(/Script "jobs": Scripts cannot run here: the thread's environment is on another machine/)).toBeTruthy();
  expect(header(slot)).toContain("Scripts cannot run here");
  expect(slot.getByText("Not loaded yet · scripts cannot run here")).toBeTruthy();
  expect(slot.queryByRole("button", { name: /Review script/ })).toBeNull();
  expect(scriptRuns(slot)).toEqual([]);
});

test("an edited script shows what changed since the approval, before the script", async () => {
  const { host, id, render, approveOnServer } = await setup(CLEAN);
  await approveOnServer();
  await host.save({ id, sources: [jobs(`printf '{"rows":[1,2]}'`), { name: "incidents", kind: "agent" }] });
  const slot = render();
  expect(await slot.findByText(/Script "jobs" is waiting for your approval: it changed since you approved it/)).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: 'Review script "jobs"' }));
  const dialog = slot.getByRole("dialog");
  const changes = within(dialog).getByRole("region", { name: "What changed since you approved it" });
  expect(within(changes).getByLabelText("Changed lines").textContent).toBe(`- ${CLEAN}+ printf '{"rows":[1,2]}'`);
  const order = Array.from(dialog.querySelectorAll("h3")).map((h) => h.textContent);
  expect(order).toEqual(["What changed since you approved it", "Why it exists", "What it gets", "The script, all 1 line"]); // the changes first, under the banner
  expect(scriptRuns(slot)).toEqual([]);
});

test("the badge lists the approved script, shows it again whole, and withdraws it: it stops and waits again", async () => {
  const { render, approveOnServer } = await setup(CLEAN);
  await approveOnServer();
  const slot = render();
  await waitFor(() => expect(value(slot, "Queued jobs")).toContain("5"), { timeout: 5000 });
  fireEvent.click(slot.getByRole("button", { name: "Runs a script" }));
  const list = slot.getByRole("list", { name: "Approved scripts" });
  expect(within(list).getAllByRole("listitem")[0]!.textContent).toMatch(/^"jobs" \(sh\), approved /);

  fireEvent.click(within(list).getByRole("button", { name: 'Read script "jobs"' }));
  const dialog = slot.getByRole("dialog", { name: 'The approved script "jobs"' });
  expect(within(dialog).getByRole("note").textContent).toBe(BANNER + LIMIT);
  expect(within(dialog).getByRole("region", { name: "The whole script" }).textContent).toContain(CLEAN);
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw approval" }));

  expect(await slot.findByText('Approval of "jobs" withdrawn: it no longer runs.')).toBeTruthy();
  await waitFor(() => expect(header(slot)).toContain("Needs your approval"));
  expect(slot.queryByRole("button", { name: "Runs a script" })).toBeNull();
  expect(slot.getByRole("button", { name: 'Review script "jobs"' })).toBeTruthy();
  const before = scriptRuns(slot).length;
  fireEvent.click(slot.getByRole("button", { name: 'Review script "jobs"' }));
  fireEvent.click(within(slot.getByRole("dialog")).getByRole("button", { name: "Don't run" }));
  expect(scriptRuns(slot).length).toBe(before);
});

test("a script secret is entered write-only in the panel; the script then runs", async () => {
  const code = `printf '{"rows":[%s]}' "$(printf %s "$QUEUE_READ_TOKEN" | wc -c | tr -d ' ')"`;
  const { render, approveOnServer } = await setup(code, { secrets: ["QUEUE_READ_TOKEN"] });
  await approveOnServer();
  const slot = render();
  expect(await slot.findByText('Script "jobs" needs QUEUE_READ_TOKEN before it runs.')).toBeTruthy();
  const field = slot.getByLabelText("New value for QUEUE_READ_TOKEN") as HTMLInputElement;
  expect(field.type).toBe("password");
  fireEvent.change(field, { target: { value: "invented-ui-token" } });
  fireEvent.click(slot.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(value(slot, "Queued jobs")).toContain("1"), { timeout: 5000 }); // one row: the token's length
  expect(document.body.innerHTML).not.toContain("invented-ui-token");
  expect(slot.queryByText(/needs QUEUE_READ_TOKEN/)).toBeNull();
});

test("the mode label: a script waiting for approval says so; an approved one refreshes itself", () => {
  expect(refreshMode([{ kind: "script", waiting: WAITING }, { kind: "file" }])).toBe("Needs your approval");
  expect(refreshMode([{ kind: "script", waiting: CANNOT_RUN }, { kind: "file" }])).toBe("Scripts cannot run here");
  expect(refreshMode([{ kind: "script" }, { kind: "file" }])).toBe("Refreshes itself");
  expect(refreshMode([{ kind: "script" }, { kind: "agent" }])).toBe("Refresh asks the agent");
});

test("lineDiff: kept, removed and added lines in order", () => {
  expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual([
    { kind: " ", text: "a" },
    { kind: "-", text: "b" },
    { kind: " ", text: "c" },
    { kind: "+", text: "d" },
  ]);
});
