// Version listing, restoring and pruning, delete and reading themes saved before font became a fixed choice,
// through bb's fake plugin host, run twice like server.test.ts: from server.ts and from the built dist/server.js.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { PROGRAM, startHost, type Factory } from "../test/host";
import { KEEP_VERSIONS } from "./store";

const BUNDLE = join(fileURLToPath(new URL("../", import.meta.url)), "dist/server.js");
const builds: [string, () => Promise<Factory>][] = [
  ["server.ts", async () => (await import("../server")).default],
  ["dist/server.js", async () => (await import(/* @vite-ignore */ BUNDLE)).default],
];

type Read = { dashboard: { version: number; title: string; program: string; theme: unknown } | null; versions: { version: number; createdAt: number }[] };

describe.each(builds)("%s", (_, load) => {
  test("read lists every version, newest first, whichever version it returns", async () => {
    const { save, harness } = await startHost(load);
    const read = (input: unknown) => harness.behavior.callRpc("read", input) as Promise<Read>;
    expect(await read({ id: "0123456789ab" })).toEqual({ dashboard: null, versions: [] });

    const { id } = await save({ title: "Shop orders", program: PROGRAM });
    expect((await read({ id })).versions).toEqual([{ version: 1, createdAt: expect.any(Number) }]);
    await save({ id, patch: `main = Section("Orders", [])` });
    await save({ id, patch: `main = Section("Orders this week", [])` });

    const latest = await read({ id });
    expect(latest.dashboard!.version).toBe(3);
    expect(latest.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    const first = await read({ id, version: 1 });
    expect(first.dashboard!.version).toBe(1);
    expect(first.versions).toEqual(latest.versions);
    expect(latest.versions[0]!.createdAt).toBeGreaterThanOrEqual(latest.versions[2]!.createdAt);
  });

  test("restore saves an old version's program, theme and sources as the next version, with a save's ping; history is kept", async () => {
    const { save, harness, db } = await startHost(load);
    const read = (input: unknown) => harness.behavior.callRpc("read", input) as Promise<Read>;
    const theme = { light: { accent: "#1f6f43" } };
    const { id } = await save({ title: "Shop orders", program: PROGRAM, theme });
    const restore = (version: number) => harness.behavior.callRpc("restore", { id, version });
    await save({ id, title: "Shop overview", patch: `main = Section("Orders", [])`, theme: null });

    expect(await restore(1)).toEqual({ ok: true, version: 3 });
    const latest = await read({ id });
    expect(latest.dashboard).toMatchObject({ version: 3, program: PROGRAM, theme, title: "Shop overview" }); // the title is not versioned
    expect(latest.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(harness.realtimeSignals.at(-1)).toEqual({ channel: "dashboard-saved", payload: { dashboardId: id, version: 3 } });

    // A program that no longer passes the save check is refused; nothing is stored or published.
    db().prepare("UPDATE versions SET program = ? WHERE dashboard_id = ? AND number = 1").run(`${PROGRAM}\nm = Mutation("delete_order", {})`, id);
    const signals = harness.realtimeSignals.length;
    expect(await restore(1)).toEqual({ ok: false, error: expect.stringMatching(/^Version 1 cannot be restored: it no longer passes the save check\. .*Mutation/) });
    expect(await restore(9)).toEqual({ ok: false, error: "There is no version 9 of this dashboard." });
    expect((await read({ id })).versions).toHaveLength(3);
    expect(harness.realtimeSignals).toHaveLength(signals);
  });

  test(`only the newest ${KEEP_VERSIONS} versions are kept, and numbers go on from the highest: 105 saves keep 6 to 105, the next is 106`, async () => {
    const { save, harness } = await startHost(load);
    const read = (input: unknown) => harness.behavior.callRpc("read", input) as Promise<Read>;
    const { id } = await save({ title: "Shop orders", program: PROGRAM });
    for (let n = 2; n <= 105; n++) await save({ id, patch: `main = Section("Orders ${n}", [])` });
    const numbers = async () => (await read({ id })).versions.map((v) => v.version);
    expect(await numbers()).toEqual(Array.from({ length: KEEP_VERSIONS }, (_, i) => 105 - i));
    expect((await read({ id, version: 5 })).dashboard).toBeNull();
    expect((await read({ id, version: 6 })).dashboard!.program).toContain(`"Orders 6"`);
    expect(await harness.behavior.callRpc("list", null)).toMatchObject({ dashboards: [{ id, version: 105, versions: KEEP_VERSIONS }] });
    expect((await save({ id, patch: `main = Section("Orders 106", [])` })).text).toContain("version 106");
    expect((await numbers()).at(-1)).toBe(7);
  });

  test("delete removes the dashboard and all its versions, and only that dashboard", async () => {
    const { save, harness, db } = await startHost(load);
    const { id } = await save({ title: "Shop orders", program: PROGRAM });
    await save({ id, patch: `main = Section("Orders", [])` });
    const { id: other } = await save({ title: "Support queue", program: PROGRAM });

    expect(await harness.behavior.callRpc("delete", { id })).toEqual({ deleted: true });
    expect(await harness.behavior.callRpc("read", { id })).toEqual({ dashboard: null, versions: [] });
    expect(db().prepare("SELECT dashboard_id AS id FROM versions").all()).toEqual([{ id: other }]);
    expect(db().prepare("SELECT id FROM dashboards").all()).toEqual([{ id: other }]);
    expect(((await harness.behavior.callRpc("list", null)) as { dashboards: { id: string }[] }).dashboards.map((a) => a.id)).toEqual([other]);

    expect(await harness.behavior.callRpc("delete", { id })).toEqual({ deleted: false });
    await expect(harness.behavior.callRpc("delete", { id: "../etc" })).rejects.toThrow();
    const again = await save({ id, patch: `main = Section("Orders", [])` });
    expect(again.text).toContain(`There is no dashboard ${id}`);
  });

  test("a theme saved with a free-form font still loads, without the font", async () => {
    const { save, harness, db } = await startHost(load);
    const { id } = await save({ title: "Old shop", program: PROGRAM });
    db().prepare("UPDATE versions SET theme = ? WHERE dashboard_id = ?").run(JSON.stringify({ light: { accent: "#1f6f43" }, font: "Georgia, serif" }), id);
    const { dashboard } = (await harness.behavior.callRpc("read", { id })) as Read;
    expect(dashboard!.theme).toEqual({ light: { accent: "#1f6f43" } });
  });
});
