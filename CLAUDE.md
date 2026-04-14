# CLAUDE.md

### Keeping Instructions in Sync
- **`CLAUDE.md` and `AGENTS.md` must stay in sync.** When you add, edit, or remove a rule in one file, apply the same change to the other. They contain the same project guidelines — one for Claude Code, one for other coding agents.

### Dev Server
- **NEVER kill the dev server (`npm run dev`, port 3456) without asking the user first.** The user is often actively working against it, and other agents may be running tests against it. Always confirm before stopping, restarting, or killing the dev server process.

### Code Quality

**Lint baseline is a release gate.** Run `npm run lint:baseline` before any production release. The baseline must pass — no net-new lint fingerprints. If you fix existing violations, run `npm run lint:baseline:update` to lock in the improvement.

**Embrace TypeScript and the type system.** Use proper types, interfaces, and generics. Never use `any` — use `unknown`, `Record<string, unknown>`, or define a proper interface. The type system is there to catch bugs at compile time; circumventing it defeats the purpose.

**Lint rules exist to protect us.** Do not suppress, disable, or work around lint rules. Fix the underlying code instead. If a rule is genuinely wrong for the project, change the rule in the lint config with a clear justification — but this should be rare. The default is to fix the code, not silence the linter.

### Architecture

**Prefer simple, maintainable, reliable architectures.** Choose the straightforward approach over the clever one. Code that is easy to read, easy to debug, and easy to delete is better than code that is abstract, configurable, or "elegant." Avoid premature abstraction — three similar lines are better than a premature helper. Build for the current requirement, not hypothetical future ones.

### Commit Messages
- Never reference "Claude", "Anthropic", "Codex", "Co-Authored-By", or any AI tool in commit messages. Write commit messages as if a human authored the code.

### Testing

**Always test with live agents.** After making changes to chat execution, streaming, plugins, connectors, or any agent-facing code path, verify the work by running a live agent chat on the platform. Unit tests and type checks are necessary but not sufficient — the real test is whether an agent can actually hold a conversation, use its plugins, and produce correct results through the running application.

**Lock in working behavior with tests.** When a feature or fix is confirmed working — whether by user verification, live agent testing, or manual QA — add regression tests (frontend and/or backend as appropriate) to prevent it from breaking later. The goal is to ratchet forward: once something works, it stays working. Don't skip this step just because the fix was small or the feature seems simple. A quick unit test today saves a painful debugging session tomorrow.

### UX Philosophy

SwarmClaw serves non-technical users alongside power users. Every UI surface should follow these principles:

**Progressive disclosure.** Hide power-user controls behind expandable sections — don't dump every option on screen at once. Use `AdvancedSettingsSection` (`src/components/shared/advanced-settings-section.tsx`) for collapsible expert panels (routing config, runtime behavior, overrides). Default state is collapsed.

**Smart defaults — never leave blanks.** Every field that can have a sensible default should have one. `setup-defaults.ts` (`src/lib/setup-defaults.ts`) is the single source of truth for provider defaults, starter agent kits, `keyUrl`/`keyLabel` pairs, and default model selections. When adding a new provider or agent preset, add its defaults there — don't scatter magic values across components. `randomSoul()` (`src/lib/soul-suggestions.ts`) provides personality suggestions so the soul field is never empty.

**Contextual help.** Use `HintTip` (`src/components/shared/hint-tip.tsx`) — the `?` tooltip component — next to any field that isn't self-explanatory. For connector config fields, add entries to `FIELD_HINTS` in `connector-sheet.tsx`. Multi-step setup guides (Discord developer portal, Slack app creation, Telegram BotFather, etc.) include exact URLs so users don't have to hunt for them.

**Never leave the user stuck.** If a form requires an API key, link directly to where they get one (`keyUrl` in `setup-defaults.ts`). If a connector needs setup steps, show them inline with clickable links. Error states should say what went wrong and what to do next.

### Zustand Store Updates

**Always use `setIfChanged` for async loaders.** Every async loader that fetches data from the API and writes it to the store must use `setIfChanged` (`src/stores/set-if-changed.ts`) instead of raw `set()`. The API always returns fresh object references, so raw `set()` triggers re-renders in every subscribed component even when the data hasn't changed. `setIfChanged` keeps a JSON fingerprint and skips the write if nothing changed.

```ts
// Wrong — causes render cascade on every poll
set({ agents: freshAgents })

// Right — only triggers re-renders when data actually changed
setIfChanged(set, 'agents', freshAgents)
```

