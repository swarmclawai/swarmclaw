---
name: swarmclaw
description: Manage your SwarmClaw agent fleet, create and assign tasks, check agent and session status, trigger workflows, and orchestrate multi-agent work from chat. Use when asked to dispatch work to other agents, check what agents are doing, run diagnostics, or coordinate across a SwarmClaw dashboard instance.
version: 1.0.0
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

SwarmClaw is a self-hosted AI agent orchestration dashboard. This skill gives you CLI access to manage agents, tasks, sessions, schedules, and memory across a SwarmClaw instance.

Install the CLI:

```bash
npm i -g @swarmclawai/swarmclaw
```

Authentication uses `SWARMCLAW_ACCESS_KEY` (preferred) or CLI key flags. Default URL is `http://localhost:3456`; override with `SWARMCLAW_URL`, `--url` (legacy commands), or `--base-url` (API-mapped commands).

Use machine-readable output when parsing command results:
- `--raw` for legacy commands
- `--json` for API-mapped commands

## Commands

Agents:

- `swarmclaw agents list` — list all agents with IDs, names, providers, status
```bash
swarmclaw agents list --raw
```
- `swarmclaw agents get <agentId>` — get full details for a specific agent
```bash
swarmclaw agents get <agentId> --raw
```

Tasks:

- `swarmclaw tasks create --title "..." --description "..." --agent-id <agentId>` — create and assign a task
```bash
swarmclaw tasks create --title "Analyse competitor pricing" --description "Research and compare competitor pricing strategies, identify gaps and opportunities" --agent-id <agentId> --raw
```
- `swarmclaw tasks list` — list all tasks with status
```bash
swarmclaw tasks list --raw
```

Sessions:

- `swarmclaw sessions list` — list active sessions
```bash
swarmclaw sessions list --raw
```
- `swarmclaw sessions main-loop <id>` — inspect/trigger mission loop state for a background session
```bash
swarmclaw sessions main-loop <id> --json
```
- `swarmclaw sessions chat <id> --data '{"message":"..."}'` — send a message to an existing session
```bash
swarmclaw sessions chat <id> --data '{"message":"Give me a status update"}' --json
```

Memory:

- `swarmclaw memory maintenance` — run memory maintenance analysis
```bash
swarmclaw memory maintenance --raw
```

Diagnostics:

- `swarmclaw setup doctor` — run system diagnostics and report issues
```bash
swarmclaw setup doctor --raw
```

Version:

- `swarmclaw version get` — check current version and update status
```bash
swarmclaw version get --json
```

## Rules

1. Always verify an agent ID exists by running `agents list` before creating tasks for it.
2. Never pass the access key as a CLI argument in visible output — rely on the `SWARMCLAW_ACCESS_KEY` env var.
3. If the SwarmClaw instance is unreachable, run `swarmclaw setup doctor` and report the findings before retrying.
4. When the user says "dispatch work", "get X agent to do Y", or "assign this to", use `tasks create` to assign the work to the appropriate agent.
5. When the user asks "what's running", "agent status", or "what are my agents doing", combine output from `agents list` and `sessions list` to give a full picture.
6. For complex multi-step orchestration, create individual tasks rather than chaining commands.
7. Use `--raw`/`--json` output modes when you need to parse command output for further processing.
8. Do not run commands that modify or delete agents without explicit user confirmation.

## Examples

Dispatch work to another agent:
User says: "Get my research agent to analyse competitor pricing"

```bash
swarmclaw agents list --raw
swarmclaw tasks create --title "Analyse competitor pricing" --description "Research and compare competitor pricing strategies, identify gaps and opportunities" --agent-id <research-agent-id> --raw
```

Then confirm the task was created and the agent will pick it up.

Check fleet status:
User says: "What are all my agents doing right now?"

```bash
swarmclaw agents list --raw
swarmclaw sessions list --raw
```

Then summarize which agents are idle, which have active sessions, and any tasks in progress.

Run diagnostics:
User says: "Something seems wrong with SwarmClaw"

```bash
swarmclaw setup doctor --raw
```

Then report issues found and suggest fixes based on the doctor output.
