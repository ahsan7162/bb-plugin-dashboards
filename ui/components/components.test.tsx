// @vitest-environment jsdom
// The plugin's own components, each rendered from an OpenUI Lang program through Renderer with the
// merged library that ships. Mounted with bb's renderSlot so the SDK's Markdown and UrlLink work.
import { readFileSync } from "node:fs";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { Renderer, type ActionEvent } from "@openuidev/react-lang";
import { ThemeProvider } from "@openuidev/dashboard-library";
import { EXAMPLES } from "../../server/generated";
import { library } from "../library";
import { BOOT, FRAME_CSP, MESSAGE, RELAY, WRAPPER_CSP, innerDocument, wrapperDocument } from "./frame";

function Harness({ program, onAction, mode }: { program: string; onAction?: (event: ActionEvent) => void; mode?: "light" | "dark" }) {
  return (
    <ThemeProvider mode={mode}>
      <Renderer response={program} library={library} onAction={onAction} />
    </ThemeProvider>
  );
}

function show(program: string) {
  const actions: ActionEvent[] = [];
  const slot = renderSlot({ component: Harness }, { program, onAction: (e) => actions.push(e) }, { openUrl: () => true });
  return Object.assign(slot, { actions });
}

/** A program whose one Section holds `rows`, plus a Card that shows `readout` (an expression) as text. */
const page = (state: string, rows: string, readout = `""`, data = "") =>
  `root = Dashboard([main])\n${state}\nmain = Section("Page", [${rows}, Row([Card("Readout", [KeyValues([KeyValue("Now", ${readout})])], "full")])])${data ? `\n${data}` : ""}`;
const readout = (slot: ReturnType<typeof show>) => slot.getByText("Now").closest("div")!.parentElement!.textContent!.replace("Now", "");

