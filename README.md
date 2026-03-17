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
| **Lead** | Architect | Delegation, tasks, schedules, missions |
| **Dev** | Builder | Shell, files, Claude Code / Codex / OpenCode |
| **QA** | Tester | Shell, browser, files, web search |
| **Designer** | Creative | Image generation, browser, web search, files |
| **Reviewer** | Critic | Files, web search, memory |

- The Lead creates missions and breaks them into tasks on the board
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

## Release Notes

### v1.1.9 Highlights

- **Docker build stability**: limit Next.js page data workers to 1 in build mode to prevent `SQLITE_BUSY` contention.
- **Async file I/O in providers**: Anthropic and OpenAI providers now use `fs.promises` for non-blocking attachment reads.
- **Anthropic request timeout**: 60s timeout on Anthropic API requests prevents indefinite hangs.
- **Graceful crash handling**: instrumentation now catches EPIPE and suppresses expected LangGraph unhandled rejections.
- **Log tail optimization**: `/api/logs` reads only the last 256 KB instead of loading the entire log file.
- **Thread session fast path**: `ensureAgentThreadSession` uses single-row lookup instead of full table scan when `threadSessionId` is set.
- **Memory graph performance**: force-directed simulation writes to DOM imperatively instead of re-rendering React state per frame; stops when kinetic energy settles.
- **Reduced polling frequency**: chat area WS polling intervals relaxed (messages/runs 2s to 10s, browser 5s to 30s) to lower server load.
- **Chat list indexing**: connector lookup indexed by `agentId` for O(1) instead of O(n) per session filter.
- **Sidebar skill badges**: skill draft count displayed as a badge on the Skills nav item.
- **Route loading states**: added `loading.tsx` skeleton pages for activity, home, logs, memory, and tasks routes.
- **Command palette cleanup**: fixed missing `setOpen` dependencies and removed unused props.
- **Playwright proxy hardening**: improved stdio pipe handling for dev server restarts.
- **Scheduler and run ledger fixes**: improved scheduler reliability and run ledger state tracking.

### v1.1.8 Highlights

- **Agent live status**: real-time `/agents/:id/status` endpoint exposes goal, progress, and plan steps; org chart detail panel consumes it via `useAgentLiveStatus` hook.
- **Learned skills lifecycle**: promote, dismiss, and delete learned skills via `/learned-skills/:id`; `/skill-review-counts` provides badge counts for the skills workspace.
- **Gemini CLI provider**: Google Gemini CLI joins the provider roster alongside claude-cli and codex-cli, with shared CLI utilities factored into `cli-utils.ts`.
- **Peer query & team context tools**: new session tools let agents query peers and access team context during conversations.
- **Team resolution**: dedicated `team-resolution.ts` module resolves agent teams for delegation routing.
- **Org chart activity feed**: timeline feed component and delegation bubble visualization for the org chart view.
- **Skills workspace improvements**: expanded skills management UI with review-ready badges.
- **Cost trend chart**: new dashboard component for cost visualization.
- **Streaming fix**: text no longer gets stuck on the thinking indicator.
- **Delegation normalization**: `delegationEnabled` now derived from agent role, removed from starter kit templates.
- **Chat execution refinements**: improved continuation limits, post-stream finalization, and stream continuation.
- **Memory and storage improvements**: memory tier management, consolidation enhancements, and storage cache updates.
- **WebSocket and provider health**: improved WS client handling, delegation edge state, and provider health monitoring.

### v1.1.7 Highlights

