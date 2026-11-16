// Edit mode, panel chrome over a dashboard: the viewer picks a part of it, writes what should
// change, and one message goes to the thread (the view's own send, ui/panel.tsx). Nothing is added to the
// program, the library's schema or the agent's guide.
//
// Screen to program. `editable` is the shipped library with every renderer wrapped once (no DOM added):
// the wrapper puts a React Fragment ref around the component (React 19.3's FragmentInstance, also in bb's
// React) and records, in a registry the view owns, its type, the named statement it came from, its
// evaluated props and its parent part. The Fragment gives its host elements (observeUsing), so their boxes
// and what contains a node. A part's place in the program: from the root part down, each part is found in
// its parent's evaluated props (same object, or equal props when its renderer skipped a redraw), which also
// passes elements that draw nothing of their own (a Tab); the nearest one with a statement id names the
// statement. Its source is cut from the program text with lang-core's tokenizer.
//
// While editing, the dashboard is inert (no pointer, focus or keys reach it, a Frame included) and a layer
// above it holds one transparent button per part that has a box: the pointer finds the innermost (deeper
// parts sit higher), Tab walks them in page order, Enter or a click picks one. Clicks that reach the
// dashboard anyway are stopped there and pick the part they landed on.
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FragmentInstance,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type {} from "react-dom"; // FragmentInstance's methods
import { split, tokenize } from "@openuidev/lang-core";
import type { ComponentRenderProps } from "@openuidev/react-lang";
import { library } from "./library";

type Props = Record<string, unknown>;
type Part = { id: string; type: string; statementId?: string; props: Props; parent: string | null; depth: number; fragment: FragmentInstance | null };
export type Parts = ReturnType<typeof createParts>;

/** The view's registry of mounted parts. `listen` hears every change while the edit layer is open. */
export function createParts() {
  const map = new Map<string, Part>();
  let changed = () => {};
  return {
    map,
    set(id: string, patch: Partial<Part>) {
      map.set(id, { ...(map.get(id) ?? { id, type: "", props: {}, parent: null, depth: 0, fragment: null }), ...patch });
      changed();
    },
    remove(id: string) {
      map.delete(id);
      changed();
    },
    listen(fn: () => void) {
      changed = fn;
      return () => void (changed = () => {});
    },
  };
}

export const PartsContext = createContext<Parts | null>(null);
// Stable per part (memoized), so a parent's redraw does not redraw children the Renderer skipped.
const ParentContext = createContext<{ id: string; depth: number } | null>(null);

function marked(type: string, Comp: (p: ComponentRenderProps) => ReactNode) {
  return function Part(p: ComponentRenderProps) {
    const parts = useContext(PartsContext);
    const parent = useContext(ParentContext);
    const id = useId();
    const depth = parent ? parent.depth + 1 : 0;
    const self = useMemo(() => ({ id, depth }), [id, depth]);
    useLayoutEffect(() => parts?.set(id, { type, statementId: p.statementId, props: p.props, parent: parent?.id ?? null, depth }));
    const ref = useCallback(
      (fragment: FragmentInstance) => {
        parts?.set(id, { fragment });
        return () => parts?.remove(id);
      },
      [parts, id],
    );
    return (
      <Fragment ref={ref}>
        <ParentContext.Provider value={self}>
          <Comp {...p} />
        </ParentContext.Provider>
      </Fragment>
    );
  };
}

/**
 * The library the view renders with, Edit mode on or off: the same components, schema and functions
 * (toJSONSchema and prompt close over the original), each renderer wrapped once. Parsing and generate.ts
 * use `library` itself.
 */
export const editable: typeof library = {
  ...library,
  components: Object.fromEntries(Object.entries(library.components).map(([name, c]) => [name, { ...c, component: marked(name, c.component as (p: ComponentRenderProps) => ReactNode) }])),
};

/** Wrappers the user does not see as a thing of their own: the root, a Row of cards, a Tab (Tabs draws it), a Record (RecordList draws it). */
const UNSEEN = new Set(["Dashboard", "Row", "Tab", "Record"]);
const selectable = (part: Part) => !UNSEEN.has(part.type) && part.fragment !== null;

