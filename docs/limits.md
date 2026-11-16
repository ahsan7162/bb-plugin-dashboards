# Limits and untested areas

This page collects every known limit of bb Dashboards and every part that has not been tested, in one place. Other pages repeat the limits that concern them; this list is the complete one. "Tested" below means one of two things, and each item says which: checked by hand in the real bb app, or covered by the automated test suite only.

## Where it was tested

- Every check in the real bb app was made on macOS, with the Claude Code provider. Windows and Linux were not tried in the real app.
- Only the Claude Code provider was used. Other agent providers are untested, both for token cost and for whether their models write programs that pass the save check.
- Installing from a git source or a marketplace is untested. That path installs dependencies with bb's own npm, with install scripts off and development dependencies left out, and relies on the repository's empty `katex` stand-in package (see [development.md](development.md)). An install into a clean bb profile has not been done either.
- Restoring an old version and the refusal of a remote `http://` address when adding a connection were checked in the real app. Keeping the newest 100 versions, the `https` rule at import and at call time, refusing other plugins and stopping a run when its approval is withdrawn are covered by the test suite only.
- No capture of real network traffic was made. The claims about outside calls come from tests on the built bundles and a server test that saves and reads many dashboards with the network blocked (see [security-and-privacy.md](security-and-privacy.md)).

## Agent providers and token cost

- Token figures were measured with the Claude Code provider only. See [agents.md](agents.md) for the numbers.
- The idle cost was not measured again after the skill's description grew by 29 characters, nor after the rename to bb Dashboards, which changed tool names and descriptions.
- With the Claude Code provider, tool definitions reach the model only when the agent first needs the tools. A provider that sends every tool definition with every request would also pay for the three definitions in each turn. That case was not measured.

## Platforms

- Script sources are not supported on Windows. On Linux they are supported by the code but have not been run.
- Script sources run only on the machine bb's server runs on. A dashboard made in a thread whose environment is on another machine cannot run scripts, and approval is not offered for it.
- Secrets (connection tokens, secret variables, script secrets) need the operating system's secure store. There is no fallback to a file.
  - macOS Keychain: tested for real, by the test suite and in the real app.
  - Windows Credential Manager: untested on a real system. The tests only check the exact commands the plugin would run.
  - Linux Secret Service: untested on a real system, checked the same way. It needs `secret-tool` (from libsecret) and a running keyring such as GNOME Keyring or KWallet.
  - Any other system: no secure store, so connections that need a secret cannot be added there.

## Not supported in this version

- Writing anywhere. A program cannot contain `Mutation`, no component submits a form, and only MCP tools the server marks read-only can be called.
- Exporting a dashboard as a web page, or sharing it with other people.
- Refreshing a dashboard while no one has it open. Nothing runs on a schedule in the background.
- Browser sign-in (OAuth) for the plugin's own MCP connections, the older SSE transport, and servers that get their headers from a helper command.
- Using the agent's own MCP connectors. bb gives plugins no access to them, so the plugin keeps its own connections.
- Clicking a row of a library table or a bar of a library chart. OpenUI's dashboard library does not report those clicks, so drill-down goes through the plugin's RecordList and Drawer (see [components.md](components.md)).
- Restoring an old version from the agent. Old versions are viewed and restored in the panel; the agent's tools read only the latest version.
- Finding a dashboard by title. The agent's tools take a dashboard's id, which is in the card block and in every message the panel sends; there is no agent tool that lists dashboards.
- Editing a connection. Remove it and add it again.
- Running scripts for a thread whose environment is on another machine.

## Validation (the save check)

- OpenUI's parser accepts some malformed text without reporting it, such as a stray line or an extra closing bracket. The save check refuses everything the parser reports, but not what the parser silently accepts.
- A component reached through a name inside a ternary or an `@Each` template is not checked for where it sits. Components written directly are checked.
- An MCP server's read-only mark (`readOnlyHint`) is the server's own claim. The plugin cannot check what a tool really does.

## Data sources

- There is no file watching. A changed file shows on the next timer tick, the next Refresh or the next time the dashboard is opened or shown.
- `git_commits` lists the branch's commits since it left its base branch, because bb offers no general commit log. On the base branch itself there are none.
- The plugin sets no time limit of its own on file, git and pull request reads. MCP calls have time limits (15 s to connect, 10 s to list tools, 20 s for the call); scripts have 20 s.
- The refresh cache and the rate limit live in memory and reset when the plugin reloads.
- A Refresh within 10 seconds of the last answer, with the same arguments, gets the cached answer (30 seconds for a script).
- A failed run is not cached, so it can be retried at once, within the rate limit of 20 runs a minute per dashboard and source. For a script this means a failed run can be retried before the 30-second floor.
- File, git, pull request and script sources read through the thread the dashboard was made in. When that thread is deleted, or its environment folder is gone, they fail with a message.
- Data an agent stores for an agent source is one latest result per source. It is not versioned, so an old version, viewed or restored, shows the latest stored data, not the data it had then. Each result is at most 256 KB.
- Size caps: 12 sources per dashboard, files up to 1 MB, 100 commits, 200 changed files listed (the totals still count every file), MCP results up to 1 MB, script output up to 1 MB.
- Each refresh of an MCP source makes two requests to the server: it lists the tools to check the read-only mark, then calls the tool.
- Tool listings stop after 20 pages. Tools beyond that can be neither confirmed nor called.
- The pull request source depends on bb's built-in GitHub pull request status plugin, and the git sources on bb's built-in Git plugin.
- When the agent tries a source with `dashboard_sources`, it runs against the agent's current thread, while the saved dashboard reads through the thread it was made in. The two differ when a dashboard is changed from another thread.