- **Projects page redesign**: tabbed navigation (Overview, Work, Operations, Activity) with health grid, sortable task list, and timeline feed.
- **Delegation visualization**: live org chart edges show active delegations with status, direction, and message popover on click.
- **Credential self-service**: agents can check whether a credential exists and request missing ones from humans with structured messages, signup URLs, and durable wait.
- **Main loop state persistence**: autonomous operation state now survives server restarts via on-disk persistence.
- **Internal metadata stripping**: classification JSON and loop detection messages no longer leak into streamed agent output.
- **Response completeness evaluator**: LLM-based detection of incomplete agent responses triggers continuation nudges.
- **Coordinator delegation nudging**: coordinators that make 3+ direct tool calls get prompted to delegate to workers.
- **Inspector panel overhaul**: new dashboard/config/files tabs absorb model switcher and workspace controls from chat header.
- **Streaming phase indicators**: agent chat list shows queued, tool-in-use, responding, and reconnecting states.
- **Shell safety**: agents can no longer kill SwarmClaw's own process or port.
- **Worker-only providers**: CLI-backed providers (claude-cli, codex-cli, etc.) properly restricted from coordinator/heartbeat roles.
- **HTTP tool removed**: the built-in HTTP session tool was removed from the standard toolkit.

### v1.1.6 Highlights

- **Org chart view**: visual agent hierarchy with drag-and-drop reparenting, team grouping, and context-menu actions for managing agent relationships directly from the canvas.
- **Dashboard API**: server-side metrics endpoint with cost tracking, usage aggregation, and budget warning thresholds for operator visibility.
- **Subagent lifecycle overhaul**: state-machine lineage tracking, `delegationDepth` limits, auto-announce on spawn, and cleaner parent-child session management.
- **Chat execution refactor**: composable prompt sections replace monolithic prompt building, continuation evaluator consolidation, and extracted stream-continuation logic for maintainability.
- **Per-agent cost attribution**: token costs are tracked and attributed per agent, enabling budget controls and cost reporting at the agent level.
- **Capability-based task routing**: tasks can match agents by declared capabilities, not just explicit assignment, enabling smarter automatic dispatch.
- **Bulk agent operations**: new `/api/agents/bulk` endpoint for batch updates across multiple agents in a single request.
- **Document revisions API**: version history for documents with `/api/documents/[id]/revisions` endpoint.
- **Store loader consolidation**: async loaders now use `createLoader()` and `setIfChanged` to eliminate redundant re-renders from polling.

### v1.1.4 Highlights

- **Orchestrator agents return as a first-class autonomy mode**: eligible agents can now run scheduled orchestrator wake cycles with their own mission, governance policy, wake interval, cycle cap, Autonomy-desk controls, and setup/editor support.
- **Runtime durability is much harder to knock over**: the task queue now supports parallel execution with restart-safe swarm state, orphaned running-task recovery, stuck-task idle timeout detection, and provider-health persistence across daemon restarts.
- **Recovery and safety paths are tighter**: provider errors are classified for smarter failover, unavailable agents defer work instead of burning it, supervisor blocks can create executable notifications, and agent budget limits now gate task execution before work starts.
- **Temporary session rooms are easier to inspect**: chatrooms now split persistent rooms from temporary session-style rooms so orchestrator or structured-session conversations can stay visible without polluting the normal room list.

### v1.1.3 Highlights

- **Release integrity repair**: `build:ci` no longer trips over the langgraph checkpoint duplicate-column path, which restores clean build validation for the release line.
- **Storage writes are safer**: credential and agent saves were tightened to upsert-only behavior and bulk-delete safety guards so tests or scripts cannot accidentally wipe live state.
- **Plugin-to-extension cleanup finished**: remaining rename residue in scripts and tests was cleaned up so packaging and release tooling stay aligned with the current extensions model.
- **Safe body parsing utility**: shared `safeParseBody()` replaces scattered `await req.json()` try/catch blocks across API routes.

### v1.1.2 Highlights

