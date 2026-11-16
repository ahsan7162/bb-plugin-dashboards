// Tabs, Tab and Drawer: which part of the dashboard is shown. Tab holds what a Section holds; Drawer
// holds what a Card holds, so either keeps the library's layout rules inside it.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { defineComponent, reactive } from "@openuidev/react-lang";
import { library as dashboard } from "@openuidev/dashboard-library";
import { z } from "zod/v4";
import { isSet, list, text, useBound } from "./bound";

// The library's own unions; ui/library.tsx adds the new components to these slots as well.
const sectionRows = dashboard.components.Section!.props.shape.rows;
const cardContent = dashboard.components.Card!.props.shape.content;

export const Tab = defineComponent({
  name: "Tab",
  props: z.object({ label: z.string(), rows: sectionRows }),
  description: "One view of Tabs: its label, then what it shows, the same things a Section holds.",
  component: ({ props, renderNode }) => <>{renderNode(props.rows)}</>,
});

export const Tabs = defineComponent({
  name: "Tabs",
  props: z.object({ tabs: z.array(Tab.ref), value: reactive(z.string().optional()) }),
  description:
    'Several views in one Section, one shown at a time: Tabs([Tab("Overview", [...]), Tab("Errors", [...])], $tab). value takes a $variable holding the shown tab\'s label ($tab = "Overview"), so other components can read it; left out, the first tab shows first.',
  component: ({ props, renderNode, statementId }) => {
    const tabs = list(props.tabs);
    const labels = tabs.map((tab) => text(tab?.props?.label));
    const field = useBound<string>(props.value, "tabs", statementId ?? labels.join("|"));
    const active = Math.max(0, labels.indexOf(text(field.value)));
    const id = useId(); // element ids only; state is named by useBound
    const buttons = useRef<(HTMLButtonElement | null)[]>([]);
    const indicator = useIndicator(buttons, active, labels.join("\n"));

    const select = (i: number, focus: boolean) => {
      field.setValue(labels[i]!);
      if (focus) buttons.current[i]?.focus();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const last = tabs.length - 1;
      const next = { ArrowRight: active === last ? 0 : active + 1, ArrowLeft: active === 0 ? last : active - 1, Home: 0, End: last }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      select(next, true);
    };
    if (tabs.length === 0) return null;
    return (
      <div className="bbd-tabs">
        <div role="tablist" className="bbd-tablist" onKeyDown={onKeyDown}>
          {labels.map((label, i) => (
            <button
              key={i}
              ref={(el) => {
                buttons.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${i}`}
              aria-selected={i === active}
              aria-controls={`${id}-panel`}
              tabIndex={i === active ? 0 : -1}
              className="bbd-tab"
              onClick={() => select(i, false)}
            >
              {label}
            </button>
          ))}
          {indicator ? <span className="bbd-tab-indicator" aria-hidden="true" style={{ transform: `translateX(${indicator.x}px) scaleX(${indicator.width})` }} /> : null}
        </div>
        {/* Keyed by the tab: a switch mounts the new view, which fades in (.bbd-tabpanel). */}
        <div key={active} role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${active}`} tabIndex={0} className="bbd-tabpanel">
          {renderNode(tabs[active]?.props?.rows)}
        </div>
      </div>
    );
  },
});

/** Where the active tab's underline goes: its left edge and width in px, measured after layout. */
function useIndicator(buttons: { current: (HTMLButtonElement | null)[] }, active: number, labels: string) {
  const [at, setAt] = useState<{ x: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const button = buttons.current[active];
    if (!button) return;
    const measure = () => setAt({ x: button.offsetLeft, width: button.offsetWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(button);
    return () => observer.disconnect();
  }, [buttons, active, labels]);
  return at;
}

export const Drawer = defineComponent({
  name: "Drawer",
  props: z.object({ title: z.string(), value: reactive(z.union([z.string(), z.number(), z.boolean()])), content: cardContent }),
  description:
    'A details panel shown while value, a $variable, holds something (usually the id a RecordList wrote); its close button clears it. content holds what a Card holds. Look the picked item up from the rows: picked = @First(@Filter(rows, "id", "==", $selected)), then Drawer(picked.title, $selected, [KeyValues([KeyValue("Owner", picked.owner)])]).',
  component: ({ props, renderNode, statementId }) => {
    const field = useBound<unknown>(props.value, "drawer", statementId ?? props.title);
    const open = isSet(field.value);
    const leaving = useLeaving(open);
    const panel = useRef<HTMLElement>(null);
    const returnTo = useRef<HTMLElement | null>(null);
    const headingId = useId();
    // While it slides out it keeps showing what it showed: the cleared $variable would blank it.
    const shown = useRef<{ title: string; content: ReactNode }>({ title: "", content: null });
    if (open) shown.current = { title: text(props.title), content: renderNode(props.content) };

    useEffect(() => {
      if (!open) return;
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; // usually the picked record
      panel.current?.scrollIntoView?.({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    }, [open, field.value]);

    const close = () => {
      field.setValue("");
      if (returnTo.current?.isConnected) returnTo.current.focus();
    };
    if (!open && !leaving.active) return null;
    return (
      <section
        ref={panel}
        className="bbd-drawer"
        data-state={open ? "open" : "closed"}
        role="region"
        aria-labelledby={headingId}
        onKeyDown={(e) => e.key === "Escape" && open && close()}
        onAnimationEnd={(e) => e.target === e.currentTarget && leaving.done()}
      >
        <header className="bbd-drawer-head">
          <h3 id={headingId} className="bbd-drawer-title">
            {shown.current.title}
          </h3>
          <button type="button" className="bbd-drawer-close" aria-label={`Close ${shown.current.title}`} onClick={close} disabled={!open}>
            ×
          </button>
        </header>
        <div className="bbd-drawer-body">{shown.current.content}</div>
      </section>
    );
  },
});

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Whether a just-closed Drawer is still playing its exit animation. Set in the same render that
 * sees it close, so it never blinks out; ends on the animation's end, at once under reduced
 * motion, and after 400 ms at the latest (when no animation ran).
 */
function useLeaving(open: boolean) {
  const [active, setActive] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    setActive(!open && !reducedMotion());
  }
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setActive(false), 400);
    return () => clearTimeout(timer);
  }, [active]);
  return { active, done: () => setActive(false) };
}
