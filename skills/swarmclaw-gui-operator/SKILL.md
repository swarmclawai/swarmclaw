---
name: swarmclaw-gui-operator
description: Use when operating Zmey's local SwarmClaw GUI, creating or queueing tasks, monitoring runs, routing agents, triaging SwarmClaw failures, syncing Knowledge after checkpoint, or preparing concise handoffs.
tags: [swarmclaw, gui-operator, tasks, runs, knowledge, local-only]
---

# SwarmClaw GUI Operator

Operate Zmey's local SwarmClaw instance safely and leave enough evidence that the next agent can continue without guessing.

## Source Order

Use these sources in order:

1. `AGENTS.md`
2. `/home/zmey/2. Personal/Codex/swarmclaw-agent-handoff.md`, if readable
3. `docs/operations/swarmclaw-next-agent-quickstart.md`
4. `docs/operations/swarmclaw-gui-operator-manual.md`
5. `docs/operations/swarmclaw-operator-failure-catalog.md`
6. Live GUI behavior at `http://127.0.0.1:3456`
7. agentmemory and official SwarmClaw docs

If sources conflict, prefer live local runtime behavior for Zmey's instance and record the conflict.

## Non-Negotiables

- Keep SwarmClaw local-only. Never expose port `3456` publicly.
- Do not kill, restart, replace, or rebind the server/container on port `3456` without asking first.
- Do not inspect or print secrets, auth JSON, full env files, tokens, credential files, private keys, raw credential output, or credential table values.
- Do not change `.env.local`, provider routing, state DB, tasks, schedules, autonomy, credentials, public exposure, managed skills, or in-app Knowledge records without checkpoint.
- Keep the external handoff short. Put detailed procedures in repo docs.

## Start Routine

1. Search agentmemory for recent SwarmClaw lessons.
2. Read the concise handoff and quickstart.
3. Confirm health and local-only binding:
   - `curl -fsS http://127.0.0.1:3456/api/healthz`
   - `docker compose -f compose.subscription.yml ps`
4. Open the GUI in read-only mode before recommending writes.
5. State the next safest action and whether it needs a checkpoint.

## Default Task Routine

Use direct managed assignment by exact stored agent ID:

- Builder `92b8cd6c` for primary implementation.
- Reviewer QA `c2cd6ff9` for review, QA, browser evidence, and quality triage.
- Copilot Mini Worker `e74dd145` for small bounded work.
- OpenCode Builder `a0f79bad` and OpenCode Go Helper `cc51c5e6` for verified alternate helper work.

Create tasks in `/tasks`. New Task creates a backlog item by default; queue it with the task card `Queue` button. Verify stored status and `agentId` after creation and after queueing.

Avoid assignment-looking prose such as `assigned to`, `agent:`, `agent id:`, or `for agent` when the GUI/payload already sets the target worker.

## Evidence Routine

For completed work, collect:

- task ID
- assigned agent ID
- session/run ID if visible
- final status
- files changed or "none"
- verification command, browser check, or GUI proof
- evidence marker
- open risks or follow-up

For browser work, include tool, target route, HTTP status if checked, final URL or ready signal, page error count, request failure count, and screenshot/DOM evidence when available.

## Failure Routine

Before retrying:

1. Preserve task/run/session IDs.
2. Classify the failure family.
3. Check `docs/operations/swarmclaw-operator-failure-catalog.md`.
4. Fix the cause or change the procedure.
5. Verify the fix.
6. Save a concise non-secret agentmemory lesson if the lesson is durable.

Known high-value checks: `process_lost`, quality gate evidence mismatch, backlog task not queued, CLI worker missing Knowledge/skill body, unauthenticated worker browser, wrong agent assignment, and stale Knowledge inline content.

## Knowledge And Skill Changes

Repo docs and repo skill files are normal code artifacts. In-app Knowledge records, managed skills, and agent skill pinning mutate runtime state and require a checkpoint naming the exact target and rollback plan.

If a CLI worker must use a doc or skill immediately, embed a short sanitized excerpt in the task prompt unless the managed skill is already pinned and verified.

## Report Shape

```markdown
Done:
Verified:
Task/run evidence:
Files changed:
Open risks:
Next safest step:
Checkpoint needed:
```
