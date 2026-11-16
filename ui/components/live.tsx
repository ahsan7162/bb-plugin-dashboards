// Freshness and RefreshButton: when a declared source last answered, and a way to refresh now. They learn
// fetch times, source kinds and the program's queries from the view's LiveContext (ui/live.tsx), not from
// props, so a program cannot make them claim anything.
import { useEffect, useReducer } from "react";
import { defineComponent, useTriggerAction } from "@openuidev/react-lang";
import { z } from "zod/v4";
import { useLive } from "../live";
import { text } from "./bound";

/** "Updated just now", "Updated 1 minute ago", "Updated 3 hours ago". */
export function updatedAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return "Updated just now";
  const [n, unit] = seconds < 3600 ? [Math.floor(seconds / 60), "minute"] : seconds < 86_400 ? [Math.floor(seconds / 3600), "hour"] : [Math.floor(seconds / 86_400), "day"];
  return `Updated ${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/** Re-renders every `ms`, so a relative time moves on without fetching anything. */
function useTick(ms: number) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  }, [ms]);
}

export const Freshness = defineComponent({
  name: "Freshness",
  props: z.object({ source: z.string() }),
  description: 'When a declared source last answered and how it refreshes, e.g. Freshness("orders") shows "Updated 2 minutes ago · refreshes itself" or, for an agent source, "· refresh asks the agent".',
  component: ({ props }) => {
    useTick(15_000);
    const { sources, states } = useLive();
    const name = text(props.source);
    const source = sources.find((s) => s.name === name);
    if (source === undefined) return <p className="bbd-freshness">No source named {name}</p>;
    const at = states[name]?.fetchedAt ?? null;
    return (
      <p className="bbd-freshness">
        {at === null ? "Not loaded yet" : updatedAgo(at, Date.now())} · {source.kind === "agent" ? "refresh asks the agent" : (source.waiting ?? "refreshes itself")}
      </p>
    );
  },
});

/** The message an agent source's refresh sends to the dashboard's thread; the panel prefixes the dashboard's title and id. */
export function refreshMessage(names: string[]): string {
  const quoted = names.map((n) => `"${n}"`).join(", ");
  return `Refresh the agent source${names.length === 1 ? "" : "s"} ${quoted} (dashboard_get with this id shows what each holds): get the data again with your tools, then call dashboard_save with this dashboard's id and data: {${names.map((n) => `"${n}": <the new result>`).join(", ")}}. Do not change the program.`;
}

export const RefreshButton = defineComponent({
  name: "RefreshButton",
  props: z.object({ label: z.string().optional(), source: z.string().optional() }),
  description:
    'Refreshes data now. RefreshButton() re-runs every query; RefreshButton("Refresh incidents", "incidents") only that source. A file, git or pull request source re-runs at once; an agent source instead asks the agent in this thread to get it again and store it (one model call).',
  component: ({ props }) => {
    const live = useLive();
    const trigger = useTriggerAction();
    const wanted = live.sources.filter((s) => props.source === undefined || props.source === null || s.name === text(props.source));
    const agent = wanted.filter((s) => s.kind === "agent").map((s) => s.name);
    const own = new Set(wanted.filter((s) => s.kind !== "agent").map((s) => s.name));
    const ids = live.queries.filter((q) => own.has(q.source)).map((q) => q.id);
    const click = () => {
      live.rerun(ids);
      if (agent.length > 0) void trigger(refreshMessage(agent)); // the panel's continue-conversation action
    };
    return (
      <button type="button" className="bbd-ask" disabled={ids.length === 0 && agent.length === 0} onClick={click}>
        <span aria-hidden="true">↻</span>
        {text(props.label) || "Refresh"}
      </button>
    );
  },
});
