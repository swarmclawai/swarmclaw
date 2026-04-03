---
name: swarmclaw
description: Manage your SwarmClaw agent fleet — agents, tasks, chats, chatrooms, goals, schedules, memory, wallets, connectors, autonomy, and 40+ more command groups. Use when asked to dispatch work, check agent status, coordinate multi-agent work, run diagnostics, manage schedules, set goals, or orchestrate across a SwarmClaw dashboard instance.
version: 2.2.0
metadata:
  openclaw:
    requires:
      env:
        - SWARMCLAW_ACCESS_KEY
      bins:
        - swarmclaw
    primaryEnv: SWARMCLAW_ACCESS_KEY
emoji: "🦞"
homepage: https://github.com/swarmclawai/swarmclaw
---

## Overview

SwarmClaw is a self-hosted AI agent orchestration platform. This skill gives you CLI access to manage agents, tasks, chats, chatrooms, goals, schedules, memory, wallets, connectors, autonomy controls, webhooks, extensions, and more across one or many SwarmClaw instances.

The CLI maps 1:1 to the SwarmClaw REST API. Every command follows the pattern:

```
swarmclaw <group> <action> [id] [--flags]
```

Install the CLI:

```bash
npm i -g @swarmclawai/swarmclaw
```

## Setup

1. Install: `npm i -g @swarmclawai/swarmclaw`
2. Set env var: `export SWARMCLAW_ACCESS_KEY=<your-key>` (shown in terminal on first run)
3. Default URL: `http://localhost:3456` — override with `SWARMCLAW_URL` or `--base-url`
4. Full docs: https://swarmclaw.ai/docs

## Output Modes

Use machine-readable output when parsing results:

- **`--json`** — structured JSON output (preferred for all API-mapped commands)
- **`--raw`** — plain text output (legacy commands)

Filter results with `--query key=value`:

```bash
swarmclaw tasks list --json --query status=in_progress
swarmclaw memory list --json --query agentId=abc123 --query q=pricing
swarmclaw runs list --json --query sessionId=xyz --query limit=10
```

## Core Commands

### Agents

Manage your agent fleet — create, configure, monitor, and clone agents.

```bash
# List all agents
swarmclaw agents list --json

# Get full agent details
swarmclaw agents get <agentId> --json

# Create an agent (pass JSON body via --data)
swarmclaw agents create --data '{"name":"Research Bot","provider":"anthropic","model":"claude-sonnet-4-20250514"}' --json

# Update agent config
swarmclaw agents update <agentId> --data '{"name":"Updated Name","soul":"You are a research assistant"}' --json

# Get live agent status (running chats, current task, etc.)
swarmclaw agents status <agentId> --json

# Clone an agent with all its config
swarmclaw agents clone <agentId> --json

# Bulk update multiple agents
swarmclaw agents bulk-update --data '{"ids":["id1","id2"],"changes":{"provider":"openai"}}' --json
```

Other: `delete`, `trash`, `restore`, `purge`, `thread`

### Tasks

Create, assign, and track work items on the task board.

```bash
# List all tasks (filterable by status, agent, project)
swarmclaw tasks list --json
swarmclaw tasks list --json --query status=in_progress --query agentId=<id>

# Create and assign a task
swarmclaw tasks create --data '{"title":"Analyse competitor pricing","description":"Research and compare competitor pricing strategies","agentId":"<agentId>"}' --json

# Get task details
swarmclaw tasks get <taskId> --json

# Update task status or fields
swarmclaw tasks update <taskId> --data '{"status":"completed"}' --json

# Get task board metrics (24h, 7d, or 30d)
swarmclaw tasks metrics --json --query range=7d

# Import GitHub issues as tasks
swarmclaw tasks import-github --data '{"repo":"owner/repo","labels":["bug"],"agentId":"<id>"}' --json

# Bulk update tasks
swarmclaw tasks bulk --data '{"ids":["id1","id2"],"changes":{"status":"todo"}}' --json
```

Other: `delete`, `approve`, `claim`, `purge`

### Chats

Manage agent chat sessions — create, send messages, stream responses, and control execution.

> **Terminology:** `chats` in the CLI = "sessions" in the SwarmClaw UI. Both refer to the same thing.

