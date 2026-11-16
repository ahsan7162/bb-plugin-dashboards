// A dashboard's view, shared by its side-panel tab and the Dashboards page: loads the dashboard over RPC,
// reloads on its realtime ping and after a reconnect (pings are not replayed), and renders the program
// with OpenUI's Renderer in bb's colours or the dashboard's own theme. It also holds the version
// switcher and restoring an old version, the user's remembered $variable values (in this browser only), the two agent actions and
// live data from the dashboard's declared sources (ui/live.tsx), paused while the tab is hidden, and its
// script sources' approval, secrets and "Runs a script" badge (ui/scripts.tsx). A script source runs
// only while the user's approval matches it; until then the rest of the dashboard works without it.
// The viewer's own colours (ui/colours.tsx) go over bb's mapping and the dashboard's saved theme.
// Edit mode (ui/edit.tsx) lets the viewer pick a part of the latest version and send a change request.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  experimental_useCodeTheme,
  experimental_usePluginId,
  experimental_useTabVisible,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSdk,
  type ExperimentalThreadTabProps,
  type JsonValue,
} from "@get-bb/plugin-sdk/app";
import { BuiltinActionType, Renderer, createStreamingParser, type ActionEvent } from "@openuidev/react-lang";
import { ThemeProvider, type ThemeProviderProps } from "@openuidev/dashboard-library";
import { DASHBOARD_DATA, DASHBOARD_SAVED, FONTS, dashboardIdFrom } from "../shared";
import type { Dashboard, ScriptsView, rpcContract } from "../server";
import type { RunInput } from "../server/run";
import { CONTROL, ColourControl, bbSeries, coloursKey, loadChoices, resolveColour, saveChoices, viewerTokens, type Choices } from "./colours";
import { EditLayer, PartsContext, createParts, editable } from "./edit";
import { library } from "./library";
import { CANNOT_RUN, LiveContext, WAITING, useLiveData, type QueryInfo, type SourceInfo } from "./live";
import { ScriptBadge, ScriptDialog, ScriptNotices } from "./scripts";

export const DASHBOARD_TAB = { id: "dashboard", context: { kind: "thread" }, availability: "action" } as const;

// The library's tokens pointed at bb's own CSS variables, so a dashboard follows bb's palette in both
// modes. bb has no chart palette (no --chart-* variables): series 1 to 4 take bb's main colour and the
// three other hues bb themes, leaving out its good/bad colours; when bb's main colour is a grey (its
// stock theme), its blue accent leads instead (bbSeries, ui/colours.tsx). 5 to 8, the sequential and
// diverging ramps keep the library's. The library has no font token; the view sets the font on its wrapper.
const BB_THEME: NonNullable<ThemeProviderProps["lightTheme"]> = {
  page: "var(--background)",
  surface: "var(--card)",
  surfaceSubtle: "var(--muted)",
  border: "var(--border)",
  borderStrong: "var(--input)",
  grid: "var(--border)",
  ink: "var(--foreground)",
  inkSecondary: "var(--muted-foreground)",
  inkMuted: "var(--subtle-foreground)",
  accent: "var(--primary)",
  accentInk: "var(--primary-foreground)",
  good: "var(--success)",
  bad: "var(--destructive-text)",
  warning: "var(--warning-text)",
  radius: "var(--radius)",
};

type Values = Record<string, unknown>;
type Version = { version: number; createdAt: number };

/** Remembered values stay in this browser's localStorage, one entry per dashboard, at most this many characters. */
const REMEMBER_CAP = 20_000;
export const rememberedKey = (pluginId: string, id: string) => `${pluginId}:remembered:${id}`;

/** Forgets what this browser keeps for a deleted dashboard: its remembered values and the viewer's colours. */
export function forgetDashboard(pluginId: string, id: string) {
  try {
    localStorage.removeItem(rememberedKey(pluginId, id));
    localStorage.removeItem(coloursKey(pluginId, id));
  } catch {
    // blocked storage: there is nothing kept to forget
  }
}

function readRemembered(key: string): Values {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Values) : {};
  } catch {
    return {}; // unreadable or blocked storage: start from the program's defaults
  }
}

const kind = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