describe("Tabs and Tab", () => {
  const program = page(`$tab = "Overview"`, `Tabs([Tab("Overview", [Callout("Overview body")]), Tab("Errors", [Callout("Errors body")])], $tab)`, "$tab");

  test("shows one tab; a click switches it and writes its label to the bound $variable", async () => {
    const slot = show(program);
    expect(await slot.findByText("Overview body")).toBeTruthy();
    expect(slot.queryByText("Errors body")).toBeNull();
    const [overview, errors] = slot.getAllByRole("tab");
    expect(overview!.getAttribute("aria-selected")).toBe("true");
    expect(slot.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(overview!.id);

    fireEvent.click(errors!);
    expect(await slot.findByText("Errors body")).toBeTruthy();
    expect(slot.queryByText("Overview body")).toBeNull();
    expect(errors!.getAttribute("aria-selected")).toBe("true");
    expect(readout(slot)).toBe("Errors");
  });

  test("arrow keys, Home and End move between tabs with a roving tabindex", async () => {
    const slot = show(program);
    await slot.findByText("Overview body");
    const [overview, errors] = slot.getAllByRole("tab");
    expect([overview!.tabIndex, errors!.tabIndex]).toEqual([0, -1]);
    fireEvent.keyDown(overview!, { key: "ArrowRight" });
    expect(await slot.findByText("Errors body")).toBeTruthy();
    expect(document.activeElement).toBe(errors);
    expect([overview!.tabIndex, errors!.tabIndex]).toEqual([-1, 0]);
    fireEvent.keyDown(errors!, { key: "ArrowRight" }); // wraps
    expect(await slot.findByText("Overview body")).toBeTruthy();
    fireEvent.keyDown(overview!, { key: "End" });
    expect(await slot.findByText("Errors body")).toBeTruthy();
  });

  test("works without a $variable, and a null list of tabs draws nothing", async () => {
    const slot = show(page("", `Tabs([Tab("A", [Callout("A body")]), Tab("B", [Callout("B body")])]), Tabs(missing.tabs)`, `""`, "missing = {tabs: null}"));
    fireEvent.click(await slot.findByRole("tab", { name: "B" }));
    expect(await slot.findByText("B body")).toBeTruthy();
    expect(slot.getAllByRole("tablist")).toHaveLength(1);
  });
});

describe("RecordList, Record and Drawer: the drill-down", () => {
  const program = `root = Dashboard([main])
$selected = ""
main = Section("Orders", [Row([Card("Orders", [RecordList(@Each(rows, "r", Record(r.id, r.title, r.status, r.owner, r.age, r.link)), $selected, {"Late": "bad"})], "full")]), details, Row([Card("Readout", [KeyValues([KeyValue("Now", "[" + $selected + "]")])], "full")])])
details = Drawer("Order " + picked.id, $selected, [KeyValues([KeyValue("Customer", picked.customer)])])
picked = @First(@Filter(rows, "id", "==", $selected))
rows = [{id: "A-1001", title: "Corner Bakery order", status: "Late", owner: "Kim", age: "2d", customer: "Corner Bakery", link: "https://shop.example.com/A-1001"}, {id: 1002, title: "Blue Kettle Cafe order", status: "Packed", customer: "Blue Kettle Cafe", link: "javascript:alert(1)"}]`;

  test("click a Record: the Drawer shows its details; close clears the $variable and the Drawer goes", async () => {
    const slot = show(program);
    const bakery = await slot.findByRole("button", { name: /Corner Bakery order/ });
    expect(slot.container.querySelector(".bbd-drawer")).toBeNull(); // library Cards are regions too
    expect(bakery.getAttribute("aria-pressed")).toBe("false");
    expect(slot.getByText("Late").getAttribute("data-tone")).toBe("bad");
    expect(slot.getByText("Packed").getAttribute("data-tone")).toBe("neutral");

    bakery.focus(); // a browser focuses a clicked button; jsdom's click does not
    fireEvent.click(bakery);
    const drawer = await slot.findByRole("region", { name: "Order A-1001" });
    expect(drawer.textContent).toContain("Corner Bakery");
    expect(bakery.getAttribute("aria-pressed")).toBe("true");
    expect(readout(slot)).toBe("[A-1001]");

    fireEvent.click(slot.getByRole("button", { name: "Close Order A-1001" }));
    expect(readout(slot)).toBe("[]");
    expect(bakery.getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(bakery); // focus goes back to the record that opened it
    expect(drawer.getAttribute("data-state")).toBe("closed"); // sliding out, still showing what it showed
    expect(drawer.textContent).toContain("Corner Bakery");
    // jsdom runs no animation (and React listens for a prefixed animationend there): the 400 ms fallback ends it.
    await waitFor(() => expect(slot.container.querySelector(".bbd-drawer")).toBeNull(), { timeout: 1000 });
  });

  test("under reduced motion the Drawer closes at once, with no exit phase", async () => {
    const reduce = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("reduce"), media: query }) as MediaQueryList);
    try {
      const slot = show(program);
      fireEvent.click(await slot.findByRole("button", { name: /Corner Bakery order/ }));
      fireEvent.click(await slot.findByRole("button", { name: "Close Order A-1001" }));
      expect(slot.container.querySelector(".bbd-drawer")).toBeNull();
    } finally {
      reduce.mockRestore();
    }
  });

  test("a numeric id is written as a number, so @Filter finds the row; picking again clears it; Escape closes", async () => {
    const slot = show(program);
    const kettle = await slot.findByRole("button", { name: /Blue Kettle Cafe order/ });
    fireEvent.click(kettle);
    const drawer = await slot.findByRole("region", { name: "Order 1002" });
    expect(drawer.textContent).toContain("Blue Kettle Cafe");
    fireEvent.click(kettle);
    expect(readout(slot)).toBe("[]");
    fireEvent.click(kettle);
    fireEvent.keyDown(await slot.findByRole("region", { name: "Order 1002" }), { key: "Escape" });
    expect(readout(slot)).toBe("[]");
  });

  test("a Record's link opens only http(s), next to the pick button, through bb's openUrl", async () => {
    const slot = show(program);
    const link = await slot.findByRole("link", { name: "Open Corner Bakery order" });
    expect(link.getAttribute("href")).toBe("https://shop.example.com/A-1001");
    expect(link.closest("button")).toBeNull();
    fireEvent.click(link);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "openUrl", url: "https://shop.example.com/A-1001" }]);
    expect(slot.queryByRole("link", { name: "Open Blue Kettle Cafe order" })).toBeNull(); // javascript: is not a link
  });

  test("a null list draws a quiet line; a Drawer without a $variable value stays shut", async () => {
    const slot = show(`root = Dashboard([main])\nmain = Section("x", [Row([Card("c", [RecordList(none.rows), Drawer("Never", "", [Markdown("hidden")])])])])\nnone = {rows: null}`);
    expect(await slot.findByText("No items.")).toBeTruthy();
    expect(slot.queryByText("hidden")).toBeNull();
  });
});