```bash
# List chats
swarmclaw chats list --json

# Create a new chat for an agent
swarmclaw chats create --data '{"agentId":"<agentId>"}' --json

# Send a message and stream the agent response (SSE)
swarmclaw chats chat <chatId> --data '{"message":"Give me a status update"}' --json

# Get chat message history
swarmclaw chats messages <chatId> --json

# Stop a running chat
swarmclaw chats stop <chatId> --json

# Clear chat history
swarmclaw chats clear <chatId> --json

# Append a user message without triggering a response
swarmclaw chats messages-send <chatId> --data '{"role":"user","content":"Note: budget is $5000"}' --json
```

Other: `get`, `update`, `delete`, `delete-many`, `edit-resend`, `retry`, `queue`, `queue-add`, `queue-clear`, `heartbeat-disable-all`, `deploy`, `devserver`, `checkpoints`

### Chatrooms

Multi-agent collaborative spaces where multiple agents discuss and work together.

```bash
# List chatrooms
swarmclaw chatrooms list --json

# Create a chatroom
swarmclaw chatrooms create --data '{"name":"Strategy Room","description":"Multi-agent planning"}' --json

# Add agents to a chatroom
swarmclaw chatrooms add-member <chatroomId> --data '{"agentId":"<agent1>"}' --json
swarmclaw chatrooms add-member <chatroomId> --data '{"agentId":"<agent2>"}' --json

# Send a message — all member agents respond
swarmclaw chatrooms chat <chatroomId> --data '{"message":"What should our Q2 strategy be?"}' --json

# Remove an agent from the chatroom
swarmclaw chatrooms remove-member <chatroomId> --data '{"agentId":"<agentId>"}' --json
```

Other: `get`, `update`, `delete`, `react`, `pin`, `moderate`

### Schedules

Automate recurring agent work on a cron schedule.

```bash
# List schedules
swarmclaw schedules list --json

# Create a schedule (cron syntax)
swarmclaw schedules create --data '{"name":"Daily Report","agentId":"<id>","cron":"0 9 * * *","message":"Generate the daily summary report"}' --json

# Update schedule
swarmclaw schedules update <scheduleId> --data '{"enabled":false}' --json

# Trigger a schedule immediately
swarmclaw schedules run <scheduleId> --json

# Delete a schedule
swarmclaw schedules delete <scheduleId> --json
```

### Memory

Store and retrieve long-term agent memories for context persistence.

```bash
# List memories (searchable)
swarmclaw memory list --json
swarmclaw memory list --json --query q=pricing --query agentId=<id>

# Create a memory entry
swarmclaw memory create --data '{"agentId":"<id>","content":"Client prefers formal tone","type":"preference"}' --json

# Update a memory
swarmclaw memory update <memoryId> --data '{"content":"Updated content"}' --json

# Delete a memory
swarmclaw memory delete <memoryId> --json

# Analyse memory for dedup/prune candidates
swarmclaw memory maintenance --json

# Run the maintenance (dedupe/prune)
swarmclaw memory maintenance-run --json
```

Other: `get`, `graph`

### Goals

Hierarchical goal management — organization, team, project, agent, and task-level goals with parent-child chains.

```bash
# List all goals
swarmclaw goals list --json

# Create a goal
swarmclaw goals create --data '{"title":"Increase revenue 20%","level":"organization","description":"Q2 revenue target"}' --json

# Get goal details
swarmclaw goals get <goalId> --json

# Update a goal
swarmclaw goals update <goalId> --data '{"status":"in_progress"}' --json

# Delete a goal
swarmclaw goals delete <goalId> --json
```

### Knowledge

Manage knowledge sources — manual text, files, and URLs that ground agent responses with citations.

```bash
# List all knowledge entries
swarmclaw knowledge list --json

# Search knowledge
swarmclaw knowledge list --json --query q=pricing

# Create a manual knowledge entry
swarmclaw knowledge create --data '{"title":"Pricing Policy","content":"Standard pricing is...","kind":"manual","tags":["pricing"]}' --json

# Upload a file as knowledge
swarmclaw knowledge upload ./docs/handbook.pdf --json

# Get full source detail (metadata + indexed chunks)
swarmclaw knowledge source-get <sourceId> --json

# List knowledge sources with summaries
swarmclaw knowledge sources --json

# Re-sync a file/URL source
swarmclaw knowledge source-sync <sourceId> --json

# Archive a source
swarmclaw knowledge source-archive <sourceId> --data '{"reason":"outdated"}' --json

# Restore an archived source
swarmclaw knowledge source-restore <sourceId> --json

# Mark a source as superseded by another
swarmclaw knowledge source-supersede <sourceId> --data '{"supersededBySourceId":"<newSourceId>"}' --json

# Get knowledge hygiene summary (stale, duplicate, broken sources)
swarmclaw knowledge hygiene --json

# Run hygiene maintenance (auto-sync stale, archive duplicates)
swarmclaw knowledge hygiene-run --json
```

