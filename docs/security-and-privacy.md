# Security and privacy

bb Dashboards is read-only by design: a dashboard can show data but has no way to write anywhere, and each path data can take is limited by something specific, listed below. Programs are data, parsed and checked, never run as JavaScript; the only free code a dashboard can hold runs in a sandboxed frame with no network. Secrets live in the operating system's secure store and are never shown to the page or the agent. Scripts are the exception to "the plugin enforces it": an approved script can do whatever its text says, and this page says so plainly. Everything the plugin keeps stays on your machine, and the plugin has no telemetry of its own. This page covers each path, what is stored where, who can call the plugin, outside network calls, and the limits.

## The read-only model

| Path | What stops a write |
| --- | --- |
| The program | The save check refuses `Mutation` in any form. No component submits a form or calls anything; the only actions are opening an `http`/`https` link and sending a message to a thread. |
| Live data from the browser | The browser can only name a declared source of a saved version. The server looks up the declaration, checks the arguments strictly for that kind, and runs it. The browser never sends a path, a command, a tool name or a thread. |
| Built-in sources | Fixed read functions in the plugin: a file read through bb inside the thread's folder (links that lead outside are refused), and the read methods of bb's built-in Git and GitHub pull request status plugins. |
| MCP connections | Only tools the server marks read-only (`readOnlyHint: true`) and that you confirmed can be called, and the mark is checked again at every call. A refused tool is never sent to the server. No setting allows a write tool. |
| Frame | Two nested sandboxed frames with no network and no way to navigate away (below). |
| Scripts | Cannot be enforced by the plugin. The controls are the approval dialog, which makes you read the exact text and flags risky lines, and your choice of read-only commands and credentials. See [scripts.md](scripts.md). |
| Messages to the agent | AskAgent, agent refresh and Edit mode send a message to a thread only when you click. What the agent then does depends on the tools you allow it, as with any message. |

Two honest limits apply to the whole model: an MCP server's read-only mark is that server's own claim, and an approved script can do whatever its text says. Read-only credentials are the real guarantee for both.

## What runs where

- In bb's server process, on the machine bb's server runs on: the save check, the plugin's database, the source reads, the MCP client, script runs and the secure store calls.
- In the browser (bb's window): rendering the program with OpenUI's React renderer, the Frame sandbox, Edit mode, the Colours control and the remembered choices.
- Scripts run as separate processes on the bb server's machine, in the thread's working folder. Local MCP servers run as separate processes there too, with bb's tool path and their own variables only.

## The Frame sandbox

A `Frame` holds HTML, CSS and JavaScript the agent wrote. It runs two frames deep:

- Both frames are sandboxed with `allow-scripts` only. Their origin is opaque, so they cannot reach the page around them, its storage or its cookies, and cannot submit forms, open pop-ups or navigate the top window.
- The inner frame runs the program's HTML under this content security policy: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`. Nothing loads from the network; images work only as `data:` URLs.
- The outer frame holds only the plugin's own code. Its policy adds `frame-src 'none'`, so the inner frame can load its own content and nothing else. If code in the inner frame tries to navigate it to an outside address, the navigation ends on the browser's blocked page with nothing sent, the plugin removes the frame and shows "This frame tried to leave the page and was stopped." (A single frame with the same policy could still navigate itself out, which is why there are two.)
- Data and colours go in, and the content's height comes out, by messages. Every hop checks which window sent a message and its shape, and drops anything else.

This was tested in a real browser: a test dashboard whose frame tries to leave made no outside request, and the frame was replaced by the note.

## Secrets

- Connection tokens, secret variables, secret headers and script secrets are stored only in the operating system's secure store on the bb server's machine, under the service name `bb-dashboards`: the macOS Keychain (tested), Windows Credential Manager or the Linux Secret Service keyring (both untested on a real system).
- The plugin reaches the store through the system's own tool. A secret is passed on standard input, base64-encoded, never on a command line where other programs could see it. Error messages from the store are fixed sentences, so no tool output can carry a secret along.
- The plugin's database holds only which secrets are set, never a value. A value is never sent to the browser, never put in a dashboard, a log or anything the agent sees. Known secret values are replaced by `[secret]` in error messages from servers and scripts.
- Secret fields on the page are write-only: they empty after saving and show only "set" or "not set".
- At run time the server reads the secret and passes it to that one call: as a request header to a web connection, or as an environment variable to a local server or a script.
- A web connection's address must use `https`; plain `http` is accepted only for this machine (`localhost`, `127.0.0.0/8`, `[::1]`). This is checked when a connection is added, when one is imported and again before each use, before its secrets are read, so a token never travels unencrypted to another machine.
- Each secret is at most 2,048 bytes. When the machine has no working secure store, connections that need a secret cannot be added. There is no fallback to a file.
- Removing a connection deletes its secrets. Deleting a dashboard deletes its script secrets. A script secret is deleted by the save that stops naming it.

## What is stored where

Nothing the plugin keeps leaves your machine.

The plugin's own database (bb's per-plugin SQLite database):

