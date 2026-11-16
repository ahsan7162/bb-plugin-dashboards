// Frame: free HTML, CSS and JS, two iframes deep, both sandbox="allow-scripts" only (opaque origins:
// no access to the page, its storage or cookies; no forms, popups or top navigation).
// - The outer frame is a wrapper document holding only our code. Its CSP adds frame-src 'none' to the
//   frame policy, so the inner frame can load its srcdoc and nothing else: a script, link or meta
//   refresh that sends it to an outside address ends on the browser's blocked page, data unsent.
//   (A single frame with the same CSP can still navigate itself out.)
// - The inner frame runs the program's HTML under the frame policy: nothing loads from the network.
// Messages: the data and the dashboard's theme go in (page → wrapper → inner), the content's height
// comes out (inner → wrapper → page), and the wrapper reports a blocked navigation. Every hop checks
// the sender's window and the message's shape; anything else is dropped.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod/v4";
import { text } from "./bound";

export const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
export const WRAPPER_CSP = `${FRAME_CSP}; frame-src 'none'`;
export const MESSAGE = { data: "openui-frame-data", theme: "openui-frame-theme", height: "openui-frame-height", left: "openui-frame-left" } as const;
const MAX_HEIGHT = 4000;

/**
 * Runs first in the inner frame: keeps the latest data in window.frameData and announces it as a
 * "framedata" event, applies theme updates to its root, and reports the content's height.
 */
export const BOOT = `(function(){var root=document.documentElement;addEventListener("message",function(e){var m=e.data;if(e.source!==parent||!m||typeof m!=="object")return;if(m.type==="${MESSAGE.theme}"){for(var k in m.theme)root.style.setProperty(k,m.theme[k])}else if(m.type==="${MESSAGE.data}"){window.frameData=m.data;dispatchEvent(new CustomEvent("framedata",{detail:m.data}))}});new ResizeObserver(function(){parent.postMessage({type:"${MESSAGE.height}",height:root.getBoundingClientRect().height},"*")}).observe(root)})();`;

/**
 * The wrapper's only script. Data and theme from the page go to the inner frame, the inner frame's
 * height goes to the page, and a second load of the inner frame (it navigated: our srcdoc loads
 * once) removes it and tells the page. The inner frame's document is never read.
 */
export const RELAY = `(function(){var f=document.getElementById("f"),root=document.documentElement,loads=0,data=null,theme=null;
function send(m){if(m&&loads===1&&f.contentWindow)f.contentWindow.postMessage(m,"*")}
addEventListener("message",function(e){var m=e.data;if(!m||typeof m!=="object")return;
if(e.source===parent&&m.type==="${MESSAGE.data}"){data={type:"${MESSAGE.data}",data:m.data};send(data)}
else if(e.source===parent&&m.type==="${MESSAGE.theme}"&&m.theme&&typeof m.theme==="object"){theme={type:"${MESSAGE.theme}",theme:m.theme};root.style.colorScheme=String(m.theme["color-scheme"]||"normal");send(theme)}
else if(loads<2&&e.source===f.contentWindow&&m.type==="${MESSAGE.height}"&&typeof m.height==="number"&&isFinite(m.height)){var h=Math.max(0,Math.min(${MAX_HEIGHT},Math.ceil(m.height)));f.style.height=h+"px";parent.postMessage({type:"${MESSAGE.height}",height:h},"*")}});
f.addEventListener("load",function(){loads++;if(loads>1){f.remove();parent.postMessage({type:"${MESSAGE.left}"},"*");return}send(theme);send(data)})})();`;

// The dashboard's colours, offered to the frame's CSS as var(--ink) and so on.
const COLOURS = { ink: "ink", muted: "ink-muted", accent: "accent", border: "border", surface: "surface" } as const;
type Theme = Record<string, string>;

/** The mode, colours and font around the frame, as CSS properties for the frame's root. */
function themeOf(box: HTMLElement): Theme {
  const style = getComputedStyle(box);
  const mode = style.colorScheme || box.closest("[data-dashboard-mode]")?.getAttribute("data-dashboard-mode") || "normal";
  const theme: Theme = { "color-scheme": mode, "font-family": style.fontFamily || "system-ui, sans-serif" };
  for (const [name, token] of Object.entries(COLOURS)) theme[`--${name}`] = style.getPropertyValue(`--openui-dashboard-${token}`).trim() || "currentColor";
  return theme;
}

const clean = (value: string) => value.replace(/[<>{};]/g, ""); // a value cannot end the rule or the style element
const declarations = (theme: Theme) => Object.entries(theme).map(([property, value]) => `${property}:${clean(value)}`).join(";");
/** For a double-quoted attribute: the program's HTML stays inside srcdoc whatever it contains. */
export const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The inner document: its CSP first, so it applies before any of the program's HTML. */
export const innerDocument = (html: string, theme: Theme) =>
  `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><meta charset="utf-8"><script>${BOOT}</script><style>html{${declarations(theme)}}html,body{margin:0;font-size:13px;line-height:1.45;color:var(--ink);background:transparent}</style></head><body>${html}</body></html>`;

