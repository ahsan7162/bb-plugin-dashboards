// The card bb shows for an ```bb-dashboard block in a reply: the dashboard's title and a button
// that opens it in the side panel, or points to the Dashboards page when bb declines. While streaming,
// or when the body is not a dashboard id, it is bb's own code block.
import { useEffect, useRef, useState } from "react";
import { experimental_useAppPanel, useBbNavigate, useRpc, type ExperimentalCodeFenceRendererProps } from "@get-bb/plugin-sdk/app";
import { dashboardIdFrom } from "../shared";
import type { rpcContract } from "../server";
import { DASHBOARDS_PAGE } from "./gallery";
import { DASHBOARD_TAB } from "./panel";

export function DashboardCard({ code, status, Original }: ExperimentalCodeFenceRendererProps) {
  const id = status === "streaming" ? null : dashboardIdFrom(code);
  const client = useRpc<typeof rpcContract>();
  const rpc = useRef(client); // the SDK does not promise a stable client; the title loads once per id
  rpc.current = client;
  const panel = experimental_useAppPanel();
  const navigate = useBbNavigate();
  const [title, setTitle] = useState<string | null | undefined>(undefined); // null: no such dashboard
  const [declined, setDeclined] = useState(false);

  useEffect(() => {
    if (id === null) return;
    let live = true;
    rpc.current.call("read", { id }).then(
      ({ dashboard }) => live && setTitle(dashboard?.title ?? null),
      () => {}, // the card still opens the panel, which shows the error itself
    );
    return () => {
      live = false;
    };
  }, [id]);

  if (id === null) return <Original />;
  if (title === null) return <p className="my-2 rounded-md border border-border p-3 text-sm text-muted-foreground">No dashboard with the id {id}.</p>;
  const open = () => setDeclined(!panel.openTab({ tab: DASHBOARD_TAB, params: { dashboardId: id }, title: title ?? "Dashboard" }));
  return (
    <div className="my-2 rounded-md border border-border bg-card p-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-foreground">{title ?? "Dashboard"}</span>
        <button type="button" className="rounded-md border border-border px-2 py-1 hover:bg-accent" onClick={open}>
          Open in side panel
        </button>
      </div>
      {declined && (
        <p role="status" className="pt-2 text-muted-foreground">
          The side panel is not available here. Open it from the{" "}
          <button type="button" className="underline hover:text-foreground" onClick={() => navigate.toPluginPanel(DASHBOARDS_PAGE.path, { subPath: id })}>
            Dashboards page
          </button>
          .
        </p>
      )}
    </div>
  );
}
