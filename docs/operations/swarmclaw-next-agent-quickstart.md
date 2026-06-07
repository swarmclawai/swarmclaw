# SwarmClaw Next-Agent Quickstart

Last verified: 2026-06-07

Audience: Codex and future agents operating Zmey's local SwarmClaw instance.

Purpose: a short boot checklist for agents that need to operate SwarmClaw without rereading every long manual first. Use this with `docs/operations/swarmclaw-gui-operator-manual.md` and `docs/operations/swarmclaw-operator-failure-catalog.md`.

Date convention: operator doc dates use Zmey's local Europe/Sofia calendar date unless a timestamp explicitly says UTC. Docker, task, and API timestamps may display UTC or epoch milliseconds.

## First 10 Minutes

1. Read `AGENTS.md` in the repo root.
2. Search agentmemory for recent `SwarmClaw`, `agentmemory`, `local subscription setup`, and `Codex memory hygiene` notes.
3. Read `/home/zmey/2. Personal/Codex/swarmclaw-agent-handoff.md` if readable. It is the concise external handoff.
4. Read this quickstart. Open the full GUI manual only for page details or safety levels.
5. Confirm runtime health and local binding:
   - `curl -fsS http://127.0.0.1:3456/api/healthz`
   - `docker compose -f compose.subscription.yml ps`
   - Expected binding: `127.0.0.1:3456-3457->3456-3457/tcp`
6. Use the in-app browser for GUI operation. Begin read-only unless Zmey has checkpointed a write.
7. Before claiming a task worked, capture task ID, assigned agent ID, session/run ID if visible, status, and evidence marker.

## Non-Negotiables

- Keep SwarmClaw local-only. Never expose port `3456` publicly.
- Do not kill, restart, replace, or rebind the server/container on port `3456` without asking first.
- Do not inspect or print secrets, auth JSON, full env files, tokens, credential files, private keys, raw credential output, or credential table values.
- Do not change `.env.local`, provider routing, state DB, tasks, schedules, autonomy, credentials, public exposure, managed skills, or in-app Knowledge records without an explicit checkpoint for that exact action.
- Keep `/home/zmey/2. Personal/Codex/swarmclaw-agent-handoff.md` short. Detailed operating knowledge belongs in repo docs, skills, Knowledge, and agentmemory.

## Current Operating Baseline

Current local setup as of 2026-06-07:

| Item | Value |
|---|---|
| App | `http://127.0.0.1:3456` |
| Branch | `docker-subscription-setup` |
| Compose file | `compose.subscription.yml` |
| Image | `swarmclaw-subscription:1.9.36` |
| Container | `swarmclaw-swarmclaw-1` |
| Local project | `SwarmClaw Local Ops` |
| Default operator path | Direct managed task assignment |

Default workers to verify before use:

| Worker | ID | Use |
|---|---|---|
| Builder | `92b8cd6c` | Primary repo implementation. |
| Reviewer QA | `c2cd6ff9` | Review, QA, browser checks, quality triage. |
| Copilot Mini Worker | `e74dd145` | Small bounded coding or summarization. |
| OpenCode Builder | `a0f79bad` | Alternate implementation worker. |
| OpenCode Go Helper | `cc51c5e6` | Bounded alternate helper. |

Avoid `opencode-go/deepseek-v4-flash` for normal agent work because headless runs can exit successfully without assistant text.

## Default Task Path

Use this path for normal worker work:

1. Open `/tasks`.
2. Draft a bounded title, description, agent, project, tags, allowed scope, non-goals, and evidence marker.
3. Create the task with the exact stored agent selected. New Task creates a backlog item by default.
4. Close the sheet and use the task card's exact `Queue` button to run it. Avoid broad `Queue` selectors because `Queued` controls can also match.
5. Verify the stored task status moved to `queued`, `running`, or `completed`, and verify the stored `agentId` matches the intended worker before counting the run as evidence.
6. Monitor `/tasks`, `/runs`, `/quality`, and sanitized `/logs`.
7. Do not retry, cancel, archive, mark complete, edit gates, or repair state without checkpoint.

Task prompts should include:

```markdown
Task:
Allowed scope:
Non-goals:
Rules:
- Follow AGENTS.md.
- Keep SwarmClaw local-only; never expose port 3456 publicly.
- Do not inspect or print secrets, auth JSON, full env files, tokens, credential files, private keys, or raw credential output.
- Do not change providers, credentials, schedules, autonomy, settings, state DB, public exposure, or the dev server without checkpoint.

Expected output:
- Summary
- Files changed, or "none"
- Verification
- Risks/follow-up
- Evidence marker: SWARMCLAW_[AREA]_[ROLE]_[GOAL]_OK
```

Prompt hygiene for task validators:

- Do not let workers echo the prompt or announce that they are starting.
- For planning/review tasks that mention app delivery or feature work, include source-path evidence and an explicit `Verification: ... ok` line.
- If the GUI agent picker does not persist the intended worker, use a title/body mention such as `@Reviewer` or `@Reviewer QA`, then verify the stored `agentId` before queueing.
- For reasoning-only tasks, disabled quality gates must persist as `qualityGate.enabled=false`; `qualityGate:null` can still fall back to the default gate when the prompt contains implementation-like wording.

## Parallel Agenting

Use direct assignment as the default. Split work only when scopes are independent:

1. Write one paragraph defining the target and acceptance criteria.
2. Split by product/spec, architecture, frontend, backend, data, integration, QA, security, docs, or release.
3. Give write tasks disjoint files or directories.
4. Run read-only QA in parallel when useful.
5. Integrate outputs in the main operator thread.
6. Save durable lessons only after verification.

Do not rely on the stored Coordinator as a true `spawn_subagent` orchestrator in the current CLI-provider setup. Use it as a planning/triage convention unless a future checkpoint changes provider or product behavior.

For full-app work, use `docs/operations/swarmclaw-parallel-app-build-template.md`. It contains task stencils, phase gates, worker metadata, QA evidence requirements, specialist-expansion rules, and an evidence ledger.

## Browser And QA Evidence

For browser-visible work, require concrete evidence:

- browser/tool name
- target URL or route
- viewport when relevant
- HTTP status if checked
- final URL or route-specific ready signal
- page error count and request failure count if checked
- screenshot or concise DOM evidence when available
- unique evidence marker

Worker browsers may be unauthenticated. For protected SwarmClaw GUI routes, reaching `/login` and seeing the access gate can be valid evidence. Do not read `.env.local` or enter an access key without checkpoint.

If browser automation reports that the virtual clipboard is not installed while filling New Task fields, stop retrying text entry. Close the unsaved dialog, verify no partial task was created, and use manual entry or a checkpointed app service/API path only if the smoke still requires a state change.

## Knowledge, Skills, And Memory

- In-app Knowledge is source material for SwarmClaw grounding. Updating a stored source mutates state and requires checkpoint.
- Repo skills in `skills/` are product artifacts. Workspace copies in `state/skills/` can make no-rebuild local testing easier, but managed skill records and agent pinning still require checkpoint.
- CLI-backed task workers may not be able to read in-app Knowledge directly. Embed short sanitized excerpts in task prompts when the worker must use a specific source.
- agentmemory stores durable cross-session lessons. Save only verified, concise, non-secret facts.
- If a manual already exists as a Knowledge source, pressing sync may not update it if the source stores inline content. Update stored source content only after checkpoint.

## Stop And Ask

Stop and checkpoint before:

- provider/model/routing changes
- credentials, secrets, wallets, or auth handling
- schedules, autonomy, missions, webhooks, connectors, MCP servers, extensions, or settings
- state DB or task/session repair
- restarts, rebuilds, public exposure, or port changes
- adding, editing, syncing, archiving, or deleting Knowledge
- creating managed skills or pinning skills to agents
- any destructive or unclear operation

Checkpoint text should name the exact action, target page or record, risk, verification, and rollback or backup plan.

## Operator Report Shape

Use this compact format for handoffs and status updates:

```markdown
Done:
Verified:
Task/run evidence:
Files changed:
Open risks:
Next safest step:
Checkpoint needed:
```

Keep the external handoff to one or two durable lines. Put detailed playbooks in repo docs.
