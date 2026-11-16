// The Dashboards page: every dashboard with when it last changed, its number of versions and the thread it
// was made in. Selecting one (its id in the page's sub-path) shows it with the side-panel tab's own view.
// Delete asks first, then removes the dashboard and its versions from the plugin's database. The
// sub-path "connections" shows the plugin's MCP connections instead (ui/connections.tsx).
import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_usePluginId,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { DASHBOARD_SAVED, dashboardIdFrom } from "../shared";
import type { rpcContract } from "../server";
import { ConnectionsSection } from "./connections";
import { DashboardView, forgetDashboard, when } from "./panel";

export const DASHBOARDS_PAGE = { id: "dashboards", title: "Dashboards", icon: "LayoutDashboard", path: "dashboards" } as const;
export const CONNECTIONS = "connections";

type Summary = { id: string; title: string; versions: number; updatedAt: number; threadId: string | null };
const button = "rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent";

export function DashboardsPage({ subPath }: PluginNavPanelProps) {
  const selected = dashboardIdFrom(subPath.split("/")[0]); // an id is hex, so it needs no decoding
  const client = useRpc<typeof rpcContract>();
  const rpc = useRef(client); // the SDK does not promise a stable client; load must not change with it
  rpc.current = client;
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const [dashboards, setDashboards] = useState<Summary[] | undefined>(undefined);
  const [threads, setThreads] = useState<Map<string, string>>(new Map()); // origin threads that still exist: id → title
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const latest = useRef(0); // only the newest request may set state

  const load = useCallback(async () => {
    const request = ++latest.current;
    try {
      const { dashboards } = await rpc.current.call("list", null);
      // shortcut: bb answers at most 200 thread ids per call, and a failed lookup counts as none; past 200
      // threads, or when the lookup fails, rows show no thread link. Page through the ids if that matters.
      const ids = [...new Set(dashboards.flatMap((a) => (a.threadId ? [a.threadId] : [])))].slice(0, 200);
      const found = ids.length === 0 ? [] : await sdk.threads.list({ threadIds: ids, includeHidden: true }).catch(() => []);
      if (request !== latest.current) return;
      setDashboards(dashboards);
      setThreads(new Map(found.map((t) => [t.id, t.title ?? t.titleFallback ?? "Untitled thread"])));
      setError(null);
    } catch (cause) {
      if (request === latest.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [sdk]);

  useEffect(() => void load(), [load]);
  useRealtime(DASHBOARD_SAVED, () => void load());
  const connection = useRealtimeConnectionState();
  const lastConnection = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && lastConnection.current !== "connected") void load();
    lastConnection.current = connection;
  }, [connection, load]);

  const remove = async (id: string) => {
    setConfirming(null);
    try {
      await rpc.current.call("delete", { id });
      forgetDashboard(pluginId, id);
    } catch (cause) {
      setError(`Could not delete: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    await load();
  };

  const open = (id?: string) => navigate.toPluginPanel(DASHBOARDS_PAGE.path, { subPath: id ?? "" });
  const showingConnections = subPath.split("/")[0] === CONNECTIONS;
  const liveThread = (threadId: string | null) => (threadId !== null && threads.has(threadId) ? threadId : null);

  if (selected !== null) {
    return (
      <div className="h-full overflow-auto p-4 md:p-5">
        <button type="button" className={`${button} mb-3`} onClick={() => open()}>
          All dashboards
        </button>
        <DashboardView key={selected} id={selected} threadId={liveThread(dashboards?.find((a) => a.id === selected)?.threadId ?? null)} visible /* no tab to hide it */ />
      </div>
    );
  }

  const sections = (
    <nav aria-label="Plugin sections" className="flex gap-2">
      <button type="button" className={button} aria-current={showingConnections ? undefined : "page"} onClick={() => open()}>
        Dashboards
      </button>
      <button type="button" className={button} aria-current={showingConnections ? "page" : undefined} onClick={() => open(CONNECTIONS)}>
        Connections
      </button>
    </nav>
  );

  if (showingConnections) {
    return (
      <div className="h-full overflow-auto p-4 md:p-5">
        <div className="mx-auto w-full max-w-3xl space-y-4 text-sm">
          {sections}
          <ConnectionsSection />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4 text-sm">
        {sections}
        {error && <p role="alert" className="text-destructive">{dashboards ? error : `Could not load the dashboards: ${error}`}</p>}
        {dashboards === undefined ? (
          !error && <p className="text-muted-foreground">Loading…</p>
        ) : dashboards.length === 0 ? (
          <div className="space-y-2 rounded-md border border-border p-4">
            <p className="font-medium text-foreground">No dashboards yet</p>
            <p className="text-muted-foreground">
              Ask an agent in any thread for a dashboard, for example "Build me a dashboard of this week's orders by channel". It saves the dashboard, shows a
              card in its reply, and the dashboard appears here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {dashboards.map((a) => {
              const thread = liveThread(a.threadId);
              return (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <div className="min-w-0 space-y-0.5">
                    <button type="button" className="text-left font-medium text-foreground hover:underline" onClick={() => open(a.id)}>
                      {a.title}
                    </button>
                    <p className="text-xs text-muted-foreground">
                      Changed {when(a.updatedAt)} · {a.versions === 1 ? "1 version" : `${a.versions} versions`} ·{" "}
                      {thread ? (
                        <button type="button" className="underline hover:text-foreground" onClick={() => navigate.toThread(thread)}>
                          {threads.get(thread)}
                        </button>
                      ) : (
                        "its thread no longer exists"
                      )}
                    </p>
                  </div>
                  {confirming === a.id ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label={`Confirm deleting ${a.title}`}>
                      <span>Delete it and all {a.versions === 1 ? "its version" : `${a.versions} versions`}? This cannot be undone.</span>
                      <button type="button" className={`${button} text-destructive`} onClick={() => void remove(a.id)}>
                        Delete
                      </button>
                      <button type="button" className={button} onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button type="button" className={button} aria-label={`Delete ${a.title}`} onClick={() => setConfirming(a.id)}>
                      Delete
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
