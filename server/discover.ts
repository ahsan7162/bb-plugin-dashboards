// Finding MCP servers the user already set up: the top-level mcpServers of Claude Code's user config
// file and of a project folder's .mcp.json (PLAN section 7). It runs only when the user asks, and the
// file paths are parameters, so tests pass fixture files. The listing holds names and kinds only. An
// import reads the file again on the server and turns one entry into a connection draft: settings to
// copy, and secret values that go straight to the secure store. Every environment variable and header
// value counts as a secret; one written as ${VAR} is left for the user to set.
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { configSchema, connectionName, encryptedOrLocal, type Config } from "./connections";

export type Origin = "user" | "project";
export type Found = { source: Origin; name: string; kind: string; importable: boolean; reason: string | null };
export type Draft = { name: string; config: Config; secrets: Record<string, string> };
type Parsed = { kind: string; draft: Draft | null; reason: string | null };

const VARIABLE = /\$\{[^}]*\}/;
const SECRETISH = /token|secret|passw|api[-_]?key|auth|bearer|credential|private[-_]?key/i;
const stdioEntry = z.object({ command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() });
const httpEntry = z.object({ url: z.string(), headers: z.record(z.string(), z.string()).optional() });

async function readServers(path: string): Promise<{ entries: [string, unknown][]; note: string | null }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    return { entries: [], note: (cause as { code?: unknown }).code === "ENOENT" ? "was not found" : "could not be read" };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { entries: [], note: "is not valid JSON" };
  }
  const servers = typeof json === "object" && json !== null ? (json as { mcpServers?: unknown }).mcpServers : undefined;
  if (servers === undefined) return { entries: [], note: "lists no MCP servers" };
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return { entries: [], note: "has an mcpServers entry that could not be read" };
  return { entries: Object.entries(servers), note: null };
}

function parseEntry(rawName: string, entry: unknown): Parsed {
  const no = (kind: string, reason: string): Parsed => ({ kind, draft: null, reason });
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return no("unknown", "Its entry could not be read.");
  const e = entry as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type.slice(0, 20) : typeof e.command === "string" ? "stdio" : typeof e.url === "string" ? "http" : "unknown";
  const kind = type === "streamable-http" ? "http" : type;
  if ("oauth" in e) return no(kind, "It signs in through the browser (OAuth), which the plugin does not support.");
  if ("headersHelper" in e) return no(kind, "It gets its headers from a helper command, which the plugin does not run.");
  if (kind === "sse") return no(kind, "It uses the older SSE transport, which the plugin does not support.");
  const name = rawName.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 40);
  if (!connectionName.safeParse(name).success) return no(kind, "Its name cannot be made into a connection name.");

  const draft = (config: Config, secrets: Record<string, string>): Parsed => {
    const checked = configSchema.safeParse(config);
    if (!checked.success) return no(kind, `Its settings do not fit a connection: ${checked.error.issues[0]?.message ?? "unknown problem"}.`);
    return { kind, draft: { name, config: checked.data, secrets }, reason: null };
  };

  if (kind === "stdio") {
    const parsed = stdioEntry.safeParse(e);
    if (!parsed.success) return no(kind, "Its entry could not be read.");
    const { command, args = [], env = {} } = parsed.data;
    if ([command, ...args].some((v) => VARIABLE.test(v))) return no(kind, "Its command or arguments use ${...} variables, which the plugin cannot fill in.");
    if (args.some((a) => SECRETISH.test(a))) return no(kind, "An argument seems to carry a secret. Move it into an environment variable, then import again.");
    const values = Object.entries(env).filter(([, v]) => v !== "" && !VARIABLE.test(v));
    return draft({ kind: "stdio", command, args, env: {}, secretEnv: Object.keys(env) }, Object.fromEntries(values.map(([k, v]) => [`env.${k}`, v])));
  }
  if (kind === "http") {
    const parsed = httpEntry.safeParse(e);
    if (!parsed.success) return no(kind, "Its entry could not be read.");
    const { url, headers = {} } = parsed.data;
    if (VARIABLE.test(url)) return no(kind, "Its address uses ${...} variables, which the plugin cannot fill in.");
    let address: URL;
    try {
      address = new URL(url);
    } catch {
      return no(kind, "Its address is not a valid URL.");
    }
    if (address.username !== "" || address.password !== "" || [...address.searchParams.keys()].some((k) => SECRETISH.test(k))) {
      return no(kind, "Its address seems to carry a secret. The plugin takes secrets only as a token or a header.");
    }
    if (!encryptedOrLocal(url)) return no(kind, "Its address is plain http to another machine, where a token would travel unencrypted. The plugin takes http only for this machine; use https.");
    const secrets: Record<string, string> = {};
    const secretHeaders: string[] = [];
    for (const [header, value] of Object.entries(headers)) {
      if (header.toLowerCase() === "authorization") {
        const bearer = /^bearer\s+(\S.*)$/i.exec(value.trim());
        if (bearer === null) return no(kind, "Its Authorization header is not a bearer token, the only kind the plugin sends.");
        if (!VARIABLE.test(bearer[1]!)) secrets.token = bearer[1]!;
        continue;
      }
      secretHeaders.push(header);
      if (value !== "" && !VARIABLE.test(value)) secrets[`header.${header}`] = value;
    }
    return draft({ kind: "http", url, secretHeaders }, secrets);
  }
  return no(kind, `Its type "${type}" is not one the plugin knows.`);
}

/** Every server in the given files, by name and kind, with why it cannot be imported where it cannot. Never a value. */
export async function discover(paths: { user: string | null; project: string | null }, taken: (name: string) => boolean): Promise<{ servers: Found[]; notes: string[] }> {
  const servers: Found[] = [];
  const notes: string[] = [];
  const files = [
    ["user", paths.user, "Claude Code's user config file"],
    ["project", paths.project, "The folder's .mcp.json"],
  ] as const;
  for (const [source, path, label] of files) {
    if (path === null) continue;
    const read = await readServers(path);
    if (read.note !== null) notes.push(`${label} ${read.note}.`);
    for (const [name, entry] of read.entries) {
      const parsed = parseEntry(name, entry);
      const reason = parsed.reason ?? (taken(parsed.draft!.name) ? `A connection named "${parsed.draft!.name}" exists already.` : null);
      servers.push({ source, name: name.slice(0, 80), kind: parsed.kind, importable: reason === null, reason });
    }
  }
  return { servers, notes };
}

/** The named server's draft, read again from the file. */
export async function draftFor(path: string, name: string): Promise<{ ok: true; draft: Draft } | { ok: false; error: string }> {
  const entry = (await readServers(path)).entries.find(([n]) => n === name);
  if (entry === undefined) return { ok: false, error: `"${name}" is no longer in that file.` };
  const parsed = parseEntry(name, entry[1]);
  return parsed.draft !== null ? { ok: true, draft: parsed.draft } : { ok: false, error: parsed.reason! };
}