describe("SearchBox, Toggle and Slider", () => {
  test("SearchBox writes what is typed; a RecordList filtered on it follows", async () => {
    const slot = show(
      page(`$q = ""`, `Row([Card("Shops", [SearchBox($q, "Search shops"), RecordList(@Each(@Filter(rows, "title", "contains", $q), "r", Record(r.id, r.title)))], "full")])`, "$q", `rows = [{id: 1, title: "Corner Bakery"}, {id: 2, title: "Hilltop Florist"}]`),
    );
    const box = await slot.findByRole("searchbox", { name: "Search shops" });
    expect(slot.getByText("Hilltop Florist")).toBeTruthy();
    fireEvent.change(box, { target: { value: "Bakery" } });
    await waitFor(() => expect(slot.queryByText("Hilltop Florist")).toBeNull());
    expect(slot.getByText("Corner Bakery")).toBeTruthy();
    expect(readout(slot)).toBe("Bakery");
  });

  test("Toggle is a switch; a ternary on its $variable follows", async () => {
    const slot = show(page(`$failing = false`, `Toggle($failing, "Only failing")`, `$failing ? "only failing" : "all"`));
    const toggle = await slot.findByRole("switch", { name: "Only failing" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(readout(slot)).toBe("all");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(readout(slot)).toBe("only failing");
  });

  test("Slider writes a number within min and max", async () => {
    const slot = show(page(`$top = 5`, `Slider($top, "Show top", 3, 20, 1)`, `$top * 2`));
    const slider = await slot.findByRole("slider", { name: "Show top" });
    expect([slider.getAttribute("min"), slider.getAttribute("max"), slider.getAttribute("step"), (slider as HTMLInputElement).value]).toEqual(["3", "20", "1", "5"]);
    fireEvent.change(slider, { target: { value: "12" } });
    expect(readout(slot)).toBe("24");
  });

  test("each keeps state of its own when given a plain value instead of a $variable", async () => {
    const slot = show(page("", `Toggle(false, "One"), Toggle(false, "Two"), SearchBox("", "Find"), Slider(4, "Size", 1, 9)`));
    fireEvent.click(await slot.findByRole("switch", { name: "One" }));
    expect(slot.getByRole("switch", { name: "One" }).getAttribute("aria-checked")).toBe("true");
    expect(slot.getByRole("switch", { name: "Two" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.change(slot.getByRole("searchbox", { name: "Find" }), { target: { value: "abc" } });
    expect((slot.getByRole("searchbox", { name: "Find" }) as HTMLInputElement).value).toBe("abc");
    fireEvent.change(slot.getByRole("slider", { name: "Size" }), { target: { value: "7" } });
    expect((slot.getByRole("slider", { name: "Size" }) as HTMLInputElement).value).toBe("7");
  });
});

describe("Badge, LinkOut, Markdown, Callout, Empty", () => {
  test("Badge is a coloured word", async () => {
    const slot = show(page("", `Row([Card("c", [Badge("Critical", "bad"), Badge("Plain")])])`));
    expect((await slot.findByText("Critical")).getAttribute("data-tone")).toBe("bad");
    expect(slot.getByText("Plain").getAttribute("data-tone")).toBe("neutral");
  });

  test("LinkOut opens http(s) through bb's openUrl; any other scheme is plain text", async () => {
    const slot = show(page("", `Row([Card("c", [LinkOut("Issue tracker", "https://tracker.example.com/T-1"), LinkOut("Sneaky", bad), LinkOut("Data", "data:text/html,hi")])])`, `""`, `bad = "javascript:alert(1)"`));
    const link = await slot.findByRole("link", { name: /Issue tracker/ });
    expect(link.getAttribute("href")).toBe("https://tracker.example.com/T-1");
    fireEvent.click(link);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "openUrl", url: "https://tracker.example.com/T-1" }]);
    for (const name of ["Sneaky", "Data"]) {
      expect(slot.getByText(name).tagName).toBe("SPAN");
      expect(slot.getByText(name).closest("a")).toBeNull();
    }
  });

  test("Markdown goes through bb's own Markdown component", async () => {
    const slot = show(page("", `Markdown("Checkout errors **doubled** on Tuesday.")`));
    expect((await slot.findByTestId("bb-markdown")).textContent).toBe("Checkout errors **doubled** on Tuesday.");
  });

  test("Callout is a note with a tone and an optional title; Empty gives its reason", async () => {
    const slot = show(page("", `Callout("Two regions report late.", "warning", "Late data"), Callout("Plain note"), Empty("No open incidents", "Nothing failed today.")`));
    const [warning, plain] = await slot.findAllByRole("note");
    expect(warning!.getAttribute("data-tone")).toBe("warning");
    expect(warning!.textContent).toContain("Late data");
    expect(plain!.getAttribute("data-tone")).toBe("info");
    expect(slot.getByText("No open incidents")).toBeTruthy();
    expect(slot.getByText("Nothing failed today.")).toBeTruthy();
  });
});

describe("Frame", () => {
  const program = (data: string) => page(`$n = 1`, `Frame("Sparkline", "<div id='out'></div><script>addEventListener('framedata', e => out.textContent = e.detail.n)</script>", ${data}, 120), Slider($n, "N", 1, 9)`);
  const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
  const THEME = { "color-scheme": "dark", "--ink": "#eee" };

  test('two levels, each exactly sandbox="allow-scripts" with its CSP first; the wrapper adds frame-src \'none\' and holds only our code', async () => {
    const slot = show(program(`{n: $n}`));
    const outer = (await slot.findByTitle("Sparkline")) as HTMLIFrameElement;
    expect(outer.getAttribute("sandbox")).toBe("allow-scripts");
    expect(outer.style.height).toBe("120px");

    const wrapper = parse(outer.getAttribute("srcdoc")!);
    expect(wrapper.head.firstElementChild!.outerHTML).toBe(`<meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}">`);
    expect(WRAPPER_CSP).toBe(`${FRAME_CSP}; frame-src 'none'`);
    const frames = wrapper.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.getAttributeNames().sort()).toEqual(["id", "sandbox", "srcdoc", "title"]);
    expect(frames[0]!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(Array.from(wrapper.querySelectorAll("script"), (el) => el.textContent)).toEqual([RELAY]);
    expect(wrapper.body.textContent).not.toContain("framedata"); // the program's HTML is only inside srcdoc

    const inner = parse(frames[0]!.getAttribute("srcdoc")!);
    expect(inner.head.firstElementChild!.outerHTML).toBe(`<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`);
    expect(FRAME_CSP).toMatch(/^default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;/);
    expect(inner.querySelector("script")!.textContent).toBe(BOOT);
    expect(inner.querySelector("#out")).not.toBeNull();
  });

  test("the program's HTML cannot break out of srcdoc: quotes, </iframe>, </script> and &quot; stay inside", () => {
    const html = `<p title="a" data-x='b'>&quot;quoted&quot; &amp; done</p></iframe></script><script>parent.parent.postMessage("x", "*")</script><iframe srcdoc="<b>x</b>"></iframe>"'>`;
    const wrapper = parse(wrapperDocument(html, THEME, 240, `A "title" </iframe>`));
    expect(wrapper.querySelectorAll("iframe")).toHaveLength(1);
    expect(Array.from(wrapper.querySelectorAll("script"), (el) => el.textContent)).toEqual([RELAY]);
    const frame = wrapper.querySelector("iframe")!;
    expect(frame.getAttribute("srcdoc")).toBe(innerDocument(html, THEME)); // round-trips exactly
    expect(frame.getAttribute("title")).toBe(`A "title" </iframe>`);
    expect(innerDocument(html, THEME)).toContain(html);
    expect(parse(innerDocument(html, THEME)).querySelector("p")!.textContent).toBe(`"quoted" & done`);
  });

  test("data and theme are posted in on load; new data goes in again with no reload", async () => {
    const slot = show(program(`{n: $n}`));
    const frame = (await slot.findByTitle("Sparkline")) as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: MESSAGE.theme }), "*");
    expect(post).toHaveBeenLastCalledWith({ type: MESSAGE.data, data: { n: 1 } }, "*");
    expect(frame.hasAttribute("data-loaded")).toBe(true);
    const srcdoc = frame.getAttribute("srcdoc");
    fireEvent.change(slot.getByRole("slider", { name: "N" }), { target: { value: "4" } });
    await waitFor(() => expect(post).toHaveBeenLastCalledWith({ type: MESSAGE.data, data: { n: 4 } }, "*"));
    expect(frame.getAttribute("srcdoc")).toBe(srcdoc);
  });

  test("only the wrapper's height and left messages are taken; a blocked navigation shows a note", async () => {
    const slot = show(program(`null`));
    const frame = (await slot.findByTitle("Sparkline")) as HTMLIFrameElement;
    const send = (data: unknown, source: MessageEventSource | null) => act(() => void window.dispatchEvent(new MessageEvent("message", { data, source })));
    send({ type: MESSAGE.height, height: 300 }, window); // another window: ignored
    send({ type: MESSAGE.left }, window);
    expect(frame.style.height).toBe("120px");
    expect(frame.isConnected).toBe(true);
    send({ type: MESSAGE.height, height: "300" }, frame.contentWindow); // not a number: ignored
    expect(frame.style.height).toBe("120px");
    send({ type: MESSAGE.height, height: 310.2 }, frame.contentWindow);
    expect(frame.style.height).toBe("311px");
    send({ type: MESSAGE.height, height: 1e9 }, frame.contentWindow);
    expect(frame.style.height).toBe("4000px");
    send({ type: MESSAGE.left }, frame.contentWindow);
    expect((await slot.findByText("This frame tried to leave the page and was stopped.")).getAttribute("role")).toBe("status");
    expect(slot.queryByTitle("Sparkline")).toBeNull();
  });

  test("follows the dashboard's mode: written into both documents, then updated by message without a reload", async () => {
    const slot = show(program(`null`));
    const frame = (await slot.findByTitle("Sparkline")) as HTMLIFrameElement;
    const srcdoc = frame.getAttribute("srcdoc")!;
    expect(srcdoc).toContain("html{color-scheme:light}");
    expect(parse(srcdoc).querySelector("iframe")!.getAttribute("srcdoc")).toMatch(/html\{color-scheme:light;[^}]*--ink:[^;]+;[^}]*\}html,body\{[^}]*background:transparent/);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    slot.lifecycle.rerender(<Harness program={program(`null`)} mode="dark" />);
    await waitFor(() => expect(post).toHaveBeenCalledWith({ type: MESSAGE.theme, theme: expect.objectContaining({ "color-scheme": "dark" }) }, "*"));
    expect(frame.getAttribute("srcdoc")).toBe(srcdoc);
  });
});

