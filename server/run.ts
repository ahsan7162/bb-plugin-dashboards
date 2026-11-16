// source_run, the only way the browser gets data. The browser names a dashboard version, one of that
// version's declared sources and the Query's args; the server looks the declaration up, checks the args
// for its kind and runs it for the dashboard's origin thread, or, for an mcp source, through the plugin's
// read-only connection filter (server/connections.ts), or, for a script source the user approved,
// through server/scripts.ts. A repeat within the floor (MIN_REFRESH_SECONDS, SCRIPT_MIN_REFRESH_SECONDS
// for a script) is answered from a short cache (the program's timer cannot go below it), real runs are
// limited per dashboard and source, a script runs one at a time, and every failure is a value.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Connections } from "./connections";
import type { Scripts } from "./scripts";
import { ARGS, MIN_REFRESH_SECONDS, SCRIPT_MIN_REFRESH_SECONDS, runSource } from "./sources";
import type { Store } from "./store";

/** Real runs (not cache answers) allowed per dashboard and source in one window. */
export const RATE_LIMIT = { runs: 20, windowMs: 60_000 };
const MAX_CACHED = 200;

export type RunAnswer = { ok: true; data: unknown; fetchedAt: number } | { ok: false; error: string };
export type RunInput = { id: string; version: number; source: string; args: Record<string, unknown> };

const fail = (error: string): RunAnswer => ({ ok: false, error });

export function createSourceRun(bb: Pick<BbPluginApi, "sdk">, store: Store, connections: Pick<Connections, "call">, scripts: Pick<Scripts, "isApproved" | "run">) {
  const cache = new Map<string, { at: number; floor: number; answer: Promise<RunAnswer> }>();
  const runs = new Map<string, number[]>();
  const running = new Set<string>(); // script sources with a run in progress

  /** Null when another real run may start now (and counts it), otherwise why not. */
  function limited(key: string, now: number): string | null {
    const recent = (runs.get(key) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
    if (recent.length >= RATE_LIMIT.runs) {
      runs.set(key, recent);
      return `refreshed too often: at most ${RATE_LIMIT.runs} times a minute. Try again in ${Math.ceil((recent[0]! + RATE_LIMIT.windowMs - now) / 1000)} s.`;
    }
    runs.set(key, [...recent, now]);
    return null;
  }

  return async function sourceRun({ id, version, source, args }: RunInput): Promise<RunAnswer> {
    const dashboard = store.get(id, version);
    if (dashboard === null) return fail(`There is no version ${version} of dashboard ${id}.`);
    const declared = dashboard.sources.find((s) => s.name === source);
    if (declared === undefined) return fail(`"${source}" is not a source of version ${version} of this dashboard.`);
    const parsed = ARGS[declared.kind].safeParse(args);
    if (!parsed.success) return fail(`Wrong arguments for "${source}" (${declared.kind}): ${z.prettifyError(parsed.error)}`);
    if (declared.kind === "mcp") {
      // The declaration fixes the tool's arguments; a Query may set only the names it lists as overridable.
      const allowed = declared.overridable ?? [];
      const extra = Object.keys(parsed.data).filter((key) => !allowed.includes(key));
      if (extra.length > 0) return fail(`Wrong arguments for "${source}" (mcp): ${extra.join(", ")} cannot be set by the Query; ${allowed.length > 0 ? `only ${allowed.join(", ")} can` : "none can"}.`);
    }

    // Checked before the cache too, so a withdrawn approval stops answers at once.
    if (declared.kind === "script" && !scripts.isApproved(id, declared)) return fail(`The script "${source}" is waiting for your approval. Review it in the panel.`);

    const now = Date.now();
    const floor = (declared.kind === "script" ? SCRIPT_MIN_REFRESH_SECONDS : MIN_REFRESH_SECONDS) * 1000;
    // The declaration is part of the key: another version's "orders" may read another file.
    const key = JSON.stringify([id, declared, parsed.data]);
    const hit = cache.get(key);
    if (hit !== undefined && now - hit.at < hit.floor) return hit.answer;
    const sourceKey = `${id}\0${source}`;
    if (declared.kind === "script" && running.has(sourceKey)) return fail(`The script "${source}" is still running; it runs one at a time. It runs again on the next refresh.`);
    const tooOften = limited(sourceKey, now);
    if (tooOften !== null) return fail(`"${source}" ${tooOften}`);

    if (declared.kind === "agent") {
      // Not cached: stored data must show at once. A database read, still counted above.
      const stored = store.getData(id, source);
      return stored ? { ok: true, data: stored.data, fetchedAt: stored.storedAt } : fail(`No data stored yet for "${source}". A RefreshButton, or asking the agent, has it fetched and stored.`);
    }
    const work =
      declared.kind === "mcp"
        ? connections.call(declared.connection, declared.tool, { ...declared.args, ...parsed.data })
        : declared.kind === "script"
          ? scripts.run(id, dashboard.origin, declared, parsed.data)
          : runSource(bb.sdk, declared, parsed.data, dashboard.origin.threadId);
    if (declared.kind === "script") {
      running.add(sourceKey);
      void work.finally(() => running.delete(sourceKey));
    }
    const answer = work.then((r): RunAnswer => (r.ok ? { ok: true, data: r.data, fetchedAt: Date.now() } : r));
    if (cache.size >= MAX_CACHED) for (const [k, v] of cache) if (now - v.at >= v.floor) cache.delete(k);
    const entry = { at: now, floor, answer };
    cache.set(key, entry); // in flight too, so two panels asking at once share one run
    void answer.then((r) => {
      if (!r.ok && cache.get(key) === entry) cache.delete(key); // a failure may be retried at once
    });
    return answer;
  };
}
