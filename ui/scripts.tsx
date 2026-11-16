// Script sources in the dashboard view (PLAN section 7): a line for each script that waits for approval,
// cannot run here or misses a secret; the approval dialog; and the "Runs a script" badge, from which the
// user reads each approved script again, sets its secrets and withdraws its approval.
// The dialog is built so that approving without reading takes effort: the warning banner is always there,
// an edited script's changes come first, the whole script is shown and never folded, flagged lines carry their reasons, "Don't run" has the focus,
// and "Approve" stays off until the script was scrolled to its end (and the flagged lines were confirmed).
// One script per dialog; nothing approves more than the script shown.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ScriptsView } from "../server";
import { SCRIPT_MIN_REFRESH_SECONDS } from "../shared";
import { CONTROL } from "./colours";
import { SecretField } from "./connections";
import { flagLines } from "./flags";
import type { QueryInfo } from "./live";

export const BANNER = "This script will run on your computer every time this dashboard refreshes. The plugin cannot limit what it does. Read it before you approve.";
export const LIMIT =
  "Approval protects against a script running by mistake and against agents that cannot run shell commands. An agent you allow to run shell commands could approve a script without this dialog, and could also run commands directly.";
const FLAG_NOTE = "The check is a help: it looks for risky patterns. No flags does not mean the script is safe.";

type Script = ScriptsView["sources"][number];
type Approved = ScriptsView["approved"][number];
type Line = { kind: " " | "-" | "+"; text: string };

const button = "rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50";
const warning = "border-[var(--warning-text)] text-[var(--warning-text)]";

/** Lines of `after` against `before`, by longest common subsequence; one side whole when the scripts are too long to compare. */
export function lineDiff(before: string, after: string): Line[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ kind: "-" as const, text })), ...b.map((text) => ({ kind: "+" as const, text }))];
  const common = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) common[i]![j] = a[i] === b[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  const lines: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: " ", text: a[i++]! });
      j++;
    } else if (j >= b.length || (i < a.length && common[i + 1]![j]! >= common[i]![j + 1]!)) lines.push({ kind: "-", text: a[i++]! });
    else lines.push({ kind: "+", text: b[j++]! });
  }
  return lines;
}

