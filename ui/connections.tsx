// The Connections section of the plugin's page: the plugin's own MCP connections with their status.
// Add one; set its secrets in write-only fields that show only "set" or "not set" and are emptied after
// saving; list the server's read-only tools and confirm them; remove it. "Find existing servers" reads
// Claude Code's user config and a folder's .mcp.json only on a click, shows names and kinds, and
// imports a server only on a second click. A Limits note says plainly what this page cannot stop.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { ConnectionView, rpcContract } from "../server";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Check = { readOnly: { name: string; description: string }[]; others: number; confirmed: string[] };
type Found = { source: "user" | "project"; name: string; kind: string; importable: boolean; reason: string | null };

const button = "rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50";
const field = "w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground";
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
const failed = (cause: unknown) => ({ ok: false as const, error: message(cause) });
export const CONNECTIONS_LIMIT =
  "Limits: connections are meant to be changed only here, by you. That protects against a change by mistake and against agents that cannot run shell commands. An agent you allow to run shell commands could add, change or remove a connection, or set its secrets, without this page, and could also run commands directly.";

function status(c: ConnectionView): string {
  const missing = c.secrets.filter((s) => s.required && !s.set).map((s) => s.label);
  if (missing.length > 0) return `Not ready: ${missing.join(", ")} not set.`;
  if (c.tools === null) return "Tools not confirmed yet.";
  if (c.tools.length === 0) return "No tools confirmed.";
  return `Ready: ${c.tools.length === 1 ? "1 read-only tool" : `${c.tools.length} read-only tools`} confirmed (${c.tools.join(", ")}).`;
}

