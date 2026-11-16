# Development

This page is for working on bb Dashboards itself: setting up a checkout, the npm scripts, how the tests are organised, the generator that writes the agent's guide and the parser schema, how to add a component or a source kind, and the checklist to run before a release, including the privacy check. Two repository settings matter from the first command: npm install scripts are turned off, and an empty stand-in replaces the `katex` package. Both are explained below.

## Setup

You need bb's command line (for `bb plugin build`, `install` and `dev`), git, and a Node.js recent enough to run TypeScript files directly (`npm run generate` runs `node scripts/generate.ts`).

```sh
npm run setup         # npm ci with install scripts off, then builds better-sqlite3 for the tests
bb plugin install .   # register this checkout with bb
bb plugin dev         # rebuild and reload on every save
```

## npm scripts

| Script | Runs | What for |
| --- | --- | --- |
| `setup` | `npm ci && npm rebuild better-sqlite3 --ignore-scripts=false` | Install exactly the locked dependencies, then build the one native module the tests need. |
| `generate` | `node scripts/generate.ts` | Write `server/generated.ts` and `skills/dashboards/SKILL.md`. |
| `typecheck` | `tsc --noEmit` | Type-check everything except `spikes/`. |
| `build` | `bb plugin build` | Write the bundles to `dist/`. |
| `test` | `bb plugin build && vitest run` | Build first (some tests check the built bundles), then run every test. |

## Install scripts are off

The repository's `.npmrc` sets `ignore-scripts=true`. The reason: OpenUI's `@openuidev/lang-core` runs an install script that reports usage over the network. With scripts off it never runs here. `better-sqlite3`, used only by the tests, needs its own native build, so `npm run setup` rebuilds that one package with scripts on and no other. When bb installs the plugin from git, it also installs with scripts off.

Do not set any of OpenUI's telemetry variables when working on the plugin. The runtime report is off unless `OPENUI_RUNTIME_TELEMETRY_ENABLED` is set; a test checks that it is unset while the tests run. See [security-and-privacy.md](security-and-privacy.md#openuis-telemetry).

## The katex stand-in

OpenUI's React components depend on `katex`, a math renderer. Its CSS names 60 font files that `bb plugin build` has no loader for, so the build fails with the real package. Dashboards never draw math, so the repository replaces it:

- `stubs/katex/` holds an empty module (`index.cjs`) and an empty `dist/katex.min.css`.
- `package.json` wires it in with an npm override: `"overrides": { "katex": "file:./stubs/katex" }`.
- `.gitignore` ignores `dist/` only at the top level (`/dist/`), so `stubs/katex/dist/` is committed.
- `build.test.ts` checks that no KaTeX font reaches the built bundle.

Installing through git or a marketplace with this override has not been tested yet.

## Tests

Tests use Vitest. They live beside the code (`server/*.test.ts`, `ui/*.test.tsx`, `ui/components/*.test.tsx`, `scripts/generate.test.ts`) and in `build.test.ts` at the root. `spikes/` is not tested.

- `test/host.ts` runs the plugin's server in a fake bb host from the plugin SDK. Threads, folders and files are invented and live in memory; no test reads your files.
- `test/setup.ts` adds the few browser APIs jsdom lacks. No layout happens in jsdom, so charts draw no marks; tests check text and behaviour.
- `test/fixtures/mcp-server.mjs` is an invented local MCP server with read-only and unmarked tools.
- On macOS, the secure store tests use the real Keychain under an invented test service (`bb-dashboards-test-...`) and delete every entry they make; the helper refuses the plugin's own service name. The Windows and Linux stores are tested only by checking the exact commands they would run.
- Script tests run real, harmless scripts with `sh`, `bash` and `node`. `python3` is never started; only its arguments are checked.
- `build.test.ts` checks the built bundles: no OpenUI development tools, no KaTeX fonts, no network calls and no MCP client in the browser bundle; no React in the server bundle; and in the server bundle, the one direct `fetch(` is OpenUI's opt-in usage report.
- A server test saves and reads dashboards, runs sources and fetches topics with `fetch` blocked, and checks that nothing was sent.

