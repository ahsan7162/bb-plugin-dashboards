// The MCP client side of the plugin's connections: starting a local-command server with an exact
// environment or reaching a web server with its headers, listing tools across pages, and turning a
// tool's result or a failure into a value. What may be called is decided in connections.ts.
import childProcess, { type ChildProcess, type StdioOptions } from "node:child_process";
import { experimental_hostToolchain, experimental_spawnHostProcess } from "@get-bb/plugin-sdk/process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, type CallToolResult, type JSONRPCMessage, type Tool } from "@modelcontextprotocol/sdk/types.js";

export type { Client, Tool };
export type Endpoint = { kind: "stdio"; command: string; args: string[]; env: Record<string, string> } | { kind: "http"; url: string; headers: Record<string, string> };
export type Answer = { ok: true; data: unknown } | { ok: false; error: string };

let refreshed: Promise<void> | undefined;
/** bb's host-toolchain PATH (the user's login-shell PATH, bb's own and the usual tool folders), read once per load. */
export async function hostPath(): Promise<string> {
  await (refreshed ??= experimental_hostToolchain.refresh().catch(() => {}));
  return experimental_hostToolchain.environment().PATH ?? "";
}

/**
 * stdio with exactly the environment given: the SDK's StdioClientTransport always adds HOME, USER,
 * SHELL, LOGNAME and TERM. Spawned with the env's own PATH (Node looks the command up there). stderr is
 * dropped: a server may print anything there, its variables included.
 */
class ProcessTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child: ChildProcess | undefined;
  private readonly buffer = new ReadBuffer();

  constructor(private readonly endpoint: Extract<Endpoint, { kind: "stdio" }>) {}

  start(): Promise<void> {
    const { command, args, env } = this.endpoint;
    const options = { env, stdio: ["pipe", "pipe", "ignore"] as StdioOptions, windowsHide: true };
    return new Promise((resolve, reject) => {
      // On Windows bb's launcher runs .cmd shims such as npx; its Windows environment adds nothing but PATH.
      const child = process.platform === "win32" ? experimental_spawnHostProcess(command, args, options) : childProcess.spawn(command, args, options);
      this.child = child;
      child.once("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.once("spawn", () => resolve());
      child.once("close", () => {
        this.child = undefined;
        this.onclose?.();
      });
      child.stdin!.on("error", (error) => this.onerror?.(error));
      child.stdout!.on("data", (chunk: Buffer) => {
        try {
          this.buffer.append(chunk);
        } catch (error) {
          this.onerror?.(error as Error); // over the SDK's buffer limit
          void this.close();
          return;
        }
        for (;;) {
          let message: JSONRPCMessage | null;
          try {
            message = this.buffer.readMessage(); // drops a line that is not JSON-RPC, then throws
          } catch (error) {
            this.onerror?.(error as Error);
            continue;
          }
          if (message === null) break;
          this.onmessage?.(message);
        }
      });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin) return Promise.reject(new Error("Not connected"));
    return new Promise((resolve) => (stdin.write(serializeMessage(message)) ? resolve() : stdin.once("drain", resolve)));
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.buffer.clear();
    if (!child || child.exitCode !== null) return;
    // MCP's stdio shutdown: end stdin, then SIGTERM, then SIGKILL. Not awaited, so closing stays quick.
    child.stdin?.end();
    const timers = [setTimeout(() => child.kill("SIGTERM"), 1000), setTimeout(() => child.kill("SIGKILL"), 3000)];
    for (const timer of timers) timer.unref();
    child.once("exit", () => timers.forEach(clearTimeout));
  }
}

/** Starts or reaches the server and completes MCP's handshake, within timeoutMs. */
export async function connect(endpoint: Endpoint, timeoutMs: number): Promise<Client> {
  const client = new Client({ name: "bb-dashboards", version: "0.1.0" });
  const transport = endpoint.kind === "stdio" ? new ProcessTransport(endpoint) : new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } });
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpError(ErrorCode.RequestTimeout, "connect timed out")), timeoutMs);
  });
  try {
    await Promise.race([client.connect(transport, { timeout: timeoutMs }), late]);
    return client;
  } catch (cause) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

export const MAX_TOOL_PAGES = 20;

/** Every tool the server lists, following nextCursor; stops on a repeated cursor. */
export async function listTools(client: Client, timeoutMs: number): Promise<Tool[]> {
  const tools: Tool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  // shortcut: past MAX_TOOL_PAGES pages the rest stays unlisted, so those tools can be neither confirmed nor called.
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const answer = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout: timeoutMs });
    tools.push(...answer.tools);
    cursor = answer.nextCursor;
    if (cursor === undefined || seen.has(cursor)) break;
    seen.add(cursor);
  }
  return tools;
}

/** Only an explicit readOnlyHint: true; a tool with no mark counts as a write tool. */
export const isReadOnly = (tool: Tool) => tool.annotations?.readOnlyHint === true;

/** The tool's structured content, else its text parsed as JSON where it parses, else the text. */
export function resultData(result: CallToolResult): Answer {
  const texts = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  if (result.isError) return { ok: false, error: `The tool answered with an error: ${texts.join(" ").slice(0, 300) || "no message"}` };
  if (result.structuredContent !== undefined) return { ok: true, data: result.structuredContent };
  const parsed = texts.map((text) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  });
  if (parsed.length === 0) return { ok: false, error: "The tool returned neither text nor structured content." };
  return { ok: true, data: parsed.length === 1 ? parsed[0] : parsed };
}

const prop = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined);

/** A failure to connect or call, as a sentence. No response body or server output is passed on. */
export function failure(cause: unknown, what: string): string {
  if (cause instanceof McpError && cause.code === ErrorCode.RequestTimeout) return `${what} did not answer in time.`;
  if (cause instanceof McpError && cause.code === ErrorCode.ConnectionClosed) return `${what} closed the connection. Check its command, arguments and variables.`;
  if (cause instanceof StreamableHTTPError && (cause.code === 401 || cause.code === 403)) {
    return `${what} asks for sign-in (HTTP ${cause.code}). Browser sign-in is not supported; if the server takes a token, set it on the Connections page.`;
  }
  if (cause instanceof StreamableHTTPError) return `${what} answered with HTTP ${cause.code}.`;
  const code = prop(cause, "code") ?? prop(prop(cause, "cause"), "code");
  if (code === "ENOENT") return `${what} could not start: the command was not found.`;
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return `${what} could not be reached (${code}).`;
  if (cause instanceof McpError) return `${what} refused the request (MCP error ${cause.code}).`;
  return `${what} failed: ${(cause instanceof Error ? cause.message : String(cause)).slice(0, 200)}`;
}
