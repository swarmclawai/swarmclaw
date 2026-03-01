# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SwarmClaw is a self-hosted AI agent orchestration dashboard. It manages multiple LLM providers, orchestrates agent swarms, schedules tasks, and bridges agents to chat platforms (Discord, Slack, Telegram, WhatsApp).

## Repository Structure

Monorepo with two projects:
- `swarmclaw-app/` — Main application (Next.js 16 + React 19 + TypeScript)
- `swarmclaw-site/` — Static documentation site (Next.js)

All development commands run from `swarmclaw-app/`.

## Commands

```bash
cd swarmclaw-app
npm install          # install dependencies
npm run dev          # dev server on 0.0.0.0:3456
npm run build        # production build
npm run lint         # ESLint
```

Docker: `docker compose up -d` (from `swarmclaw-app/`)

No test framework is configured.

## Architecture

### Frontend
- **UI**: Tailwind v4 + shadcn/ui + Radix primitives
- **State**: Zustand stores in `src/stores/` (`use-app-store.ts`, `use-chat-store.ts`)
- **Pages/Routes**: Next.js App Router in `src/app/`
- **Components**: `src/components/` organized by domain (agents, auth, chat, connectors, providers, schedules, tasks)

### Backend (Next.js API Routes)
All API routes live under `src/app/api/`. Key endpoints:
- `/sessions/[id]/chat` — SSE streaming chat
- `/agents/` — Agent CRUD + `/generate` for AI-powered creation
- `/connectors/` — Chat platform bridge management
- `/tasks/`, `/schedules/` — Task board and cron scheduling
- `/secrets/` — Encrypted credential vault
- `/orchestrator/run/` — Multi-agent orchestration trigger
- `/daemon/` — Background daemon status

### Server Core (`src/lib/server/`)
- `storage.ts` — SQLite (WAL mode) with JSON-blob collections pattern: each table has `id TEXT PRIMARY KEY, data TEXT NOT NULL`
- `memory-db.ts` — Hybrid FTS5 + vector embeddings for agent memory (separate `data/memory.db`)
- `orchestrator.ts` / `orchestrator-lg.ts` — Multi-agent orchestration (plain + LangGraph), max 10 turns
- `stream-agent-chat.ts` — SSE streaming implementation
- `daemon-state.ts` — Background daemon (30s heartbeat) running scheduler + task queue
- `connectors/` — Chat platform bridges (Discord, Slack, Telegram, WhatsApp) with `manager.ts` routing messages
- `session-tools.ts` — Agent tool execution (shell, files, web search, browser, claude_code delegation)
- `plugins.ts` — Plugin system with lifecycle hooks (JS files in `data/plugins/`)
- `cost.ts` — Token counting and pricing per provider/model
- `embeddings.ts` — Vector embedding provider integration

### LLM Providers (`src/lib/providers/`)
Each provider implements a `streamChat` function. Provider registry in `index.ts` handles:
- Built-in: `claude-cli`, `anthropic`, `openai`, `ollama`, `openclaw`
- Custom providers (stored in DB) use OpenAI-compatible handler with custom `baseUrl`
- Automatic failover through `streamChatWithFailover()` on 401/429/5xx errors

### Types
Core type definitions in `src/types/index.ts`: `Agent`, `Session`, `Message`, `ProviderType`, `Connector`, `Schedule`, `MemoryEntry`, `BoardTask`, `Skill`, `Plugin`, `PluginHooks`

### Data
- `data/swarmclaw.db` — Main SQLite database (sessions, agents, tasks, usage, etc.)
- `data/memory.db` — Agent memory with FTS5 + vector search
- `data/plugins/` — Plugin JS files
- `.env.local` — Auto-generated config (`ACCESS_KEY`, `CREDENTIAL_SECRET`, `PORT=3456`)

### Commit Messages
- Never reference "Claude", "Anthropic", or "Co-Authored-By" in commit messages
- Write commit messages as if a human authored the code

### OpenClaw Device Pairing (added in v0.3.0, commit `9558813`)

SwarmClaw authenticates to OpenClaw gateways using ed25519 device identity, not just API tokens. The full flow:

**Identity resolution** (`src/lib/providers/openclaw.ts` — `loadOrCreateDeviceIdentity()`):
1. Checks `~/.openclaw/identity/device.json` (or `~/.clawdbot/identity/device.json`) — reuses the CLI's keypair if already paired
2. Falls back to `data/openclaw-device.json` (SwarmClaw's own identity)
3. If neither exists, generates a new ed25519 keypair, writes to `data/openclaw-device.json` with mode `0o600`
4. `deviceId` is derived from the public key via `fingerprintPublicKey()`

**Connection test** (`src/app/api/setup/check-provider/route.ts` — `checkOpenClaw()`):
1. Calls `getDeviceId()` to resolve the device identity
2. Opens a WebSocket to the gateway via `wsConnect()` which signs a nonce challenge with the private key
3. Gateway returns success (paired), or an error message containing "pairing"/"not paired"/"pending approval" → mapped to `PAIRING_REQUIRED`, or "signature"/"device auth" → mapped to `DEVICE_AUTH_INVALID`

**Agent sheet UX** (`src/components/agents/agent-sheet.tsx`):
- Bottom button: idle → **Connect**, testing → **Connecting...**, `PAIRING_REQUIRED` → **Retry Connection**, other fail → **Retry**, pass → **Save**
- `PAIRING_REQUIRED` and `DEVICE_AUTH_INVALID` blocks show an **Approve in Dashboard** link that opens the gateway URL (with auto `http://` prefix for bare host:port)
- Inline status block handles all feedback; bottom error/success bars are hidden for OpenClaw (`!openclawEnabled && ...`)
- On successful test, skips the 1.5s delay and saves immediately

**Important files**:
- `data/openclaw-device.json` — SwarmClaw's device keypair. In `.gitignore`. **Never commit this** (contains private key)
- `src/lib/providers/openclaw.ts` — `loadOrCreateDeviceIdentity()`, `getDeviceId()`, `wsConnect()`, nonce signing
- `src/app/api/setup/check-provider/route.ts` — `checkOpenClaw()` calls `wsConnect` and returns `errorCode`
- `src/app/api/setup/openclaw-device/route.ts` — GET endpoint exposing device ID
- `src/components/agents/agent-sheet.tsx` — UI for the pairing flow (~lines 658-740)

### Real-time & Communication Patterns

**Three transport layers serve different consumers:**

| Transport | Port | Consumer | Purpose |
|-|-|-|-|
| HTTP REST API | `PORT` (3456) | CLI, external tools, frontend mutations | CRUD operations, all writes go through here |
| SSE (Server-Sent Events) | `PORT` (3456) | Frontend chat | Streaming LLM responses via `/api/sessions/[id]/chat` |
| WebSocket push | `PORT + 1` (3457) | Frontend state sync | Notify-on-mutate: pushes topic invalidations so clients re-fetch |

**WebSocket architecture (`ws-hub.ts` / `ws-client.ts` / `use-ws.ts`):**
- Separate WS server on `PORT + 1`, started from `instrumentation.ts`, stored on `globalThis.__swarmclaw_ws__` (HMR-safe)
- Auth: `?key=` query param validated against access key
- Protocol: clients subscribe to topics, server broadcasts `{topic, action, id?}` — no data over WS, just invalidation signals
- Topics: `daemon`, `sessions`, `tasks`, `runs`, `connectors`, `agents`, `providers`, `schedules`, `logs`, `messages:{sessionId}`, `browser:{sessionId}`
- `notify(topic)` is called from API route handlers and server modules after writes
- Frontend `useWs(topic, handler, fallbackMs?)` hook subscribes and falls back to polling when WS is disconnected
- `fallbackMs` is read from a ref (not an effect dep) to avoid teardown/re-render loops — changing fallback rate does not re-create the WS subscription
- `connectWs(key)` is called from `page.tsx` after auth; `disconnectWs()` on logout

**CLI (`src/cli/index.ts`, `bin/server-cmd.js`):**
- CLI talks exclusively to the HTTP REST API — no WebSocket dependency
- `bin/server-cmd.js` manages the server process: `start`/`stop`/`status`, `--port`, `--ws-port`, `--host`, `--detach`
- `WS_PORT` env var is passed to the spawned server process

### Key Patterns
- **Storage**: All entities stored as JSON blobs in SQLite collections, not normalized tables
- **Streaming**: SSE (Server-Sent Events) for real-time chat responses
- **Auth**: Single access key gate (no user accounts). API uses `X-Access-Key` header or `?key=` param (see `middleware.ts`)
- **Secrets**: AES-256 encrypted credential vault (`CREDENTIAL_SECRET` env var)
- **Native deps**: `better-sqlite3` requires native build (python3, make, g++ in Docker)
- **Standalone build**: `next.config.ts` sets `output: 'standalone'` for self-contained deployment