/** The part's top-level host elements, through the Fragment's observeUsing (it calls observe on each). */
function nodesOf(fragment: FragmentInstance): Element[] {
  const nodes: Element[] = [];
  const collector = { observe: (node: Element) => void nodes.push(node), unobserve() {} } as unknown as ResizeObserver;
  fragment.observeUsing(collector);
  fragment.unobserveUsing(collector);
  return nodes;
}

/** The deepest selectable part whose elements contain `node`. */
function innermost(parts: Parts, node: Node): Part | null {
  let best: Part | null = null;
  for (const part of parts.map.values()) {
    if (selectable(part) && (best === null || part.depth > best.depth) && nodesOf(part.fragment!).some((n) => n.contains(node))) best = part;
  }
  return best;
}

// ---- What a part is called ----

/** One line of display text: no line breaks, control or direction-changing characters, at most `max` characters. */
const oneLine = (value: string, max: number) => {
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const LABELS = ["title", "label", "text", "placeholder", "source"];
const LISTS = ["options", "tabs", "columns", "items", "series"]; // a filter's options, Tabs' tabs, a Table's columns, Kpis' items, a chart's series
const isElement = (value: unknown): value is { type: "element"; typeName: string; statementId?: string; props: Props } =>
  typeof value === "object" && value !== null && (value as { type?: unknown }).type === "element";

/** What the user sees as its name: a title or label, else the first labels of its options, tabs, columns or series. */
export function labelOf(props: Props): string {
  for (const key of LABELS) {
    const value = props[key];
    if ((typeof value === "string" && value.trim() !== "") || typeof value === "number") return oneLine(String(value), 60);
  }
  for (const key of LISTS) {
    const names = (Array.isArray(props[key]) ? (props[key] as unknown[]) : []).flatMap((item) => {
      const fields = (isElement(item) ? item.props : item) as Props | null;
      const name = fields?.label ?? fields?.name;
      return typeof name === "string" && name.trim() !== "" ? [name] : [];
    });
    if (names.length > 0) return oneLine(names.slice(0, 3).join(" / ") + (names.length > 3 ? " / …" : ""), 60);
  }
  return "";
}

/** `Card "Revenue by week"`: the kind, then the label JSON-quoted, so no title can break the line it is in. */
const nameOf = (part: Pick<Part, "type" | "props">) => {
  const label = labelOf(part.props);
  return label ? `${part.type} ${JSON.stringify(label)}` : part.type;
};

/** The part and its parents, root first. */
function chainOf(parts: Parts, id: string): Part[] {
  const chain: Part[] = [];
  for (let part = parts.map.get(id); part; part = part.parent === null ? undefined : parts.map.get(part.parent)) chain.unshift(part);
  return chain;
}

// ---- Where a part is in the program ----

type El = { typeName: string; statementId?: string; props: Props };

/** Equal evaluated values; elements compare on what the Renderer draws from (type, statement, props). */
function same(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || depth > 64 || Array.isArray(a) !== Array.isArray(b)) return false;
  if (isElement(a) || isElement(b)) return isElement(a) && isElement(b) && a.typeName === b.typeName && a.statementId === b.statementId && same(a.props, b.props, depth + 1);
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => same((a as Props)[k], (b as Props)[k], depth + 1));
}