describe("Frame's own scripts, run with fake windows", () => {
  /** The wrapper's relay, with the page, the inner frame and its load event faked. */
  function relay() {
    const listeners: ((e: { data: unknown; source: unknown }) => void)[] = [];
    let load = () => {};
    const inner = { postMessage: vi.fn() };
    const frame = { contentWindow: inner, style: { height: "" }, remove: vi.fn(), addEventListener: (_: string, fn: () => void) => (load = fn) };
    const root = { style: { colorScheme: "" } };
    const page = { postMessage: vi.fn() };
    new Function("document", "parent", "addEventListener", RELAY)({ getElementById: () => frame, documentElement: root }, page, (_: string, fn: (typeof listeners)[number]) => listeners.push(fn));
    const message = (data: unknown, source: unknown) => listeners.forEach((fn) => fn({ data, source }));
    return { inner, frame, root, page, message, load: () => load() };
  }

  test("the relay passes data and theme inward only from the page, and only once the inner frame has loaded", () => {
    const r = relay();
    r.message({ type: MESSAGE.data, data: { n: 1 }, extra: "dropped" }, r.page);
    r.message({ type: MESSAGE.theme, theme: { "color-scheme": "dark" } }, r.page);
    expect(r.inner.postMessage).not.toHaveBeenCalled(); // kept until the inner frame loads
    expect(r.root.style.colorScheme).toBe("dark");
    r.load();
    expect(r.inner.postMessage.mock.calls).toEqual([
      [{ type: MESSAGE.theme, theme: { "color-scheme": "dark" } }, "*"],
      [{ type: MESSAGE.data, data: { n: 1 } }, "*"],
    ]);
    r.message({ type: MESSAGE.data, data: { n: 2 } }, r.inner); // from the inner frame: ignored
    r.message({ type: MESSAGE.data, data: { n: 3 } }, {}); // from any other window: ignored
    r.message("not an object", r.page);
    expect(r.inner.postMessage).toHaveBeenCalledTimes(2);
    r.message({ type: MESSAGE.data, data: { n: 4 } }, r.page);
    expect(r.inner.postMessage).toHaveBeenLastCalledWith({ type: MESSAGE.data, data: { n: 4 } }, "*");
  });

  test("the relay passes only the inner frame's numeric height outward, clamped, and nothing else", () => {
    const r = relay();
    r.load();
    r.message({ type: MESSAGE.height, height: 500 }, r.page); // from the page: ignored
    r.message({ type: MESSAGE.height, height: "500" }, r.inner);
    r.message({ type: MESSAGE.left }, r.inner); // the inner frame cannot claim it left
    r.message({ type: MESSAGE.data, data: 1 }, r.inner);
    expect(r.page.postMessage).not.toHaveBeenCalled();
    r.message({ type: MESSAGE.height, height: 99.5, extra: 1 }, r.inner);
    expect(r.page.postMessage).toHaveBeenLastCalledWith({ type: MESSAGE.height, height: 100 }, "*");
    expect(r.frame.style.height).toBe("100px");
    r.message({ type: MESSAGE.height, height: 1e9 }, r.inner);
    expect(r.page.postMessage).toHaveBeenLastCalledWith({ type: MESSAGE.height, height: 4000 }, "*");
  });

  test("a second load of the inner frame (it navigated) removes it and tells the page; nothing is sent in after", () => {
    const r = relay();
    r.load();
    r.load();
    expect(r.frame.remove).toHaveBeenCalled();
    expect(r.page.postMessage).toHaveBeenLastCalledWith({ type: MESSAGE.left }, "*");
    r.message({ type: MESSAGE.data, data: 1 }, r.page);
    r.message({ type: MESSAGE.height, height: 10 }, r.inner);
    expect(r.inner.postMessage).not.toHaveBeenCalled();
    expect(r.page.postMessage).toHaveBeenCalledTimes(1);
  });

  test("the inner bootstrap takes data and theme only from its parent and reports its content's height", () => {
    const listeners: ((e: { data: unknown; source: unknown }) => void)[] = [];
    const wrapper = { postMessage: vi.fn() };
    const set = vi.fn();
    const root = { style: { setProperty: set }, getBoundingClientRect: () => ({ height: 87 }) };
    const win: Record<string, unknown> = {};
    const events: unknown[] = [];
    let observed: (() => void) | null = null;
    class FakeObserver {
      constructor(fn: () => void) {
        observed = fn;
      }
      observe() {}
    }
    new Function("document", "parent", "window", "addEventListener", "dispatchEvent", "CustomEvent", "ResizeObserver", BOOT)(
      { documentElement: root },
      wrapper,
      win,
      (_: string, fn: (typeof listeners)[number]) => listeners.push(fn),
      (e: { detail: unknown }) => events.push(e.detail),
      class {
        detail: unknown;
        constructor(_: string, init: { detail: unknown }) {
          this.detail = init.detail;
        }
      },
      FakeObserver,
    );
    const message = (data: unknown, source: unknown) => listeners.forEach((fn) => fn({ data, source }));
    message({ type: MESSAGE.data, data: { n: 5 } }, {}); // not from the parent: ignored
    message({ type: MESSAGE.data, data: { n: 6 } }, wrapper);
    message({ type: MESSAGE.theme, theme: { "--ink": "#fff" } }, wrapper);
    expect(win.frameData).toEqual({ n: 6 });
    expect(events).toEqual([{ n: 6 }]);
    expect(set).toHaveBeenCalledWith("--ink", "#fff");
    observed!();
    expect(wrapper.postMessage).toHaveBeenCalledWith({ type: MESSAGE.height, height: 87 }, "*");
  });
});