Other: `get`, `update`, `delete`, `source-create`, `source-update`, `source-delete`

### Search

Global cross-resource search across agents, tasks, chats, schedules, webhooks, and skills.

```bash
swarmclaw search query --json --query q=pricing
```

### System

System health, version, and usage information.

```bash
# Health check (lightweight, safe for polling)
swarmclaw system status --json

# Check current version and updates
swarmclaw system version --json

# View resource usage
swarmclaw system usage --json
```

## More Commands

These groups are available but used less frequently by agents. Use `swarmclaw <group> --help` for full details.

| Group | Description | Key commands |
|-------|-------------|-------------|
| **connectors** | Chat connectors (Discord, Slack, Telegram, etc.) | `list`, `get`, `create`, `update`, `delete`, `start`, `stop`, `repair`, `health`, `doctor` |
| **autonomy** | Supervisor incidents, reflections, emergency stop | `incidents`, `reflections`, `estop`, `estop-set`, `guardian-restore` |
| **approvals** | Human-in-the-loop approval gates | `list`, `resolve` |
| **webhooks** | Inbound webhook triggers and delivery history | `list`, `get`, `create`, `update`, `delete`, `trigger`, `history` |
| **wallets** | Agent wallets and transaction management | `list`, `get`, `create`, `update`, `delete`, `send`, `approve`, `transactions`, `balance-history` |
| **providers** | LLM provider configs and model overrides | `list`, `get`, `create`, `update`, `delete`, `configs`, `ollama`, `models`, `models-set` |
| **gateways** | OpenClaw gateway profiles and health checks | `list`, `create`, `update`, `delete`, `health` |
| **credentials** | Encrypted provider credentials | `list`, `get`, `create`, `delete` |
| **secrets** | Encrypted secret vault | `list`, `get`, `create`, `update`, `delete` |
| **notifications** | In-app notification center | `list`, `create`, `clear`, `mark-read`, `delete` |
| **extensions** | Extension marketplace and config | `list`, `set`, `install`, `marketplace`, `settings-get`, `settings-set`, `builtins` |
| **knowledge** | Knowledge source management and hygiene | `list`, `get`, `create`, `update`, `delete`, `upload`, `sources`, `source-get`, `source-create`, `source-update`, `source-delete`, `source-archive`, `source-restore`, `source-supersede`, `source-sync`, `hygiene`, `hygiene-run` |
| **skills** | Reusable skill management | `list`, `get`, `create`, `update`, `delete`, `import` |
| **learned-skills** | Agent-scoped learned skill review | `list`, `promote`, `dismiss`, `delete`, `review-counts` |
| **skill-suggestions** | AI-generated skill recommendations | `list`, `draft`, `approve`, `reject` |
| **external-agents** | External agent registration and heartbeat | `list`, `create`, `update`, `delete`, `heartbeat` |
| **delegation-jobs** | Cross-agent delegation job tracking | `list` |
| **portability** | Config import/export between installs | `export`, `import` |
| **settings** | App-level configuration | `get`, `update` |
| **runs** | Chat run queue and execution history | `list`, `get`, `events` |
| **activity** | Activity feed events | `list` (supports `--query entityType=`, `--query action=`) |
| **daemon** | Background daemon lifecycle | `status`, `start`, `stop`, `health-check` |
| **logs** | Application logs | `list` (supports `--query lines=200`, `--query level=INFO`), `clear` |
| **setup** | Diagnostics and provider validation | `doctor`, `check-provider` |
| **documents** | Document management and revisions | `list`, `get`, `create`, `update`, `delete`, `revisions` |
| **uploads** | Uploaded artifact management | `list`, `get`, `delete`, `delete-many` |
| **clawhub** | Browse and install ClawHub skills | `search`, `preview`, `install` |
| **openclaw** | OpenClaw gateway control, deploy, sync (30+ subcommands) | `discover`, `gateway-status`, `deploy-*`, `remote-*`, `skills`, `sync` |

