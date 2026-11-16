// A fake bb host running the plugin's server, shared by the server and browser tests. The origin
// thread's folders and files are invented and live in memory; no test reads this machine's files.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { SecretStore } from "../server/secrets";

export type Factory = (bb: BbPluginApi) => unknown;

/** The invented stdio MCP server, started with this Node. From the working folder: jsdom tests have no file: import.meta.url. */
export const FIXTURE = join(process.cwd(), "test/fixtures/mcp-server.mjs");
/** The PATH tests give local-command servers, so no test runs the login shell to find bb's. */
export const TEST_PATH = "/usr/bin:/bin";

/**
 * Deletes every login-Keychain entry of a test service, whatever a failed test left, without reading a
 * value; true when none remain. Only invented test services: the plugin's own name is refused.
 */
export function clearTestService(service: string): boolean {
  if (!service.startsWith("bb-dashboards-test-")) throw new Error("only a test service");
  if (process.platform !== "darwin") return true;
  for (let i = 0; i < 100 && spawnSync("/usr/bin/security", ["delete-generic-password", "-s", service]).status === 0; i++);
  return spawnSync("/usr/bin/security", ["find-generic-password", "-s", service]).status === 44;
}

/** A secure store in memory, for tests that are not about the real one. */
export function memorySecrets(): SecretStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    label: "the test store",
    entries,
    unavailable: async () => null,
    set: async (account, value) => void entries.set(account, value),
    get: async (account) => entries.get(account) ?? null,
    delete: async (account) => void entries.delete(account),
  };
}

export const PROGRAM = `root = Dashboard([main])
main = Section("Orders", [Row([Card("Today", [KeyValues([KeyValue("Orders", 42, "number")])])])])`;

/** The origin thread's environment and storage folders (invented paths). */
export const FOLDER = "/work/corner-shop";
export const STORAGE = "/work/thread-storage/thread-1";

/**
 * Files by absolute path. A string is the file's text; `{ size }` a file of that many bytes; `{ escape }`
 * a link to outside its folder, which bb refuses when given rootPath (its daemon realpaths both).
 */
export type FakeFiles = Record<string, string | { size: number } | { escape: true }>;

function fakeRead(files: FakeFiles, { path, rootPath }: { path: string; rootPath?: string }) {
  const file = files[path];
  if (file === undefined) throw Object.assign(new Error(`Path does not exist: ${path}`), { code: "ENOENT" });
  if (typeof file === "object" && "escape" in file) {
    if (rootPath !== undefined) throw Object.assign(new Error(`Path "${path}" escapes read root`), { code: "invalid_path" });
    return { content: "outside", contentEncoding: "utf8" as const, path, sha256: "0", sizeBytes: 7 };
  }
  if (typeof file === "object") return { content: "{}", contentEncoding: "utf8" as const, path, sha256: "0", sizeBytes: file.size };
  return { content: file, contentEncoding: "utf8" as const, path, sha256: "0", sizeBytes: Buffer.byteLength(file) };
}

const textOf = (result: PluginAgentToolResult) => (typeof result === "string" ? result : result.content.map((p) => ("text" in p ? p.text : "")).join(""));
const isError = (result: PluginAgentToolResult) => typeof result !== "string" && result.isError === true;

/**
 * The plugin in bb's fake host. The origin thread's environment is FOLDER on "host-1", the bb server's
 * own machine; `folder` gives a real folder instead (for scripts, which run there), `hostId` another machine.
 */
export async function startHost(load: () => Promise<Factory>, files: FakeFiles = {}, where: { folder?: string; hostId?: string } = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "dashboards",
    agentSkillIds: ["dashboards"], // the manifest's skill (skills/dashboards), which configure selects
    sdk: {
      threads: {
        get: async () => ({ ...makeThreadResponse({ id: "thread-1", environmentId: "env-1" }), environment: { id: "env-1", hostId: where.hostId ?? "host-1", path: where.folder ?? FOLDER } }),
        storageLocation: async () => ({ hostId: "host-1", storageRootPath: STORAGE }),
      },
      system: { config: async () => ({ primaryHostId: "host-1" }) },
      files: { read: async (args: { path: string; rootPath?: string }) => fakeRead(files, args) },
    } as never,
  });
  await (await load())(bb);
  const call = async (tool: string, input: unknown) => {
    const result = await harness.behavior.callAgentTool(tool, input, { threadId: "thread-1", projectId: "project-1" });
    return { text: textOf(result), error: isError(result) };
  };
  const save = async (input: unknown) => {
    const result = await call("dashboard_save", input);
    return { ...result, id: result.text.match(/dashboard ([0-9a-f]{12})/)?.[1] ?? null };
  };
  type Answer = { ok: boolean; data?: unknown; error?: string; fetchedAt?: number };
  const run = (input: unknown) => harness.behavior.callRpc("source_run", input) as Promise<Answer>;
  // any: each test reads the fields of the answer it asked for
  const rpc = (method: string, input: unknown = null) => harness.behavior.callRpc(method, input) as Promise<any>;
  const db = () => bb.storage.database();
  return { bb, harness, call, save, run, rpc, db, files };
}