/** The wrapper document: our CSP, one inner frame and the relay, nothing of the program's outside srcdoc. */
export const wrapperDocument = (html: string, theme: Theme, height: number, title: string) =>
  `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}"><meta charset="utf-8"><style>html{color-scheme:${clean(theme["color-scheme"] ?? "normal")}}html,body{margin:0;background:transparent}iframe{display:block;width:100%;height:${height}px;border:0}</style></head><body><iframe id="f" sandbox="allow-scripts" title="${escapeAttribute(title)}" srcdoc="${escapeAttribute(innerDocument(html, theme))}"></iframe><script>${RELAY}</script></body></html>`;

export const Frame = defineComponent({
  name: "Frame",
  props: z.object({ title: z.string(), html: z.string(), data: z.any().optional(), height: z.number().optional() }),
  description:
    "Free HTML, CSS and JS for what no component draws, in a sandboxed frame with no network: no outside scripts, styles, fonts or images (images only as data: URLs), no access to the page, and no way out: links and navigation inside it are blocked (put a LinkOut beside it). html is one string: use single quotes inside it for HTML attributes and JS strings. data is passed in: the frame's script reads window.frameData or listens for the \"framedata\" event (event.detail). Its CSS can use the dashboard's colours, which follow light and dark mode: var(--ink), var(--muted), var(--accent), var(--border), var(--surface). The frame fits its content's height; height (px, default 240) is the starting height.",
  component: ({ props }) => {
    const box = useRef<HTMLDivElement>(null);
    const frame = useRef<HTMLIFrameElement>(null);
    const [initialTheme, setInitialTheme] = useState<Theme | null>(null); // written into the documents; later changes go by message
    const [height, setHeight] = useState<number | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [left, setLeft] = useState(false);
    const json = JSON.stringify(props.data ?? null) ?? "null";
    const start = props.height && props.height > 0 ? Math.min(props.height, MAX_HEIGHT) : 240;
    // "*": the sandboxed wrapper's origin is opaque. It forwards only these two kinds inward.
    const send = (message: object) => frame.current?.contentWindow?.postMessage(message, "*");
    const sendData = () => send({ type: MESSAGE.data, data: JSON.parse(json) });
    const sendTheme = () => box.current && send({ type: MESSAGE.theme, theme: themeOf(box.current) });

    useLayoutEffect(() => setInitialTheme(themeOf(box.current!)), []); // before paint, so the frame loads once
    useEffect(() => {
      const onMessage = (e: MessageEvent) => {
        if (e.source === null || e.source !== frame.current?.contentWindow) return;
        if (e.data?.type === MESSAGE.left) return setLeft(true);
        if (e.data?.type !== MESSAGE.height || typeof e.data.height !== "number" || !Number.isFinite(e.data.height)) return;
        setHeight(Math.min(MAX_HEIGHT, Math.max(0, Math.ceil(e.data.height))));
      };
      addEventListener("message", onMessage);
      return () => removeEventListener("message", onMessage);
    }, []);
    useEffect(() => void sendData(), [json]); // new data reaches a loaded frame without reloading it
    useEffect(() => setLeft(false), [props.html]); // changed HTML gets a fresh frame after a "left" note
    // bb's mode or the dashboard's theme changed: ThemeProvider rewrites its element's attributes (and bb
    // its root's). The new colours go in by message, so the frame's content is not reloaded.
    useEffect(() => {
      const provider = box.current?.closest("[data-dashboard-mode]");
      let last = JSON.stringify(initialTheme);
      const observer = new MutationObserver(() => {
        if (!box.current) return; // the frame left and a note stands in its place
        const next = JSON.stringify(themeOf(box.current));
        if (next !== last) (last = next), sendTheme();
      });
      if (provider) observer.observe(provider, { attributes: true, attributeFilter: ["style", "data-dashboard-mode"] });
      observer.observe(document.documentElement, { attributes: true });
      return () => observer.disconnect();
    }, [initialTheme]);

    if (left) {
      return (
        <p className="bbd-frame-left bbd-enter" role="status">
          This frame tried to leave the page and was stopped.
        </p>
      );
    }
    return (
      <div ref={box} className="bbd-frame-box">
        {initialTheme === null ? null : (
          <iframe
            ref={frame}
            className="bbd-frame"
            data-loaded={loaded ? "" : undefined}
            title={text(props.title) || "Custom content"}
            sandbox="allow-scripts"
            srcDoc={wrapperDocument(text(props.html), initialTheme, start, text(props.title) || "Custom content")}
            style={{ height: height ?? start }}
            onLoad={() => {
              setLoaded(true); // fades in once; a later reload (new html) stays visible
              sendTheme(); // the current colours, which may have changed since the document was written
              sendData();
            }}
          />
        )}
      </div>
    );
  },
});