After local mutations (optimistic updates, removes), call `invalidateFingerprint(key)` so the next loader write goes through.

### Adding Providers

**Most new providers are OpenAI-compatible.** Don't write a new streaming handler from scratch. Instead, patch the session's `apiEndpoint` and delegate to `streamOpenAiChat` (`src/lib/providers/openai.ts`). This is how google, deepseek, groq, together, mistral, xai, fireworks, nebius, deepinfra, and all custom providers work — each one is a thin wrapper that sets the base URL and calls `streamOpenAiChat({ ...opts, session: patchedSession })`.

When adding a new provider:
1. Add an entry in the provider registry (`src/lib/providers/index.ts`) that patches the endpoint and delegates to `streamOpenAiChat`
2. Add defaults to `setup-defaults.ts` — display name, `keyUrl`, `keyLabel`, default model, description
3. Only write a custom handler if the provider's API is genuinely incompatible with the OpenAI chat completions format

### Chat Execution Pipeline

**`enqueueSessionRun()` is the only correct entry point for running a chat turn.** Never call `executeSessionChatTurn()` directly — it bypasses queuing, dedup, coalescing, and execution locking.

The pipeline (`src/lib/server/runtime/session-run-manager.ts`):
1. **Dedup** — duplicate requests with the same `dedupeKey` are dropped
2. **Collect-mode coalescing** — rapid messages within a 1500ms window are merged into a single turn (prevents multiple LLM calls when a user sends several messages quickly)
3. **Heartbeat preemption** — a user-initiated chat aborts any running heartbeat turn for that session
4. **Execution lock** — only one turn runs per session at a time; others queue

Connectors, heartbeat, scheduler, and the chat API all go through `enqueueSessionRun()`. If you're adding a new caller, use it too.

### `hmrSingleton` for Module-Level State

**Never use bare `const x = new Map()` at module scope.** Next.js HMR re-executes the module on save, wiping the state. Use `hmrSingleton<T>(key, init)` from `src/lib/shared-utils.ts` instead — it attaches to `globalThis` and survives reloads.

```ts
// Wrong — lost on HMR reload
const running = new Map<string, RunState>()

// Right — survives HMR
const running = hmrSingleton('myFeature_running', () => new Map<string, RunState>())
```

**Backfilling new fields:** When you add a field to an existing `hmrSingleton` object, the initializer won't re-run (the key already exists on `globalThis`). Apply defaults at the usage site or add a migration check after the `hmrSingleton` call.

### Terminal Tool Boundaries

**Some tool completions force-exit the agent loop immediately.** Code that runs after tool execution (post-tool hooks, continuation logic) will not run for terminal tools. If you add a new tool or post-execution logic, you need to know which tools are terminal.

Three boundary kinds:
- **`memory_write`** — memory persistence tools; loop exits after successful write
- **`durable_wait`** — tools that block on external input (e.g., approval gates); loop exits to avoid holding resources
- **`context_compaction`** — context window management; loop exits to restart with compacted context

Resolved in `resolveSuccessfulTerminalToolBoundary()` (`src/lib/server/chat-execution/chat-streaming-utils.ts`). Only mark a new tool as terminal if it genuinely needs to end the turn — most tools should not be terminal.

### Storage: Load-Modify-Save

**`saveCollection()` silently blocks bulk deletes.** If the save would delete more rows than it upserts, the guard prevents it and logs a warning. This protects against accidentally wiping a collection by saving a partial record set.

The correct pattern:
1. **Load all** records from the collection
2. **Modify** the in-memory array (add, update, or remove items)
3. **Save all** back with `saveCollection()`

For single-item updates, use `upsertCollectionItem()` instead — it doesn't trigger the bulk-delete guard.

**Normalization on load:** `storage-normalization.ts` auto-migrates records when they're loaded, applying default values for new fields. When you add a new field to a stored type, add its default to the normalization function — don't rely on `undefined` checks scattered across the codebase.

### Missions (Autonomous Goal-Driven Runs)

Missions wrap a session with a goal, budgets, a milestone log, and periodic reports. They are the first-class way users hand off long-running autonomous work. A Mission always has exactly one `rootSessionId` that drives it through the existing heartbeat pipeline.

**Storage tables**: `agent_missions`, `mission_reports`, `agent_mission_events`. The legacy deprecated `missions` table is untouched. All mission-specific repository and service code lives in `src/lib/server/missions/`.

