// Dashboards and their versions in the plugin's own SQLite database. Every successful save adds a version
// and the newest KEEP_VERSIONS are kept. Version numbers go on from the highest, so they are never reused.
// Data the agent stored for its agent sources sits beside them, one latest result per source, unversioned.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { sourceSchema, type Source } from "./sources";
import { storedTheme, type Theme } from "./theme";

export type Origin = { threadId: string | null; environmentId: string | null; hostId: string | null };
export type Dashboard = {
  id: string;
  title: string;
  version: number;
  program: string;
  theme: Theme | null;
  sources: Source[];
  origin: Origin;
  createdAt: number;
  updatedAt: number;
};
export type DashboardSummary = Pick<Dashboard, "id" | "title" | "version" | "updatedAt"> & { versions: number; threadId: string | null };
/** Versions kept per dashboard; a save deletes older ones. */
export const KEEP_VERSIONS = 100;
export type Store = ReturnType<typeof openStore>;

type Row = {
  id: string;
  title: string;
  thread_id: string | null;
  environment_id: string | null;
  host_id: string | null;
  created_at: number;
  updated_at: number;
  number: number;
  program: string;
  theme: string | null;
  sources: string;
};

export function openStore(bb: Pick<BbPluginApi, "storage">) {
  const db = bb.storage.database();
  // The schema as first released. From here on append-only: never edit or reorder a shipped statement, only add new ones.
  bb.storage.migrate(db, [
    `CREATE TABLE dashboards (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      thread_id TEXT, environment_id TEXT, host_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE versions (
      dashboard_id TEXT NOT NULL REFERENCES dashboards(id), number INTEGER NOT NULL,
      program TEXT NOT NULL, theme TEXT, sources TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (dashboard_id, number))`,
    `CREATE TABLE agent_data (
      dashboard_id TEXT NOT NULL REFERENCES dashboards(id), source TEXT NOT NULL,
      data TEXT NOT NULL, stored_at INTEGER NOT NULL,
      PRIMARY KEY (dashboard_id, source))`,
    // The plugin's MCP connections (server/connections.ts). Never a secret: only which secrets are set.
    `CREATE TABLE connections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, config TEXT NOT NULL,
      secrets TEXT NOT NULL, tools TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    // Script approvals (server/scripts.ts): one per dashboard and source name, for the hash of runner,
    // code and secret names, with that text kept so the user can read it again and see what changed.
    `CREATE TABLE script_approvals (
      dashboard_id TEXT NOT NULL REFERENCES dashboards(id), source TEXT NOT NULL, hash TEXT NOT NULL,
      runner TEXT NOT NULL, code TEXT NOT NULL, secrets TEXT NOT NULL, approved_at INTEGER NOT NULL,
      PRIMARY KEY (dashboard_id, source))`,
    // Which script secrets the user set for a dashboard. Never a value: those are in the OS secure store.
    `CREATE TABLE script_secrets (
      dashboard_id TEXT NOT NULL REFERENCES dashboards(id), name TEXT NOT NULL,
      PRIMARY KEY (dashboard_id, name))`,
  ]);

  const select = `SELECT a.*, v.number, v.program, v.theme, v.sources FROM dashboards a JOIN versions v ON v.dashboard_id = a.id`;
  const latest = db.prepare(`${select} WHERE a.id = ? ORDER BY v.number DESC LIMIT 1`);
  const exact = db.prepare(`${select} WHERE a.id = ? AND v.number = ?`);
  const insertDashboard = db.prepare(`INSERT INTO dashboards (id, title, thread_id, environment_id, host_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const touchDashboard = db.prepare(`UPDATE dashboards SET title = ?, updated_at = ? WHERE id = ?`);
  const insertVersion = db.prepare(`INSERT INTO versions (dashboard_id, number, program, theme, sources, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const nextNumber = db.prepare(`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM versions WHERE dashboard_id = ?`);
  const all = db.prepare(
    `SELECT a.id, a.title, a.thread_id, a.updated_at, MAX(v.number) AS number, COUNT(*) AS versions FROM dashboards a JOIN versions v ON v.dashboard_id = a.id GROUP BY a.id ORDER BY a.updated_at DESC`,
  );
  const pruneVersions = db.prepare(
    `DELETE FROM versions WHERE dashboard_id = ? AND number <= (SELECT number FROM versions WHERE dashboard_id = ? ORDER BY number DESC LIMIT 1 OFFSET ${KEEP_VERSIONS})`,
  );
  const versionsOf = db.prepare(`SELECT number AS version, created_at AS createdAt FROM versions WHERE dashboard_id = ? ORDER BY number DESC`);
  const deleteVersions = db.prepare(`DELETE FROM versions WHERE dashboard_id = ?`);
  const deleteDashboard = db.prepare(`DELETE FROM dashboards WHERE id = ?`);
  const upsertData = db.prepare(
    `INSERT INTO agent_data (dashboard_id, source, data, stored_at) VALUES (?, ?, ?, ?) ON CONFLICT (dashboard_id, source) DO UPDATE SET data = excluded.data, stored_at = excluded.stored_at`,
  );
  const dataOf = db.prepare(`SELECT data, stored_at FROM agent_data WHERE dashboard_id = ? AND source = ?`);
  const dataTimesOf = db.prepare(`SELECT source, stored_at FROM agent_data WHERE dashboard_id = ?`);
  const deleteData = db.prepare(`DELETE FROM agent_data WHERE dashboard_id = ?`);
  const deleteApprovals = db.prepare(`DELETE FROM script_approvals WHERE dashboard_id = ?`);
  const deleteScriptSecrets = db.prepare(`DELETE FROM script_secrets WHERE dashboard_id = ?`);

  const toDashboard = (row: Row): Dashboard => ({
    id: row.id,
    title: row.title,
    version: row.number,
    program: row.program,
    theme: row.theme === null ? null : storedTheme(JSON.parse(row.theme)),
    sources: (JSON.parse(row.sources) as unknown[]).flatMap((s) => sourceSchema.safeParse(s).data ?? []),
    origin: { threadId: row.thread_id, environmentId: row.environment_id, hostId: row.host_id },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  /** Agent results by source name; each replaces that source's last one. */
  type Data = Record<string, unknown>;
  const storeData = (id: string, data: Data, now: number) => {
    for (const [source, value] of Object.entries(data)) upsertData.run(id, source, JSON.stringify(value), now);
  };

  type NewVersion = { id: string; title: string; program: string; theme: Theme | null; sources: Source[]; data?: Data; now: number };
  const addVersion = (v: NewVersion): number => {
    const { n } = nextNumber.get(v.id) as { n: number };
    insertVersion.run(v.id, n, v.program, v.theme === null ? null : JSON.stringify(v.theme), JSON.stringify(v.sources), v.now);
    pruneVersions.run(v.id, v.id);
    touchDashboard.run(v.title, v.now, v.id);
    if (v.data) storeData(v.id, v.data, v.now);
    return n;
  };

  return {
    /** The database handle, shared with server/connections.ts. */
    db,
    get(id: string, version?: number): Dashboard | null {
      const row = (version === undefined ? latest.get(id) : exact.get(id, version)) as Row | undefined;
      return row ? toDashboard(row) : null;
    },
    list(): DashboardSummary[] {
      return (all.all() as (Pick<Row, "id" | "title" | "thread_id" | "updated_at" | "number"> & { versions: number })[]).map((r) => ({
        id: r.id,
        title: r.title,
        version: r.number,
        versions: r.versions,
        updatedAt: r.updated_at,
        threadId: r.thread_id,
      }));
    },
    /** Every kept version's number and save time, newest first; empty when there is no such dashboard. */
    versions(id: string): { version: number; createdAt: number }[] {
      return versionsOf.all(id) as { version: number; createdAt: number }[];
    },
    /** Removes the dashboard, all its versions, its agent data and its script records; false when there was no such dashboard. Script secrets' values are removed first, by server/scripts.ts. */
    delete: db.transaction((id: string): boolean => {
      deleteData.run(id);
      deleteApprovals.run(id);
      deleteScriptSecrets.run(id);
      deleteVersions.run(id);
      return deleteDashboard.run(id).changes > 0;
    }),
    /** Inserts the dashboard and its version 1 together. */
    create: db.transaction((v: NewVersion & { origin: Origin }) => {
      insertDashboard.run(v.id, v.title, v.origin.threadId, v.origin.environmentId, v.origin.hostId, v.now, v.now);
      return addVersion(v);
    }),
    /** Adds the next version number (and stores data given with it), deleting versions past the newest KEEP_VERSIONS; returns it. */
    addVersion: db.transaction(addVersion),
    /** Stores agent results without a new version. */
    storeData: db.transaction(storeData),
    /** An agent source's last stored result and when it was stored, or null. */
    getData(id: string, source: string): { data: unknown; storedAt: number } | null {
      const row = dataOf.get(id, source) as { data: string; stored_at: number } | undefined;
      return row ? { data: JSON.parse(row.data) as unknown, storedAt: row.stored_at } : null;
    },
    /** When each agent source of the dashboard last had data stored. */
    dataTimes(id: string): Record<string, number> {
      return Object.fromEntries((dataTimesOf.all(id) as { source: string; stored_at: number }[]).map((r) => [r.source, r.stored_at]));
    },
  };
}