describe("AskAgent", () => {
  test("raises a continue_conversation action with its message and nothing else", async () => {
    const slot = show(page(`$region = "North"`, `AskAgent("Explain this spike", "Why did errors rise on Tuesday?")`));
    fireEvent.click(await slot.findByRole("button", { name: /Explain this spike/ }));
    expect(slot.actions).toHaveLength(1);
    expect(slot.actions[0]).toMatchObject({ type: "continue_conversation", humanFriendlyMessage: "Why did errors rise on Tuesday?", params: {} });
    expect(slot.inspection.sdkCalls).toEqual([]);
    expect(slot.inspection.navigateCalls).toEqual([]);
  });
});

describe("motion", () => {
  test("a redraw with changed data keeps the same element, so its entrance does not replay", async () => {
    const slot = show(page(`$q = ""`, `SearchBox($q, "Type"), Callout("You typed: " + $q, "info"), Markdown("Also: " + $q), Badge("Seen " + $q)`));
    const callout = await slot.findByRole("note");
    const markdown = slot.getByTestId("bb-markdown").parentElement!;
    const badge = slot.getByText("Seen").closest(".bbd-badge")!;
    fireEvent.change(slot.getByRole("searchbox", { name: "Type" }), { target: { value: "abc" } });
    await waitFor(() => expect(callout.textContent).toContain("You typed: abc"));
    // Same nodes, still in the page: the CSS entrance on .bbd-enter runs only when a node is inserted.
    expect(slot.getByRole("note")).toBe(callout);
    expect(slot.getByTestId("bb-markdown").parentElement).toBe(markdown);
    expect(slot.getByText("Seen abc")).toBe(badge);
    for (const node of [callout, markdown, badge]) expect(node.isConnected && node.classList.contains("bbd-enter")).toBe(true);
  });

  test("switching tabs mounts a new panel (it fades in), while a redraw of the same tab keeps it", async () => {
    const slot = show(page(`$tab = "A"\n$on = false`, `Tabs([Tab("A", [Toggle($on, "Flip"), Callout($on ? "on" : "off")]), Tab("B", [Callout("B body")])], $tab)`));
    const panel = await slot.findByRole("tabpanel");
    fireEvent.click(slot.getByRole("switch", { name: "Flip" }));
    await waitFor(() => expect(panel.textContent).toContain("on"));
    expect(slot.getByRole("tabpanel")).toBe(panel);
    fireEvent.click(slot.getByRole("tab", { name: "B" }));
    await slot.findByText("B body");
    expect(slot.getByRole("tabpanel")).not.toBe(panel);
  });
});