**Budget enforcement**: `enqueueSessionRun` consults `checkMissionBudgetForSession(session.missionId)` on every autonomous-managed enqueue (anything that is not a direct user chat). When a cap is hit the mission transitions to `budget_exhausted`, the queue drains, and a final report fires. User-initiated chats bypass the check so the user can still talk to a mission session mid-run. Caps enforced today: USD, tokens, turns, wallclock.

**Scheduler**: `runMissionScheduler()` is called from the top of `tickHeartbeats()` every minute, independent of the heartbeat active-hours window. It enforces wallclock budgets and dispatches `reportSchedule` reports. The scheduler uses `hmrSingleton` for state so it survives HMR.

**Nested patch pitfall**: when writing mission service code, never call `appendMissionMilestone` inside a `patchMission` updater closure. The inner patch reads a stale snapshot and clobbers the outer write. Collect the milestone intent during the patch, call `appendMissionMilestone` after the patch returns. See `recordTurnUsage` in `mission-service.ts` for the pattern.

### Desktop App (Electron)

SwarmClaw also ships as a desktop app via Electron. The wrapper lives in `electron/`
and spawns the existing Next.js standalone server as a child process. **The web
app code is not modified for Electron.**

- **Wrapper model:** `electron/main.ts` spawns `.next/standalone/server.js` using
  `process.execPath` + `ELECTRON_RUN_AS_NODE=1` (no separate Node runtime shipped).
  The child binds to `127.0.0.1` only, never `0.0.0.0` from the desktop path.
- **Data directory:** Electron sets `SWARMCLAW_HOME = app.getPath('userData') + '/home'`
  before spawning. `DATA_DIR`, `WORKSPACE_DIR`, and `BROWSER_PROFILES_DIR` are all
  rooted there. Do not write to `./data` from code reached by the desktop app.
- **Native modules:** `better-sqlite3` must be ABI-compatible with Electron's Node.
  `scripts/build-electron.mjs` runs `@electron/rebuild` against
  `.next/standalone/node_modules` before packaging.
- **Auto-update:** `electron-updater` + GitHub Releases. Unsigned macOS builds fall
  back to notify-only (Squirrel.Mac requires a signed bundle). Windows NSIS and
  Linux AppImage auto-update unsigned.
- **Build locally:** `npm run electron:build` (current platform only). CI matrix
  in `.github/workflows/desktop-release.yml` handles all three platforms.
- **Release gate:** before cutting a tag, run `npm run electron:build` as a smoke
  test on the maintainer's OS.

### Preparing a Release

When preparing a new version release, follow this checklist in order:

1. **Fix lint blockers**: run `npx eslint <changed-files>` to catch issues. Fix them, then run `npm run lint:baseline:update` to lock in the new count.
2. **Verify storage normalization**: if any stored type fields were renamed or removed, confirm `storage-normalization.ts` migrates old data on load. Add normalization if missing.
3. **Version bump**: update `"version"` in `package.json`.
4. **Update README release notes**: add a new `### vX.Y.Z Highlights` section above the previous version in the `## Release Notes` block in `README.md`. Include concise bullet points for each notable change.
5. **Update site docs release notes**: add a new `## vX.Y.Z (date)` entry at the top of `../swarmclaw-site/content/docs/release-notes.md` with `### Highlights` and `### Upgrade Guidance` subsections.
6. **Register new API routes in CLI**: if new API routes were added, add them to the CLI manifest in `src/cli/index.js` (and `src/cli/spec.js` if applicable) so the route-coverage test passes.
7. **Smoke-test the desktop app**: `npm run electron:build` on the maintainer's OS, launch the packaged artifact, and verify a live agent chat works before tagging.
8. **Run CI validation** (all must pass):
   - `npm run lint:baseline` — lint gate
   - `NODE_ENV=production npm run build:ci` — production build
   - `npm run test:cli` — CLI tests
   - `npm run test:openclaw` — OpenClaw tests
9. **Commit**: stage all changes and commit with a release message (e.g., `Release v1.1.6`). Do not push until the user confirms.

### Extensions, Not Plugins

**The codebase has fully migrated from "plugins" to "extensions."** Use `extensions` in all new code — variable names, function signatures, interfaces, UI copy.

- **Type names:** `Extension`, `ExtensionHooks`, `ExtensionMeta` (not `Plugin`, `PluginHooks`)
- **Server module:** `src/lib/server/extensions.ts` (not `plugins.ts` — deleted)
- **Storage directory:** `data/extensions/` (not `data/plugins/`)
- **Session field:** `session.extensions` (not `session.plugins`)

Legacy `data/plugins/` files are auto-migrated to `data/extensions/` on first access. Deprecated aliases exist for backward compatibility but must not be used in new code.
