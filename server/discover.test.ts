// "Find existing servers" and import, through the plugin's RPC with fixture config files (invented
// servers and values in a temporary folder). No test reads this machine's real config files: the user
// config path is always a fixture, and folders are temporary ones.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { createPlugin } from "../server";
import { TEST_PATH, memorySecrets, startHost } from "../test/host";
import type { SecretStore } from "./secrets";

const dir = mkdtempSync(join(tmpdir(), "oa-discover-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const INLINE = ["invented-inline-secret-1", "invented-inline-secret-2", "invented-inline-secret-3", "invented-inline-secret-4", "invented-inline-secret-5"];
const USER_CONFIG = {
  numStartups: 3,
  projects: { "/work/corner-shop": { mcpServers: { "project-local": { command: "node", args: ["local.mjs"] } } } }, // not top level: not listed
  mcpServers: {
    "widget-shop": { type: "stdio", command: "node", args: ["widget-server.mjs"], env: { WIDGET_TOKEN: INLINE[0], WIDGET_REGION: "north" } },
    notes: { type: "http", url: "https://notes.example.com/mcp", headers: { Authorization: `Bearer ${INLINE[1]}`, "X-Shop-Key": INLINE[2] } },
    "old-events": { type: "sse", url: "https://events.example.com/sse" },
    calendar: { type: "http", url: "https://calendar.example.com/mcp", oauth: { clientId: "invented-client" } },
    broken: "not an object",
    flagged: { command: "widget-cli", args: [`--api-key=${INLINE[3]}`] },
    "from-env": { command: "node", args: ["stock.mjs"], env: { WIDGET_TOKEN: "${WIDGET_TOKEN}" } },
    "plain-notes": { type: "http", url: "http://plain-notes.example.com/mcp" },
    "local-notes": { type: "http", url: "http://localhost:8123/mcp" },
  },
};
const PROJECT_CONFIG = {
  mcpServers: {
    stock: { command: "npx", args: ["-y", "invented-stock-server"] },
    "keyed url": { type: "http", url: `https://stock.example.com/mcp?api_key=${INLINE[4]}` },
  },
};
/** Everything the fixture files hold besides names and kinds; none of it may reach the page. */
const VALUES = [...INLINE, "widget-server.mjs", "notes.example.com", "north", "WIDGET_TOKEN", "WIDGET_REGION", "X-Shop-Key", "invented-client", "--api-key", "invented-stock-server", "stock.example.com", "local.mjs", "localhost:8123"];
const PLAIN_HTTP = "Its address is plain http to another machine, where a token would travel unencrypted. The plugin takes http only for this machine; use https.";

/** Writes the fixture files; null writes none. */
function files(user: unknown, project: unknown) {
  const folder = mkdtempSync(join(dir, "case-"));
  const project_ = join(folder, "project");
  mkdirSync(project_);
  const userPath = join(folder, "claude.json");
  if (user !== null) writeFileSync(userPath, typeof user === "string" ? user : JSON.stringify(user));
  if (project !== null) writeFileSync(join(project_, ".mcp.json"), JSON.stringify(project));
  return { userPath, project: project_ };
}

async function setup(secrets: SecretStore & { entries?: Map<string, string> } = memorySecrets(), user: unknown = USER_CONFIG, project: unknown = PROJECT_CONFIG) {
  const paths = files(user, project);
  const host = await startHost(async () => createPlugin({ secrets, claudeConfig: paths.userPath, toolPath: async () => TEST_PATH }));
  return { ...host, ...paths, secrets };
}

describe("find existing servers", () => {
  test("names and kinds from both files, each importable or with the reason; never a value", async () => {
    const { rpc, project, harness } = await setup();
    const found = await rpc("discover", { folder: project });
    expect(found).toEqual({
      servers: [
        { source: "user", name: "widget-shop", kind: "stdio", importable: true, reason: null },
        { source: "user", name: "notes", kind: "http", importable: true, reason: null },
        { source: "user", name: "old-events", kind: "sse", importable: false, reason: "It uses the older SSE transport, which the plugin does not support." },
        { source: "user", name: "calendar", kind: "http", importable: false, reason: "It signs in through the browser (OAuth), which the plugin does not support." },
        { source: "user", name: "broken", kind: "unknown", importable: false, reason: "Its entry could not be read." },
        { source: "user", name: "flagged", kind: "stdio", importable: false, reason: "An argument seems to carry a secret. Move it into an environment variable, then import again." },
        { source: "user", name: "from-env", kind: "stdio", importable: true, reason: null },
        { source: "user", name: "plain-notes", kind: "http", importable: false, reason: PLAIN_HTTP },
        { source: "user", name: "local-notes", kind: "http", importable: true, reason: null },
        { source: "project", name: "stock", kind: "stdio", importable: true, reason: null },
        { source: "project", name: "keyed url", kind: "http", importable: false, reason: "Its address seems to carry a secret. The plugin takes secrets only as a token or a header." },
      ],
      notes: [],
    });
    for (const value of VALUES) expect(JSON.stringify(found)).not.toContain(value);
    expect(harness.sdk.calls).toEqual([]);
  });

  test("an import copies the settings and moves every inline value straight into the secure store", async () => {
    const { rpc, project, secrets, db } = await setup();
    const shop = await rpc("discover_import", { source: "user", folder: null, name: "widget-shop" });
    expect(shop).toEqual({ ok: true, id: expect.stringMatching(/^[0-9a-f]{12}$/) });
    const notes = await rpc("discover_import", { source: "user", folder: null, name: "notes" });
    const fromEnv = await rpc("discover_import", { source: "user", folder: null, name: "from-env" });
    const stock = await rpc("discover_import", { source: "project", folder: project, name: "stock" });

    expect(Object.fromEntries(secrets.entries!)).toEqual({
      [`${shop.id}.env.WIDGET_TOKEN`]: INLINE[0],
      [`${shop.id}.env.WIDGET_REGION`]: "north", // every variable's value counts as a secret
      [`${notes.id}.token`]: INLINE[1],
      [`${notes.id}.header.X-Shop-Key`]: INLINE[2],
    });
    const rows = db().prepare("SELECT name, config, secrets FROM connections ORDER BY name").all() as { name: string; config: string; secrets: string }[];
    expect(rows.map((r) => [r.name, JSON.parse(r.config), JSON.parse(r.secrets)])).toEqual([
      ["from-env", { kind: "stdio", command: "node", args: ["stock.mjs"], env: {}, secretEnv: ["WIDGET_TOKEN"] }, []], // ${WIDGET_TOKEN} is left for the user to set
      ["notes", { kind: "http", url: "https://notes.example.com/mcp", secretHeaders: ["X-Shop-Key"] }, ["token", "header.X-Shop-Key"]],
      ["stock", { kind: "stdio", command: "npx", args: ["-y", "invented-stock-server"], env: {}, secretEnv: [] }, []],
      ["widget-shop", { kind: "stdio", command: "node", args: ["widget-server.mjs"], env: {}, secretEnv: ["WIDGET_TOKEN", "WIDGET_REGION"] }, ["env.WIDGET_TOKEN", "env.WIDGET_REGION"]],
    ]);
    for (const secret of INLINE) expect(JSON.stringify(db().prepare("SELECT * FROM connections").all())).not.toContain(secret);

    const listed = await rpc("connections_list");
    for (const secret of INLINE) expect(JSON.stringify(listed)).not.toContain(secret);
    expect(listed.connections.find((c: { name: string }) => c.name === "from-env").secrets).toEqual([{ slot: "env.WIDGET_TOKEN", label: "WIDGET_TOKEN", required: true, set: false }]);
    expect(stock.ok && fromEnv.ok).toBe(true);
  });

  test("a second import of the same server, a server that cannot be imported or is gone, are refused with the reason", async () => {
    const { rpc, project } = await setup();
    await rpc("discover_import", { source: "user", folder: null, name: "widget-shop" });
    expect(await rpc("discover_import", { source: "user", folder: null, name: "widget-shop" })).toEqual({ ok: false, error: 'A connection named "widget-shop" exists already.' });
    expect((await rpc("discover", { folder: null })).servers[0]).toEqual({ source: "user", name: "widget-shop", kind: "stdio", importable: false, reason: 'A connection named "widget-shop" exists already.' });
    expect(await rpc("discover_import", { source: "user", folder: null, name: "calendar" })).toEqual({ ok: false, error: "It signs in through the browser (OAuth), which the plugin does not support." });
    expect(await rpc("discover_import", { source: "user", folder: null, name: "plain-notes" })).toEqual({ ok: false, error: PLAIN_HTTP });
    expect((await rpc("discover_import", { source: "user", folder: null, name: "local-notes" })).ok).toBe(true);
    expect(await rpc("discover_import", { source: "user", folder: null, name: "nowhere" })).toEqual({ ok: false, error: '"nowhere" is no longer in that file.' });
    expect(await rpc("discover_import", { source: "project", folder: null, name: "stock" })).toEqual({ ok: false, error: "Give the folder the server was found in." });
    await expect(rpc("discover", { folder: "relative/folder" })).rejects.toThrow("rpc input validation failed"); // only absolute folders
    expect((await rpc("discover_import", { source: "project", folder: project, name: "stock" })).ok).toBe(true);
  });

  test("without a working secure store, a server with secrets is not imported; one without is", async () => {
    const store = { ...memorySecrets(), unavailable: async () => "No Secret Service keyring answered (for example GNOME Keyring or KWallet)." };
    const { rpc, project } = await setup(store);
    expect(await rpc("discover_import", { source: "user", folder: null, name: "widget-shop" })).toEqual({
      ok: false,
      error: "Connections with secrets are unavailable on this machine: No Secret Service keyring answered (for example GNOME Keyring or KWallet).",
    });
    expect((await rpc("discover_import", { source: "project", folder: project, name: "stock" })).ok).toBe(true);
    expect((await rpc("connections_list")).store).toEqual({ label: "the test store", unavailable: "No Secret Service keyring answered (for example GNOME Keyring or KWallet)." });
  });

  test("missing, unreadable or empty files are notes, not errors", async () => {
    const missing = await setup(memorySecrets(), null, null);
    expect(await missing.rpc("discover", { folder: missing.project })).toEqual({ servers: [], notes: ["Claude Code's user config file was not found.", "The folder's .mcp.json was not found."] });
    const junk = await setup(memorySecrets(), "{ not json", { other: 1 });
    expect(await junk.rpc("discover", { folder: junk.project })).toEqual({ servers: [], notes: ["Claude Code's user config file is not valid JSON.", "The folder's .mcp.json lists no MCP servers."] });
  });
});