/** When the source runs, from the Queries that read it. */
export function howOften(queries: QueryInfo[], source: string): string {
  const reading = queries.filter((q) => q.source === source);
  if (reading.length === 0) return "No Query of this version reads it, so it does not run.";
  const timers = reading.flatMap((q) => (typeof q.refresh === "number" ? [Math.max(q.refresh, SCRIPT_MIN_REFRESH_SECONDS)] : []));
  const timer = timers.length > 0 ? `, and every ${Math.min(...timers)} seconds while the dashboard is open` : "";
  return `When the dashboard opens, when a filter it reads changes and when you click Refresh${timer}. Never more than once every ${SCRIPT_MIN_REFRESH_SECONDS} seconds with the same arguments.`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-1">
      <h3 id={id} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

type DialogProps = {
  dashboardTitle: string;
  folder: string | null;
  queries: QueryInfo[];
  script: { name: string; runner: string; code: string; why?: string; secrets: string[]; previous?: Script["previous"]; approvedAt?: number };
} & ({ mode: "approve"; onApprove: () => Promise<string | null>; onDecline: () => void } | { mode: "read"; onWithdraw: () => void; onClose: () => void });

/** One script, for approval or (from the badge) for reading again. Escape is "Don't run" (or Close). */
export function ScriptDialog(props: DialogProps) {
  const { script } = props;
  const titleId = useId();
  const bannerId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(false);
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lines = script.code.split("\n");
  const flagged = new Map(flagLines(script.code).map((f) => [f.line, f.reasons]));
  const leave = props.mode === "approve" ? props.onDecline : props.onClose;

  // Back to what had the focus before the dialog opened.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus?.();
  }, []);
  const checkEnd = () => {
    const el = scroller.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 2) setAtEnd(true);
  };
  useEffect(checkEnd, []); // a script short enough to show whole is read to its end already

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      return leave();
    }
    if (e.key !== "Tab" || !dialog.current) return;
    // The focus stays inside the dialog.
    const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]'));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) e.preventDefault(), last?.focus();
    else if (!e.shiftKey && document.activeElement === last) e.preventDefault(), first?.focus();
  };

  const approve = async () => {
    if (props.mode !== "approve") return;
    setBusy(true);
    const problem = await props.onApprove();
    setBusy(false);
    setError(problem);
  };
  const canApprove = atEnd && (flagged.size === 0 || ticked) && !busy;
  const previous = props.mode === "approve" ? (script.previous ?? null) : null;
  const changes = previous ? lineDiff(previous.code, script.code).flatMap((l, i) => (l.kind === " " ? [] : [{ ...l, key: i }])) : [];
  const added = previous ? script.secrets.filter((n) => !previous.secrets.includes(n)) : [];
  const removed = previous ? previous.secrets.filter((n) => !script.secrets.includes(n)) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bannerId}
        onKeyDown={onKeyDown}
        className="flex max-h-full w-full max-w-3xl flex-col gap-3 overflow-auto rounded-lg border border-border bg-background p-4 text-sm text-foreground shadow-lg"
      >
        <h2 id={titleId} className="text-base font-medium">
          {props.mode === "approve" ? `Run the script "${script.name}"?` : `The approved script "${script.name}"`}
        </h2>
        <div id={bannerId} role="note" className={`space-y-1 rounded-md border px-3 py-2 ${warning}`}>
          <p className="font-medium">{BANNER}</p>
          <p className="text-xs">{LIMIT}</p>
        </div>
        {previous && (
          <Section title="What changed since you approved it">
            {previous.runner !== script.runner && (
              <p className="text-xs">
                Runner: <span className="font-mono">{previous.runner}</span> → <span className="font-mono">{script.runner}</span>
              </p>
            )}
            {added.length > 0 && <p className="text-xs">New secret variables: <span className="font-mono">{added.join(", ")}</span></p>}
            {removed.length > 0 && <p className="text-xs">No longer takes: <span className="font-mono">{removed.join(", ")}</span></p>}
            {changes.length > 0 && (
              <pre aria-label="Changed lines" className="max-h-48 overflow-auto rounded-md border border-border p-2 font-mono text-xs">
                {changes.map((l) => (
                  <div key={l.key} className={l.kind === "+" ? "text-[var(--success)]" : "text-[var(--destructive-text)]"}>
                    {l.kind === "+" ? "+ " : "- "}
                    {l.text}
                  </div>
                ))}
              </pre>
            )}
          </Section>
        )}
        <Section title="Why it exists">
          {script.why && <p>{script.why}</p>}
          <p className="text-xs text-muted-foreground">
            Asked for by the dashboard "{props.dashboardTitle}", as its source "{script.name}".
            {script.approvedAt !== undefined && ` You approved it on ${new Date(script.approvedAt).toLocaleString()}.`}
          </p>
        </Section>
        <Section title="What it gets">
          <ul className="list-disc space-y-0.5 pl-5 text-xs">
            <li>
              Runs with <span className="font-mono">{script.runner}</span> in the folder <span className="break-all font-mono">{props.folder ?? "unknown"}</span>, on this computer.
            </li>
            <li>{howOften(props.queries, script.name)}</li>
            <li>
              {script.secrets.length === 0 ? "No secret variables." : <>Secret variables (names only; you enter their values): <span className="font-mono">{script.secrets.join(", ")}</span>.</>} Nothing else from bb's
              environment except its tool path.
            </li>
            <li>The dashboard's arguments as JSON on its standard input.</li>
          </ul>
        </Section>
        <Section title={`The script, all ${lines.length} ${lines.length === 1 ? "line" : "lines"}`}>
          <div ref={scroller} role="region" aria-label="The whole script" tabIndex={0} onScroll={checkEnd} className="max-h-80 overflow-auto rounded-md border border-border font-mono text-xs">
            <pre className="min-w-fit p-2">
              {lines.map((text, i) => {
                const reasons = flagged.get(i + 1);
                return (
                  <div key={i} data-flagged={reasons ? "" : undefined} className={reasons ? `rounded-sm border-l-2 bg-[color-mix(in_oklab,var(--warning-text)_15%,transparent)] ${warning}` : undefined}>
                    <span aria-hidden="true" className="inline-block w-8 select-none pr-2 text-right text-muted-foreground">
                      {i + 1}
                    </span>
                    <span className="whitespace-pre-wrap break-all">{text}</span>
                    {reasons && <span className="block pl-8 font-sans">Flagged, line {i + 1}: {reasons.join("; ")}</span>}
                  </div>
                );
              })}
            </pre>
          </div>
          <p className="text-xs text-muted-foreground">
            {flagged.size === 0 ? "No lines are flagged." : `${flagged.size} ${flagged.size === 1 ? "line is" : "lines are"} flagged.`} {FLAG_NOTE}
          </p>
          {props.mode === "approve" && flagged.size > 0 && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />I have read the flagged lines
            </label>
          )}
        </Section>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {props.mode === "approve" ? (
            <>
              {!atEnd && <span className="text-xs text-muted-foreground">Scroll to the end of the script to approve it.</span>}
              <button type="button" className={button} autoFocus onClick={props.onDecline}>
                Don't run
              </button>
              <button type="button" className={button} disabled={!canApprove} onClick={() => void approve()}>
                Approve
              </button>
            </>
          ) : (
            <>
              <button type="button" className={button} autoFocus onClick={props.onClose}>
                Close
              </button>
              <button type="button" className={button} onClick={props.onWithdraw}>
                Withdraw approval
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** One line per script source of the shown version that cannot run yet, with what to do; secret fields when one is missing. */
export function ScriptNotices(props: { view: ScriptsView; onReview: (name: string) => void; saveSecret: (name: string, value: string | null) => Promise<void> }) {
  const { view } = props;
  return (
    <>
      {view.sources.map((s) => {
        const missing = s.secrets.filter((x) => !x.set);
        if (view.blocked === null && s.approved && missing.length === 0) return null;
        return (
          <div key={s.name} role="status" className={`mb-2 space-y-1 rounded-md border px-2 py-1 text-xs ${view.blocked === null && !s.approved ? warning : "border-border"}`}>
            <p className="flex flex-wrap items-center gap-2">
              {view.blocked !== null ? (
                <span>
                  Script "{s.name}": {view.blocked}
                </span>
              ) : !s.approved ? (
                <>
                  <span>Script "{s.name}" is waiting for your approval{s.previous ? ": it changed since you approved it" : ""}. The rest of the dashboard works without it.</span>
                  {view.latest ? (
                    <button type="button" className={button} onClick={() => props.onReview(s.name)}>
                      Review script "{s.name}"
                    </button>
                  ) : (
                    <span>Go back to the latest version to review it.</span>
                  )}
                </>
              ) : (
                <span>
                  Script "{s.name}" needs {missing.map((x) => x.name).join(", ")} before it runs.
                </span>
              )}
            </p>
            {view.blocked === null && view.latest && missing.map((x) => <SecretField key={x.name} label={x.name} set={false} save={(value) => props.saveSecret(x.name, value)} />)}
          </div>
        );
      })}
    </>
  );
}

/** "Runs a script": the dashboard's approved scripts, each to read again, give secrets and withdraw. */
export function ScriptBadge(props: { approved: Approved[]; onRead: (source: string) => void; onWithdraw: (source: string) => void; saveSecret: (name: string, value: string | null) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className="relative flex">
      <button type="button" className={`${CONTROL} ${warning}`} aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        Runs a script
      </button>
      {open && (
        <div id={listId} className="absolute right-0 top-full z-40 mt-1 w-80 space-y-2 rounded-md border border-border bg-background p-2 text-xs text-foreground shadow-lg">
          <ul aria-label="Approved scripts" className="space-y-2">
            {props.approved.map((a) => (
              <li key={a.source} className="space-y-1">
                <p>
                  "{a.source}" ({a.runner}), approved {new Date(a.approvedAt).toLocaleString()}
                </p>
                <div className="flex gap-2">
                  <button type="button" className={button} onClick={() => props.onRead(a.source)}>
                    Read script "{a.source}"
                  </button>
                  <button type="button" className={button} onClick={() => props.onWithdraw(a.source)}>
                    Withdraw approval of "{a.source}"
                  </button>
                </div>
                {a.secrets.map((x) => (
                  <SecretField key={x.name} label={x.name} set={x.set} save={(value) => props.saveSecret(x.name, value)} />
                ))}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">Withdrawing stops the script at once; the rest of the dashboard keeps working.</p>
        </div>
      )}
    </div>
  );
}