/**
 * Every $variable the program declares: its remembered value when that has the declared value's type
 * (anything when the declared value is null), otherwise the declared value. Passed as the Renderer's
 * initialState, which also overwrites a live value a new version no longer fits.
 */
function fit(remembered: Values, declared: Values): Values {
  return Object.fromEntries(
    Object.entries(declared).map(([name, value]) => {
      const keep = Object.hasOwn(remembered, name) && (value === null || kind(remembered[name]) === kind(value));
      return [name, keep ? remembered[name] : value];
    }),
  );
}

const isWebUrl = (url: unknown) => {
  try {
    return typeof url === "string" && ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

export const when = (time: number) => new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The dashboard's side-panel tab. A continue-conversation action goes to the tab's thread. */
export function DashboardTab({ threadId, params }: ExperimentalThreadTabProps & { params: JsonValue | null }) {
  const id = dashboardIdFrom(params);
  const visible = experimental_useTabVisible(); // false outside a panel tab, so only the tab asks
  if (id === null) return <p className="p-3 text-sm text-muted-foreground">Open a dashboard from its card in a reply.</p>;
  return <DashboardView key={id} id={id} threadId={threadId} visible={visible} />;
}

/** The panel header's refresh mode (PLAN section 2, item 7); null without sources. An approved script refreshes itself. */
export function refreshMode(sources: readonly { kind: string; waiting?: string }[]): string | null {
  if (sources.length === 0) return null;
  if (sources.some((s) => s.waiting === WAITING)) return "Needs your approval";
  if (sources.some((s) => s.waiting === CANNOT_RUN)) return "Scripts cannot run here";
  return sources.some((s) => s.kind === "agent") ? "Refresh asks the agent" : "Refreshes itself";
}

const failed = (cause: unknown) => ({ ok: false as const, error: cause instanceof Error ? cause.message : String(cause) });

/**
 * One dashboard. `threadId` is where a continue-conversation action is sent; null when the thread it was
 * made in no longer exists. `visible` is false while its side-panel tab is hidden: live data then
 * fetches nothing. Render it with `key={id}`: its remembered values belong to one dashboard.
 */
export function DashboardView({ id, threadId, visible }: { id: string; threadId: string | null; visible: boolean }) {
  const client = useRpc<typeof rpcContract>();
  const rpc = useRef(client); // the SDK does not promise a stable client; load must not change with it
  rpc.current = client;
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const storageKey = rememberedKey(pluginId, id);
  const remembered = useRef<Values | null>(null);
  remembered.current ??= readRemembered(storageKey);
  const [colours, setColours] = useState<Choices>(() => loadChoices(coloursKey(pluginId, id)));
  const chooseColours = (next: Choices) => {
    setColours(next);
    saveChoices(coloursKey(pluginId, id), next);
  };

  const [dashboard, setDashboard] = useState<Dashboard | null | undefined>(undefined); // undefined: not loaded yet
  const [versions, setVersions] = useState<Version[]>([]);
  // An old version the user chose, and the latest version number at that moment; null follows the latest.
  const [pinned, setPinned] = useState<{ version: number; latest: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The shown version's script sources and the dashboard's approvals, and the dialog open on one of them.
  const [scripts, setScripts] = useState<{ version: number; view: ScriptsView } | null>(null);
  const [scriptsError, setScriptsError] = useState<string | null>(null);
  // The dialog keeps the copy it opened with: a save while it is open must not change what is approved.
  const [dialog, setDialog] = useState<{ mode: "approve"; script: ScriptsView["sources"][number] } | { mode: "read"; approved: ScriptsView["approved"][number]; why?: string } | null>(null);
  const latest = useRef(0); // only the newest request may set state
  const pinnedVersion = pinned?.version;
  const [editing, setEditing] = useState(false);
  const [parts] = useState(createParts); // the dashboard's parts, for Edit mode; kept whether or not it is on
  const content = useRef<HTMLDivElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    const request = ++latest.current;
    try {
      const result = await rpc.current.call("read", pinnedVersion === undefined ? { id } : { id, version: pinnedVersion });
      if (request !== latest.current) return;
      if (result.dashboard === null && pinnedVersion !== undefined && result.versions.length > 0) {
        // The pinned version was deleted by a save (only the newest are kept): show the latest instead.
        setPinned(null);
        setNotice(`Version ${pinnedVersion} is no longer kept, so the latest version is shown.`);
        return;
      }
      setDashboard(result.dashboard);
      setVersions(result.versions);
      setError(null);
    } catch (cause) {
      if (request === latest.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [id, pinnedVersion]);

  useEffect(() => void load(), [load]);
  // A new version moves a view on the latest forward; a pinned view only learns the newer number.
  useRealtime(DASHBOARD_SAVED, (payload) => {
    if (dashboardIdFrom(payload) === id) void load();
  });
  const connection = useRealtimeConnectionState();
  const lastConnection = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && lastConnection.current !== "connected") void load();
    lastConnection.current = connection;
  }, [connection, load]);
  const { mode: colorMode, name: paletteName } = experimental_useCodeTheme(); // bb's current light or dark mode and palette
  // bb's chart series, decided from bb's resolved main colour. Checked again when bb's mode or palette changes
  // (and a frame later, should bb apply its variables after telling us); only tokens change, nothing remounts.
  const viewRoot = useRef<HTMLDivElement>(null);
  const [series, setSeries] = useState(() => bbSeries(null, true));
  const loaded = dashboard !== null && dashboard !== undefined;
  useLayoutEffect(() => {
    const check = () => {
      const at = viewRoot.current ?? document.documentElement;
      const next = bbSeries(resolveColour(at, "--primary"), getComputedStyle(at).getPropertyValue("--timeline-accent").trim() !== "");
      setSeries((before) => (JSON.stringify(before) === JSON.stringify(next) ? before : next));
    };
    check();
    const frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [colorMode, paletteName, loaded]);

  const program = dashboard?.program ?? null;
  // The streaming parser, not createParser: that one carries lang-core's opt-in usage report.
  const { declared, queries } = useMemo<{ declared: Values; queries: QueryInfo[] }>(() => {
    if (program === null) return { declared: {}, queries: [] };
    const parsed = createStreamingParser(library.toJSONSchema(), library.root).set(program, true);
    const queries = parsed.queryStatements.flatMap((q) => (q.toolAST?.k === "Str" ? [{ id: q.statementId, source: q.toolAST.v, refresh: q.refreshAST?.k === "Num" ? q.refreshAST.v : null }] : []));
    return { declared: parsed.stateDeclarations, queries };
  }, [program]);
  const run = useCallback((input: RunInput) => rpc.current.call("source_run", input), []);
  const shownVersion = dashboard?.version;
  const hasScripts = (dashboard?.sources ?? []).some((s) => s.kind === "script");
  const loadScripts = useCallback(async () => {
    if (!hasScripts || shownVersion === undefined) return;
    try {
      setScripts({ version: shownVersion, view: await rpc.current.call("scripts", { id, version: shownVersion }) });
      setScriptsError(null);
    } catch (cause) {
      setScriptsError(failed(cause).error);
    }
  }, [id, hasScripts, shownVersion]);
  useEffect(() => void loadScripts(), [loadScripts, dashboard]);
  const view = scripts !== null && scripts.version === shownVersion ? scripts.view : null;
  // Until its approval is known, a script source counts as waiting: nothing runs that the user has not approved.
  const sources = useMemo<SourceInfo[]>(
    () =>
      (dashboard?.sources ?? []).map((s) => {
        if (s.kind !== "script") return s;
        const waiting = view?.blocked ? CANNOT_RUN : view?.sources.some((x) => x.name === s.name && x.approved) ? undefined : WAITING;
        return { ...s, waiting };
      }),
    [dashboard, view],
  );
  const { toolProvider, live, dataStored } = useLiveData({
    run,
    id,
    version: dashboard?.version ?? null,
    sources,
    queries,
    visible,
    renderKey: pinnedVersion === undefined ? "latest" : `version-${pinnedVersion}`,
  });
  useRealtime(DASHBOARD_DATA, (payload) => {
    const stored = typeof payload === "object" && payload !== null && "sources" in payload && Array.isArray(payload.sources) ? payload.sources.filter((s) => typeof s === "string") : [];
    if (dashboardIdFrom(payload) === id) dataStored(stored);
  });
  // A script approved or withdrawn: re-run the queries that read it (once its approval is known, not at the first load).
  const ready = !hasScripts || view !== null || scriptsError !== null;
  const waitingKey = ready ? sources.flatMap((s) => (s.waiting ? [s.name] : [])).join("\0") : null;
  const lastWaiting = useRef<string | null>(null);
  useEffect(() => {
    if (waitingKey === null) return;
    const before = lastWaiting.current;
    lastWaiting.current = waitingKey;
    if (before === null || before === waitingKey) return;
    const was = new Set(before.split("\0"));
    const now = new Set(waitingKey.split("\0"));
    live.rerun(queries.filter((q) => was.has(q.source) !== now.has(q.source)).map((q) => q.id));
  }, [waitingKey, live, queries]);

  if (dashboard === null) return <p className="p-3 text-sm" role="alert">There is no dashboard with the id {id}. It may have been deleted, or the card points to one that was never saved.</p>;
  if (dashboard === undefined) {
    return error ? <p className="p-3 text-sm text-destructive" role="alert">Could not load the dashboard: {error}</p> : <p className="p-3 text-sm text-muted-foreground">Loading…</p>;
  }

  const newest = versions[0]?.version ?? dashboard.version;
  const shown = dashboard.version === (pinned?.version ?? newest); // false for a moment after switching
  const theme = dashboard.theme;
  const look = colours.look ?? colorMode;
  // bb's variables hold bb's own mode, here and in the library's popovers (portals, outside this tree):
  // a look against bb's mode takes the library's colours for that mode instead, and bb's radius.
  const base = look === colorMode ? { ...BB_THEME, ...series } : { radius: BB_THEME.radius };
  const mode = refreshMode(sources);
  // A script source that cannot run yet has its own line (ScriptNotices) instead.
  const noticed = (name: string) => view !== null && (view.blocked !== null || view.sources.some((x) => x.name === name && (!x.approved || x.secrets.some((secret) => !secret.set))));
  const failing = sources.flatMap((s) => (live.states[s.name]?.error && !s.waiting && !noticed(s.name) ? [{ name: s.name, error: live.states[s.name]!.error! }] : []));

  const approve = async (source: ScriptsView["sources"][number]) => { // the dialog's copy: its hash is what the user read
    const result = await rpc.current.call("script_approve", { id, source: source.name, hash: source.hash }).catch(failed);
    if (!result.ok) return result.error;
    setDialog(null);
    setNotice(`Approved "${source.name}": it runs from now on.`);
    await loadScripts();
    return null;
  };
  const withdraw = async (source: string) => {
    const result = await rpc.current.call("script_withdraw", { id, source }).catch(failed);
    setDialog(null);
    setNotice(result.ok ? `Approval of "${source}" withdrawn: it no longer runs.` : result.error);
    await loadScripts();
  };
  /** Saves the pinned old version as a new latest one, then shows the latest. */
  const restore = async (version: number) => {
    const result = await rpc.current.call("restore", { id, version }).catch(failed);
    if (!result.ok) return setNotice(result.error);
    setPinned(null);
    setNotice(`Version ${version} restored as version ${result.version}.`);
  };
  const saveSecret = async (name: string, value: string | null) => {
    const result = await rpc.current.call("script_secret", { id, name, value }).catch(failed);
    setNotice(result.ok ? null : result.error);
    await loadScripts();
    const using = new Set(view?.sources.filter((x) => x.secrets.some((secret) => secret.name === name)).map((x) => x.name));
    live.rerun(queries.filter((q) => using.has(q.source)).map((q) => q.id));
  };
  const review = (name: string) => {
    const script = view?.sources.find((x) => x.name === name);
    if (script) setDialog({ mode: "approve", script });
  };
  const read = (source: string) => {
    const approved = view?.approved.find((x) => x.source === source);
    if (approved) setDialog({ mode: "read", approved, why: view?.sources.find((x) => x.name === source && x.approved)?.why });
  };

  // An old version is read-only: its filter choices are not remembered.
  const remember = (state: Values) => {
    if (pinned !== null) return;
    try {
      // Only values the user moved away from the program's default, so a new default still applies.
      const changed = Object.fromEntries(Object.entries(state).filter(([name, value]) => name.startsWith("$") && JSON.stringify(value) !== JSON.stringify(declared[name])));
      remembered.current = changed;
      const json = JSON.stringify(changed);
      if (json.length <= REMEMBER_CAP) localStorage.setItem(storageKey, json);
    } catch {
      // storage full or blocked: the values last until the view closes
    }
  };

  /** The one way a message leaves the view: to the dashboard's thread, from the latest version only. Null when sent, else why not. */
  const toThread = async (text: string): Promise<string | null> => {
    if (pinned !== null) return "Old versions are read-only. Go back to the latest version to ask the agent.";
    if (threadId === null) return "Not sent: the thread this dashboard was made in no longer exists. Ask in any thread and name the dashboard.";
    return sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] }).then(
      () => null,
      (cause: unknown) => `Not sent: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  };

  // Only two kinds of action do anything; every other kind is ignored.
  const onAction = (event: ActionEvent) => {
    if (event.type === BuiltinActionType.OpenUrl) {
      if (isWebUrl(event.params.url)) navigate.openUrl(event.params.url as string);
      else setNotice("Only http and https links open from a dashboard.");
      return;
    }
    if (event.type !== BuiltinActionType.ContinueConversation) return;
    const text = typeof event.humanFriendlyMessage === "string" ? event.humanFriendlyMessage.trim() : "";
    if (text === "") return;
    void toThread(`About dashboard "${dashboard.title}" (${dashboard.id}): ${text}`).then((why) => setNotice(why ?? "Sent to the dashboard's thread."));
  };

  const edit = (on: boolean) => {
    setEditing(on);
    if (on) setNotice(null);
  };
  // Escape leaves Edit mode once nothing of ours inside the view is open (the change popover and Colours stop it first).
  const onKeyDown = (e: KeyboardEvent) => {
    if (!editing || e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault(); // bb's own Escape (back to the app) is for when nothing of ours is open
    e.stopPropagation();
    edit(false);
    editButton.current?.focus();
  };

  return (
    <div ref={viewRoot} style={{ fontFamily: theme?.font ? FONTS[theme.font] : "var(--font-sans)" }} onKeyDown={onKeyDown}>
      <header className="flex flex-wrap items-center gap-2 pb-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <h2 className="text-base font-medium text-foreground">{dashboard.title}</h2>
          {mode && <span className="text-xs text-muted-foreground">{mode}</span>}
        </div>
        {/* The controls stay together: to the right of the title, or as one row under it when the panel is narrow. */}
        <div role="group" aria-label="View controls" className="flex flex-wrap items-center gap-2">
          {view && view.approved.length > 0 && (
            <ScriptBadge approved={view.approved} onRead={read} onWithdraw={(source) => void withdraw(source)} saveSecret={saveSecret} />
          )}
          <button
            ref={editButton}
            type="button"
            className={`${CONTROL} aria-pressed:bg-accent`} // pressed changes the fill only, never the box
            aria-pressed={editing}
            disabled={pinned !== null}
            title={pinned !== null ? "Old versions are read-only: go back to the latest to request a change" : "Pick a part of the dashboard and say what should change"}
            onClick={() => edit(!editing)}
          >
            Edit
          </button>
          <ColourControl choices={colours} onChange={chooseColours} />
          <select
            aria-label="Version"
            className={`${CONTROL} bg-background text-foreground`} // its own fill: the native list takes it
            value={pinned ? String(pinned.version) : "latest"}
            onChange={(e) => {
              const version = Number(e.target.value);
              setPinned(e.target.value === "latest" || version >= newest ? null : { version, latest: newest });
              setEditing(false);
            }}
          >
            <option value="latest">Latest: version {newest}</option>
            {versions.slice(1).map((v) => (
              <option key={v.version} value={v.version}>
                Version {v.version}, {when(v.createdAt)}
              </option>
            ))}
          </select>
        </div>
      </header>
      {pinned && (
        <div role="status" className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground">
          <span>
            Version {pinned.version} of {newest}, read-only.
            {newest > pinned.latest && ` Version ${newest} was saved while you were viewing this one.`}
          </span>
          <button type="button" className="rounded-md border border-border px-1.5 hover:bg-accent" onClick={() => setPinned(null)}>
            Back to latest
          </button>
          <button type="button" className="rounded-md border border-border px-1.5 hover:bg-accent" onClick={() => void restore(pinned.version)}>
            Restore this version
          </button>
        </div>
      )}
      {error && <p className="pb-2 text-xs text-destructive" role="status">Could not refresh: {error}</p>}
      {notice && <p className="pb-2 text-xs text-muted-foreground" role="status">{notice}</p>}
      {/* Always there, so screen readers announce the change when Edit mode starts. */}
      <p className={editing ? "pb-2 text-xs text-foreground" : "sr-only"} aria-live="polite">
        {editing ? "Edit mode: click a part of the dashboard, or Tab to it and press Enter, then say what should change. Escape leaves." : ""}
      </p>
      {scriptsError && (
        <p className="pb-2 text-xs text-destructive" role="status">
          Could not load the scripts' approval, so none runs: {scriptsError}
        </p>
      )}
      {view && <ScriptNotices view={view} onReview={review} saveSecret={saveSecret} />}
      {dialog?.mode === "approve" && (
        <ScriptDialog
          mode="approve"
          dashboardTitle={dashboard.title}
          folder={view?.folder ?? null}
          queries={queries}
          script={{ ...dialog.script, secrets: dialog.script.secrets.map((x) => x.name) }}
          onApprove={() => approve(dialog.script)}
          onDecline={() => setDialog(null)}
        />
      )}
      {dialog?.mode === "read" && (
        <ScriptDialog
          mode="read"
          dashboardTitle={dashboard.title}
          folder={view?.folder ?? null}
          queries={queries}
          script={{ name: dialog.approved.source, runner: dialog.approved.runner, code: dialog.approved.code, why: dialog.why, secrets: dialog.approved.secrets.map((x) => x.name), approvedAt: dialog.approved.approvedAt }}
          onWithdraw={() => void withdraw(dialog.approved.source)}
          onClose={() => setDialog(null)}
        />
      )}
      {failing.map((f) => (
        <p key={f.name} className="pb-2 text-xs text-destructive" role="status">
          Source {f.name} did not load: {f.error}
        </p>
      ))}
      {shown && ready ? (
        // The tree never changes shape: a colour change re-renders the Renderer with the same key and
        // the same toolProvider, so nothing restarts and no data is fetched again.
        <ThemeProvider
          mode={look}
          lightTheme={{ ...base, ...theme?.light, ...viewerTokens(colours, "light") }}
          darkTheme={{ ...base, ...(theme?.dark ?? theme?.light), ...viewerTokens(colours, "dark") }}
        >
          <div className={`relative${colours.look ? " rounded-md p-2" : ""}`} style={colours.look && { background: "var(--openui-dashboard-page)" }}>
            {/* Edit mode toggles attributes here and adds the layer beside it: the Renderer is not remounted. */}
            <div ref={content} inert={editing} data-editing={editing ? "" : undefined}>
              <PartsContext.Provider value={parts}>
                <LiveContext.Provider value={live}>
                  <Renderer
                    key={pinned ? `version-${pinned.version}` : "latest"} // a new version keeps the live state; switching starts fresh
                    response={dashboard.program}
                    library={editable} // the same library, its renderers wrapped to report their parts (ui/edit.tsx)
                    initialState={fit(remembered.current, declared)}
                    onStateUpdate={remember}
                    onAction={onAction}
                    toolProvider={toolProvider} // never null: that would start the queries over without their data
                  />
                </LiveContext.Provider>
              </PartsContext.Provider>
            </div>
            {editing && (
              <EditLayer
                parts={parts}
                content={content}
                dashboard={dashboard}
                send={toThread}
                onSent={() => {
                  edit(false);
                  setNotice("Change request sent to the dashboard's thread.");
                  editButton.current?.focus();
                }}
              />
            )}
          </div>
        </ThemeProvider>
      ) : (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
    </div>
  );
}