describe("the guide's example (Tabs, RecordList, Drawer, SearchBox) as a model would copy it", () => {
  test("pick a ticket, search, switch tabs", async () => {
    const slot = show(EXAMPLES[3]!);
    fireEvent.click(await slot.findByRole("button", { name: /Cannot change delivery address/ }));
    const drawer = await slot.findByRole("region", { name: "T-1047 · Cannot change delivery address" });
    expect(drawer.textContent).toContain("Blue Kettle Cafe");
    expect(slot.getByText("Asked the customer for the new postcode.")).toBeTruthy(); // the Markdown summary

    fireEvent.change(slot.getByRole("searchbox", { name: "Search titles" }), { target: { value: "Invoice" } });
    await waitFor(() => expect(slot.queryByRole("button", { name: /Refund not received/ })).toBeNull());
    expect(slot.getByRole("button", { name: /Invoice shows the wrong tax rate/ })).toBeTruthy();

    fireEvent.click(slot.getByRole("tab", { name: "Solved" }));
    expect(await slot.findByRole("button", { name: /Order arrived damaged/ })).toBeTruthy();
    expect(slot.queryByRole("button", { name: /Invoice shows the wrong tax rate/ })).toBeNull();
  });
});

describe("links the save check cannot see", () => {
  test("a link computed from parts renders as plain text", async () => {
    const slot = show(page("", `Row([Card("c", [LinkOut("Joined", "java" + "script:alert(1)")])])`));
    expect((await slot.findByText("Joined")).closest("a")).toBeNull();
  });
});

describe("card-fit (styles.css)", () => {
  test("matches a Card holding only these components, not one that also holds a library component or nothing", async () => {
    const css = readFileSync("ui/components/styles.css", "utf8"); // vitest runs from the repo root; import.meta.url is not a file URL under jsdom
    const selector = css.match(/card-fit:[\s\S]*?\*\/\s*([^{]+)\{\s*min-height: auto;/)![1]!.trim();
    const slot = show(`root = Dashboard([Section("x", [Row([Card("Ours", [RecordList([Record("a", "First")]), Empty("None", "Why")]), Card("Mixed", [Badge("x"), KeyValues([KeyValue("k", 1, "number")])]), Card("Bare", [])])])])`);
    const card = async (name: string) => (await slot.findByRole("region", { name })) as HTMLElement;
    expect((await card("Ours")).matches(selector)).toBe(true);
    expect((await card("Mixed")).matches(selector)).toBe(false);
    expect((await card("Bare")).matches(selector)).toBe(false);
  });
});
