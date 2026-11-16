// The viewer's colours for one dashboard: an accent, the chart colours and a light or dark look, chosen
// in a popover in the dashboard's header and kept in this browser only. They become dashboard tokens
// laid over bb's mapping and the dashboard's saved theme (ui/panel.tsx); no model call, no new version.
// The colour maths are small pure functions, tested in ui/colours.test.tsx.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

export type Mode = "light" | "dark";
export type Rgb = { r: number; g: number; b: number }; // 0 to 255 each
type Hsl = { h: number; s: number; l: number }; // h 0 to 360, s and l 0 to 1

/** "#abc" or "#aabbcc", any case; anything else is null. */
export function parseHex(value: unknown): Rgb | null {
  const match = typeof value === "string" ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim()) : null;
  if (!match) return null;
  const hex = match[1]!.length === 3 ? match[1]!.replace(/./g, (c) => c + c) : match[1]!;
  const n = parseInt(hex, 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
}

export const toHex = ({ r, g, b }: Rgb) => `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

const linear = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);

/** WCAG relative luminance: 0 for black, 1 for white. */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** OKLCH chroma (OKLab, Björn Ottosson): 0 for any grey, about 0.1 to 0.3 for clear colours, the same scale at every lightness. */
export function chroma({ r, g, b }: Rgb): number {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return Math.hypot(1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}

/**
 * Below this OKLCH chroma bb's main colour reads as grey on a chart. bb's stock --primary has 0 and its
 * coloured hues 0.09 and up; 0.04 also counts near-greys (a faint blue-grey) as grey, which on a chart line
 * look grey too. Chroma, not HSL saturation: saturation runs to 100% for a near-black with any tint.
 */
export const NEUTRAL_CHROMA = 0.04;

/** bb's own chart series for the default mapping (ui/panel.tsx), from bb's resolved --primary (null: not known). */
export function bbSeries(primary: Rgb | null, accentDefined: boolean): Record<string, string> {
  // A coloured primary, or one that could not be resolved (no such variable, no canvas): the mapping as it always was.
  if (primary === null || chroma(primary) >= NEUTRAL_CHROMA) return { series1: "var(--primary)", series2: "var(--timeline-accent)", series3: "var(--pr-merged)", series4: "var(--attention)" };
  // A grey primary: bb's blue accent leads, its other two hues follow, then the library's own palette.
  return { ...(accentDefined && { series1: "var(--timeline-accent)" }), series2: "var(--pr-merged)", series3: "var(--attention)" };
}

/**
 * A CSS variable's colour as the browser resolves it at `inside`, in sRGB: whatever its notation (oklch,
 * hex, rgb, hsl, color-mix), a probe element computes it and a 1 px canvas converts it. Null when the
 * variable is not defined there or the browser cannot convert it.
 */
export function resolveColour(inside: Element, variable: string): Rgb | null {
  if (getComputedStyle(inside).getPropertyValue(variable).trim() === "") return null;
  const probe = document.createElement("span");
  probe.style.color = `var(${variable})`;
  inside.append(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const pen = canvas.getContext("2d", { willReadFrequently: true });
  if (typeof pen?.fillRect !== "function" || typeof pen.getImageData !== "function") return null;
  const sentinel = "#010203";
  pen.fillStyle = sentinel;
  pen.fillStyle = computed; // ignored when the canvas cannot read it
  if (pen.fillStyle === sentinel) return null;
  pen.fillRect(0, 0, 1, 1);
  const [r, g, b] = pen.getImageData(0, 0, 1, 1).data;
  return { r: r!, g: g!, b: b! };
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** Text on `background`: black or white, whichever contrasts more. */
export const inkOn = (background: Rgb) => (contrast(background, WHITE) >= contrast(background, BLACK) ? "#ffffff" : "#000000");

function toHsl({ r, g, b }: Rgb): Hsl {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === rr ? ((gg - bb) / d + 6) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return { h: h * 60, s, l };
}

function fromHsl({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });

// shortcut: the real surface is a CSS variable (bb's or the theme's) the maths cannot read; these stand
// in for a light and a dark card. Read the computed surface colour if a theme's ever strays far from them.
export const SURFACE: Record<Mode, Rgb> = { light: WHITE, dark: { r: 30, g: 30, b: 30 } };
/** The contrast a chart mark keeps against the surface: WCAG's figure for graphics. */
export const MARK_CONTRAST = 3;
/** The least a published palette's colour keeps: below it, a mark all but vanishes. */
const PALETTE_CONTRAST = 2;

/** The colour, lightened on a dark surface or darkened on a light one, just enough to reach `min` against it. */
export function forMarks(colour: Rgb, mode: Mode, min = MARK_CONTRAST): Rgb {
  const hsl = toHsl(colour);
  let out = { ...colour };
  while (contrast(out, SURFACE[mode]) < min && (mode === "dark" ? hsl.l < 1 : hsl.l > 0)) {
    hsl.l = Math.min(1, Math.max(0, hsl.l + (mode === "dark" ? 0.02 : -0.02)));
    out = fromHsl(hsl);
  }
  return out;
}

const GOLDEN_ANGLE = 137.508;

/**
 * Eight series colours from the accent: the accent itself (made legible), then seven hues a golden
 * angle apart from it, so every prefix of the set is spread round the wheel, at one shared saturation
 * and a lightness that alternates a little, each made legible against the mode's surface.
 */
export function palette(accent: Rgb, mode: Mode): string[] {
  const { h, s } = toHsl(accent);
  const saturation = Math.min(0.8, Math.max(0.5, s)); // a grey accent still gives distinct series
  const rest = Array.from({ length: 7 }, (_, i) => {
    const l = (mode === "dark" ? 0.62 : 0.42) + (i % 2 === 0 ? 0.06 : -0.04);
    return toHex(forMarks(fromHsl({ h: (h + GOLDEN_ANGLE * (i + 1)) % 360, s: saturation, l }), mode));
  });
  return [toHex(forMarks(accent, mode)), ...rest];
}

/** Nine steps from near the surface to the accent and a little past it, for heatmaps and treemaps (lowest first). */
export function ramp(accent: Rgb, mode: Mode): string[] {
  const end = forMarks(accent, mode);
  const far = mode === "dark" ? WHITE : BLACK;
  return Array.from({ length: 9 }, (_, i) => toHex(i < 7 ? mix(SURFACE[mode], end, (i + 1) / 7) : mix(end, far, (i - 6) * 0.2)));
}

export const SWATCHES = [
  { name: "Blue", hex: "#2f6fde" },
  { name: "Teal", hex: "#0d9488" },
  { name: "Green", hex: "#2f9e44" },
  { name: "Amber", hex: "#d97706" },
  { name: "Orange", hex: "#e8590c" },
  { name: "Red", hex: "#e03131" },
  { name: "Pink", hex: "#d6336c" },
  { name: "Purple", hex: "#7048e8" },
] as const;

/**
 * Fixed palettes that stay apart for the common kinds of colour blindness, as published, except: grey
 * in place of Okabe–Ito's black (lost on a dark surface), and a darker grey as Tol bright's eighth.
 */
export const PALETTES = {
  "okabe-ito": { name: "Okabe–Ito", colours: ["#0072b2", "#e69f00", "#009e73", "#cc79a7", "#56b4e9", "#d55e00", "#f0e442", "#999999"] },
  "tol-bright": { name: "Tol bright", colours: ["#4477aa", "#ee6677", "#228833", "#ccbb44", "#66ccee", "#aa3377", "#bbbbbb", "#777777"] },
} as const;
export type ChartChoice = "accent" | keyof typeof PALETTES;
const CHARTS: Record<ChartChoice, string> = { accent: "From the accent", "okabe-ito": PALETTES["okabe-ito"].name, "tol-bright": PALETTES["tol-bright"].name };

/** What the viewer chose; a field left out keeps what the dashboard has. */
export type Choices = { accent?: string; charts?: ChartChoice; look?: Mode };

/** Stored choices are untrusted: each field is kept only when valid, anything else is dropped. */
export function readChoices(raw: unknown): Choices {
  const value = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const accent = parseHex(value.accent);
  const charts = typeof value.charts === "string" && Object.hasOwn(CHARTS, value.charts) ? (value.charts as ChartChoice) : undefined;
  const look = value.look === "light" || value.look === "dark" ? value.look : undefined;
  return { ...(accent && { accent: toHex(accent) }), ...(charts && { charts }), ...(look && { look }) };
}

/**
 * The dashboard tokens the choices set for one mode, and only those: the accent (made legible against
 * the surface: a white accent on light would hide focus rings), the text on it and
 * the sequential ramp from an accent; the eight series from a fixed palette or, by default, from the accent.
 * A fixed palette keeps its published colours unless one would all but vanish into the surface
 * (Okabe–Ito's yellow on light), which is then darkened just enough.
 */
export function viewerTokens(choices: Choices, mode: Mode): Record<string, string> {
  const tokens: Record<string, string> = {};
  const accent = parseHex(choices.accent);
  if (accent) {
    const legible = forMarks(accent, mode); // the library draws focus rings and selections in it too
    tokens.accent = toHex(legible);
    tokens.accentInk = inkOn(legible);
    ramp(accent, mode).forEach((colour, i) => {
      tokens[`seq${i + 1}`] = colour;
      tokens[`seqInk${i + 1}`] = inkOn(parseHex(colour)!);
    });
  }
  const fixed = choices.charts && choices.charts !== "accent" ? PALETTES[choices.charts].colours : null;
  const series = fixed ? fixed.map((c) => toHex(forMarks(parseHex(c)!, mode, PALETTE_CONTRAST))) : accent ? palette(accent, mode) : [];
  series.forEach((colour, i) => (tokens[`series${i + 1}`] = colour));
  return tokens;
}

/** Choices stay in this browser's localStorage, one entry per dashboard beside its remembered values, at most this many characters. */
const CHOICES_CAP = 500;
export const coloursKey = (pluginId: string, id: string) => `${pluginId}:colours:${id}`;

export function loadChoices(key: string): Choices {
  try {
    return readChoices(JSON.parse(localStorage.getItem(key) ?? "{}"));
  } catch {
    return {}; // unreadable or blocked storage: the dashboard's own colours
  }
}

export function saveChoices(key: string, choices: Choices) {
  try {
    const json = JSON.stringify(choices);
    if (json === "{}") localStorage.removeItem(key);
    else if (json.length <= CHOICES_CAP) localStorage.setItem(key, json);
  } catch {
    // storage full or blocked: the choices last until the view closes
  }
}

const nameOf = (hex: string | undefined) => (hex === undefined ? undefined : (SWATCHES.find((s) => s.hex === hex)?.name ?? `custom ${hex}`));
const button = "rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent";
/** One box for every control in a dashboard's header (Edit, Colours, the script badge, the version list), so they line up. */
export const CONTROL = "inline-flex h-6 items-center rounded-md border border-border px-2 text-xs leading-none hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50";

/** The header's Colours button and its popover. Every pick applies at once; Reset forgets them all. */
export function ColourControl({ choices, onChange }: { choices: Choices; onChange: (next: Choices) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const popover = useId();
  const group = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => box.current?.contains(e.target as Node) || setOpen(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !open) return;
    e.preventDefault(); // bb's own Escape (back to the app) is for when nothing of ours is open
    e.stopPropagation();
    setOpen(false);
    trigger.current?.focus();
  };
  const set = (patch: Choices) => onChange(readChoices({ ...choices, ...patch }));
  const summary = [
    `Accent: ${nameOf(choices.accent) ?? "the dashboard's own"}.`,
    `Chart colours: ${choices.charts ? CHARTS[choices.charts] : CHARTS.accent}${!choices.accent && (choices.charts ?? "accent") === "accent" ? " (the dashboard's own until you pick an accent)" : ""}.`,
    `Look: ${choices.look ?? "follows bb"}.`,
  ].join(" ");

  return (
    <div ref={box} className="relative flex" onKeyDown={onKeyDown}>
      <button ref={trigger} type="button" className={CONTROL} aria-haspopup="dialog" aria-expanded={open} aria-controls={popover} onClick={() => setOpen(!open)}>
        Colours
      </button>
      {open && (
        <div id={popover} role="dialog" aria-label="Dashboard colours" className="bbd-pop absolute right-0 top-full z-40 mt-1 w-64 space-y-3 rounded-md border border-border bg-background p-3 text-xs text-foreground shadow-lg">
          <div role="group" aria-labelledby={`${group}-accent`} className="space-y-1.5">
            <p id={`${group}-accent`} className="font-medium">
              Accent
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {SWATCHES.map((s) => (
                <button key={s.hex} type="button" className="bbd-swatch" aria-label={s.name} title={s.name} aria-pressed={choices.accent === s.hex} style={{ background: s.hex }} onClick={() => set({ accent: s.hex })} />
              ))}
              <label className="flex items-center gap-1 text-muted-foreground" title="Custom colour">
                <input type="color" className="bbd-swatch bbd-swatch-custom" aria-label="Custom accent colour" value={choices.accent ?? "#7f7f7f"} onChange={(e) => set({ accent: e.target.value })} />
                Custom
              </label>
            </div>
          </div>
          <fieldset className="space-y-1">
            <legend className="mb-1 font-medium">Chart colours</legend>
            {(Object.keys(CHARTS) as ChartChoice[]).map((key) => (
              <label key={key} className="flex items-center gap-2">
                <input type="radio" name={`${group}-charts`} checked={(choices.charts ?? "accent") === key} onChange={() => set({ charts: key === "accent" ? undefined : key })} />
                <span className="flex-1">{CHARTS[key]}</span>
                {key !== "accent" && (
                  <span className="flex" aria-hidden="true">
                    {PALETTES[key].colours.map((c) => (
                      <span key={c} className="size-2.5" style={{ background: c }} />
                    ))}
                  </span>
                )}
              </label>
            ))}
          </fieldset>
          <fieldset className="space-y-1">
            <legend className="mb-1 font-medium">Look of this dashboard</legend>
            {([undefined, "light", "dark"] as const).map((look) => (
              <label key={look ?? "bb"} className="flex items-center gap-2">
                <input type="radio" name={`${group}-look`} checked={choices.look === look} onChange={() => set({ look })} />
                {look === undefined ? "Follow bb" : look === "light" ? "Light" : "Dark"}
              </label>
            ))}
          </fieldset>
          <div className="flex items-center justify-between gap-2">
            <button type="button" className={button} onClick={() => onChange({})}>
              Reset
            </button>
            <span className="text-muted-foreground">Kept in this browser only</span>
          </div>
          <p role="status" className="text-muted-foreground">
            {summary}
          </p>
        </div>
      )}
    </div>
  );
}