## Connections

- "Find existing servers" reads only the top-level server list of Claude Code's user config file, not the per-project entries inside it, and a folder's `.mcp.json` when you give the folder. It was not clicked in the real app; tests cover it with invented config files.
- Importing a local-command server makes every one of its environment variables a secret variable. Values written as `${VAR}` are left for you to set.
- A web connection needs an `https://` address. Plain `http://` is accepted only for this machine (`localhost`, `127.0.0.0/8`, `[::1]`); a local server reached that way gets its token unencrypted, but it never leaves the machine.
- Secrets are at most 2,048 bytes each.
- No real third-party MCP server was used in testing. The real-app check used an invented test server.

## Scripts

- Approving a script and seeing it run was never done in the real app: approval is the user's decision, so Approve was deliberately not clicked during testing. Running after approval, the "Runs a script" badge, withdrawing, the "what changed" view and script secrets are covered by tests, which run real harmless scripts. `python3` is never started by the tests; only its arguments are checked.
- Approval is not a sandbox. An approved script can do anything your user account can, including network access and, on macOS, probably reading the plugin's other Keychain entries with the system's own tool.
- A script that deliberately moves itself to another process group (with `setsid`, for example) can outlive the time limit.
- The flagged-line patterns in the approval dialog are a reading aid and are easy to get around.
- Approving in one open view does not update another open view of the same dashboard until it reloads.
- One run at a time per source. A second run while the first is going is refused, not queued.
- An agent that you allow to run shell commands could approve a script without the dialog, because bb cannot tell the plugin's page from bb's command line. Such an agent can also run commands directly. See [scripts.md](scripts.md).

## Callers of the plugin's functions

- bb reports its own app, its command line and agents as the same kind of caller, so the plugin cannot tell them apart. Anyone who can run bb's command line, including an agent allowed to run shell commands, can call every function the Dashboards page uses: add a connection, set a secret, approve a script, delete a dashboard.
- Only other plugins are refused, on every function, reads included. bb's app, its command line and agents all remain accepted, because they cannot be told apart.

## Edit mode

- Two identical parts side by side map to the first of them.
- Only the latest version can be edited, one part per message.
- Not selectable: layout rows, a single series or column inside a chart or table, popovers, and anything inside a Frame (the Frame as a whole is selectable).
- From the Dashboards page, a change request goes to the thread the dashboard was made in. When that thread no longer exists, it cannot be sent.

## Colours and themes

- The viewer's Colours control does not change the good, bad and warning colours, the diverging colour ramp, map land, or a few fixed textures inside the charts.
- Colours are adjusted for contrast against a standard white card in light mode and a dark grey card (#1e1e1e) in dark mode, not against the real card colour. A theme with a very different card colour can end up with less contrast than intended.
- The default chart colours depend on whether bb's main colour counts as grey, which is decided by a threshold (OKLCH chroma below 0.04, `NEUTRAL_CHROMA` in `ui/colours.tsx`). A theme whose main colour is only a faint tint is treated as grey, so its charts start from bb's blue accent instead. When the colour cannot be resolved in the browser, charts start from bb's main colour. See [themes-and-colours.md](themes-and-colours.md#layer-1-bbs-theme-the-default).
- Not seen in the real app: dragging the custom colour picker, and a narrow panel.
- The animations and the reduced-motion setting were not watched in the real app.

## Browser storage

- Remembered filter, tab and selection choices and the Colours choices are kept in the browser's local storage on one device. They do not follow you to another device or browser.
- Deleting a dashboard removes those entries only in the browser where you clicked Delete.
- Remembered choices are not saved when they exceed 20,000 characters for one dashboard; Colours choices are capped at 500 characters.

## Components

- An AskAgent button shows its label; the message it sends was written by the agent that built the dashboard, and you see it only once it appears in the thread as your message. Each click costs one model turn.
- Markdown text is drawn with bb's own Markdown renderer. Whether that renderer loads a remote image written into Markdown text was not checked.
- A Frame has no network and no links out, shows images only as `data:` URLs, and grows to at most 4,000 pixels high.

## The Dashboards page

- The page asks bb for the titles of at most 200 threads. Past 200, or when that lookup fails, rows show "its thread no longer exists" instead of a link.

## Other

- Only the newest 100 versions of a dashboard are kept. A save past that deletes the oldest, for good.
- A version's title is not kept with it: a restored version keeps the dashboard's current title.
- OpenUI's `@openuidev/lang-core` has its own telemetry. Its install-time report runs from an npm install script, which does not run when bb installs the plugin from git (bb installs with scripts off) or in this repository (its `.npmrc` turns them off). Its runtime report in the plugin's server is off unless the machine's owner sets `OPENUI_RUNTIME_TELEMETRY_ENABLED`; see [security-and-privacy.md](security-and-privacy.md).
