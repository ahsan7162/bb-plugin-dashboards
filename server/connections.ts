// The plugin's own MCP connections (PLAN sections 7 to 9). Records live in its database and never hold
// a secret, only which secrets are set; secrets live in the OS secure store (server/secrets.ts) under
// "<connection id>.<slot>". Clients open on first use, are reused, close after an idle period or on
// dispose, and are dropped after any failure. A tool is sent only when the user confirmed it and the
// server still marks it read-only at that moment; anything else is refused before it reaches the server.
// A web server is reached over https, or plain http only on this machine (encryptedOrLocal).
import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { connect, failure, isReadOnly, listTools, resultData, type Answer, type Client, type Endpoint, type Tool } from "./mcp";
import type { SecretStore } from "./secrets";

export const TIMEOUTS = { connectMs: 15_000, listMs: 10_000, callMs: 20_000, idleMs: 5 * 60_000 };
export type Timeouts = typeof TIMEOUTS;
export const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_DESCRIPTION = 500;
const MAX_SCHEMA_CHARS = 4_000;

const unique = (names: string[]) => new Set(names).size === names.length;
const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "a variable name: letters, digits and _, not starting with a digit")
  .refine((n) => n.toUpperCase() !== "PATH", "PATH comes from bb");
const headerName = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/, "a header name: letters, digits and -")
  .refine((h) => h.toLowerCase() !== "authorization", "the token is sent as the Authorization header");
export const connectionName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/, "a name: letters, digits, _ . and -, starting with a letter or digit, 40 at most");
const webAddress = z
  .url({ protocol: /^https?$/ })
  .max(2000)
  .refine((u) => new URL(u).username === "" && new URL(u).password === "", "no user name or password in the address; use the token");

/**
 * The one check on a web connection's address, made when it is added, when it is imported and before each
 * use: https, or plain http only to this machine (localhost, 127.0.0.0/8, [::1]), so a token never travels
 * unencrypted to another one. It reads the parsed host, so localhost.example.com or localhost@example.com fail.
 */
export function encryptedOrLocal(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" || (protocol === "http:" && (hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)));
  } catch {
    return false;
  }
}

/** What a connection starts or reaches. Secret variables and headers are names here; their values are in the secure store. */
export const configSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("stdio"),
      command: z.string().trim().min(1).max(500),
      args: z.array(z.string().max(2000)).max(50),
      env: z.record(envName, z.string().max(2000)),
      secretEnv: z.array(envName).max(20).refine(unique, "each secret variable once"),
    })
    .strict()
    .refine((c) => c.secretEnv.every((n) => !(n in c.env)), "a variable is either plain or secret, not both"),
  z.object({ kind: z.literal("http"), url: webAddress, secretHeaders: z.array(headerName).max(20).refine(unique, "each header once") }).strict(),
]);
export type Config = z.infer<typeof configSchema>;
export type ConfirmedTool = { name: string; description: string; inputSchema: unknown };
export type Connection = { id: string; name: string; config: Config; secretsSet: string[]; tools: ConfirmedTool[] | null; createdAt: number };
export type Slot = { slot: string; label: string; required: boolean };

/** The secrets a connection takes: each secret variable; or the optional token and each secret header. */
export function slotsOf(config: Config): Slot[] {
  return config.kind === "stdio"
    ? config.secretEnv.map((name) => ({ slot: `env.${name}`, label: name, required: true }))
    : [{ slot: "token", label: "Token", required: false }, ...config.secretHeaders.map((h) => ({ slot: `header.${h}`, label: `Header ${h}`, required: true }))];
}

type Db = ReturnType<BbPluginApi["storage"]["database"]>;
type Row = { id: string; name: string; config: string; secrets: string; tools: string | null; created_at: number };
type Failure = { ok: false; error: string };
const fail = (error: string): Failure => ({ ok: false, error });
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
/** A sentence meant for the user as it is: a refusal, a missing secret, a failure already described. */
class Refused extends Error {}