Guards worth knowing, so a change that breaks them is deliberate:

| Guard | Value | File |
| --- | --- | --- |
| Tool definition size (name, description and schema, in characters) | `dashboard_save` 1,000, `dashboard_get` 650, `dashboard_sources` 1,000; 2,600 together | `server/server.test.ts` |
| Core guide size | 10,500 characters | `scripts/generate.test.ts` |
| Skill description size | 300 characters | `scripts/generate.test.ts` |
| Generated files current | must match what `npm run generate` writes now | `scripts/generate.test.ts` |
| `dashboard_sources` answers | 6,000 characters (`MAX_OUTPUT_CHARS`) | `server/tools.ts` |

Constants that decide behaviour, and where they live:

| Constant | Value | File |
| --- | --- | --- |
| `MIN_REFRESH_SECONDS` | 10 | `server/sources.ts` |
| `SCRIPT_MIN_REFRESH_SECONDS` | 30 | `shared.ts` |
| `RATE_LIMIT` | 20 runs per 60 s, per dashboard and source | `server/run.ts` |
| `MAX_SOURCES` | 12 | `server/sources.ts` |
| `MAX_FILE_BYTES`, `MAX_AGENT_BYTES` | 1 MB, 256 KB | `server/sources.ts` |
| `MAX_COMMITS`, `MAX_CHANGED_FILES` | 100, 200 | `server/sources.ts` |
| `SCRIPT_TIMEOUT_MS`, `MAX_SCRIPT_OUTPUT`, `MAX_SCRIPT_CODE` | 20 s, 1 MB, 20,000 characters | `server/sources.ts` |
| `RUNNERS` | `sh`, `bash`, `python3`, `node` | `server/sources.ts` |
| `TIMEOUTS` | connect 15 s, list 10 s, call 20 s, idle 5 min | `server/connections.ts` |
| `MAX_RESULT_BYTES` | 1 MB | `server/connections.ts` |
| `MAX_SECRET_BYTES` | 2,048 bytes | `server/secrets.ts` |
| `SERVICE` | `bb-dashboards` | `server/secrets.ts` |
| `MAX_PROGRAM` | 100,000 characters | `server/tools.ts` |
| `REQUEST_CAP`, `QUOTE_CAP` | 2,000 and 1,500 characters | `ui/edit.tsx` |

## The generator

`scripts/generate.ts` builds the agent's guide and the save check's schema from the component library, so they cannot drift apart:

- It loads `ui/library.tsx` through Vite's module runner (plain Node loads neither `.tsx` nor CSS; styles are stubbed out).
- It writes `server/generated.ts`: the parser schema and root, the core guide, the detail topics, the examples, one signature line per component and the theme token names.
- It writes `skills/dashboards/SKILL.md`: the skill's description and the guide as its body.
- It starts from OpenUI's library prompt and condenses it. It throws when the library's stock text, rules, built-ins, examples or theme tokens change, so an upgrade of `@openuidev/*` is reviewed by hand.
- `scripts/generate.test.ts` fails while either file is stale, and checks that the guide and its topics name only what is built.

Run `npm run generate` after upgrading `@openuidev/*`, after editing a component's props or description, and after editing the guide's text in `scripts/generate.ts`. The server imports only the generated file, never React.

## Adding a component

