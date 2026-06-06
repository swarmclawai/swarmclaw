---
name: swarmclaw-parallel-agenting
description: Use when decomposing a large SwarmClaw task into direct assigned worker tasks, especially app builds, multi-file implementation plans, QA sweeps, or independent failure investigations that can run without shared write conflicts.
tags: [swarmclaw, tasks, parallel-agenting, coordination, qa]
---

# SwarmClaw Parallel Agenting

Draft status: repo-local review draft only. Do not install, import, pin, or attach this skill without Zmey's checkpoint.

This skill turns one large target into several observable SwarmClaw tasks with clear owners, bounded scopes, and review checkpoints.

## Source And Local Policy

This draft was written for Zmey's local SwarmClaw instance after auditing:

- Local operator registry: `docs/operations/swarmclaw-skill-intake-specialist-registry.md`
- Upstream inspiration: `subagent-driven-development` from `NeoLabHQ/context-engineering-kit`
- Upstream checked file: `plugins/sadd/skills/subagent-driven-development/SKILL.md`, blob `c5693fae070ed2c7f621e07ed25d1761c2134d1c`
- Upstream license observed: GPL-3.0

This is a SwarmClaw-local rewrite, not a bulk import. The local rules win over upstream instructions.

## When To Use

Use this skill when:

- The user asks for a full app, broad feature, multi-part refactor, or multi-page UI.
- There are three or more independent bugs, test failures, or investigation domains.
- Work can be split by subsystem, route, component, file group, or responsibility.
- A read-only review can run in parallel with implementation.

Do not use it when:

- The task is small enough for one agent.
- Workers would edit the same files or shared state without a merge plan.
- The next step depends on one blocking decision that the main operator must make first.
- The work requires changes to credentials, providers, schedules, autonomy, public exposure, state DB, or `.env.local` without an explicit checkpoint.

## Non-Negotiables

- Keep SwarmClaw local-only. Never expose port `3456` publicly.
- Use direct managed task assignment by exact stored agent ID as the default.
- Verify agent IDs in the live instance or current operator manual before assignment.
- Do not rely on the stored Coordinator as a true `spawn_subagent` orchestrator in the current CLI-provider setup.
- Give every task a bounded scope, expected output, and verification evidence.
- Parallel write tasks must have disjoint write scopes.
- Read-only QA/review tasks can run while implementation is active.
- Save durable memory only after a result is verified.
- Refresh Knowledge or install/pin skills only after Zmey checkpoints that exact action.

## Default Workers

Use these only after confirming they still match the current instance:

| Worker | ID | Default use |
|---|---|---|
| Builder | `92b8cd6c` | Primary implementation and repo tasks. |
| Reviewer QA | `c2cd6ff9` | Reviews, quality triage, regression checks. |
| Copilot Mini Worker | `e74dd145` | Small bounded coding or summarization tasks. |
| OpenCode Builder | `a0f79bad` | Alternate implementation worker. |
| OpenCode Go Helper | `cc51c5e6` | Alternate bounded helper. |

Avoid `opencode-go/deepseek-v4-flash` for normal worker tasks because headless runs can exit successfully without assistant text.

## Workflow

### 1. Define The Target

Write a one-paragraph target:

- what must exist when done
- what is out of scope
- affected repo or project path
- user-visible acceptance criteria
- checkpoints required before high-risk actions

If the target is vague, create a Product Architect planning task first instead of starting implementation.

### 2. Split Workstreams

Split by ownership boundary:

- product/spec
- architecture/API contract
- frontend
- backend
- data/storage
- integration
- QA/regression
- security/release review
- docs/handoff

Prefer fewer high-quality tasks over many tiny tasks. Each task needs a clear definition of done.

### 3. Decide Sequential Or Parallel

Use sequential execution when:

- task B depends on task A's design or files
- workers would touch the same files
- one failure could invalidate later work

Use parallel execution when:

- tasks are independent
- write scopes do not overlap
- review can happen after the batch
- the main operator can integrate outputs

Use read-only parallel review when:

- implementation is underway
- QA can inspect plans, diffs, or routes without changing files
- you want early risk detection

### 4. Create Direct Assigned Tasks

Each task description must include:

- exact target agent ID
- purpose and non-goals
- allowed files or read-only scope
- relevant `AGENTS.md` constraints
- command/test limits
- expected evidence marker
- required final report fields
- whether the task may write files
- whether the task may ask for checkpoint before risky actions

Avoid assignment-looking phrases in the description when the API payload already sets the target worker. The task parser can treat `@mentions`, `assigned to`, `agent:`, `agent id:`, or `for agent` as reassignment hints and override the explicit worker ID. After creating a task, verify the stored `agentId`.

Task workspaces are isolated under the SwarmClaw state workspace. Newly edited repo docs may not exist inside the current runtime image or task workspace until the service is rebuilt or files are deliberately staged. For CLI-backed task runs that must use a new local doc, embed a short sanitized excerpt in the task description or explicitly stage the file after checkpoint.