/** The elements below `from` down to the first (depth first) that is `part`; null when none is. */
function pathTo(from: El, part: Part): El[] | null {
  const walk = (value: unknown): El[] | null => {
    if (typeof value !== "object" || value === null) return null;
    if (isElement(value)) {
      if (value.typeName === part.type && value.statementId === part.statementId && (value.props === part.props || same(value.props, part.props))) return [value];
      const below = walk(value.props);
      return below && [value, ...below];
    }
    for (const child of Object.values(value)) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(from.props);
}

/** Elements of `type` below `from` that have no statement of their own, in program order. */
function inlineOfType(from: El, type: string): El[] {
  const found: El[] = [];
  const walk = (value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    if (isElement(value)) {
      if (value.statementId) return;
      if (value.typeName === type) found.push(value);
      return walk(value.props);
    }
    Object.values(value).forEach(walk);
  };
  walk(from.props);
  return found;
}

// lang-core's token kinds (a const enum, not exported at run time), as server/validate.ts has them.
const LPAREN = 1;
const IDENT = 16;
const TYPE = 17;

export type Place = {
  /** The named statement the part is written in; null when the program has none for it. */
  statement: string | null;
  source: string;
  /** Written inside a statement rather than being one. */
  inline: boolean;
  /** For a part reached through a list or value statement: the statement that uses it. */
  usedBy?: string;
  /** Its place among the parts of its kind written inline in the statement, when there are several. */
  position?: { n: number; of: number };
};

/** Where part `id` is in `program` (the shown version's text). */
export function placeOf(parts: Parts, id: string, program: string): Place {
  const chain = chainOf(parts, id);
  const target = chain.at(-1)!;
  // The element path from the root, through elements that draw nothing themselves; the parts alone when a step is not found.
  let path: El[] = [{ typeName: chain[0]!.type, statementId: chain[0]!.statementId, props: chain[0]!.props }];
  for (const part of chain.slice(1)) {
    const below = pathTo(path.at(-1)!, part);
    if (below === null) {
      path = chain.map((p) => ({ typeName: p.type, statementId: p.statementId, props: p.props }));
      break;
    }
    path.push(...below);
  }
  const element = path.at(-1)!;
  const enclosing = [...path].reverse().find((el) => el.statementId) ?? null;

  const statements = new Map(split(tokenize(program)).map((s) => [s.id, s])); // a name given twice: the last one
  const calls = (name: string) => statements.get(name)?.tokens.some((t, i, all) => t.t === TYPE && t.v === target.type && all[i + 1]?.t === LPAREN) ?? false;
  const sourceOf = (name: string | null) => {
    const s = name === null ? undefined : statements.get(name);
    return s?.start !== undefined && s.end !== undefined ? program.slice(s.start, s.end) : "";
  };
  if (enclosing === null) return { statement: null, source: "", inline: true };
  const name = enclosing.statementId!;
  if (enclosing === element) return { statement: name, source: sourceOf(name), inline: false };

  // Not written in the statement it is drawn under: a list or value statement it uses (cards = [Card(...)]).
  if (!calls(name)) {
    const seen = new Set([name]);
    for (const queue = [name]; queue.length > 0; ) {
      for (const t of statements.get(queue.shift()!)?.tokens ?? []) {
        const ref = t.t === IDENT || t.t === TYPE ? String(t.v) : null;
        if (ref === null || seen.has(ref) || !statements.has(ref)) continue;
        if (calls(ref)) return { statement: ref, source: sourceOf(ref), inline: true, usedBy: name };
        seen.add(ref);
        queue.push(ref);
      }
    }
  }
  const kin = inlineOfType(enclosing, target.type);
  const n = kin.indexOf(element) + 1;
  return { statement: name, source: sourceOf(name), inline: true, ...(n > 0 && kin.length > 1 && { position: { n, of: kin.length } }) };
}

// ---- The message ----

export const REQUEST_CAP = 2000;
export const QUOTE_CAP = 1500;

/** A fenced block whose fence is longer than any run of backticks inside, so the body cannot close it. */
function fenced(body: string, info: string): string {
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${body}\n${fence}`;
}

/** The one message a change request sends: which dashboard and version, what was picked and where, its source, the request. */
export function changeMessage(m: { dashboard: { id: string; title: string; version: number }; kind: string; target: string; within: string[]; place: Place; request: string }): string {
  const { place } = m;
  const statement = place.statement;
  const where =
    statement === null
      ? ", in no statement that could be found"
      : !place.inline
        ? `, the statement ${statement}`
        : `${m.within.length > 0 ? ` in ${m.within.join(" > ")}` : ""}, written inline in statement ${statement}${place.usedBy ? `, which ${place.usedBy} uses` : ""}${place.position ? ` (${m.kind} ${place.position.n} of ${place.position.of} there)` : ""}`;
  const cut = place.source.length > QUOTE_CAP ? ` (first ${QUOTE_CAP} of ${place.source.length} characters)` : "";
  return [
    `Change request for dashboard ${JSON.stringify(oneLine(m.dashboard.title, 200))} (id ${m.dashboard.id}), version ${m.dashboard.version}.`,
    `Target: ${m.target}${where}.`,
    ...(statement === null ? [] : [`Source of ${statement}${cut}:`, fenced(place.source.slice(0, QUOTE_CAP), "openui")]),
    "Requested change:",
    fenced(m.request.trim().slice(0, REQUEST_CAP), "text"),
    `Change only this with a dashboard_save patch of ${statement ?? "the statement that holds it"}; leave the rest unchanged.`,
  ].join("\n");
}

// ---- Where the popover goes ----

export type Box = { top: number; left: number; width: number; height: number };
/** The popover's normal width, its distance from the visible area's edges, and from the part. */
export const POPOVER = { width: 320, margin: 8, gap: 6 } as const;

/**
 * The popover's place, all in one coordinate space: under the part, else over it, else (neither fits,
 * or the part fills the view) inside the visible area against the edge nearer to where it would go.
 * Never past the visible area's sides: it narrows below its normal width when that is narrower, and
 * its height is capped to the visible area (its own content then scrolls, Send and Cancel stay).
 */
export function placePopover(part: Box, size: { width: number; height: number }, visible: Box): Box & { maxHeight: number } {
  const { margin, gap } = POPOVER;
  const width = Math.max(0, Math.min(size.width, visible.width - 2 * margin));
  const maxHeight = Math.max(0, visible.height - 2 * margin);
  const height = Math.min(size.height, maxHeight);
  const minTop = visible.top + margin;
  const maxTop = visible.top + visible.height - margin - height;
  const below = part.top + part.height + gap;
  const above = part.top - gap - height;
  const fits = (top: number) => top >= minTop && top <= maxTop;
  const top = fits(below) ? below : fits(above) ? above : Math.abs(below - maxTop) <= Math.abs(above - minTop) ? maxTop : minTop;
  const left = Math.min(Math.max(part.left, visible.left + margin), visible.left + visible.width - margin - width);
  return { top, left, width, height, maxHeight };
}

/** What of `from` can be seen, in viewport coordinates: the window, cut by every ancestor that clips or scrolls. */
function visibleBox(from: Element): Box {
  let top = 0;
  let left = 0;
  let right = innerWidth;
  let bottom = innerHeight;
  for (let el = from.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (!/auto|scroll|hidden|clip|overlay/.test(`${style.overflowX} ${style.overflowY}`)) continue;
    const r = el.getBoundingClientRect(); // its client area: inside the borders, without the scrollbars
    top = Math.max(top, r.top + el.clientTop);
    left = Math.max(left, r.left + el.clientLeft);
    right = Math.min(right, r.left + el.clientLeft + el.clientWidth);
    bottom = Math.min(bottom, r.top + el.clientTop + el.clientHeight);
  }
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

// ---- The layer over the dashboard ----

type Spot = { id: string; name: string; depth: number; box: Box; first: Element };
const spotKey = (spots: Spot[]) => JSON.stringify(spots.map((s) => [s.id, s.name, s.depth, s.box]));
// What reaches the inert dashboard anyway is stopped before the components' own handlers (React's sit at the root).
const BLOCKED = ["click", "dblclick", "auxclick", "contextmenu", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "keydown", "submit"];
const frameLater = (fn: () => void) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : setTimeout(fn, 16));
const button = "rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50";

export function EditLayer(props: {
  parts: Parts;
  /** The dashboard's wrapper, inert while this is open. */
  content: RefObject<HTMLElement | null>;
  dashboard: { id: string; title: string; version: number; program: string };
  /** Sends the text to the dashboard's thread; resolves to null when sent, else why not. */
  send: (text: string) => Promise<string | null>;
  onSent: () => void;
}) {
  const { parts, content } = props;
  const layer = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const headingId = useId();
  const areaId = useId();

  // Each selectable part with a box, in page order; boxes relative to the layer.
  const measure = useCallback(() => {
    const origin = layer.current?.getBoundingClientRect();
    if (!origin) return;
    const next = [...parts.map.values()].flatMap((part): Spot[] => {
      if (!selectable(part)) return [];
      const nodes = nodesOf(part.fragment!);
      const rects = nodes.map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0 || r.height > 0);
      if (rects.length === 0) return [];
      const top = Math.min(...rects.map((r) => r.top));
      const left = Math.min(...rects.map((r) => r.left));
      const box = { top: top - origin.top, left: left - origin.left, width: Math.max(...rects.map((r) => r.right)) - left, height: Math.max(...rects.map((r) => r.bottom)) - top };
      return [{ id: part.id, name: nameOf(part), depth: part.depth, box, first: nodes[0]! }];
    });
    next.sort((a, b) => (a.first === b.first ? a.depth - b.depth : a.first.compareDocumentPosition(b.first) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    setSpots((before) => (spotKey(before) === spotKey(next) ? before : next));
  }, [parts]);

  // Measured now, then again after anything that can move a part: a part drawn, resized, scrolled or the window resized.
  useLayoutEffect(() => {
    measure();
    let waiting = false;
    const later = () => {
      if (waiting) return;
      waiting = true;
      frameLater(() => {
        waiting = false;
        measure();
      });
    };
    const stop = parts.listen(later);
    const resized = new ResizeObserver(later);
    const mutated = new MutationObserver(later);
    if (content.current) {
      resized.observe(content.current);
      mutated.observe(content.current, { childList: true, subtree: true });
    }
    addEventListener("resize", later);
    document.addEventListener("scroll", later, true);
    return () => {
      stop();
      resized.disconnect();
      mutated.disconnect();
      removeEventListener("resize", later);
      document.removeEventListener("scroll", later, true);
    };
  }, [measure, parts, content]);

  const pick = useCallback((id: string) => {
    setPicked(id);
    setProblem(null);
  }, []);

  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const block = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const part = e.type === "click" && e.target instanceof Node ? innermost(parts, e.target) : null;
      if (part) pick(part.id);
    };
    for (const type of BLOCKED) el.addEventListener(type, block, true);
    return () => {
      for (const type of BLOCKED) el.removeEventListener(type, block, true);
    };
  }, [content, parts, pick]);

  useEffect(() => {
    if (picked !== null) area.current?.focus();
  }, [picked]);

  const part = picked === null ? undefined : parts.map.get(picked);
  const spot = spots.find((s) => s.id === picked);

  // The popover stays in the visible part of the panel (placePopover): placed after every render, and
  // again when the panel scrolls, the window resizes or the popover itself grows (the text area, a line).
  const placeNow = useRef(() => {});
  placeNow.current = () => {
    const pop = popover.current;
    if (!pop || !layer.current) return;
    const origin = layer.current.getBoundingClientRect();
    const box = spot?.box ?? { top: 0, left: 0, width: 0, height: 0 };
    const at = { top: origin.top + box.top, left: origin.left + box.left, width: box.width, height: box.height };
    const visible = visibleBox(layer.current);
    const size = placePopover(at, { width: POPOVER.width, height: pop.offsetHeight }, visible); // the width first: it changes the height
    pop.style.width = `${size.width}px`;
    pop.style.maxHeight = `${size.maxHeight}px`;
    const place = placePopover(at, { width: POPOVER.width, height: pop.offsetHeight }, visible);
    pop.style.top = `${place.top - origin.top}px`;
    pop.style.left = `${place.left - origin.left}px`;
  };
  useLayoutEffect(() => placeNow.current());
  const open = part !== undefined;
  useEffect(() => {
    if (!open) return;
    const again = () => placeNow.current();
    const grown = new ResizeObserver(again);
    if (popover.current) grown.observe(popover.current);
    addEventListener("resize", again);
    document.addEventListener("scroll", again, true);
    return () => {
      grown.disconnect();
      removeEventListener("resize", again);
      document.removeEventListener("scroll", again, true);
    };
  }, [open]);

  const close = () => {
    const id = picked;
    setPicked(null);
    setProblem(null);
    setText("");
    if (id !== null) Array.from(layer.current?.querySelectorAll<HTMLElement>("[data-part]") ?? []).find((b) => b.dataset.part === id)?.focus();
  };
  // From the popover or a part's button: while a part is picked, Escape only closes the popover.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || picked === null) return;
    e.preventDefault(); // the next Escape, on the view, leaves Edit mode
    e.stopPropagation();
    close();
  };

  const request = text.trim();
  const send = async () => {
    if (!part || request === "" || busy) return;
    const chain = chainOf(parts, part.id).filter(selectable);
    const message = changeMessage({ dashboard: props.dashboard, kind: part.type, target: nameOf(part), within: chain.slice(0, -1).map(nameOf), place: placeOf(parts, part.id, props.dashboard.program), request });
    setBusy(true);
    const why = await props.send(message);
    setBusy(false);
    if (why === null) props.onSent();
    else setProblem(why);
  };

  const crumbs = part ? chainOf(parts, part.id).filter(selectable) : [];
  return (
    <div
      ref={layer}
      className="bbd-edit-layer"
      onPointerOver={(e) => setHover((e.target as HTMLElement).closest<HTMLElement>("[data-part]")?.dataset.part ?? null)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
    >
      {spots.map((s) => (
        <button
          key={s.id}
          type="button"
          className="bbd-spot"
          data-part={s.id}
          data-hover={hover === s.id ? "" : undefined}
          aria-label={s.name}
          aria-haspopup="dialog"
          aria-expanded={picked === s.id}
          style={{ ...s.box, zIndex: s.depth + 1 }}
          onClick={() => pick(s.id)}
        />
      ))}
      {part && (
        <div ref={popover} role="dialog" aria-labelledby={headingId} className="bbd-pop absolute flex flex-col rounded-md border border-border bg-background text-xs text-foreground shadow-lg" style={{ zIndex: 1000 }}>
          {/* Capped to the visible area: this part scrolls, the buttons below stay in view. */}
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 pb-2">
            <p id={headingId} className="font-medium">
              {nameOf(part)}
            </p>
            {crumbs.length > 1 && (
              <nav aria-label="Where it is">
                <ol className="flex flex-wrap items-center gap-1 text-muted-foreground">
                  {crumbs.map((c, i) => (
                    <li key={c.id} className="flex items-center gap-1">
                      {i > 0 && <span aria-hidden="true">›</span>}
                      {c.id === part.id ? (
                        <span aria-current="location" className="text-foreground">
                          {nameOf(c)}
                        </span>
                      ) : (
                        <button type="button" className="underline hover:text-foreground" onClick={() => pick(c.id)}>
                          {nameOf(c)}
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
              </nav>
            )}
            <label htmlFor={areaId} className="block font-medium">
              What should change?
            </label>
            <textarea
              ref={area}
              id={areaId}
              rows={4}
              maxLength={REQUEST_CAP}
              className="w-full rounded-md border border-border bg-background p-1.5 text-xs text-foreground"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, REQUEST_CAP))}
            />
            {text.length >= REQUEST_CAP - 200 && (
              <p className="text-right text-muted-foreground" aria-live="polite">
                {text.length} / {REQUEST_CAP} characters
              </p>
            )}
            {problem && (
              <p role="alert" className="text-destructive">
                {problem}
              </p>
            )}
          </div>
          <div className="flex shrink-0 justify-end gap-2 px-3 pb-3">
            <button type="button" className={button} onClick={close}>
              Cancel
            </button>
            <button type="button" className={button} disabled={request === "" || busy} onClick={() => void send()}>
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