## Rules

1. Always verify an agent ID exists by running `agents list` before creating tasks for it.
2. Never pass the access key as a CLI argument in visible output — rely on the `SWARMCLAW_ACCESS_KEY` env var.
3. If the SwarmClaw instance is unreachable, run `swarmclaw setup doctor --json` and report the findings before retrying.
4. When the user says "dispatch work", "get X agent to do Y", or "assign this to", use `tasks create` to assign the work.
5. When the user asks "what's running", "agent status", or "what are my agents doing", combine output from `agents list` and `chats list` to give a full picture.
6. For complex multi-step orchestration, create individual tasks rather than chaining commands.
7. Prefer `--json` output mode for all commands. Use `--raw` only for legacy commands that don't support `--json`.
8. Do not run commands that modify or delete agents without explicit user confirmation.
9. Use `system status` for quick health checks — it's lightweight and safe for repeated polling.
10. Use `search query --query q=<term>` to discover resources across agents, tasks, chats, schedules, and skills.
11. The CLI group `chats` = "sessions" in the SwarmClaw UI. The legacy `sessions` alias is no longer available; always use `chats`.
12. Use `autonomy estop-set` to engage emergency stop across all autonomous agents when safety action is needed.

## Examples

### Dispatch work to another agent

User says: "Get my research agent to analyse competitor pricing"

```bash
swarmclaw agents list --json
# Find the research agent's ID from the output
swarmclaw tasks create --data '{"title":"Analyse competitor pricing","description":"Research and compare competitor pricing strategies, identify gaps and opportunities","agentId":"<research-agent-id>"}' --json
```

Then confirm the task was created and the agent will pick it up.

### Check fleet status

User says: "What are all my agents doing right now?"

```bash
swarmclaw agents list --json
swarmclaw chats list --json
swarmclaw tasks list --json --query status=in_progress
```

Then summarize which agents are idle, which have active chats, and any tasks in progress.

### Run diagnostics

User says: "Something seems wrong with SwarmClaw"

```bash
swarmclaw system status --json
swarmclaw setup doctor --json
```

Check the health summary first (fast), then run full diagnostics if issues are found.

### Multi-agent chatroom collaboration

User says: "Get my strategy and research agents to brainstorm Q2 plans together"

```bash
swarmclaw agents list --json
# Identify the strategy and research agent IDs
swarmclaw chatrooms create --data '{"name":"Q2 Strategy Brainstorm"}' --json
swarmclaw chatrooms add-member <chatroomId> --data '{"agentId":"<strategy-agent-id>"}' --json
swarmclaw chatrooms add-member <chatroomId> --data '{"agentId":"<research-agent-id>"}' --json
swarmclaw chatrooms chat <chatroomId> --data '{"message":"Brainstorm our Q2 growth strategy. Consider market trends, competitor moves, and our current strengths."}' --json
```

### Schedule recurring work

User says: "Have my reporting agent send a daily summary every morning at 9am"

```bash
swarmclaw agents list --json
# Find the reporting agent's ID
swarmclaw schedules create --data '{"name":"Daily Morning Summary","agentId":"<reporting-agent-id>","cron":"0 9 * * *","message":"Generate and send the daily summary report covering key metrics, alerts, and action items from the last 24 hours"}' --json
```

### Emergency stop all autonomous agents

User says: "Stop everything now!"

```bash
swarmclaw autonomy estop-set --data '{"engaged":true}' --json
```

Then confirm the emergency stop is engaged and all autonomous execution has halted.

### Set up a goal hierarchy

User says: "Create a Q2 revenue goal and link my sales agent's tasks to it"

```bash
swarmclaw goals create --data '{"title":"Increase Q2 revenue 20%","level":"organization","description":"Hit $1.2M ARR by end of Q2"}' --json
# Use the returned goalId to link agent tasks
swarmclaw tasks list --json --query agentId=<sales-agent-id>
swarmclaw tasks update <taskId> --data '{"goalId":"<goalId>"}' --json
```

## Discovery

This skill covers the most-used commands. The full CLI has 50+ command groups. To explore:

```bash
swarmclaw --help                    # List all command groups
swarmclaw <group> --help            # List commands in a group
swarmclaw <group> <action> --help   # Show flags for a specific command
```
