// @vitest-environment jsdom
// The viewer's colours: the pure colour maths, then the Colours popover in the dashboard view, in bb's
// frontend harness with the real plugin server in its fake host.
import { fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { FOLDER, PROGRAM, startHost } from "../test/host";
import { MARK_CONTRAST, NEUTRAL_CHROMA, PALETTES, SURFACE, SWATCHES, bbSeries, chroma, contrast, forMarks, inkOn, palette, parseHex, ramp, readChoices, resolveColour, toHex, viewerTokens, type Mode } from "./colours";
import { MESSAGE } from "./components/frame";
import { DashboardsPage } from "./gallery";
import { DashboardTab, DashboardView } from "./panel";

const rgb = (hex: string) => parseHex(hex)!;
const MODES: Mode[] = ["light", "dark"];

describe("colour maths", () => {
  test("parseHex takes #rgb and #rrggbb in any case and nothing else; toHex writes #rrggbb", () => {
    expect(parseHex("#2F6FDE")).toEqual({ r: 47, g: 111, b: 222 });
    expect(parseHex(" #abc ")).toEqual({ r: 170, g: 187, b: 204 });
    for (const junk of ["2f6fde", "#abcd", "#ggg", "#12345", "red", "", "url(x)", null, 42, {}]) expect(parseHex(junk)).toBeNull();
    expect(toHex({ r: 47, g: 111, b: 222 })).toBe("#2f6fde");
    expect(toHex({ r: -4, g: 300, b: 127.6 })).toBe("#00ff80");
  });

  test("contrast is WCAG's ratio, and inkOn picks black or white text by it", () => {
    expect(contrast(rgb("#000"), rgb("#fff"))).toBeCloseTo(21, 5);
    expect(contrast(rgb("#777"), rgb("#777"))).toBe(1);
    expect(contrast(rgb("#767676"), rgb("#fff"))).toBeCloseTo(4.54, 2);
    expect(inkOn(rgb("#f0e442"))).toBe("#000000"); // yellow
    expect(inkOn(rgb("#1f2a6b"))).toBe("#ffffff"); // navy
    expect(inkOn(rgb("#b02525"))).toBe("#ffffff"); // a deep red
    expect(inkOn(rgb("#e03131"))).toBe("#000000"); // a bright red: black has the (slightly) higher contrast, 4.7 to 4.5
    expect(inkOn(rgb("#5fdc8a"))).toBe("#000000"); // a light green
  });

  test("forMarks lightens a too-dark colour on dark, darkens a too-light one on light, and leaves a legible one alone", () => {
    const black = forMarks(rgb("#000000"), "dark");
    expect(contrast(black, SURFACE.dark)).toBeGreaterThanOrEqual(MARK_CONTRAST);
    expect(contrast(black, SURFACE.dark)).toBeLessThan(MARK_CONTRAST + 0.5); // just enough
    const yellow = forMarks(rgb("#f0e442"), "light");
    expect(contrast(yellow, SURFACE.light)).toBeGreaterThanOrEqual(MARK_CONTRAST);
    expect(toHex(forMarks(rgb("#2f6fde"), "light"))).toBe("#2f6fde");
    expect(toHex(forMarks(rgb("#2f6fde"), "dark"))).toBe("#2f6fde");
    expect(toHex(forMarks(rgb("#ffffff"), "dark"))).toBe("#ffffff");
  });

  test.each(["#2f6fde", "#000000", "#ffffff", "#808080", "#f0e442", "#7048e8", "#0d9488"])("palette from %s: eight distinct colours, the accent first, each legible in both modes", (accent) => {
    for (const mode of MODES) {
      const colours = palette(rgb(accent), mode);
      expect(colours).toHaveLength(8);
      expect(new Set(colours).size).toBe(8);
      expect(colours[0]).toBe(toHex(forMarks(rgb(accent), mode)));
      for (const c of colours) expect(contrast(rgb(c), SURFACE[mode]), `${c} in ${mode}`).toBeGreaterThanOrEqual(MARK_CONTRAST);
    }
  });

  test("ramp: nine steps from the surface's side to past the accent, with readable text on each", () => {
    for (const mode of MODES) {
      const steps = ramp(rgb("#2f6fde"), mode).map(rgb);
      expect(steps).toHaveLength(9);
      const distance = steps.map((s) => contrast(s, SURFACE[mode]));
      for (let i = 1; i < 9; i++) expect(distance[i]!).toBeGreaterThan(distance[i - 1]!); // each step further from the surface
      for (const s of steps) expect(contrast(s, rgb(inkOn(s)))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("viewerTokens sets only what was chosen", () => {
    expect(viewerTokens({}, "light")).toEqual({});
    expect(viewerTokens({ look: "dark" }, "dark")).toEqual({});
    const accent = viewerTokens({ accent: "#e03131" }, "light");
    expect(accent).toMatchObject({ accent: "#e03131", accentInk: "#000000", series1: "#e03131" });
    expect(Object.keys(accent).sort()).toEqual(["accent", "accentInk", ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `series${n}`), ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`seq${n}`, `seqInk${n}`])].sort());
    expect(viewerTokens({ accent: "#ffffff" }, "dark")).toMatchObject({ accent: "#ffffff", accentInk: "#000000" });
    const white = viewerTokens({ accent: "#ffffff" }, "light"); // would hide focus rings on a light surface
    expect(contrast(rgb(white.accent!), SURFACE.light)).toBeGreaterThanOrEqual(MARK_CONTRAST);
    expect(white.accentInk).toBe(inkOn(rgb(white.accent!)));
    const fixed = viewerTokens({ charts: "okabe-ito" }, "dark");
    expect(Object.values(fixed)).toEqual(PALETTES["okabe-ito"].colours); // all legible on dark as published
    const onLight = viewerTokens({ charts: "okabe-ito" }, "light");
    expect(Object.values(onLight).filter((c, i) => c !== PALETTES["okabe-ito"].colours[i])).toHaveLength(1); // only the yellow is darkened
  });

  test("readChoices keeps valid fields only", () => {
    expect(readChoices({ accent: "#ABC", charts: "tol-bright", look: "dark" })).toEqual({ accent: "#aabbcc", charts: "tol-bright", look: "dark" });
    expect(readChoices({ accent: "url(x)", charts: "rainbow", look: "sepia", extra: 1 })).toEqual({});
    expect(readChoices({ charts: "toString" })).toEqual({});
    for (const junk of [null, "x", 42, [1, 2], undefined]) expect(readChoices(junk)).toEqual({});
  });
});

// ---- The Colours popover in the dashboard view ----

const FILE = [{ name: "orders", kind: "file", path: "data/orders.json" }];
const LIVE = `root = Dashboard([main])
orders = Query("orders", {}, {rows: []})
first = @First(orders.rows)
main = Section("Orders", [Row([Card("Latest order", [KeyValues([KeyValue("Customer", first.customer)])])])])`;

async function setup() {
  const host = await startHost(async () => (await import("../server")).default, { [`${FOLDER}/data/orders.json`]: JSON.stringify({ rows: [{ id: "A-1001", customer: "Corner Bakery" }] }) });
  const rpc = {
    read: (input: unknown) => host.harness.behavior.callRpc("read", input),
    list: (input: unknown) => host.harness.behavior.callRpc("list", input),
    delete: (input: unknown) => host.harness.behavior.callRpc("delete", input),
    source_run: (input: unknown) => host.harness.behavior.callRpc("source_run", input),
  } as never;
  return { ...host, rpc };
}

type Slot = ReturnType<typeof renderSlot>;
const tab = (slot: { rpc: never }, id: string, options: object = {}) =>
  renderSlot({ component: DashboardTab }, { threadId: "thread-1", environment: null, params: { dashboardId: id } }, { rpc: slot.rpc, ...options });
const provider = (slot: Slot) => slot.container.querySelector<HTMLElement>("[data-dashboard-mode]")!;
const token = (slot: Slot, name: string) => provider(slot).style.getPropertyValue(`--openui-dashboard-${name}`);
const openColours = (slot: Slot) => {
  fireEvent.click(slot.getByRole("button", { name: "Colours" }));
  return slot.getByRole("dialog", { name: "Dashboard colours" });
};
const key = (id: string) => `test-plugin:colours:${id}`;

beforeEach(() => localStorage.clear());

describe("the Colours popover", () => {
  test("a swatch changes the accent, its text and the chart colours at once, and is kept across a remount", async () => {
    const host = await setup();
    const { id } = await host.save({ title: "Corner shop sales", program: PROGRAM });
    const slot = tab(host, id!);
    await slot.findByText("Today");
    const dialog = openColours(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Teal" }));
    expect(token(slot, "accent")).toBe("#0d9488");
    expect(token(slot, "accent-ink")).toBe(inkOn(rgb("#0d9488")));
    expect(token(slot, "series-1")).toBe("#0d9488");
    expect(token(slot, "series-2")).toBe(palette(rgb("#0d9488"), "light")[1]);
    expect(token(slot, "seq-9")).toBe(ramp(rgb("#0d9488"), "light")[8]);
    expect(token(slot, "page")).toBe("var(--background)"); // only what the viewer set changes
    expect(within(dialog).getByRole("button", { name: "Teal" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByRole("status").textContent).toContain("Accent: Teal.");
    expect(JSON.parse(localStorage.getItem(key(id!))!)).toEqual({ accent: "#0d9488" });
    slot.lifecycle.unmount();

    const again = tab(host, id!);
    await again.findByText("Today");
    expect(token(again, "accent")).toBe("#0d9488");
  });

  test("a custom colour from the colour input", async () => {
    const host = await setup();
    const { id } = await host.save({ title: "Corner shop sales", program: PROGRAM });
    const slot = tab(host, id!);
    await slot.findByText("Today");
    const dialog = openColours(slot);
    fireEvent.change(within(dialog).getByLabelText("Custom accent colour"), { target: { value: "#123456" } });
    expect(token(slot, "accent")).toBe("#123456");
    expect(token(slot, "accent-ink")).toBe("#ffffff");
    expect(within(dialog).getByRole("status").textContent).toContain("Accent: custom #123456.");
  });

  test("a fixed palette sets the chart colours without touching the accent; From the accent goes back", async () => {
    const host = await setup();
    const { id } = await host.save({ title: "Corner shop sales", program: PROGRAM });
    const slot = tab(host, id!, { codeTheme: { mode: "dark" } });
    await slot.findByText("Today");
    const dialog = openColours(slot);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Okabe–Ito" }));
    expect([1, 2, 8].map((n) => token(slot, `series-${n}`))).toEqual(["#0072b2", "#e69f00", "#999999"]);
    expect(token(slot, "accent")).toBe("var(--primary)");
    fireEvent.click(within(dialog).getByRole("button", { name: "Purple" }));
    expect(token(slot, "series-1")).toBe("#0072b2"); // the palette stays chosen
    fireEvent.click(within(dialog).getByRole("radio", { name: "From the accent" }));
    expect(token(slot, "series-1")).toBe(palette(rgb("#7048e8"), "dark")[0]);
    expect(JSON.parse(localStorage.getItem(key(id!))!)).toEqual({ accent: "#7048e8" });
  });

  test("the look: against bb's mode, the library's own colours for that mode (literal, so its popovers carry them too)", async () => {
    const host = await setup();
    const { id } = await host.save({ title: "Corner shop sales", program: PROGRAM, theme: { light: { accent: "#1f6f43" } } });
    const slot = tab(host, id!); // bb is in light mode
    await slot.findByText("Today");
    const dialog = openColours(slot);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Dark" }));
    expect(provider(slot).dataset.dashboardMode).toBe("dark");
    expect(provider(slot).style.colorScheme).toBe("dark");
    expect(["page", "surface", "ink", "radius", "accent"].map((name) => token(slot, name))).toEqual(["#141414", "#151515", "#fafafa", "var(--radius)", "#1f6f43"]);
    expect(provider(slot).firstElementChild!.getAttribute("style")).toContain("background: var(--openui-dashboard-page)");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Light" })); // bb's own mode: bb's mapping again
    expect(["page", "surface"].map((name) => token(slot, name))).toEqual(["var(--background)", "var(--card)"]);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Follow bb" }));
    expect(provider(slot).dataset.dashboardMode).toBe("light");
    expect((provider(slot).firstElementChild as HTMLElement).style.background).toBe("");
  });

  test("Reset returns to the dashboard's saved theme, or to bb's when it has none", async () => {
    const host = await setup();
    const { id: themed } = await host.save({ title: "Green shop", program: PROGRAM, theme: { light: { accent: "#1f6f43", series1: "#2a9d8f" } } });
    const { id: plain } = await host.save({ title: "Plain shop", program: PROGRAM });
    for (const [id, accent, series1] of [
      [themed!, "#1f6f43", "#2a9d8f"],
      [plain!, "var(--primary)", "var(--primary)"],
    ] as const) {
      const slot = tab(host, id);
      await slot.findByText("Today");
      const dialog = openColours(slot);
      fireEvent.click(within(dialog).getByRole("button", { name: "Red" }));
      fireEvent.click(within(dialog).getByRole("radio", { name: "Dark" }));
      expect(token(slot, "accent")).toBe("#e03131");
      fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
      expect([token(slot, "accent"), token(slot, "series-1"), provider(slot).dataset.dashboardMode]).toEqual([accent, series1, "light"]);
      expect(localStorage.getItem(key(id))).toBeNull();
      slot.lifecycle.unmount();
    }
  });

  test("choices belong to one dashboard, apply to its old versions too, and go when it is deleted", async () => {
    const host = await setup();
    const { id } = await host.save({ title: "Corner shop sales", program: PROGRAM });
    await host.save({ id, patch: `main = Section("Orders", [Row([Card("Version two", [KeyValues([KeyValue("Orders", 7, "number")])])])])` });
    const { id: other } = await host.save({ title: "Support queue", program: PROGRAM });
    const slot = tab(host, id!);
    await slot.findByText("Version two");
    fireEvent.click(within(openColours(slot)).getByRole("button", { name: "Green" }));
    fireEvent.change(slot.getByLabelText("Version"), { target: { value: "1" } });
    await slot.findByText("Today");
    expect(token(slot, "accent")).toBe("#2f9e44");
    slot.lifecycle.unmount();

    const otherSlot = tab(host, other!);
    await otherSlot.findByText("Today");
    expect(token(otherSlot, "accent")).toBe("var(--primary)");
    otherSlot.lifecycle.unmount();

    localStorage.setItem(`test-plugin:remembered:${id}`, JSON.stringify({ $range: "30d" }));
    const page = renderSlot({ component: DashboardsPage }, { subPath: "" }, { rpc: host.rpc, sdk: { threads: { list: async () => [] as never } } });
    await page.findByText("Corner shop sales");
    fireEvent.click(page.getByRole("button", { name: "Delete Corner shop sales" }));
    fireEvent.click(within(page.getByRole("group")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(page.queryByText("Corner shop sales")).toBeNull());
    expect(localStorage.getItem(key(id!))).toBeNull();
    expect(localStorage.getItem(`test-plugin:remembered:${id}`)).toBeNull();
  });

  test.each([
    ["not JSON", "{oops"],
    ["not an object", "[1, 2]"],
    ["null", "null"],
    ["bad values", JSON.stringify({ accent: "url(https://example.com/x)", charts: "rainbow", look: "sepia" })],
    ["wrong types", JSON.stringify({ accent: 42, charts: ["okabe-ito"], look: true })],
  ])("junk in storage (%s) is ignored", async (_, junk) => {
    const host = await setup();
    const { id } = await host.save({ title: "Corner shop sales", program: PROGRAM });
    localStorage.setItem(key(id!), junk);
    const slot = tab(host, id!);
    expect(await slot.findByText("Today")).toBeTruthy();
    expect([token(slot, "accent"), token(slot, "series-1"), provider(slot).dataset.dashboardMode]).toEqual(["var(--primary)", "var(--primary)", "light"]);
  });

  test("a colour change neither remounts the Renderer nor fetches the data again", async () => {
    const host = await setup();
    const { id } = await host.save({ title: "Orders", program: LIVE, sources: FILE });
    const slot = renderSlot({ component: DashboardView }, { id: id!, threadId: "thread-1", visible: true }, { rpc: host.rpc });
    const shown = await slot.findByText("Corner Bakery");
    const runs = () => slot.inspection.rpcCalls.filter((c) => c.method === "source_run").length;
    expect(runs()).toBe(1);
    const dialog = openColours(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Blue" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: "Tol bright" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: "Dark" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(slot.getByText("Corner Bakery")).toBe(shown); // the same element: nothing was drawn anew
    expect(runs()).toBe(1);
  });

  test("a Frame gets the new colours by message and is not reloaded", async () => {
    const host = await setup();
    const program = `root = Dashboard([main])\nmain = Section("Page", [Frame("Sparkline", "<p>hi</p>", null, 120)])`;
    const { id, error, text } = await host.save({ title: "Framed", program });
    expect(error, text).toBe(false);
    const slot = tab(host, id!);
    const frame = (await slot.findByTitle("Sparkline")) as HTMLIFrameElement;
    fireEvent.load(frame);
    const srcdoc = frame.getAttribute("srcdoc");
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    const dialog = openColours(slot);
    fireEvent.click(within(dialog).getByRole("button", { name: "Teal" }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith({ type: MESSAGE.theme, theme: expect.objectContaining({ "--accent": "#0d9488", "color-scheme": "light" }) }, "*"));
    fireEvent.click(within(dialog).getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith({ type: MESSAGE.theme, theme: expect.objectContaining({ "--accent": "#0d9488", "color-scheme": "dark" }) }, "*"));
    expect(frame.getAttribute("srcdoc")).toBe(srcdoc);
    expect(slot.getByTitle("Sparkline")).toBe(frame);
  });
});

describe("keyboard and announcements", () => {
  test("the button opens a labelled popover; Escape closes it and focus returns to the button", async () => {
    const host = await setup();
    const { id } = await host.save({ title: "Corner shop sales", program: PROGRAM });
    const slot = tab(host, id!);
    await slot.findByText("Today");
    const button = slot.getByRole("button", { name: "Colours" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const dialog = slot.getByRole("dialog", { name: "Dashboard colours" });
    expect(button.getAttribute("aria-controls")).toBe(dialog.id);
    expect(within(dialog).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([...SWATCHES.map((s) => s.name), "Reset"]);
    expect(within(dialog).getByRole("radio", { name: "From the accent" })).toHaveProperty("checked", true);
    expect(within(dialog).getByRole("radio", { name: "Follow bb" })).toHaveProperty("checked", true);
    expect(within(dialog).getByRole("status").textContent).toBe("Accent: the dashboard's own. Chart colours: From the accent (the dashboard's own until you pick an accent). Look: follows bb.");

    const swatch = within(dialog).getByRole("button", { name: "Amber" });
    swatch.focus();
    fireEvent.keyDown(swatch, { key: "Escape" });
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  test("a click outside closes it", async () => {
    const host = await setup();
    const { id } = await host.save({ title: "Corner shop sales", program: PROGRAM });
    const slot = tab(host, id!);
    await slot.findByText("Today");
    openColours(slot);
    fireEvent.pointerDown(slot.getByText("Today"));
    expect(slot.queryByRole("dialog")).toBeNull();
  });
});

// ---- bb's chart series when bb's main colour is a grey ----

// What the browser resolves bb's stock --primary to: oklch(0.82 0 0) in dark mode, oklch(0.27 0 0) in light.
const STOCK_DARK = { r: 196, g: 196, b: 196 };
const STOCK_LIGHT = { r: 38, g: 38, b: 38 };
const TODAY = { series1: "var(--primary)", series2: "var(--timeline-accent)", series3: "var(--pr-merged)", series4: "var(--attention)" };
const BLUE_FIRST = { series1: "var(--timeline-accent)", series2: "var(--pr-merged)", series3: "var(--attention)" }; // series 4 on: the library's

describe("bb's series from its main colour", () => {
  test("chroma is 0 for every grey and well above the threshold for bb's coloured hues", () => {
    for (const grey of [STOCK_DARK, STOCK_LIGHT, rgb("#000"), rgb("#fff"), rgb("#7f7f7f")]) expect(chroma(grey)).toBeLessThan(0.001);
    expect(chroma(rgb("#2f9e44"))).toBeGreaterThan(0.1); // a green theme
    expect(chroma(rgb("#6f8fc0"))).toBeGreaterThan(NEUTRAL_CHROMA); // about bb's blue accent, oklch(0.62 0.08 260)
    expect(chroma(rgb("#828282"))).toBeLessThan(NEUTRAL_CHROMA);
  });

  test.each([
    ["bb's stock dark primary", STOCK_DARK, BLUE_FIRST],
    ["bb's stock light primary", STOCK_LIGHT, BLUE_FIRST],
    ["pure black", rgb("#000000"), BLUE_FIRST],
    ["pure white", rgb("#ffffff"), BLUE_FIRST],
    ["a green theme's primary", rgb("#2f9e44"), TODAY],
    ["an undefined variable (or no canvas to resolve it)", null, TODAY],
  ])("%s", (_, primary, expected) => {
    expect(bbSeries(primary, true)).toEqual(expected);
  });

  test("a grey primary in a theme without --timeline-accent leaves series 1 to the library", () => {
    expect(bbSeries(STOCK_DARK, false)).toEqual({ series2: "var(--pr-merged)", series3: "var(--attention)" });
    expect(bbSeries(rgb("#2f9e44"), false)).toEqual(TODAY);
  });
});

// jsdom has no canvas: a stand-in converts the few computed colours these tests use, as the browser's canvas would.
const CANVAS: Record<string, number[]> = { "oklch(0.82 0 0)": [196, 196, 196], "oklch(0.27 0 0)": [38, 38, 38], "rgb(47, 158, 68)": [47, 158, 68] };
function fakeCanvas() {
  let style = "#000000";
  return {
    get fillStyle() {
      return style;
    },
    set fillStyle(value: string) {
      if (value in CANVAS || value === "#010203") style = value; // anything else is ignored, as a canvas ignores what it cannot read
    },
    fillRect() {},
    getImageData: () => ({ data: Uint8ClampedArray.from([...(CANVAS[style] ?? [1, 2, 3]), 255]) }),
  };
}

describe("bb's series in the view", () => {
  const root = document.documentElement.style;
  beforeEach(() => void vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(fakeCanvas as never));
  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of ["--primary", "--timeline-accent"]) root.removeProperty(name);
  });

  test("resolveColour: the variable as the browser computes it, through a canvas; null when it is not defined", () => {
    root.setProperty("--primary", "oklch(0.82 0 0)");
    expect(resolveColour(document.body, "--primary")).toEqual(STOCK_DARK);
    expect(resolveColour(document.body, "--no-such-colour")).toBeNull();
    root.setProperty("--primary", "#2f9e44"); // hex in, the computed rgb() is what the canvas reads
    expect(resolveColour(document.body, "--primary")).toEqual(rgb("#2f9e44"));
    expect(document.body.children).toHaveLength(0); // the probe is gone
  });

  test("a grey bb primary gives series 1 bb's blue accent; a coloured one keeps it; the accent stays bb's primary", async () => {
    const host = await setup();
    const { id } = await host.save({ title: "Corner shop sales", program: PROGRAM });
    root.setProperty("--timeline-accent", "oklch(0.72 0.09 250)");

    root.setProperty("--primary", "oklch(0.82 0 0)"); // bb's stock dark theme
    const stock = tab(host, id!, { codeTheme: { mode: "dark", name: "stock" } });
    await stock.findByText("Today");
    expect([1, 2, 3].map((n) => token(stock, `series-${n}`))).toEqual(["var(--timeline-accent)", "var(--pr-merged)", "var(--attention)"]);
    expect(token(stock, "series-4")).not.toMatch(/var\(/); // the library's own from here on
    expect(token(stock, "accent")).toBe("var(--primary)"); // focus rings, selections and the Edit outline
    // The viewer's colours still win, and Reset comes back to this.
    const dialog = openColours(stock);
    fireEvent.click(within(dialog).getByRole("button", { name: "Teal" }));
    expect(token(stock, "series-1")).toBe("#0d9488");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    expect(token(stock, "series-1")).toBe("var(--timeline-accent)");
    stock.lifecycle.unmount();

    root.setProperty("--primary", "#2f9e44"); // a green bb theme
    const green = tab(host, id!, { codeTheme: { mode: "dark", name: "green" } });
    await green.findByText("Today");
    expect([1, 2, 3, 4].map((n) => token(green, `series-${n}`))).toEqual(["var(--primary)", "var(--timeline-accent)", "var(--pr-merged)", "var(--attention)"]);
    green.lifecycle.unmount();

    // A dashboard's saved theme still wins over either.
    root.setProperty("--primary", "oklch(0.82 0 0)");
    const { id: themed } = await host.save({ title: "Green shop", program: PROGRAM, theme: { light: { series1: "#2a9d8f" } } });
    const saved = tab(host, themed!, { codeTheme: { mode: "dark", name: "stock" } });
    await saved.findByText("Today");
    expect([1, 2].map((n) => token(saved, `series-${n}`))).toEqual(["#2a9d8f", "var(--pr-merged)"]);
  });
});
