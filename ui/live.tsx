// Live data in the dashboard view. The Renderer's toolProvider is a function map, one function per
// declared source, each calling source_run for the shown version. While the side-panel tab is hidden it
// answers from its last result and fetches nothing; when the tab shows again, the view re-runs its
// queries once. LiveContext tells Freshness and RefreshButton when each source last answered, its kind,
// and how to re-run queries; Bridge, mounted inside the Renderer by the Dashboard root, does the re-run.
// A script source waiting for the user's approval is never asked for: its function refuses at once.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ACTION_STEPS, useTriggerAction } from "@openuidev/react-lang";
import type { RunAnswer, RunInput } from "../server/run";

export type SourceKind = "file" | "git_commits" | "git_changes" | "pull_request" | "agent" | "mcp" | "script";
/** waiting: why a script source is not run, WAITING (not approved as it is now) or CANNOT_RUN. */
export type SourceInfo = { name: string; kind: SourceKind; waiting?: string };
/** A Query statement of the shown program, the source it reads and its refresh interval in seconds, if any. */
export type QueryInfo = { id: string; source: string; refresh?: number | null };
export const WAITING = "waiting for your approval";
export const CANNOT_RUN = "scripts cannot run here";
export type SourceState = { fetchedAt: number | null; error: string | null };

export type Live = {
  sources: SourceInfo[];
  queries: QueryInfo[];
  states: Record<string, SourceState>;
  /** Re-runs these Query statements now. */
  rerun(ids: string[]): void;
  /** Set by Bridge: how to re-run statements inside the Renderer. */
  runner: MutableRefObject<(ids: string[]) => void>;
};

const idle = { current: () => {} };
export const LiveContext = createContext<Live>({ sources: [], queries: [], states: {}, rerun: () => {}, runner: idle });
export const useLive = () => useContext(LiveContext);

/** Inside the Renderer: hands the view a way to re-run queries (the library's own run step, one per statement). */
export function Bridge() {
  const trigger = useTriggerAction();
  const { runner } = useLive();
  useEffect(() => {
    runner.current = (ids) => {
      if (ids.length > 0) void trigger("", undefined, { steps: ids.map((statementId) => ({ type: ACTION_STEPS.Run, statementId, refType: "query" as const })) });
    };
  }, [trigger, runner]);
  return null;
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * The toolProvider and LiveContext value for one dashboard view. `version` is the shown version, whose
 * declared sources source_run uses; `visible` is false while the side-panel tab is hidden.
 */
export function useLiveData(options: {
  run: (input: RunInput) => Promise<RunAnswer>;
  id: string;
  version: number | null;
  sources: SourceInfo[];
  queries: QueryInfo[];
  visible: boolean;
  /** The Renderer's key: when it changes, the Renderer starts over and fetches by itself. */
  renderKey: string;
}) {
  const { id, version, sources, queries, visible, renderKey } = options;
  const now = useRef(options);
  now.current = options;
  const [states, setStates] = useState<Record<string, SourceState>>({});
  const last = useRef(new Map<string, unknown>()); // by version, source and args
  const held = useRef<(() => void)[]>([]); // calls made while hidden with no last result, waiting to be shown
  const runner = useRef<(ids: string[]) => void>(() => {});
  const rerun = useCallback((ids: string[]) => runner.current(ids), []);

  const names = sources.map((s) => s.name).join("\0");
  const toolProvider = useMemo(
    () =>
      Object.fromEntries(
        names.split("\0").filter(Boolean).map((source) => [
          source,
          async (args: Record<string, unknown>) => {
            const waiting = now.current.sources.find((s) => s.name === source)?.waiting;
            if (waiting) throw new Error(waiting); // never sent to the server
            const key = JSON.stringify([now.current.version, source, args]);
            if (!now.current.visible) {
              if (last.current.has(key)) return last.current.get(key);
              await new Promise<void>((resolve) => held.current.push(resolve));
            }
            const answer = await now.current.run({ id: now.current.id, version: now.current.version!, source, args }).catch((cause: unknown): RunAnswer => ({ ok: false, error: message(cause) }));
            setStates((s) => ({ ...s, [source]: { fetchedAt: answer.ok ? answer.fetchedAt : (s[source]?.fetchedAt ?? null), error: answer.ok ? null : answer.error } }));
            if (!answer.ok) throw new Error(answer.error); // the library shows its notice and keeps the defaults
            last.current.set(key, answer.data);
            return answer.data;
          },
        ]),
      ),
    [names],
  );

  // Shown again after being hidden: release held calls, and re-run the rest once.
  const wasHidden = useRef(!visible);
  useEffect(() => {
    if (!visible) {
      wasHidden.current = true;
      return;
    }
    if (!wasHidden.current) return;
    wasHidden.current = false;
    const waiting = held.current.splice(0);
    waiting.forEach((resolve) => resolve());
    if (waiting.length < now.current.queries.length) rerun(now.current.queries.map((q) => q.id));
  }, [visible, rerun]);

  // A new version in the same Renderer: a source it declares may now read something else.
  const lastShown = useRef({ version, renderKey });
  useEffect(() => {
    const before = lastShown.current;
    lastShown.current = { version, renderKey };
    if (before.version !== null && version !== before.version && renderKey === before.renderKey && now.current.visible) rerun(now.current.queries.map((q) => q.id));
  }, [version, renderKey, rerun]);

  /** The agent stored new data for these sources: re-run the queries that read them (when shown; showing re-runs anyway). */
  const dataStored = useCallback(
    (stored: string[]) => {
      if (now.current.visible) rerun(now.current.queries.filter((q) => stored.includes(q.source)).map((q) => q.id));
    },
    [rerun],
  );

  const live = useMemo<Live>(() => ({ sources, queries, states, rerun, runner }), [sources, queries, states, rerun]);
  return { toolProvider, live, dataStored };
}