| Table | What it holds |
| --- | --- |
| `dashboards` | Each dashboard's id, title, creation and change times, and the ids of the thread, environment and machine it was made in |
| `versions` | The newest 100 versions' program, theme and declared sources (file paths, MCP arguments and full script text included) |
| `agent_data` | The latest result the agent stored for each agent source |
| `connections` | Each connection's name, its command, arguments and plain variables or its address, which of its secrets are set (never the values), and its confirmed tools with their descriptions and input schemas |
| `script_approvals` | Each approval: dashboard, source name, hash, runner, script text, secret names and time |
| `script_secrets` | Which script secret names have a value set, per dashboard (never the values) |

The browser's local storage, on the device where you use bb:

- the `$variable` values you changed (filter, tab and selection choices), one entry per dashboard;
- your Colours choices, one entry per dashboard.

The operating system's secure store: the secret values described above.

Elsewhere: messages the panel sends (AskAgent, agent refresh, Edit mode) become ordinary messages in a bb thread.

Nothing ships with the plugin: no connection, source, dashboard or token is built in, and the plugin declares no settings.

"Find existing servers" reads Claude Code's user config file and a folder's `.mcp.json` only when you click it, and shows only names and kinds. Values are read only when you import one server, on the server side, and secret values go straight to the secure store. Nothing it reads is written into the plugin's files.

## Who can call the plugin's functions

The Dashboards page and the panel talk to the plugin's server through functions (RPC) that bb routes.

- Every function refuses another plugin as the caller, the reading ones included: reading a dashboard can mean running its approved script or a confirmed MCP tool.
- bb reports its own app, its command line and agents as the same kind of caller, so the plugin cannot tell them apart and accepts all three. Anyone who can run bb's command line, including an agent you allow to run shell commands, can therefore call these functions without the page. The approval dialog and the Connections page both say so.
- The agent's own tools cannot add or change connections, confirm tools, approve scripts or delete dashboards.

## Outside network calls

- The plugin has no telemetry of its own and never contacts a server of the plugin's author.
- The plugin's browser code makes no network requests: a test on the built bundle checks that it contains no `fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket` or `EventSource` call, no development tool loaded from a CDN, and no math fonts. Fonts are the system's own.
- The plugin's server contacts only what you connect: the address of a web MCP connection when it is used. Local MCP servers and scripts are processes on your machine and reach whatever they reach. The MCP library's sign-in (OAuth) code is in the bundle but never runs, because the plugin never gives it a sign-in provider.
- The server bundle contains one other outside address: OpenUI's usage report (below), off unless you turn it on.
- A server test saves and reads dashboards, runs sources and fetches topics with the network blocked and records no call. No capture of real network traffic was made.
- Markdown text in a dashboard is drawn by bb's own Markdown renderer. Whether that renderer loads a remote image written into the text was not checked.

## OpenUI's telemetry

The plugin uses OpenUI's `@openuidev/lang-core` to parse programs. That package has its own telemetry, documented in its README:

- An install-time report, sent by an npm install script. It does not run when bb installs the plugin from git, because bb installs with scripts off, and it does not run in this repository, whose `.npmrc` sets `ignore-scripts=true`.
- A runtime report from server-side parsing, which is opt-in: it runs only when the environment of bb's server sets `OPENUI_RUNTIME_TELEMETRY_ENABLED`, and then for a sample of parses. `DO_NOT_TRACK=1` or `OPENUI_TELEMETRY_DISABLED=1` turn it off even then. With the variable unset, the plugin's server contacts nothing for it. The plugin's browser code parses with OpenUI's streaming parser, which does not send this report.

The plugin itself never sets any of these variables.

## Limits, stated plainly

- Approving a script does not sandbox it. It can do what your user account can, including network access and, on macOS, probably reading the plugin's other Keychain entries with the system's own tool. A script that moves itself to another process group can outlive the time limit.
- An agent you allow to run shell commands can approve scripts, add connections and set secrets through bb's command line, without the dialog or the page. It can also run commands directly.
- An MCP server's read-only mark is its own claim.
- An AskAgent button shows its label, while the message it sends was written by the agent that built the dashboard; you see the message once it is in the thread.
- Windows and Linux secure stores are untested on real systems.
- See [limits.md](limits.md) for every other limit.

## Related pages

- [scripts.md](scripts.md): the approval dialog and what approval covers.
- [connections.md](connections.md): the read-only tool filter and where tokens live.
- [architecture.md](architecture.md): how the parts fit together.
- [development.md](development.md#release-checklist): the privacy check before each release.
