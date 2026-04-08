---
name: swarmclaw
description: AI agent runtime and multi-agent orchestration platform. Teaches agents how to use SwarmClaw's 6 primitive tools, persistent memory, dreaming, delegation, connectors, credentials, and the skill system. Use when an agent is running on SwarmClaw and needs to understand the platform's capabilities.
metadata:
  openclaw:
    emoji: "\U0001F41D"
    privacyPolicy: All data stays on the local SwarmClaw instance. Memory, workspace files, and session data are stored on the host machine. No data is sent to external services unless the agent explicitly calls an external API.
    dataHandling: Agent memory is stored locally in the SwarmClaw data directory. Workspace files are scoped per agent. Credentials are injected as environment variables and automatically redacted from tool output.
version: 2.4.1
author: swarmclawai
homepage: https://swarmclaw.ai
tags: [agents, orchestration, multi-agent, runtime, memory, delegation, skills, connectors, dreaming]
---

# SwarmClaw Platform

SwarmClaw is an AI agent runtime and multi-agent orchestration platform. It gives agents a uniform set of tools, persistent memory, connector integrations, and the ability to delegate work to other agents.

Website: https://swarmclaw.ai
Docs: https://swarmclaw.ai/docs
GitHub: https://github.com/swarmclawai/swarmclaw
npm: `npm install -g swarmclaw`

## The 6 Primitive Tools

Every agent has access to these core tools. They cover the full range of agent capabilities.

| Tool | Purpose | When to Use |
|------|---------|-------------|
| **files** | Read, write, edit, list, search files | Any file operation on the workspace filesystem |
| **execute** | Run bash scripts (sandboxed or host) | Shell commands, curl, data processing, package management |
| **memory** | Store and retrieve persistent knowledge | Facts, preferences, decisions that should survive across sessions |
| **platform** | Tasks, communication, delegation, projects | Coordinating with humans and other agents |
| **browser** | Control a headless browser | Interactive web pages, JavaScript-rendered content |
| **skills** | Discover and load skill documentation | Learning how to use tools, APIs, or workflows |

### Tool Selection Guide

| Task | Tool |
|------|------|
| Edit a source file | `files` (edit action) |
| Run tests | `execute` |
| Call a REST API (JSON) | `execute` (curl) |
| Scrape a dynamic web page | `browser` |
| Remember a user preference | `memory` |
| Ask the user a question | `platform` (communicate.ask_human) |
| Send a Slack message | `platform` (communicate.send_message) |
| Hand off work to another agent | `platform` (communicate.delegate) |
| Find out how a tool works | `skills` (read action) |

## Credentials

Credentials are configured per agent in the SwarmClaw UI. They are:

- **Injected as environment variables** into `execute` tool runs (e.g., `$OPENAI_API_KEY`, `$GITHUB_TOKEN`)
- **Automatically redacted** from all tool output -- secrets never appear in chat history
- **Named by convention**: `<PROVIDER>_API_KEY` or custom names set in the credential config

You never need to ask the user for API keys directly. If a credential is configured, it's available as an env var. If it's not configured, tell the user which credential to add in the agent settings.

## The Skill System

Skills are markdown files that teach agents how to use tools, APIs, and workflows. They are documentation, not executable code.

### Loading Skills

```json
{ "tool": "skills", "action": "list" }
{ "tool": "skills", "action": "read", "name": "tools/files" }
{ "tool": "skills", "action": "search", "query": "github pr" }
```

### Skill Locations

- `skills/` -- built-in skills shipped with SwarmClaw
- `data/skills/` -- user-created skills added at runtime

### When to Load Skills

- Before using a tool you're unfamiliar with
- When a task involves an API or workflow you haven't used before
- When the user asks you to do something and you're unsure of the best approach

## Agent Capabilities

### Memory

Agents have persistent memory across sessions:

- **Working memory** (session-scoped): scratch notes, intermediate results
- **Durable memory** (cross-session): user preferences, project facts, decisions
- Memories are automatically surfaced in context when relevant
- Store important learnings proactively -- don't wait to be asked

### Dreaming

Agents with dreaming enabled automatically consolidate memories during idle periods. You can also trigger a dream manually:

#### Check dream status
```json
{ "tool": "memory", "action": "list", "category": "dream_reflection" }
```

#### Manual dream trigger
Use the platform API to trigger a dream cycle:
```json
{ "tool": "execute", "command": "curl -s -X POST http://localhost:3456/api/memory/dream -H 'Content-Type: application/json' -d '{\"agentId\":\"YOUR_AGENT_ID\"}'" }
```

Dream cycles produce `dream_reflection` and `consolidated_insight` memories that help maintain a clean, coherent memory store over time.

### Delegation

Agents can delegate work to other agents:

- **delegate**: route a task to a specific agent and wait for the result
- **spawn**: create a subagent that runs independently (fire-and-forget or session-based)
- Use `agents.list` to discover available agents and their specializations

### Connectors

Agents can communicate through external platforms:

- Discord, Slack, Telegram, and custom webhooks
- Messages sent via `platform` tool with `communicate.send_message`
- Inbound messages from connectors trigger agent sessions automatically

## Workspace Conventions

- The workspace root is the agent's working directory
- File paths in tool calls are relative to the workspace root
- `/workspace/...` paths are resolved to the workspace root automatically
- The `$WORKSPACE` env var points to the workspace root in execute tool runs

## Best Practices

1. **Load skills before unfamiliar operations.** A 30-second skill read prevents minutes of trial and error.

2. **Use the right tool for the job.** Don't use `execute` with `echo > file.txt` when `files` write action is cleaner. Don't use `browser` when `curl` in `execute` suffices.

3. **Store important context in memory.** If you learn something that would help in future sessions (user preference, project convention, API quirk), store it immediately.

4. **Ask rather than guess.** When genuinely uncertain about user intent, use `communicate.ask_human`. A brief clarification is better than wasted work on the wrong approach.

5. **Delegate when appropriate.** If another agent is better suited for a subtask, delegate. Check `agents.list` to know what's available.

6. **Be explicit about what you're doing.** When running commands, editing files, or making decisions, explain your reasoning. Transparency builds trust.

7. **Respect file access boundaries.** Stay within the workspace unless the agent has machine-scope access. Never write to system directories.

8. **Handle errors gracefully.** When a tool call fails, read the error message, diagnose the issue, and retry with a corrected approach. Don't repeat the same failing call.
