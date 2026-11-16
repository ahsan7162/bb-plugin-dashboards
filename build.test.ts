// What `bb plugin build` wrote (npm test builds first): a production app bundle with no OpenUI
// devtools, no katex fonts, no network calls and no MCP client; React from bb, not bundled; no React on
// the server, which bundles the MCP SDK (the one dependency added for connections).
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const read = (file: string) => readFileSync(new URL(`./dist/${file}`, import.meta.url), "utf8");

test("app bundle", () => {
  const app = read("app.js");
  expect(app).not.toMatch(/devtools|cdn\.jsdelivr\.net/); // react-lang's development mode loads devtools from a CDN
  expect(app).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|new WebSocket|EventSource/);
  expect(app + read("app.css")).not.toMatch(/KaTeX_/);
  expect(JSON.parse(read("app.meta.json")).runtimeSlots).toEqual(expect.arrayContaining(["react", "reactDom"]));
  expect(app).not.toMatch(/notifications\/initialized|modelcontextprotocol/);
});

test("server bundle", () => {
  const server = read("server.js");
  expect(server).not.toMatch(/from\s*"react|require\("react/);
  // lang-core's parser carries usage telemetry that runs only with OPENUI_RUNTIME_TELEMETRY_ENABLED
  // set (and neither DO_NOT_TRACK nor OPENUI_TELEMETRY_DISABLED); it is the only direct fetch( call.
  expect(server.match(/fetch\(/g)).toHaveLength(1);
  expect(server).toContain("OPENUI_RUNTIME_TELEMETRY_ENABLED");
  // The MCP SDK is bundled: its client handshake and its streamable HTTP transport, whose fetch calls
  // (written as `(this._fetch??fetch)(`) reach only a web connection's own address. Its OAuth code is
  // bundled too but runs only with an auth provider, which the plugin never passes.
  expect(server).toContain("notifications/initialized");
  expect(server).toContain("Streamable HTTP error");
});
