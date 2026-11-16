// An invented stdio MCP server for an invented widget shop, for the tests and for trying the plugin by
// hand: `node test/fixtures/mcp-server.mjs`. Five read-only tools, one with no read-only mark and one
// marked as a write tool. Environment variables steer it:
//   FIXTURE_LOG   a file: one JSON line on start (pid, variable names, arguments) and per tool call
//   FIXTURE_PAGE  tools per tools/list page (default: all on one page)
//   FIXTURE_FLIP  a file: while it exists, count_widgets is no longer marked read-only
//   FIXTURE_HANG  "1": never answer, so connecting times out
//   WIDGET_TOKEN  a secret it reports only as set or not, never echoes
import { appendFileSync, existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const env = process.env;
const log = (entry) => env.FIXTURE_LOG && appendFileSync(env.FIXTURE_LOG, `${JSON.stringify(entry)}\n`);
log({ event: "start", pid: process.pid, env: Object.keys(env).sort(), argv: process.argv.slice(2) });

const readOnly = { readOnlyHint: true };
const object = (properties = {}, required = []) => ({ type: "object", properties, required });
const TOOLS = [
  { name: "count_widgets", description: "Counts the widgets of one colour in stock.", inputSchema: object({ colour: { type: "string" } }, ["colour"]), annotations: readOnly },
  { name: "list_orders", description: "Lists open orders, optionally of one status.", inputSchema: object({ status: { type: "string" }, limit: { type: "number" } }), annotations: readOnly },
  { name: "shop_motto", description: "The shop's motto, as plain text.", inputSchema: object(), annotations: readOnly },
  { name: "big_report", description: "A report of about the given size in kilobytes.", inputSchema: object({ kb: { type: "number" } }, ["kb"]), annotations: readOnly },
  { name: "slow_report", description: "Answers after the given number of milliseconds.", inputSchema: object({ ms: { type: "number" } }, ["ms"]), annotations: readOnly },
  { name: "restock_widgets", description: "Orders more widgets.", inputSchema: object() }, // no annotations: a write tool
  { name: "delete_widget", description: "Deletes a widget.", inputSchema: object({ id: { type: "string" } }), annotations: { readOnlyHint: false, destructiveHint: true } },
];
const ORDERS = [
  { id: "W-101", customer: "Corner Bakery", status: "open", widgets: 12 },
  { id: "W-102", customer: "Blue Kettle Cafe", status: "packed", widgets: 4 },
  { id: "W-103", customer: "Hilltop Florist", status: "open", widgets: 30 },
];

const listed = () =>
  TOOLS.map((tool) => (tool.name === "count_widgets" && env.FIXTURE_FLIP && existsSync(env.FIXTURE_FLIP) ? { ...tool, annotations: { readOnlyHint: false } } : tool));
const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

if (env.FIXTURE_HANG === "1") {
  setInterval(() => {}, 60_000); // alive, silent
} else {
  const server = new Server({ name: "invented-widget-shop", version: "0.0.1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
    const tools = listed();
    const size = Number(env.FIXTURE_PAGE) || tools.length;
    const start = Number(params?.cursor ?? 0);
    const next = start + size;
    return { tools: tools.slice(start, next), ...(next < tools.length && { nextCursor: String(next) }) };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
    log({ event: "call", name, args });
    switch (name) {
      case "count_widgets":
        return text({ colour: args.colour, count: args.colour === "teal" ? 42 : 7, tokenSet: Boolean(env.WIDGET_TOKEN) });
      case "list_orders": {
        const rows = ORDERS.filter((o) => !args.status || o.status === args.status).slice(0, args.limit ?? ORDERS.length);
        return { ...text(`${rows.length} orders`), structuredContent: { rows } };
      }
      case "shop_motto":
        return text("Every widget, every colour.");
      case "big_report":
        return text({ filler: "w".repeat(Math.round(args.kb * 1024)) });
      case "slow_report":
        await new Promise((resolve) => setTimeout(resolve, args.ms));
        return text({ done: true });
      case "restock_widgets":
        return text({ restocked: true });
      case "delete_widget":
        return text({ deleted: args.id });
      default:
        return { ...text(`no tool named ${name}`), isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
}
