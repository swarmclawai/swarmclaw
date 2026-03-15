# SwarmClaw

[![CI](https://github.com/swarmclawai/swarmclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/swarmclawai/swarmclaw/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/tag/swarmclawai/swarmclaw)](https://github.com/swarmclawai/swarmclaw/releases)
[![npm](https://img.shields.io/npm/v/%40swarmclawai%2Fswarmclaw?label=npm)](https://www.npmjs.com/package/@swarmclawai/swarmclaw)

<p align="center">
  <img src="https://raw.githubusercontent.com/swarmclawai/swarmclaw/main/public/branding/swarmclaw-org-avatar.png" alt="SwarmClaw lobster logo" width="120" />
</p>

SwarmClaw is a self-hosted AI runtime for OpenClaw and multi-agent work. It helps you run autonomous agents with heartbeats, schedules, delegation, memory, runtime skills, and reviewed conversation-to-skill learning across OpenClaw gateways and other providers.

GitHub: https://github.com/swarmclawai/swarmclaw  
Docs: https://swarmclaw.ai/docs  
Website: https://swarmclaw.ai  
Extension tutorial: https://swarmclaw.ai/docs/extension-tutorial

<div align="center">
<table>
 <tr>
  <td align="center"><strong>Works<br>with</strong></td>
  <td align="center"><img src="doc/assets/logos/openclaw.svg" width="32" alt="OpenClaw"><br><sub>OpenClaw</sub></td>
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

## Release Notes

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

- **Delegation and background execution**: delegated work, subagents, durable jobs, checkpointing, and background task execution.
- **Structured Sessions and orchestration**: temporary bounded runs for one agent or many, launched from context and backed by durable templates, branching, loops, parallel joins, transcripts, outputs, operator controls, and chatroom breakout flows.
- **Autonomy and memory**: heartbeats, schedules, long-running execution, durable memory, reflection memory, human-context learning, document recall, and project-aware context.
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
