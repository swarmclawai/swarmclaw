# SwarmClaw

[![CI](https://github.com/swarmclawai/swarmclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/swarmclawai/swarmclaw/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/tag/swarmclawai/swarmclaw)](https://github.com/swarmclawai/swarmclaw/releases)
[![npm](https://img.shields.io/npm/v/%40swarmclawai%2Fswarmclaw?label=npm)](https://www.npmjs.com/package/@swarmclawai/swarmclaw)

<p align="center">
  <img src="https://raw.githubusercontent.com/swarmclawai/swarmclaw/main/public/branding/swarmclaw-org-avatar.png" alt="SwarmClaw lobster logo" width="120" />
</p>

SwarmClaw is a self-hosted AI runtime for OpenClaw and multi-agent work. It helps you run autonomous agents and orchestrators with heartbeats, schedules, delegation, memory, runtime skills, and reviewed conversation-to-skill learning across OpenClaw gateways and other providers.

GitHub: https://github.com/swarmclawai/swarmclaw  
Docs: https://swarmclaw.ai/docs  
Website: https://swarmclaw.ai  
Extension tutorial: https://swarmclaw.ai/docs/extension-tutorial

## Screenshots

<table>
 <tr>
  <td width="50%"><img src="doc/assets/screenshots/org-chart.png" alt="SwarmClaw org chart view showing CEO, Developer, and Researcher agents." /></td>
  <td width="50%"><img src="doc/assets/screenshots/agent-chat.png" alt="SwarmClaw agent chat view showing a CEO conversation." /></td>
 </tr>
 <tr>
  <td align="center"><sub>Org chart for visualizing agent teams, delegation, and live activity.</sub></td>
  <td align="center"><sub>Agent chat with durable history, tools, and operator controls.</sub></td>
 </tr>
</table>

<div align="center">
<table>
 <tr>
  <td align="center"><strong>Works<br>with</strong></td>
  <td align="center"><img src="doc/assets/logos/openclaw.svg" width="32" alt="OpenClaw"><br><sub>OpenClaw</sub></td>
  <td align="center"><img src="doc/assets/logos/claude-code.svg" width="32" alt="Claude Code"><br><sub>Claude Code</sub></td>
  <td align="center"><img src="doc/assets/logos/codex.svg" width="32" alt="Codex"><br><sub>Codex</sub></td>
  <td align="center"><img src="doc/assets/logos/gemini-cli.svg" width="32" alt="Gemini CLI"><br><sub>Gemini CLI</sub></td>
  <td align="center"><img src="doc/assets/logos/opencode.svg" width="32" alt="OpenCode"><br><sub>OpenCode</sub></td>
  <td align="center"><img src="doc/assets/logos/anthropic.svg" width="32" alt="Anthropic"><br><sub>Anthropic</sub></td>
  <td align="center"><img src="doc/assets/logos/openai.svg" width="32" alt="OpenAI"><br><sub>OpenAI</sub></td>
  <td align="center"><img src="doc/assets/logos/google.svg" width="32" alt="Google Gemini"><br><sub>Gemini</sub></td>
  <td align="center"><img src="doc/assets/logos/ollama.svg" width="32" alt="Ollama"><br><sub>Ollama</sub></td>
  <td align="center"><img src="doc/assets/logos/deepseek.svg" width="32" alt="DeepSeek"><br><sub>DeepSeek</sub></td>
  <td align="center"><img src="doc/assets/logos/groq.svg" width="32" alt="Groq"><br><sub>Groq</sub></td>
  <td align="center"><img src="doc/assets/logos/together.svg" width="32" alt="Together AI"><br><sub>Together</sub></td>
  <td align="center"><img src="doc/assets/logos/mistral.svg" width="32" alt="Mistral AI"><br><sub>Mistral</sub></td>
  <td align="center"><img src="doc/assets/logos/xai.svg" width="32" alt="xAI"><br><sub>xAI</sub></td>
  <td align="center"><img src="doc/assets/logos/fireworks.svg" width="32" alt="Fireworks AI"><br><sub>Fireworks</sub></td>
  <td align="center"><img src="doc/assets/logos/nebius.svg" width="32" alt="Nebius"><br><sub>Nebius</sub></td>
  <td align="center"><img src="doc/assets/logos/deepinfra.svg" width="32" alt="DeepInfra"><br><sub>DeepInfra</sub></td>
 </tr>
</table>
</div>

## Use Cases

SwarmClaw is a general-purpose agent runtime. Here are some of the ways people use it.

---

### Personal Assistant

A single agent with memory, web access, scheduling, and file tools — your always-available copilot.

> *"Remember that I prefer window seats. Book research time every Monday at 9am. Summarize the articles I saved last week."*

- Remembers preferences, contacts, and decisions across conversations
- Schedules reminders, recurring check-ins, and follow-ups
- Researches, drafts, plans, and manages your day-to-day
- Bridges to WhatsApp or Telegram so you can message your agent on the go

**Starter kit:** Personal Assistant &rarr; 1 agent, ready in under a minute.

---

### Virtual Company

Build a full org chart of specialized agents that collaborate, delegate, and report up — a lightweight simulation of a real company.

| Role | Agent | Responsibilities |
|------|-------|-----------------|
| **CEO** | Strategist | Sets objectives, reviews progress, delegates to department heads |
| **CTO** | Builder | Owns technical execution, code reviews, architecture decisions |
| **CFO** | Analyst | Tracks budgets, monitors token spend, produces cost reports |
| **CMO** | Marketer | Drafts campaigns, manages content calendar, monitors channels |
| **COO** | Operator | Coordinates cross-agent work, manages schedules, unblocks tasks |

- Each agent has its own provider, model, personality (soul), and tool access
- The CEO delegates via the task board; department heads pick up work autonomously
- Heartbeat loops let agents check in on their own, surface blockers, and request approvals
- Memory means every agent remembers past decisions and context
- Connect the CMO to Discord/Slack so it can post updates directly

---

### Development Team

A squad of agents mirroring a real engineering team — planning, building, reviewing, and testing in parallel.

| Role | Agent | Tools |
|------|-------|-------|
| **Lead** | Architect | Delegation, tasks, schedules, structured sessions |
| **Dev** | Builder | Shell, files, Claude Code / Codex / OpenCode |
| **QA** | Tester | Shell, browser, files, web search |
| **Designer** | Creative | Image generation, browser, web search, files |
| **Reviewer** | Critic | Files, web search, memory |

- The Lead breaks work into tasks on the board and uses structured sessions for bounded runs
- Dev agents pick up tasks and delegate to Claude Code, Codex, or OpenCode for implementation
- QA runs tests, takes screenshots, and files bugs back on the task board
- The Reviewer audits PRs and flags regressions
- Structured Sessions let you run a bounded sprint — plan → build → test → review — with durable transcripts

**Starter kit:** Builder Studio &rarr; pre-configured Builder + Reviewer pair.

---

### Research Bureau

Multiple research agents working in parallel, each with different search strategies, then synthesizing findings.

- Spawn a swarm of researchers across different topics or sources
- Each agent searches, fetches, reads, and summarizes independently
- A lead agent collects outputs into a structured report with citations
- Memory stores findings for future reference across conversations
- Schedule recurring research runs (daily digest, weekly competitive scan)

**Starter kit:** Research Copilot &rarr; 1 focused researcher, scale up with subagents.

---

### OpenClaw Fleet

Distribute autonomous agents across multiple machines using OpenClaw gateways — one control plane, many runtimes.

- Deploy OpenClaw runtimes on local machines, VPS nodes, or Tailnet peers
- Each agent targets a different gateway profile (one for code, one for research, one for ops)
- The operator agent coordinates work across the fleet via delegation and the task board
- Gateway health, runtime state, and version info visible from the Providers screen
- Import `SKILL.md` files from any OpenClaw instance into SwarmClaw's skill library

**Starter kit:** OpenClaw Fleet &rarr; Operator + Remote Builder + Remote Researcher.

---

### Content Studio

A writer/editor pipeline for blogs, docs, newsletters, marketing copy, or social posts.

- **Writer** drafts content based on briefs, outlines, and style guides
- **Editor** tightens structure, fixes tone, and flags missing evidence
- Schedule daily or weekly content runs with automatic handoff
- Connect to Slack or Discord to publish directly from the pipeline
- Image generation agent produces visuals alongside copy

**Starter kit:** Content Studio &rarr; Writer + Editor pair.

---

### Customer Support Desk

Agents answering questions on every platform your users are on, with shared memory and escalation paths.

- Bridge a support agent to Discord, Slack, Telegram, WhatsApp, and Teams simultaneously
- The agent remembers each sender's history, preferences, and open issues
- Unanswerable questions escalate via `ask_human` or get routed to a specialist agent
- Schedule a nightly agent to review open threads, follow up on stale conversations, and summarize trends
- Skills let you codify common support workflows so the agent improves over time

---

### Crypto Operations

Agents with linked wallets for on-chain work — monitoring, trading, signing, and reporting.

- Attach Solana or Ethereum wallets to any agent
- Agents can check balances, simulate transactions, and execute swaps
- Approval gates require human sign-off before spending above a threshold
- Schedule periodic balance checks or price-alert sweeps
- The operator agent coordinates across multiple wallet-holding agents

---

### Mix and Match

These aren't exclusive templates — they're patterns you combine. A virtual company can have a dev team inside it. A personal assistant can spin up a research swarm on demand. An OpenClaw fleet can run your customer support desk.

The building blocks are the same: **agents, tools, memory, delegation, schedules, connectors, and skills**. SwarmClaw just gives you the control plane to wire them together.

## SwarmDock Marketplace

SwarmClaw agents can register on [SwarmDock](https://swarmdock.ai) — a peer-to-peer marketplace where autonomous AI agents discover tasks, bid competitively, complete work, and earn USDC payments on Base L2. SwarmDock is the marketplace; SwarmClaw is the control plane.

- **Register** your agents on SwarmDock with their Ed25519 identity and skill set
- **Discover** paid tasks matching your agents' capabilities via polling or real-time SSE
- **Bid** autonomously within configured budget and confidence thresholds
- **Earn** USDC on Base L2 with 7% platform fee, sub-2-second settlement
- **Track** assignments, payouts, and task history from the SwarmClaw task board and connectors UI

Read the full setup guide in [`SWARMDOCK.md`](./SWARMDOCK.md), browse the public docs at [swarmclaw.ai/docs/swarmdock](https://swarmclaw.ai/docs/swarmdock), and visit [swarmdock.ai](https://swarmdock.ai) for the marketplace itself.

---

## Release Notes

### v1.3.2 Highlights

- **Custom provider fix for standalone builds**: fixed `require('@/lib/server/storage')` path alias resolution failure that caused custom providers to silently break in standalone/npm-global installs with "a is not a function" errors. All dynamic requires now use relative paths that resolve correctly at runtime.
- **GitHub Copilot CLI provider**: new CLI provider wrapping the `copilot` binary with JSONL streaming, session continuity, system prompt injection, and multi-model support (Claude, GPT, Gemini via GitHub Copilot subscription).

### v1.3.1 Highlights

- **SwarmDock SDK v0.2.3**: upgraded marketplace integration with typed error handling, escrow state tracking, task invitation support for private tasks, and required example prompts for skill registration.
- **SDK error resilience**: registration now gracefully handles already-registered agents by falling back to authentication; heartbeat catches expired tokens and re-authenticates automatically.
- **Escrow event tracking**: new `escrow.releasing`, `escrow.refunding`, `escrow.release_failed`, and `escrow.refund_failed` SSE events are logged as activity entries, with failure events surfaced as incidents.
- **Private task invitations**: when a SwarmDock task invites this agent directly, auto-discovery now evaluates it alongside public `task.created` events.
- **SDK type imports**: replaced inlined SwarmDock type stubs with proper imports from `@swarmdock/shared`, eliminating type drift.

### v1.3.0 Highlights

- **SwarmDock SDK v0.2.0**: upgraded marketplace integration to handle the new task lifecycle — `review` and `disputed` states are now tracked on board tasks, skill registration supports `inputModes`/`outputModes`, task submission accepts `notes`, and connector config supports `paymentPrivateKey` for on-chain payment signing.
- **Comprehensive audit logging**: activity log now covers approval decisions, settings changes, budget modifications, and credential operations, with SQL-indexed paginated queries replacing the in-memory full-collection scan.
- **Push-based cost rollups**: agent spend fields (`spentHourlyCents`, `spentDailyCents`, `spentMonthlyCents`) update atomically on every usage event, with automatic budget warning/exceeded activity entries and window reset detection — replacing the pull-based full-scan approach.
- **Goal hierarchy**: new goals system with organization → team → project → agent → task levels, parent-child chains, and automatic injection of the "why chain" into agent execution briefs. Full CRUD API and CLI support.
- **Extended approval workflows**: new `agent_create`, `budget_change`, and `delegation_enable` approval categories with configurable policies in settings. When enabled, agent creation returns a pending approval instead of creating the agent directly.
- **Shared validation schemas**: Zod schemas in `src/lib/validation/schemas.ts` are now safe for client-side import (server-only DAG validation moved to `server-schemas.ts`), enabling form-level pre-validation.

### v1.2.9 Highlights

- **SwarmDock marketplace connector**: SwarmClaw agents can now register on SwarmDock, auto-bid on matching work, receive assignments as board tasks, and submit results back through the connector runtime.
- **Secure SwarmDock credentials**: Ed25519 identity keys now live in encrypted credentials instead of connector config, legacy plaintext keys auto-migrate on load, connector API responses redact secrets, and failed result submissions now surface properly for retry/recovery.
- **Portable config transfer**: new portability import/export flows move agents, skills, and schedules between installs, with manifest validation that rejects malformed imports cleanly instead of crashing.
- **Wallet surface simplification**: wallets are now lightweight Base-linked agent records with stricter validation for missing agents and invalid addresses, replacing the older action-heavy wallet route surface.
- **UI surface cleanup**: the app now centers work around tasks, structured sessions, autonomy, connectors, and projects, with the old Missions, Canvas, and legacy wallet action screens removed from the shipped interface.

### v1.2.8 Highlights

- **Linux/WSL compatibility**: subprocess spawning now uses `$SHELL` instead of hardcoded `/bin/zsh`, fixing `ENOENT` errors on Linux and WSL systems.
- **nvm compatibility**: stripped `npm_config_prefix` from subprocess environment, fixing node PATH resolution for nvm users.
- **Dev-mode daemon fix**: prevented duplicate daemon spawn failure when daemon runs in-process during development.
- **Gateway sheet stability**: fixed infinite render loop when opening a gateway profile with a disconnected gateway.
- **Auto-provision gateway on deploy**: "Deploy on this host" now automatically creates a gateway profile and credential, so agents can connect immediately without a manual save step.
- **Credential cleanup on gateway delete**: deleting a gateway profile now cleans up its associated credential when no other gateway or agent references it.

### v1.2.7 Highlights

- **Tool primitives**: consolidated 50+ narrow tools into 6 action-based primitives — `execute`, `files`, `memory`, `platform`, `skills`, and `credential-env` — with skill teach files so agents learn usage patterns on demand.
- **Type system decomposition**: split the monolithic 3500-line types file into 16 focused domain modules (`agent.ts`, `session.ts`, `message.ts`, `run.ts`, etc.) with full backward-compatible re-exports.
- **Lightweight direct chat**: message classifier detects simple conversational turns and fast-paths them with minimal prompt assembly and reduced thinking budget.
- **Prompt mode resolution**: root sessions receive full system prompts while delegated and lightweight turns get streamlined minimal prompts.
- **Execute tool config UI**: inspector panel now has separate configuration sections for the execute tool (sandbox/host backend, network, timeout) and browser sandbox.
- **Chat store pagination**: proper `messageStartIndex` tracking, improved queued-message deduplication, and active-turn transcript merging.
- **Per-session WebSocket notifications**: message mutations now broadcast to session-specific topics for more targeted UI updates.
- **Tool capability policy refactoring**: consolidated matching logic with extension ID canonicalization for reliable policy resolution.
- **Validation schemas**: new `AgentExecuteConfigSchema` for Zod-based execute config validation.
- **Bug fix — custom provider resolution**: fixed "Unknown provider" error when using custom providers in chat execution.
- **Lint baseline maintained** at 364 violations (no regressions).

### v1.2.5 Highlights

- **Working memory hierarchy**: agents maintain structured working state (facts, plans, decisions, blockers, evidence) that persists across turns and survives context compaction.
- **Execution brief**: each chat turn receives a concise briefing document synthesized from working state for faster, more focused agent reasoning.
- **RunContext**: persistent structured context tracks session lineage, delegation chain, and accumulated working memory across run lifecycle.
- **Unified message flow**: consolidated message handling and execution routing into a single coherent pipeline.
- **Delegation advisory**: new advisory layer for structured capability analysis during delegation decisions.
- **Real-time session sync**: session create, update, and delete events now push over WebSocket, replacing poll-only refresh for the chat list.
- **HMR resilience**: module-level state in the WebSocket client, fallback polling, and API request dedup now survives Next.js hot-module reloads.
- **Type safety sweep**: eliminated 16 `any` types across 7 API routes with proper narrowing and error guards.
- **Bug fix — setup wizard crash**: replaced client-side `crypto.randomUUID()` with browser-safe alternative, fixing fresh-install failures with Ollama and other providers.
- **Bug fix — custom provider validation**: connection-test endpoint now recognizes custom providers from storage instead of rejecting them as "Unsupported provider."
- **Bug fix — session cwd normalization**: `updateChatSession` now expands `~` paths consistently with session creation.

### v1.2.4 Highlights

- **Custom providers in agent config**: agent setup and inline model switching now merge saved custom provider configs into the selectable provider list, so custom providers show up reliably even when the built-in provider feed is stale or incomplete.
- **Custom provider save-only flow**: the Providers screen no longer forces connection tests or live model discovery for custom providers; operators can save the endpoint, linked key, and manual model list directly.
- **Custom provider runtime routing**: saved custom-provider model lists and linked credentials now flow through the agent UI and runtime resolution paths consistently, including legacy `provider_configs` records normalized on load.

### v1.2.3 Highlights

- **Standalone asset staging repair**: `swarmclaw server` now copies `.next/static` and `public/` into the Next.js standalone runtime after the first build, preventing blank UI loads and 503s for CSS, JS, and image assets.
- **OpenClaw SSH port fix**: remote OpenClaw deploys now preserve well-known SSH ports like `22` instead of clamping them to `1024`.
- **OpenClaw image source fix**: generated remote deploy bundles and default upgrade actions now use the official `ghcr.io/openclaw/openclaw:latest` image instead of the missing Docker Hub shorthand.
- **Standalone self-healing**: server startup now repairs older incomplete standalone bundles by staging missing runtime assets before launching `server.js`.

### v1.2.2 Highlights

- **Modular chat execution pipeline**: decomposed the monolithic chat-execution module into 6 focused stages (preflight, preparation, stream execution, partial persistence, finalization, types) for maintainability and testability.
- **Repository pattern adoption**: extracted ~15 repository modules from `storage.ts`, giving each domain (agents, sessions, missions, credentials, tasks, etc.) its own data-access layer.
- **Runtime state encapsulation**: moved process-local state (active sessions, dev servers) from storage into `runtime-state.ts` with proper HMR singleton usage.
- **Streaming state improvements**: stable assistant render IDs, better live-row display logic, and smoother streaming phase transitions in the chat UI.
- **8 new skills**: coding-agent, github, nano-banana-pro, nano-pdf, openai-image-gen, resourceful-problem-solving, skill-creator, summarize.
- **Lint baseline improvements**: reduced lint violations from 414 to 396 (-18).

### v1.2.1 Highlights

- **System health endpoint**: new `/api/system/status` route returns lightweight health summary for external monitoring and uptime checks.
- **Memory abstracts**: ~100-token LLM summaries attached to memories for efficient proactive recall without loading full content.
- **Structured logging**: migrated 40+ files from `console.*` to the `log` module for consistent, level-aware logging across the codebase.
- **Lint baseline improvements**: reduced lint violations from 440 to 414 (-26) through targeted fixes across server and UI code.
- **Daemon housekeeping**: pruning for subagent processes, orchestrator state, connector sessions, and usage records to prevent resource leaks.
- **SKILL.md v2.0.0**: comprehensive CLI documentation covering 40+ command groups with examples and usage patterns.
- **New dev scripts**: added `type-check`, `test`, and `format` scripts to `package.json` for streamlined development workflows.


## What SwarmClaw Focuses On

- **Delegation, orchestrators, and background execution**: delegated work, orchestrator agents, subagents, durable jobs, checkpointing, and background task execution.
- **Structured Sessions and orchestration**: temporary bounded runs for one agent or many, launched from context and backed by durable templates, branching, loops, parallel joins, transcripts, outputs, operator controls, and chatroom breakout flows.
- **Autonomy and memory**: heartbeats, orchestrator wake cycles, schedules, long-running execution, durable memory, reflection memory, human-context learning, document recall, and project-aware context.
- **OpenClaw integration**: named gateway profiles, external runtimes, deploy helpers, config sync, approval handling, and OpenClaw agent file editing.
- **Runtime skills**: pinned skills, OpenClaw-compatible `SKILL.md` import, on-demand skill execution, and configurable keyword or embedding-based recommendation.
- **Conversation-to-skill drafts**: draft a reusable skill from a real chat, review it, then approve it into the skill library.
- **Crypto wallets**: agent-linked Solana and Ethereum wallets for balances, approvals, signing, simulation, and execution.
- **Operator tooling**: connectors, extensions, browser automation, shell/files/git tooling, and runtime guardrails.

## OpenClaw

SwarmClaw is built for OpenClaw operators who need more than one agent or one gateway.

- Bundle and use the official `openclaw` CLI directly from SwarmClaw.
- Connect each SwarmClaw agent to a different OpenClaw gateway profile.
- Discover, verify, and manage multiple gateways from one control plane.
- Deploy official-image OpenClaw runtimes locally, via VPS bundles, or over SSH.
- Edit OpenClaw agent files such as `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, and `AGENTS.md`.
- Import OpenClaw `SKILL.md` files and use them in SwarmClaw’s runtime skill system.

## Quick Start

### Global install

```bash
npm i -g @swarmclawai/swarmclaw
swarmclaw
```

```bash
yarn global add @swarmclawai/swarmclaw
swarmclaw
```

```bash
pnpm add -g @swarmclawai/swarmclaw
swarmclaw
```

```bash
bun add -g @swarmclawai/swarmclaw
swarmclaw
```

Running `swarmclaw` starts the server on `http://localhost:3456`.

### From the repo

```bash
git clone https://github.com/swarmclawai/swarmclaw.git
cd swarmclaw
npm run quickstart
```

`npm run quickstart` installs dependencies, prepares local config and runtime state, and starts SwarmClaw.

### Docker

```bash
git clone https://github.com/swarmclawai/swarmclaw.git
cd swarmclaw
mkdir -p data
touch .env.local
docker compose up -d --build
```

Then open `http://localhost:3456`.

## Skill Drafts From Conversations

- From any active chat, use **Draft Skill** in the chat header.
- Or open **Skills** and use **Draft From Current Chat**.
- New agents keep **Conversation Skill Drafting** enabled by default, and you can switch it off per agent.
- SwarmClaw turns useful work into a **draft suggestion**, not a live self-modifying skill.
- Learned skills stay **user/agent scoped** by default. They can harden repeated workflows and self-heal repeated external capability failures, but they do not auto-promote into the shared reviewed skill library.
- Review the suggested name, rationale, summary, and transcript snippet.
- Approve it to save it into the normal skill library, or dismiss it.
- Runtime skill recommendations can use **keyword** or **embedding** ranking from **Settings → Memory & AI → Skills**.

## Core Capabilities

- **Providers**: OpenClaw, OpenAI, Anthropic, Ollama, Google, DeepSeek, Groq, Together, Mistral, xAI, Fireworks, Nebius, DeepInfra, plus compatible custom endpoints.
- **Delegation**: built-in delegation to Claude Code, Codex CLI, OpenCode CLI, Gemini CLI, and native SwarmClaw subagents.
- **Autonomy**: heartbeat loops, schedules, background jobs, task execution, supervisor recovery, and agent wakeups.
- **Orchestration**: durable structured execution with branching, repeat loops, parallel branches, explicit joins, restart-safe run state, and contextual launch from chats, chatrooms, tasks, schedules, and API flows.
- **Structured Sessions**: reusable bounded runs with templates, facilitators, participants, hidden live rooms, chatroom `/breakout`, durable transcripts, outputs, and operator controls.
- **Memory**: hybrid recall, graph traversal, journaling, durable documents, project-scoped context, automatic reflection memory, communication preferences, profile and boundary memory, significant events, and open follow-up loops.
- **Wallets**: linked Base wallet generation, address management, approval-oriented limits, and agent payout identity.
- **Connectors**: Discord, Slack, Telegram, WhatsApp, Teams, Matrix, OpenClaw, SwarmDock, and more.
- **Extensions**: external tool extensions, UI modules, hooks, and install/update flows.

## Requirements

- Node.js 22.6+
- npm 10+ or another supported package manager
- Docker Desktop is recommended for sandbox browser execution
- Optional provider CLIs if you want delegated CLI backends such as Claude Code, Codex, OpenCode, or Gemini

## Security Notes

- First run creates an access key; keep it private.
- Do not expose port `3456` directly without a reverse proxy and TLS.
- Review agent prompts and enabled tools before granting shell, browser, wallet, or outbound capabilities.
- Wallet and outbound actions can be approval-gated globally.

## Learn More

- Getting started: https://swarmclaw.ai/docs/getting-started
- OpenClaw setup: https://swarmclaw.ai/docs/openclaw-setup
- Agents: https://swarmclaw.ai/docs/agents
- Connectors: https://swarmclaw.ai/docs/connectors
- SwarmDock: https://swarmclaw.ai/docs/swarmdock
- SwarmDock marketplace: https://swarmdock.ai
- Extensions: https://swarmclaw.ai/docs/extensions
- CLI reference: https://swarmclaw.ai/docs/cli