export function ConnectionsSection() {
  const client = useRpc<typeof rpcContract>();
  const rpc = useRef(client); // the SDK does not promise a stable client
  rpc.current = client;
  const [data, setData] = useState<{ store: { label: string; unavailable: string | null }; connections: ConnectionView[] } | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // Per connection: its listed tools to confirm, or a sentence (in progress, or why listing failed).
  const [checks, setChecks] = useState<Record<string, Check | string>>({});

  const load = useCallback(async () => {
    try {
      setData(await rpc.current.call("connections_list", null));
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const check = async (id: string) => {
    setChecks((c) => ({ ...c, [id]: "Listing the server's tools…" }));
    const result = await rpc.current.call("connection_check", { id }).catch(failed);
    setChecks((c) => ({ ...c, [id]: result.ok ? result : `Could not list its tools: ${result.error}` }));
  };
  const added = async (id: string) => {
    await load();
    await check(id); // the user sees and confirms the read-only tools right away
  };

  if (data === undefined) return error ? <p role="alert" className="text-destructive">Could not load the connections: {error}</p> : <p className="text-muted-foreground">Loading…</p>;
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        MCP servers this plugin reaches by itself, so a dashboard refreshes without the agent. Only tools the server marks read-only and you confirm here can be called. Secrets are kept in{" "}
        {data.store.label}, never in the plugin's database.
      </p>
      <p role="note" className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
        {CONNECTIONS_LIMIT}
      </p>
      {data.store.unavailable && (
        <p role="status" className="rounded-md border border-border bg-muted px-2 py-1 text-xs">
          The secure store is not available on this machine: {data.store.unavailable} Connections that need a token or other secret cannot be added here.
        </p>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {data.connections.length === 0 ? (
        <p className="rounded-md border border-border p-3 text-muted-foreground">No connections yet. Add one below, or find servers you already set up for Claude Code.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {data.connections.map((c) => (
            <ConnectionRow key={c.id} connection={c} rpc={rpc.current} check={checks[c.id]} onCheck={() => void check(c.id)} onChanged={load} />
          ))}
        </ul>
      )}
      <AddForm rpc={rpc.current} onAdded={added} />
      <Discover rpc={rpc.current} onImported={added} />
    </div>
  );
}

function ConnectionRow(props: { connection: ConnectionView; rpc: Rpc; check: Check | string | undefined; onCheck: () => void; onChanged: () => Promise<void> }) {
  const { connection: c, rpc, check, onCheck, onChanged } = props;
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const confirm = async (names: string[]) => {
    const result = await rpc.call("connection_confirm", { id: c.id, tools: names }).catch(failed);
    setNote(result.ok ? `Confirmed: ${result.tools.length === 0 ? "no tools" : result.tools.join(", ")}.` : result.error);
    await onChanged();
  };
  const remove = async () => {
    setConfirming(false);
    const result = await rpc.call("connection_remove", { id: c.id }).catch(failed);
    if (!result.ok) setNote(result.error);
    await onChanged();
  };

  return (
    <li className="space-y-2 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium text-foreground">
            {c.name} <span className="text-xs font-normal text-muted-foreground">{c.kind === "stdio" ? "local command" : "web server"}</span>
          </p>
          <p className="break-all font-mono text-xs text-muted-foreground">{c.target}</p>
          {c.variables.length > 0 && <p className="break-all font-mono text-xs text-muted-foreground">{c.variables.map((v) => `${v.name}=${v.value}`).join(" ")}</p>}
          <p className="text-xs text-foreground">{status(c)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} onClick={onCheck} aria-label={`List and confirm the tools of ${c.name}`}>
            {c.tools === null ? "List tools" : "Test and confirm tools"}
          </button>
          {confirming ? (
            <span className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label={`Confirm removing ${c.name}`}>
              Remove it and its secrets?
              <button type="button" className={`${button} text-destructive`} onClick={() => void remove()}>
                Remove
              </button>
              <button type="button" className={button} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className={button} aria-label={`Remove ${c.name}`} onClick={() => setConfirming(true)}>
              Remove
            </button>
          )}
        </div>
      </div>
      {c.secrets.map((s) => (
        <SecretField
          key={s.slot}
          label={s.label}
          optional={!s.required}
          set={s.set}
          save={async (value) => {
            const result = await rpc.call("connection_secret", { id: c.id, slot: s.slot, value }).catch(failed);
            setNote(result.ok ? null : result.error);
            await onChanged();
          }}
        />
      ))}
      {typeof check === "string" && <p role="status" className="text-xs text-muted-foreground">{check}</p>}
      {typeof check === "object" && <ToolConfirm key={JSON.stringify(check)} check={check} onConfirm={(names) => void confirm(names)} />}
      {note && <p role="status" className="text-xs text-muted-foreground">{note}</p>}
    </li>
  );
}

/** Write-only: the value goes to the server on Save and is cleared here at once; only "set" or "not set" comes back. null clears it. */
export function SecretField(props: { label: string; optional?: boolean; set: boolean; save: (value: string | null) => Promise<void> }) {
  const { label, optional = false, set } = props;
  const [value, setValue] = useState("");
  const save = async (next: string | null) => {
    setValue("");
    await props.save(next);
  };
  return (
    <form
      className="flex flex-wrap items-center gap-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (value !== "") void save(value);
      }}
    >
      <span className="min-w-28">
        {label}
        {optional ? " (optional)" : ""}: <span className={set ? "text-foreground" : "text-muted-foreground"}>{set ? "set" : "not set"}</span>
      </span>
      <input
        type="password"
        autoComplete="off"
        aria-label={`New value for ${label}`}
        placeholder={set ? "Replace" : "Enter"}
        className={`${field} max-w-56`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" className={button} disabled={value === ""}>
        Save
      </button>
      {set && (
        <button type="button" className={button} onClick={() => void save(null)} aria-label={`Clear ${label}`}>
          Clear
        </button>
      )}
    </form>
  );
}

function ToolConfirm({ check, onConfirm }: { check: Check; onConfirm: (names: string[]) => void }) {
  const before = check.confirmed.length > 0;
  // Tools confirmed before stay ticked; a tool new since then waits for the user. Never confirmed: all ticked, for the user to review.
  const [chosen, setChosen] = useState(() => new Set(check.readOnly.map((t) => t.name).filter((name) => !before || check.confirmed.includes(name))));
  const toggle = (name: string) =>
    setChosen((s) => {
      const next = new Set(s);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  return (
    <fieldset className="space-y-1 rounded-md border border-border p-2">
      <legend className="px-1 text-xs font-medium text-foreground">Read-only tools the server offers</legend>
      {check.readOnly.length === 0 && <p className="text-xs text-muted-foreground">The server marks no tool read-only, so none can be used.</p>}
      {check.readOnly.map((t) => (
        <label key={t.name} className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={chosen.has(t.name)} onChange={() => toggle(t.name)} />
          <span>
            <span className="font-mono">{t.name}</span>
            {before && !check.confirmed.includes(t.name) && " (new)"}
            {t.description && <span className="text-muted-foreground"> · {t.description}</span>}
          </span>
        </label>
      ))}
      {check.others > 0 && (
        <p className="text-xs text-muted-foreground">
          {check.others === 1 ? "1 other tool is" : `${check.others} other tools are`} not marked read-only and can never be called.
        </p>
      )}
      <button type="button" className={button} onClick={() => onConfirm([...chosen])}>
        Confirm these tools
      </button>
    </fieldset>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function AddForm({ rpc, onAdded }: { rpc: Rpc; onAdded: (id: string) => Promise<void> }) {
  const empty = { name: "", command: "", args: "", variables: "", secretVariables: "", url: "", token: "", headers: "" };
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"stdio" | "http">("stdio");
  const [form, setForm] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof empty) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async () => {
    const env = Object.fromEntries(lines(form.variables).map((l) => (l.includes("=") ? [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1)] : [l, ""])));
    const config = kind === "stdio" ? { kind, command: form.command, args: lines(form.args), env, secretEnv: lines(form.secretVariables) } : { kind, url: form.url.trim(), secretHeaders: lines(form.headers) };
    const token = form.token;
    setForm((f) => ({ ...f, token: "" })); // the token is not kept in the page
    const result = await rpc.call("connection_add", { name: form.name.trim(), config, ...(kind === "http" && token !== "" && { secrets: { token } }) }).catch(failed);
    if (!result.ok) return setError(result.error);
    setError(null);
    setForm(empty);
    setOpen(false);
    await onAdded(result.id);
  };

  if (!open) {
    return (
      <button type="button" className={button} onClick={() => setOpen(true)}>
        Add a connection
      </button>
    );
  }
  return (
    <form
      className="space-y-2 rounded-md border border-border p-3"
      aria-label="Add a connection"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="font-medium text-foreground">Add a connection</p>
      <Labeled label="Kind">
        <select className={field} value={kind} onChange={(e) => setKind(e.target.value as "stdio" | "http")}>
          <option value="stdio">Local command (stdio)</option>
          <option value="http">Web server (streamable HTTP)</option>
        </select>
      </Labeled>
      <Labeled label="Name (letters, digits, _ . -)">
        <input className={field} value={form.name} onChange={set("name")} />
      </Labeled>
      {kind === "stdio" ? (
        <>
          <Labeled label="Command">
            <input className={field} value={form.command} onChange={set("command")} />
          </Labeled>
          <Labeled label="Arguments, one per line">
            <textarea className={field} rows={2} value={form.args} onChange={set("args")} />
          </Labeled>
          <Labeled label="Plain variables, NAME=value per line (shown here; no secrets)">
            <textarea className={field} rows={2} value={form.variables} onChange={set("variables")} />
          </Labeled>
          <Labeled label="Secret variables, one name per line (values are set after adding)">
            <textarea className={field} rows={2} value={form.secretVariables} onChange={set("secretVariables")} />
          </Labeled>
        </>
      ) : (
        <>
          <Labeled label="Address (https, or http on this machine)">
            <input className={field} value={form.url} onChange={set("url")} />
          </Labeled>
          <Labeled label="Token, sent as a bearer header (optional)">
            <input className={field} type="password" autoComplete="off" value={form.token} onChange={set("token")} />
          </Labeled>
          <Labeled label="Secret headers, one name per line (values are set after adding)">
            <textarea className={field} rows={2} value={form.headers} onChange={set("headers")} />
          </Labeled>
        </>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className={button}>
          Add
        </button>
        <button type="button" className={button} onClick={() => (setOpen(false), setForm(empty), setError(null))}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Discover({ rpc, onImported }: { rpc: Rpc; onImported: (id: string) => Promise<void> }) {
  const [folder, setFolder] = useState("");
  const [found, setFound] = useState<{ folder: string | null; servers: Found[]; notes: string[] } | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({}); // per server: imported, or why not
  const [error, setError] = useState<string | null>(null);
  const key = (s: Found) => `${s.source}:${s.name}`;

  const find = async () => {
    const searched = folder.trim() === "" ? null : folder.trim();
    try {
      setFound({ folder: searched, ...(await rpc.call("discover", { folder: searched })) });
      setNotes({});
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  };
  const importServer = async (s: Found) => {
    const result = await rpc.call("discover_import", { source: s.source, folder: s.source === "project" ? found!.folder : null, name: s.name }).catch(failed);
    setNotes((n) => ({ ...n, [key(s)]: result.ok ? "Imported." : result.error }));
    if (result.ok) await onImported(result.id);
  };

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="font-medium text-foreground">Find existing servers</p>
      <p className="text-xs text-muted-foreground">Reads Claude Code's user config file and, if you give a folder, its .mcp.json. Only names and kinds are shown; nothing is imported until you click Import.</p>
      <div className="flex flex-wrap gap-2">
        <input className={`${field} max-w-md`} aria-label="Project folder (optional)" placeholder="Project folder (optional, absolute path)" value={folder} onChange={(e) => setFolder(e.target.value)} />
        <button type="button" className={button} onClick={() => void find()}>
          Find existing servers
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {found && (
        <>
          {found.notes.map((n) => (
            <p key={n} className="text-xs text-muted-foreground">
              {n}
            </p>
          ))}
          {found.servers.length === 0 ? (
            <p className="text-xs text-muted-foreground">No servers found.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border" aria-label="Servers found">
              {found.servers.map((s) => (
                <li key={key(s)} className="flex flex-wrap items-center justify-between gap-2 p-2 text-xs">
                  <span>
                    <span className="font-medium text-foreground">{s.name}</span> <span className="text-muted-foreground">{s.kind} · {s.source === "user" ? "Claude Code user config" : "the folder's .mcp.json"}</span>
                    {!s.importable && <span className="block text-muted-foreground">Not importable: {s.reason}</span>}
                    {notes[key(s)] && <span className="block" role="status">{notes[key(s)]}</span>}
                  </span>
                  {s.importable && !notes[key(s)]?.startsWith("Imported") && (
                    <button type="button" className={button} aria-label={`Import ${s.name}`} onClick={() => void importServer(s)}>
                      Import
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