Create and queue normal work through the GUI or authenticated app/API path. Do not import SwarmClaw route services from a one-off shell process for routine task assignment; that shortcut can bypass the live app context and produce `process_lost` daemon-recovery failures.

Task title format:

```text
[Role] [Project/Area]: [short objective] YYYY-MM-DD HH:MM
```

Evidence marker format:

```text
SWARMCLAW_[AREA]_[ROLE]_[SHORT_GOAL]_OK
```

### 5. Monitor

Watch:

- `/tasks` for status, assignment, dependencies, and failed validations
- `/runs` for queued/running/completed/failed execution
- `/quality` for eval gates or quality incidents
- `/logs` for sanitized runtime warnings
- `/autonomy` only read-only unless checkpointed

Do not retry, cancel, archive, or edit task state unless the user approved that action.

### 6. Review And Integrate

After each batch:

- read each worker's final report
- verify changed files are within scope
- check for conflicting edits
- run focused tests or browser checks
- assign Reviewer QA for read-only review when risk is meaningful
- consolidate decisions in the main operator thread

Critical issues block integration. Important issues should be fixed before the next batch. Minor issues can be tracked if they do not affect correctness or safety.

### 7. Finish

Before calling the work complete:

- all implementation tasks are completed or deliberately deferred
- QA/review findings are resolved or accepted by Zmey
- verification commands or browser checks are reported
- no new local-only or secret-hygiene violations exist
- durable lessons are saved to agentmemory if verified
- handoff stays short and only captures durable state

## Task Prompt Template

```markdown
You are working inside Zmey's local SwarmClaw instance.

Task: [specific objective]
Assigned role: [Builder / Reviewer QA / etc.]
Allowed scope: [files, directories, routes, or read-only]
Non-goals: [what not to touch]

Rules:
- Follow AGENTS.md.
- Do not inspect or print secrets, auth JSON, full env files, tokens, credential files, private keys, or raw credential output.
- Keep SwarmClaw local-only; never expose port 3456 publicly.
- Do not change .env.local, provider routing, state DB, tasks, schedules, autonomy, credentials, or public exposure settings without checkpoint.
- Do not kill, restart, or replace the dev server on port 3456.
- If blocked, report the blocker and the safest next action.

Expected output:
- Summary of what you did.
- Files changed, or "none".
- Verification performed.
- Any risks or follow-up tasks.
- Evidence marker: SWARMCLAW_[AREA]_[ROLE]_[SHORT_GOAL]_OK
```

## Review Prompt Template

```markdown
Review this worker result read-only.

Worker task: [title/id]
Claimed result: [summary]
Allowed scope: [scope]
Acceptance criteria: [criteria]

Check:
- Did the worker stay in scope?
- Are tests or browser checks adequate?
- Are there risky assumptions?
- Are there secret-hygiene or local-only violations?
- Are follow-up tasks needed?

Return:
- Findings ordered by severity.
- Verification gaps.
- Recommendation: accept, request changes, or block.
```

## Stop Conditions

Stop and ask Zmey before:

- changing credentials, providers, schedules, autonomy, wallets, connectors, webhooks, MCP servers, extensions, public exposure, state DB, or `.env.local`
- installing or pinning runtime skills
- creating or reconfiguring specialist agents
- restarting or replacing the dev server on port `3456`
- running broad destructive commands
- using external SaaS automation or OAuth flows
- adopting a git worktree workflow

Stop and re-plan before:

- two workers need the same write files
- a worker returns no assistant text
- a task completes but validation fails
- tests fail repeatedly without root cause
- a plan no longer matches observed runtime behavior
- a worker cannot find required source files in its isolated task workspace
- a created task's stored `agentId` does not match the intended worker

## Verification Checklist

For this skill itself:

- It is in `docs/operations/skill-drafts/`, not runtime `skills/`.
- It has no secret-like strings.
- It references direct assignment and checkpoints.
- It does not instruct agents to expose ports or inspect credentials.
- It can be tested with one read-only planning task plus one Reviewer QA review task.

## Live Test Notes

2026-06-06 safe-shell test:

- Diagnostic planning task `c568d8b8` completed with marker `SWARMCLAW_PARALLEL_AGENTING_PLANNING_READONLY_OK` but reported that relative repo docs were missing from the isolated task workspace.
- Diagnostic review task `73b9bb81` completed with marker `SWARMCLAW_PARALLEL_AGENTING_REVIEW_READONLY_OK`, but the description text accidentally reassigned it to Builder because it contained an assignment-looking upstream worker line.
- Corrected planning task `fd8004f3` embedded a sanitized draft excerpt and completed with marker `SWARMCLAW_PARALLEL_AGENTING_PLANNING_EMBEDDED_OK`.
- Corrected review task `0f3074eb` avoided assignment-looking phrases, stayed on Reviewer QA `c2cd6ff9`, completed with marker `SWARMCLAW_PARALLEL_AGENTING_REVIEW_EMBEDDED_OK`, and recommended accepting the workflow as a runtime candidate after Zmey review with one minor clarification: enumerate expected evidence per worker before real execution.