1. Write it in `ui/components/` with OpenUI's `defineComponent` and a `zod` props schema. Its `description` becomes its signature line in the guide. Use the helpers in `ui/components/bound.ts`: `useBound` for a `$binding` prop, `text` and `list` for data that may be null, `webUrl` for any link.
2. Add it to the library in `ui/library.tsx` with the slots it may sit in: inside a card or drawer, in a section's or tab's rows, or both. Nothing new goes in a `Row`.
3. A component must not write anywhere. The only actions a program may raise are opening an `http`/`https` link and sending a message to the thread; the panel ignores every other kind.
4. If it opens a link from a written-in prop, add that prop to `LINKS` in `server/validate.ts`, so the save check refuses other schemes too.
5. Style it in `ui/components/styles.css` with the `bbd-` class prefix (bb appends the file to the app's CSS unscoped). Take colours, radii and spacing from the library's `--openui-dashboard-*` tokens, so themes and the Colours control apply. Use the shared motion timings, and check the reduced-motion block at the end of the file.
6. Name it in the guide: add it to the plugin's own list in `scripts/generate.ts` (the `views` topic) or to the topic that fits, then run `npm run generate`.
7. Add tests next to the others in `ui/components/components.test.tsx`, and check that the guide stays under its size guard.

## Adding a source kind

1. In `server/sources.ts`: add a strict schema to `sourceSchema`, its name to `KINDS`, a strict argument schema to `ARGS`, and an entry with an invented sample to the help the agent reads. A reader returns `{ok: true, data}` or `{ok: false, error}` and never throws.
2. Read only. Reach the system through bb's SDK or another read-only path, take any path or target from the declaration (never from the browser), and cap the size of what comes back.
3. In `server/run.ts`, route the kind if it does not go through `runSource` (as `mcp` and `script` do not). The refresh floor, cache and rate limit apply to every kind.
4. In `ui/live.tsx`, add the kind to `SourceKind`. If it refreshes through the agent, check the header label in `ui/panel.tsx` and the Freshness wording in `ui/components/live.tsx`.
5. Describe it in the `live-data` topic in `scripts/generate.ts`, run `npm run generate`, and add tests in `server/sources.test.ts`.
6. Update [data-sources.md](data-sources.md) and [security-and-privacy.md](security-and-privacy.md#the-read-only-model).

## Release checklist

1. `npm run typecheck` and `npm test` pass. `npm run generate` leaves no change.
2. The version in `package.json` is raised; `engines` still match the bb and SDK versions the plugin needs.
3. `bb.description` in `package.json` and `PLUGIN_OVERVIEW.md` say the same thing at two lengths. The overview stays under 4,000 characters, uses only `##` headings, lists, inline code and https links (no tables, images or HTML), and names every cost.
4. Screenshots are taken from dashboards built on invented data, in a clean bb profile with no real threads, projects or connections visible.
5. The privacy check passes (below).
6. The plugin installs from its git source into a clean bb profile and works there. This has not been done yet.
7. The source map `dist/server.js.map` holds folder paths from the machine that built it. `dist/` is not committed; if built files are ever published, leave the map out.

### The privacy check

Run it on the final files, before anything is published, and again before each release. Nothing ships until every line passes.

| What | How | Passes when |
| --- | --- | --- |
| Source files | Scan for a word list kept outside the repository: the names of the author's employer, internal domains, personal names and addresses | No match |
| Built bundle | The same scan over `dist/` | No match |
| Commit history | The same scan plus a secret scan over every commit, messages and author details included | No match, no secret |
| Agent guide and examples | Read through | Every system and number is invented |
| Tests and fixtures | Read through | No recorded real response |
| Screenshots and video | Look at each one; a video frame by frame where real windows could appear | No real thread, project, connection or name visible |
| Listing and package details | Author, copyright, links, descriptions | A public identity only; commits use a no-reply address |
| A fresh install | Install the built plugin in a clean bb profile; open its database, settings and connections | All empty: no dashboard, connection or token arrives with the plugin |
| Outside calls | Run the plugin with no connections and watch its network use | It contacts nothing |

If anything is found: fix it at the source and run the whole check again from the first line. A hit in the commit history means rewriting the history before the repository is made public; deleting the text in a later commit is not enough. A real token found anywhere is treated as leaked: revoke and replace it.

## Related pages

- [architecture.md](architecture.md): how the parts fit together.
- [components.md](components.md) and [data-sources.md](data-sources.md): what a new component or kind must match.
- [limits.md](limits.md): what is untested today.
