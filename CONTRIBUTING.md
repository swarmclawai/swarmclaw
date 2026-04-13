# Contributing to SwarmClaw

Thanks for considering a contribution. SwarmClaw is an open-source autonomous-agent runtime, and the project moves faster when issues and PRs come with concrete repro steps and small focused changes. This guide lays out what we look for.

## Filing an issue

Bugs are easiest to land when the report contains:

- The SwarmClaw version (visible in the sidebar footer or `npm ls @swarmclawai/swarmclaw`).
- How you are running it (npm install, Docker image, packaged desktop app, hosted on Render / Fly / Railway).
- The provider, model, and any relevant connector / extension involved.
- The exact error text, stack trace, or log line.
- A minimal sequence of steps to reproduce.
- Any file paths or function names you suspect, especially if you have already opened the source.

[Issue #39](https://github.com/swarmclawai/swarmclaw/issues/39) is the gold-standard bug report we have received: it identified three concrete root causes by file path and line number, explained how each one combined to produce the symptom, and proposed a minimal fix. The PR was almost mechanical to land. If your report can look like that, please make it look like that.

## Filing a feature request

Good feature requests are easy to scope and easy to say yes (or no) to. We look for:

- A short motivation: what real workflow is blocked today?
- One or more user stories ("As a SwarmClaw user, I want to ...").
- A list of functional requirements with stable IDs (`FR-1`, `FR-2`, ...). Distinguish must-have, should-have, nice-to-have.
- Open design questions called out explicitly. The implementer will need decisions on those before writing code; flagging them up front saves a round trip.
- Any relevant external documentation links (provider API docs, RFCs, etc.).

[Issue #40](https://github.com/swarmclawai/swarmclaw/issues/40) is the gold-standard feature request: a clear motivation, eight numbered requirements split by priority, and three explicit design questions for the implementer. That made it possible to commit to a concrete plan in a single planning round.

## Sending a pull request

Before you push:

1. **Keep the PR focused.** One bug fix or one feature per PR. Refactors and unrelated cleanup should land separately.
2. **Add a regression test where it makes sense.** A unit test that would have caught the bug, or that pins the new behavior, is the durable artifact.
3. **Run `npm run lint:baseline`.** It must report `No net-new lint issues detected`. If you fix existing lint violations along the way, run `npm run lint:baseline:update` to lock the new (lower) baseline in.
4. **Do not suppress lint rules.** If a rule is genuinely wrong for the project, change the rule in the lint config with a clear justification rather than disabling it inline.
5. **Avoid `any`.** Use `unknown`, a `Record<string, unknown>`, or define a real interface. The type system is the safety net.
6. **Prefer editing existing files** over adding new abstractions. Three similar lines beats a premature helper.

## Commit messages

- Short imperative summary on the first line, body explains the *why* below.
- Reference the issue number ("Reported as issue #39") in the body when relevant.
- No references to AI tooling. Write commit messages as if a human authored the code.
- No em dashes. Use a colon, parentheses, or two sentences instead.

## Local development

```sh
git clone https://github.com/swarmclawai/swarmclaw.git
cd swarmclaw
npm install
npm run dev      # starts the dev server on port 3456
```

Useful npm scripts while iterating:

```sh
npm run lint:baseline           # release gate; must pass before merging
npx tsx --test path/to/file.test.ts   # run a single Node-test file
npm run test:cli                # CLI test suite
npm run test:openclaw           # OpenClaw integration suite
npm run test:setup              # setup wizard suite
NODE_ENV=production npm run build:ci   # production build sanity check
```

If you are running multiple agents against the same checkout, please do not kill the dev server without checking with the other agent first; another agent may be actively testing against it.

## Where to look first

- **`CLAUDE.md`** is the canonical project conventions reference. It covers storage patterns (`saveCollection`, `setIfChanged`), Zustand store rules, the chat-execution pipeline, terminal-tool boundaries, the extensions migration, the desktop-app architecture, and the release checklist. Read this first before any non-trivial change.
- **`src/lib/providers/`** for new provider integrations. Most new providers are OpenAI-compatible and can be added as a thin wrapper that delegates to `streamOpenAiChat`. See `claude.ts` and `anthropic.ts` for the raw HTTP / SSE pattern when a provider is not OpenAI-compatible.
- **`src/lib/server/session-tools/`** for new agent tools. Native tool builders go through the assembler in `session-tools/index.ts`; native tool names are deduplicated across all assembly phases.
- **`src/lib/server/chat-execution/`** for the chat loop, continuation evaluator, classifier, and tool-event tracker.
- **`src/lib/setup-defaults.ts`** is the single source of truth for provider display names, default models, `keyUrl` / `keyLabel` pairs, and starter agent kits. New providers must add an entry here.

## Releases

Maintainers cut releases. Contributors do not need to bump versions or write release notes; PRs get bundled into the next `vX.Y.Z` tag and the maintainer publishes notes on the SwarmClaw site.

## Code of conduct

Be kind. Critique the code, not the person. Assume good faith. Issues that are dismissive or hostile to other contributors will be closed.
