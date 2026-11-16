// @vitest-environment jsdom
// The Connections section of the plugin's page, and an mcp source in the panel, in bb's frontend harness.
// Their RPC is answered by the real plugin server in bb's fake host, with the invented stdio fixture
// server, a secure store in memory and a fixture Claude Code config file.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, expect, test } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createPlugin } from "../server";
import { FIXTURE, TEST_PATH, memorySecrets, startHost } from "../test/host";
import { CONNECTIONS_LIMIT } from "./connections";
import { DashboardView } from "./panel";

const app = await loadPluginApp(() => import("../app"));
const page = app.navPanels[0]!;
const dir = mkdtempSync(join(tmpdir(), "oa-ui-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const TOKEN = "invented-ui-widget-token-41c2";

type Host = Awaited<ReturnType<typeof startHost>>;
const hosts: Host[] = [];
afterEach(async () => void (await Promise.all(hosts.splice(0).map((h) => h.harness.lifecycle.dispose()))));

const METHODS = ["read", "list", "source_run", "connections_list", "connection_add", "connection_secret", "connection_check", "connection_confirm", "connection_remove", "discover", "discover_import"];
async function setup(claudeConfig?: string) {
  const secrets = memorySecrets();
  const host = await startHost(async () => createPlugin({ secrets, toolPath: async () => TEST_PATH, claudeConfig: claudeConfig ?? join(dir, "no-such-config.json") }));
  hosts.push(host);
  const rpc = Object.fromEntries(METHODS.map((m) => [m, (input: unknown) => host.harness.behavior.callRpc(m, input)])) as never;
  return { ...host, secrets, rpc };
}
const connectionsPage = (rpc: never) => renderSlot(page, { subPath: "connections" }, { rpc, sdk: { threads: { list: async () => [] as never } } });

test("add a local-command connection, set its secret write-only, confirm its read-only tools, remove it", async () => {
  const { rpc, secrets } = await setup();
  const slot = connectionsPage(rpc);
  expect(await slot.findByText(/No connections yet/)).toBeTruthy();
  expect(slot.getByRole("button", { name: "Connections" }).getAttribute("aria-current")).toBe("page");
  // The limit, said plainly: bb cannot tell this page from its command line.
  expect(slot.getByRole("note").textContent).toBe(CONNECTIONS_LIMIT);
  expect(CONNECTIONS_LIMIT).toContain("An agent you allow to run shell commands could add, change or remove a connection, or set its secrets, without this page, and could also run commands directly.");

  fireEvent.click(slot.getByRole("button", { name: "Add a connection" }));
  const form = slot.getByRole("form", { name: "Add a connection" });
  fireEvent.change(within(form).getByLabelText("Name (letters, digits, _ . -)"), { target: { value: "widget-shop" } });
  fireEvent.change(within(form).getByLabelText("Command"), { target: { value: process.execPath } });
  fireEvent.change(within(form).getByLabelText("Arguments, one per line"), { target: { value: FIXTURE } });
  fireEvent.change(within(form).getByLabelText(/^Secret variables/), { target: { value: "WIDGET_TOKEN" } });
  fireEvent.click(within(form).getByRole("button", { name: "Add" }));

  // Adding lists the tools at once; without its secret the server is not started.
  expect(await slot.findByText('Could not list its tools: WIDGET_TOKEN of "widget-shop" is not set. Set it on the Connections page.')).toBeTruthy();
  expect(slot.getByText("Not ready: WIDGET_TOKEN not set.")).toBeTruthy();

  const secretField = slot.getByLabelText("New value for WIDGET_TOKEN") as HTMLInputElement;
  expect(secretField.type).toBe("password");
  fireEvent.change(secretField, { target: { value: TOKEN } });
  fireEvent.click(slot.getByRole("button", { name: "Save" }));
  expect(await slot.findByText("Tools not confirmed yet.")).toBeTruthy();
  expect((slot.getByLabelText("New value for WIDGET_TOKEN") as HTMLInputElement).value).toBe(""); // emptied, never read back
  expect(slot.getByText("set")).toBeTruthy();
  expect([...secrets.entries.values()]).toEqual([TOKEN]);
  expect(document.body.innerHTML).not.toContain(TOKEN);

  fireEvent.click(slot.getByRole("button", { name: "List and confirm the tools of widget-shop" }));
  const offered = await slot.findByRole("group", { name: "Read-only tools the server offers" });
  expect(within(offered).getAllByRole("checkbox").map((box) => box.closest("label")!.querySelector(".font-mono")!.textContent)).toEqual(["count_widgets", "list_orders", "shop_motto", "big_report", "slow_report"]);
  expect(offered.textContent).toContain("2 other tools are not marked read-only and can never be called.");
  for (const name of ["shop_motto", "big_report", "slow_report"]) fireEvent.click(within(offered).getByRole("checkbox", { name: new RegExp(`^${name}`) }));
  fireEvent.click(within(offered).getByRole("button", { name: "Confirm these tools" }));
  expect(await slot.findByText("Ready: 2 read-only tools confirmed (count_widgets, list_orders).")).toBeTruthy();

  fireEvent.click(slot.getByRole("button", { name: "Remove widget-shop" }));
  fireEvent.click(within(slot.getByRole("group", { name: "Confirm removing widget-shop" })).getByRole("button", { name: "Remove" }));
  expect(await slot.findByText(/No connections yet/)).toBeTruthy();
  expect(secrets.entries.size).toBe(0);
  expect(slot.inspection.rpcCalls.filter((c) => c.method === "connections_list").every((c) => !JSON.stringify(c).includes(TOKEN))).toBe(true);
});

test("find existing servers shows names and kinds only, and imports one on a second click", async () => {
  const config = join(dir, "claude.json");
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        "widget-shop": { command: process.execPath, args: [FIXTURE], env: { WIDGET_TOKEN: TOKEN } },
        calendar: { type: "http", url: "https://calendar.example.com/mcp", oauth: { clientId: "invented-client" } },
      },
    }),
  );
  const { rpc, secrets } = await setup(config);
  const slot = connectionsPage(rpc);
  await slot.findByText(/No connections yet/);
  fireEvent.click(slot.getByRole("button", { name: "Find existing servers" }));
  const found = await slot.findByRole("list", { name: "Servers found" });
  const rows = within(found).getAllByRole("listitem");
  expect(rows.map((r) => r.textContent)).toEqual([
    "widget-shop stdio · Claude Code user configImport",
    "calendar http · Claude Code user configNot importable: It signs in through the browser (OAuth), which the plugin does not support.",
  ]);
  for (const hidden of [TOKEN, FIXTURE, "calendar.example.com", "invented-client", "WIDGET_TOKEN"]) expect(document.body.innerHTML).not.toContain(hidden);
  expect(slot.inspection.rpcCalls.map((c) => c.method)).not.toContain("discover_import");

  fireEvent.click(within(found).getByRole("button", { name: "Import widget-shop" }));
  expect(await slot.findByText("Imported.")).toBeTruthy();
  expect(await slot.findByRole("group", { name: "Read-only tools the server offers" })).toBeTruthy(); // its secret came along, so the server started
  expect([...secrets.entries.values()]).toEqual([TOKEN]);
  expect(document.body.innerHTML).not.toContain(TOKEN);
});

test("an mcp source refreshes itself: the panel's mode label and Freshness say so, and its data shows", async () => {
  const { rpc, save } = await setup();
  const host = hosts[0]!;
  const { id } = await host.rpc("connection_add", { name: "widget-shop", config: { kind: "stdio", command: process.execPath, args: [FIXTURE], env: {}, secretEnv: [] } });
  await host.rpc("connection_confirm", { id, tools: ["count_widgets"] });
  const program = `root = Dashboard([main])\nstock = Query("stock", {}, {count: 0})\nmain = Section("Stock", [Kpis([Kpi("Teal widgets", stock.count, "number")]), Freshness("stock")])`;
  const saved = await save({ title: "Widget stock", program, sources: [{ name: "stock", kind: "mcp", connection: "widget-shop", tool: "count_widgets", args: { colour: "teal" } }] });
  expect(saved.error, saved.text).toBe(false);
  const slot = renderSlot({ component: DashboardView }, { id: saved.id!, threadId: "thread-1", visible: true }, { rpc });
  expect(await slot.findByText("Refreshes itself")).toBeTruthy();
  await waitFor(() => expect(slot.getByText(/Updated just now · refreshes itself/)).toBeTruthy());
  expect(slot.getByText("42")).toBeTruthy();
});