/** Known secret values never appear in a message, whatever a server sent back. */
const redact = (text: string, hidden: string[]) => hidden.reduce((t, secret) => (secret.length >= 4 ? t.split(secret).join("[secret]") : t), text);

const keep = (tool: Tool): ConfirmedTool => ({
  name: tool.name,
  description: (tool.description ?? "").slice(0, MAX_DESCRIPTION),
  inputSchema: JSON.stringify(tool.inputSchema).length <= MAX_SCHEMA_CHARS ? tool.inputSchema : { type: "object", note: "The schema is too long to keep; see the description." },
});

export type Connections = ReturnType<typeof createConnections>;

export function createConnections(options: { db: Db; secrets: SecretStore; toolPath: () => Promise<string>; timeouts?: Partial<Timeouts> }) {
  const { db, secrets, toolPath } = options;
  const t = { ...TIMEOUTS, ...options.timeouts };
  const all = db.prepare(`SELECT * FROM connections ORDER BY name`);
  const byId = db.prepare(`SELECT * FROM connections WHERE id = ?`);
  const byNameRow = db.prepare(`SELECT * FROM connections WHERE name = ?`);
  const insert = db.prepare(`INSERT INTO connections (id, name, config, secrets, tools, created_at, updated_at) VALUES (?, ?, ?, '[]', NULL, ?, ?)`);
  const updateSecrets = db.prepare(`UPDATE connections SET secrets = ?, updated_at = ? WHERE id = ?`);
  const updateTools = db.prepare(`UPDATE connections SET tools = ?, updated_at = ? WHERE id = ?`);
  const deleteRow = db.prepare(`DELETE FROM connections WHERE id = ?`);

  const toConnection = (r: Row): Connection => ({
    id: r.id,
    name: r.name,
    config: JSON.parse(r.config) as Config, // checked by configSchema before it was stored
    secretsSet: JSON.parse(r.secrets) as string[],
    tools: r.tools === null ? null : (JSON.parse(r.tools) as ConfirmedTool[]),
    createdAt: r.created_at,
  });
  const get = (id: string) => {
    const row = byId.get(id) as Row | undefined;
    return row ? toConnection(row) : null;
  };
  const byName = (name: string) => {
    const row = byNameRow.get(name) as Row | undefined;
    return row ? toConnection(row) : null;
  };

  // --- open clients, one per connection
  type Session = { client: Client; hidden: string[] };
  type Open = { session: Promise<Session>; busy: number; idle?: NodeJS.Timeout };
  const open = new Map<string, Open>();

  function close(id: string): Promise<void> {
    const entry = open.get(id);
    if (entry === undefined) return Promise.resolve();
    open.delete(id);
    clearTimeout(entry.idle);
    return entry.session.then(({ client }) => client.close()).catch(() => {});
  }

  async function start(c: Connection): Promise<Session> {
    // One stored before https was required: refused before its secrets are read.
    if (c.config.kind === "http" && !encryptedOrLocal(c.config.url)) {
      throw new Refused(`"${c.name}" has a plain http address on another machine, where its token would travel unencrypted, so it was not contacted. Remove it and add it again with an https address.`);
    }
    const values: Record<string, string> = {};
    for (const { slot, label, required } of slotsOf(c.config)) {
      if (!c.secretsSet.includes(slot)) {
        if (required) throw new Refused(`${label} of "${c.name}" is not set. Set it on the Connections page.`);
        continue;
      }
      const value = await secrets.get(`${c.id}.${slot}`).catch((cause: unknown) => {
        throw new Refused(message(cause));
      });
      if (value === null) throw new Refused(`${label} of "${c.name}" is no longer in ${secrets.label}. Set it again on the Connections page.`);
      values[slot] = value;
    }
    const hidden = Object.values(values);
    const config = c.config;
    const endpoint: Endpoint =
      config.kind === "stdio"
        ? { kind: "stdio", command: config.command, args: config.args, env: { PATH: await toolPath(), ...config.env, ...Object.fromEntries(config.secretEnv.map((n) => [n, values[`env.${n}`]!])) } }
        : {
            kind: "http",
            url: config.url,
            headers: { ...(values.token !== undefined && { Authorization: `Bearer ${values.token}` }), ...Object.fromEntries(config.secretHeaders.map((h) => [h, values[`header.${h}`]!])) },
          };
    try {
      return { client: await connect(endpoint, t.connectMs), hidden };
    } catch (cause) {
      throw new Refused(redact(failure(cause, `"${c.name}"`), hidden));
    }
  }

  /** Runs work on the connection's client, opening it first when needed. Every failure is a value, with known secrets taken out. */
  async function use<T extends { ok: boolean }>(c: Connection, work: (client: Client) => Promise<T | Failure>): Promise<T | Failure> {
    let entry = open.get(c.id);
    if (entry === undefined) {
      const created: Open = { session: start(c), busy: 0 };
      open.set(c.id, created);
      created.session.then(
        ({ client }) => {
          client.onclose = () => void (open.get(c.id) === created && open.delete(c.id)); // the server went away
        },
        () => {},
      );
      entry = created;
    }
    const current = entry;
    current.busy++;
    clearTimeout(current.idle);
    let hidden: string[] = [];
    try {
      const session = await current.session;
      hidden = session.hidden;
      const result = await work(session.client);
      return result.ok ? result : fail(redact((result as Failure).error, hidden));
    } catch (cause) {
      if (open.get(c.id) === current) void close(c.id); // a timed-out or broken client is not reused
      return fail(cause instanceof Refused ? cause.message : redact(failure(cause, `"${c.name}"`), hidden));
    } finally {
      current.busy--;
      if (current.busy === 0 && open.get(c.id) === current) current.idle = setTimeout(() => void close(c.id), t.idleMs).unref();
    }
  }

  async function setSecret(id: string, slot: string, value: string | null): Promise<{ ok: true } | Failure> {
    const c = get(id);
    if (c === null) return fail("There is no such connection.");
    if (!slotsOf(c.config).some((s) => s.slot === slot)) return fail(`"${slot}" is not a secret of "${c.name}".`);
    try {
      if (value === null) await secrets.delete(`${id}.${slot}`);
      else await secrets.set(`${id}.${slot}`, value);
    } catch (cause) {
      return fail(message(cause)); // fixed sentences from secrets.ts
    }
    const set = new Set(c.secretsSet);
    if (value === null) set.delete(slot);
    else set.add(slot);
    updateSecrets.run(JSON.stringify([...set]), Date.now(), id);
    await close(id); // the next use starts with the new value
    return { ok: true };
  }

  async function remove(id: string): Promise<{ ok: true } | Failure> {
    const c = get(id);
    if (c === null) return fail("There is no such connection.");
    await close(id);
    const slots = slotsOf(c.config);
    if (c.secretsSet.length > 0 || (slots.length > 0 && (await secrets.unavailable()) === null)) {
      try {
        for (const { slot } of slots) await secrets.delete(`${id}.${slot}`);
      } catch (cause) {
        return fail(`${message(cause)} The connection is kept so that its secrets can be removed later.`);
      }
    }
    deleteRow.run(id);
    return { ok: true };
  }

  return {
    list: () => (all.all() as Row[]).map(toConnection),
    get,
    byName,

    /** Adds a connection; secrets given here go straight to the secure store. Its tools are confirmed separately. */
    async add(input: { name: string; config: Config; secrets?: Record<string, string> }): Promise<{ ok: true; id: string } | Failure> {
      if (byName(input.name) !== null) return fail(`A connection named "${input.name}" exists already.`);
      if (input.config.kind === "http" && !encryptedOrLocal(input.config.url)) {
        return fail("The address must start with https://. Plain http:// is accepted only for this machine (localhost, 127.0.0.1 or [::1]): to another machine, the token would travel unencrypted.");
      }
      const given = input.secrets ?? {};
      const slots = slotsOf(input.config);
      const unknown = Object.keys(given).filter((slot) => !slots.some((s) => s.slot === slot));
      if (unknown.length > 0) return fail(`Not secrets of this connection: ${unknown.join(", ")}.`);
      if (Object.keys(given).length > 0 || slots.some((s) => s.required)) {
        const why = await secrets.unavailable();
        if (why !== null) return fail(`Connections with secrets are unavailable on this machine: ${why}`);
      }
      const id = randomBytes(6).toString("hex");
      const now = Date.now();
      insert.run(id, input.name, JSON.stringify(input.config), now, now);
      for (const [slot, value] of Object.entries(given)) {
        const saved = await setSecret(id, slot, value);
        if (!saved.ok) {
          await remove(id);
          return saved;
        }
      }
      return { ok: true, id };
    },

    setSecret,
    remove,

    /** The server's tools now: the read-only ones by name, and how many others (never callable). */
    async check(id: string) {
      const c = get(id);
      if (c === null) return fail("There is no such connection.");
      return use(c, async (client) => {
        const tools = await listTools(client, t.listMs);
        return {
          ok: true as const,
          readOnly: tools.filter(isReadOnly).map((tool) => ({ name: tool.name, description: (tool.description ?? "").slice(0, MAX_DESCRIPTION) })),
          others: tools.filter((tool) => !isReadOnly(tool)).length,
          confirmed: (c.tools ?? []).map((tool) => tool.name),
        };
      });
    },

    /** Saves the user's choice, re-checked against the server: every name must be offered as read-only now. */
    async confirm(id: string, names: string[]) {
      const c = get(id);
      if (c === null) return fail("There is no such connection.");
      return use(c, async (client) => {
        const tools = await listTools(client, t.listMs);
        const refused = names.filter((name) => !tools.some((tool) => tool.name === name && isReadOnly(tool)));
        if (refused.length > 0) return fail(`Not confirmed: "${c.name}" does not offer ${refused.join(", ")} as read-only.`);
        const kept = tools.filter((tool) => names.includes(tool.name)).map(keep);
        updateTools.run(JSON.stringify(kept), Date.now(), id);
        return { ok: true as const, tools: kept.map((tool) => tool.name) };
      });
    },

    /** Calls a tool through the read-only filter: confirmed by the user, and still marked read-only by the server now. */
    async call(name: string, tool: string, args: Record<string, unknown>): Promise<Answer> {
      const c = byName(name);
      if (c === null) return fail(`There is no connection named "${name}".`);
      if (!(c.tools ?? []).some((confirmed) => confirmed.name === tool)) {
        return fail(`"${tool}" is not a confirmed read-only tool of "${name}", so it is not called. The user confirms tools on the plugin's Connections page.`);
      }
      return use(c, async (client): Promise<Answer> => {
        const listed = (await listTools(client, t.listMs)).find((candidate) => candidate.name === tool);
        if (listed === undefined) return fail(`"${name}" no longer offers "${tool}".`);
        if (!isReadOnly(listed)) return fail(`"${name}" no longer marks "${tool}" read-only, so it was not called. Confirm its tools again on the Connections page.`);
        const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: t.callMs });
        const answer = "content" in result ? resultData(result as CallToolResult) : fail("The tool answered in a form this plugin does not read.");
        if (answer.ok && Buffer.byteLength(JSON.stringify(answer.data) ?? "") > MAX_RESULT_BYTES) {
          return fail(`"${tool}" returned more than ${MAX_RESULT_BYTES / 1024 / 1024} MB. Ask it for less: fewer rows or fields.`);
        }
        return answer;
      });
    },

    /** Closes every open client; for plugin dispose. */
    closeAll: () => Promise.all([...open.keys()].map(close)).then(() => {}),
  };
}