- **Structured Sessions expanded into richer orchestration**: ProtocolRun-based sessions now support dependency-aware step graphs, reusable step outputs, and a broader advanced execution model on the same durable runtime instead of bringing back a separate orchestrator.
- **Explicit Ollama local/cloud routing**: agents and sessions now persist the user-selected Ollama mode directly, so local Ollama no longer flips to cloud because of model naming or leftover credentials.
- **Chat and runtime regression hardening**: live-streamed inline media, stale streaming cleanup, exact-output handling, and chat rendering bugs were tightened again, including the recent message-row and avatar rendering regressions.
- **Nebius and DeepInfra as built-in providers**: both are now first-class providers with setup wizard entries, model discovery, and pre-configured defaults instead of requiring the custom provider workaround.
- **`stream_options` resilience**: the OpenAI-compatible streaming handler now retries without `stream_options` if a provider rejects it with 400, fixing connectivity for strict endpoints.

### v1.1.1 Highlights

- **Structured Sessions are now contextual**: start bounded structured runs from direct chats, chatrooms, tasks, missions, or schedules, including a new chatroom `/breakout` command that spins up a focused session from the current room with auto-filled participants and kickoff context.
- **ProtocolRun orchestration matured**: structured sessions now run on the same durable engine for step-based branching, repeat loops, parallel branches, and explicit joins instead of growing a separate orchestration subsystem.
- **Live-agent runtime hardening**: exact-output contracts, memory preflight behavior, same-channel delivery rendering, inline media, and grounded runtime inspection were all tightened through live-agent validation before release.

### v1.1.0 Highlights

- **Mission controller and Missions UI**: SwarmClaw now tracks durable multi-step objectives as missions with status, phase, linked tasks, queued turns, recent runs, event history, and operator actions from the new **Missions** surface.
- **Autonomy safety desk and run replay**: the new **Autonomy Control** page adds estop visibility, resume policy controls, incident review, and run replay backed by durable run history rather than transient in-memory state.
- **Durable queued follow-ups**: direct chat and connector follow-up turns now use a backend queue so queued work survives reloads, drains in order, and stays attached to the right mission/session context.
- **Chat execution and UX hardening**: streamed handoff, memory writes, inline media, queue state, and tool-policy fallback behavior were cleaned up so agents are less noisy, less brittle, and easier to follow in real chats.

### v1.0.9 Highlights

- **Quieter chat and inbox replies**: chat-origin and connector turns now suppress more hidden control text, stop replaying connector-tool output as normal assistant prose, and avoid extra empty follow-up chatter after successful tool work.
- **Sender-aware direct inbox replies**: direct connector sessions can honor stored sender display names and reply-medium preferences, including voice-note-first replies when the connector supports binary media and the agent has a configured voice.
- **Cleaner connector delivery reconciliation**: connector delivery markers now track what was actually sent, response previews prefer the delivered transcript, and task/connector followups resolve local output files more reliably.
- **Memory-write followthrough hardening**: successful memory store/update turns terminate more cleanly, which reduces unnecessary post-tool loops while still allowing a natural acknowledgement when the user needs one.

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
- **Autonomy**: heartbeat loops, schedules, background jobs, task execution, supervisor recovery, mission control, and agent wakeups.
- **Orchestration**: durable structured execution with branching, repeat loops, parallel branches, explicit joins, restart-safe run state, and contextual launch from chats, chatrooms, tasks, missions, schedules, and API flows.
- **Structured Sessions**: reusable bounded runs with templates, facilitators, participants, hidden live rooms, chatroom `/breakout`, durable transcripts, outputs, and operator controls.
- **Memory**: hybrid recall, graph traversal, journaling, durable documents, project-scoped context, automatic reflection memory, communication preferences, profile and boundary memory, significant events, and open follow-up loops.
- **Wallets**: balances, transfers, signatures, EVM call/quote/swap flows, and approval-gated execution.
- **Connectors**: Discord, Slack, Telegram, WhatsApp, Teams, Matrix, OpenClaw, and more.
- **Extensions**: external tool extensions, UI modules, hooks, and install/update flows.

## Requirements

- Node.js 22.6+
- npm 10+ or another supported package manager
- Docker Desktop is recommended for sandbox/browser execution
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
- Extensions: https://swarmclaw.ai/docs/extensions
- CLI reference: https://swarmclaw.ai/docs/cli
