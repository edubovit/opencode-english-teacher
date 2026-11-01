# Development and testing

## Setup

Use Node 24+ and npm. Dependencies are pinned in `package-lock.json`. The development baseline is OpenCode 2.2.5, Effect 4.0.6, OpenTUI 0.8.0, and Solid 1.9.18.

```sh
npm ci --ignore-scripts
npm run build
npm run check
```

The Node engine warning from OpenTUI concerns its Node renderer backend. Renderer tests run on the pinned optional Bun binary instead. OpenCode supplies its own host runtime for plugins; do not bundle a second Effect/OpenTUI instance or use private host imports.

The build compiles TUI JSX into `dist/tui.js` using the public OpenTUI Solid Bun plugin. All package imports remain external; host runtimes are not bundled. Rebuild after changing UI/shared client code. OpenTUI 0.8's runtime transform skips `node_modules`, so publishing raw TSX alone does not work. `npm pack` runs the build through `prepack`; consumer installation requires no lifecycle scripts. Server code remains TypeScript and has no JSX.

## Tests

GitHub Actions runs on pushes, pull requests, and manual dispatch. Its Linux and Windows jobs use Node 24, install locked dependencies without lifecycle scripts, and run `npm run check` plus a package dry-run. Actions are pinned to commit SHAs, repository permissions are read-only, and checkout credentials are not retained. No secrets, installed-host tests, or live model requests are used in CI. Host/provider verification remains separate.

```sh
npm run typecheck
npm test
npm run test:tui
npm run test:host
npm run test:host -- --tui
npm run test:host -- --pack --tui
```

The host harness uses a private OpenCode server, isolated user/config/data directories, generated authentication, and a loopback synthetic provider. It must not use real credentials or change the shared service. Set `OPENCODE_BIN` to the native executable when automatic discovery is unsuitable. Keep source files stable while installed-host tests are running; file watching can reload the test plugin mid-scenario.

Real-provider checks consume usage and require explicit approval:

```sh
npm run test:live -- --allow-usage
```

The live script uses only `openai/gpt-6.1-terra` with `low`, fixed synthetic text, and the public stateless-generation API through the authenticated OpenCode CLI. It does not install the plugin, access session history, or change configuration. Passing these checks does not establish compatibility with other providers or deterministic linguistic accuracy.

Test package contents with `npm pack --dry-run`. Test a freshly packed install through the actual host rather than importing packaged TypeScript with Node's native type stripping.

## Architecture

- The server observes successful user admissions. It ignores children, synthetic/control input, and foreign locations.
- Local filtering removes obvious source/code material. Global user-owned teacher instructions, a fixed response/isolation contract, and one filtered message form a stateless request. Language/authorship decisions that cannot be made locally remain conservative model judgments.
- Configuration determines model/variant precedence. Session metadata is used only for routing, eligibility, and model selection; it is never analysis input.
- Plugin storage owns corrections and session settings. Native session history, metadata, and model state are not modified.
- Authenticated native RPC connects the server and TUI. Shared schemas validate inputs, outputs, stored comments, and model results.
- Corrections are rendered by the UI, not copied as arbitrary model-formatted Markdown. Page Up means older; Page Down means newer.

The public stateless API is `ctx.experimental.generate.text`. Do not substitute `session.generate`, which includes history and agent context. The 2.2.5 Promise plugin API adapter does not forward API request cancellation signals; the server uses Effect lifetime/interruption and stale-result guards instead.

The stateless response exposes text, not usage or finish-reason metadata. Schema validation catches malformed/truncated JSON; it cannot prove semantic completeness or that a provider stopped for the intended reason.

`src/prompt-file.ts` reads the global `english-teacher.md` under absolute `XDG_CONFIG_HOME/opencode`, or the server user's home `.config/opencode` directory. Initialization publishes a fully written UTF-8 temporary file using an exclusive hard link, so simultaneous plugin instances cannot overwrite existing edits or read a partially initialized default. Initialization requires a filesystem supporting hard links; failures are reported without fallback. Only the designated prompt is read, with a 64 KiB bound; project files and attachments remain excluded. Instructions are read at dispatch, including for queued jobs. Startup attempts initialization, and subsequent analysis retries file access; errors are sanitized. Tests use isolated directories, never the real global file. Live linguistic fixtures deliberately use the built-in default rather than user customizations.

## State and lifecycle invariants

- Each admission has one identity; event repetition must not produce another correction or notification.
- An explicit session override takes precedence over `enabledByDefault`. New sessions and forks do not inherit teacher state.
- Disable, deletion, ownership loss, unload, and timeout revoke provisional work. Already-authorized final persistence drains; later disables are ordered behind it. Do not publish a late provisional result.
- Persist before notifying. A storage failure is not a successful correction.
- Do not replay missed events or restart saved jobs. Subscriptions are live-only.
- Sort by source admission order, never completion order. Do not jump to a newly completed comment while an older one is being read.
- RPC handlers revalidate session/location. TUI cache state is not write authority.
- Error text is sanitized. Do not log prompts, corrections, credentials, or raw provider output.

Operational limits are constants: two simultaneous requests and 100 waiting jobs per location, a 120-second analysis deadline including queue/preflight time, and 64,000 UTF-16 characters of raw input. The deadline does not forcibly interrupt final persistence or recovery cleanup. Deletion reconciliation visits up to 25 stored session owners per minute per location and also runs on access. These are not extra configuration options.

Persistent records use schema version 1. Session settings/counts, individual comments, reverse-admission-order indexes, and an owner index are separate KV records. Durable prepare markers keep incomplete corrections and setting changes unreadable until committed or rolled back. Admission decisions reserve FIFO order before background dispatch; later enabling cannot authorize earlier disabled input. Ownership epochs and scoped control fibers prevent stale toggles after movement or teardown.

Final authorization settles under the session reservation immediately before clearing its durable marker. Later disables wait behind that final commit; teardown drains it rather than abandoning a partially written result. An already-authorized record can survive a crash without its toast. The host's ownership state and plugin KV have no joint transaction, so an external move can race an already-authorized final write. These are bounded guarantees, not crash-proof exactly-once processing or transactions across arbitrary writers.

## Dependency audit

The pinned host dependency family includes transitive `glob` and `minimatch` advisories:

- [Glob cancellation bypass](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4).
- [Minimatch pattern amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249).

Do not force incompatible major-version overrides merely to remove audit output. The teacher does not accept glob patterns or traverse files during analysis, but that does not establish safety of every host or development-tool path. Recheck `npm audit` and compatible upstream releases before distribution.

## Release gate

Verify source and package loading, isolated provider requests, real-server RPC, cancellation, restart persistence, deletion cleanup, multi-session/location ownership, and actual terminal keyboard/modal behavior. Renderer tests alone do not prove installed TUI behavior. Synthetic provider success does not prove real authentication, correction quality, or all transport compatibility.

Do not commit, publish, activate globally, or restart the user's shared service as a side effect of testing.
