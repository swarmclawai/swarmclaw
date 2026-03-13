# SwarmClaw

[![CI](https://github.com/swarmclawai/swarmclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/swarmclawai/swarmclaw/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/tag/swarmclawai/swarmclaw)](https://github.com/swarmclawai/swarmclaw/releases)
[![npm](https://img.shields.io/npm/v/%40swarmclawai%2Fswarmclaw?label=npm)](https://www.npmjs.com/package/@swarmclawai/swarmclaw)

<p align="center">
  <img src="https://raw.githubusercontent.com/swarmclawai/swarmclaw/main/public/branding/swarmclaw-org-avatar.png" alt="SwarmClaw lobster logo" width="120" />
</p>

SwarmClaw is a self-hosted AI orchestration control plane for OpenClaw and multi-agent work. It gives you one place to run agents, route work across providers and gateways, coordinate delegated tasks, manage runtime skills, and operate agent-linked crypto wallets.

GitHub: https://github.com/swarmclawai/swarmclaw  
Docs: https://swarmclaw.ai/docs  
Website: https://swarmclaw.ai  
Plugin tutorial: https://swarmclaw.ai/docs/plugin-tutorial

## What SwarmClaw Focuses On

- **AI orchestration**: LangGraph-backed orchestration, delegated work, subagents, durable jobs, checkpointing, and background task execution.
- **OpenClaw integration**: named gateway profiles, external runtimes, deploy helpers, config sync, approval handling, and OpenClaw agent file editing.
- **Runtime skills**: pinned skills, OpenClaw-compatible `SKILL.md` import, on-demand skill execution, and configurable keyword or embedding-based recommendation.
- **Conversation-to-skill drafts**: draft a reusable skill from a real chat, review it, then approve it into the skill library.
- **Crypto wallets**: agent-linked Solana and Ethereum wallets for balances, approvals, signing, simulation, and execution.
- **Operator tooling**: connectors, memory, plugins, browser automation, shell/files/git tooling, and runtime guardrails.

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

Running `swarmclaw` starts the server on `http://localhost:3456`.

### One-off run

```bash
npx @swarmclawai/swarmclaw
```

### From the repo

```bash
git clone https://github.com/swarmclawai/swarmclaw.git
cd swarmclaw
npm run quickstart
```

`npm run quickstart` installs dependencies, prepares local config and runtime state, and starts SwarmClaw.

## Skill Drafts From Conversations

- From any active chat, use **Draft Skill** in the chat header.
- Or open **Skills** and use **Draft From Current Chat**.
- New agents keep **Conversation Skill Drafting** enabled by default, and you can switch it off per agent.
- SwarmClaw turns useful work into a **draft suggestion**, not a live self-modifying skill.
- Review the suggested name, rationale, summary, and transcript snippet.
- Approve it to save it into the normal skill library, or dismiss it.
- Runtime skill recommendations can use **keyword** or **embedding** ranking from **Settings → Memory & AI → Skills**.

## Core Capabilities

- **Providers**: OpenClaw, OpenAI, Anthropic, Ollama, Google, DeepSeek, Groq, Together, Mistral, xAI, Fireworks, plus compatible custom endpoints.
- **Delegation**: built-in delegation to Claude Code, Codex CLI, OpenCode CLI, Gemini CLI, and native SwarmClaw subagents.
- **Memory**: hybrid memory search, graph traversal, journaling, and durable document storage.
- **Wallets**: balances, transfers, signatures, EVM call/quote/swap flows, and approval-gated execution.
- **Connectors**: Discord, Slack, Telegram, WhatsApp, Teams, Matrix, OpenClaw, and more.
- **Plugins**: tool plugins, UI extensions, hooks, install/update flows, and runtime policy controls.

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
- Orchestration: https://swarmclaw.ai/docs/orchestration
- Connectors: https://swarmclaw.ai/docs/connectors
- Plugins: https://swarmclaw.ai/docs/plugins
- CLI reference: https://swarmclaw.ai/docs/cli
