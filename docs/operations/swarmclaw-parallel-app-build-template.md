# SwarmClaw Parallel App Build Template

Last verified: 2026-06-07

Audience: Codex and future agents operating Zmey's local SwarmClaw instance.

Purpose: a reusable, sanitized template for turning a broad "build a full app" request into direct assigned SwarmClaw tasks with clear ownership, safe parallelism, review gates, and concise handoff.

Date convention: operator doc dates use Zmey's local Europe/Sofia calendar date unless a timestamp explicitly says UTC. Docker, task, and API timestamps may display UTC or epoch milliseconds.

## Truth Sources

Use these sources in this order:

1. Live local runtime at `http://127.0.0.1:3456`.
2. Current handoff at `/home/zmey/2. Personal/Codex/swarmclaw-agent-handoff.md`.
3. Repo operator docs in `docs/operations/`.
4. Official SwarmClaw docs:
   - `https://www.swarmclaw.ai/docs`
   - `https://www.swarmclaw.ai/docs/tasks`
   - `https://www.swarmclaw.ai/docs/agents`
   - `https://www.swarmclaw.ai/docs/skills`
   - `https://www.swarmclaw.ai/docs/projects`
   - `https://www.swarmclaw.ai/docs/knowledge`

Docs cross-check: official docs describe tasks as durable queued work with owner, project linkage, dependencies, artifacts, comments, verification summaries, handoff packets, and optional execution policies. They describe projects as durable operating context; agents as execution units with tools, prompts, skills, memory, MCP, and delegation settings; skills as discoverable or pinned prompt guidance; and Knowledge as shared source material with lifecycle and citations.

Local override: in Zmey's current subscription setup, CLI-backed Coordinator is worker-only for stored orchestration. Use direct task assignment by exact stored agent ID instead of relying on automatic stored-agent `spawn_subagent` routing.

## Safety Rules

- Keep SwarmClaw local-only. Never expose port `3456` publicly.
- Do not inspect or print secrets, auth JSON, full env files, tokens, credential files, private keys, raw credential output, or credential tables.
- Do not change `.env.local`, provider routing, state DB repair paths, tasks, schedules, autonomy, credentials, public exposure, managed skills, or in-app Knowledge without a checkpoint for that exact action.
- Do not kill, restart, or replace the dev server on port `3456` without asking first.
- Avoid `opencode-go/deepseek-v4-flash` for normal worker tasks.
- Keep the external handoff short. Put detailed workflow material in repo docs and Knowledge.

## Default Workers

Verify these IDs against the live instance before creating work.

| Role | Stored ID | Default Use |
|---|---|---|
| Coordinator | `default` | Planning, triage, operator-facing synthesis. Not true stored-agent orchestration in the current CLI setup. |
| Builder | `92b8cd6c` | Primary implementation and local repo work. |
| Reviewer QA | `c2cd6ff9` | Review, browser checks, quality triage, regression checks. |
| Copilot Mini Worker | `e74dd145` | Lightweight coding, summarization, and narrow helper work. |
| OpenCode Builder | `a0f79bad` | Alternate implementation worker when provider/model behavior is verified for the scope. |
| OpenCode Go Helper | `cc51c5e6` | Bounded helper work. |

## Operator Support Cell

Use this model when SwarmClaw itself is the project or when Codex needs durable operator help:

| Function | Default owner | Notes |
|---|---|---|
| Intent, safety, checkpoints, synthesis | Main Codex helper plus Coordinator `default` | Codex stays the gatekeeper. Coordinator produces bounded plans and summaries. |
| Verification, risk, evidence checks | Reviewer QA `c2cd6ff9` | Use for GUI workflow checks, failed-task triage, browser evidence, and stale instruction review. |
| Docs, templates, local repo patches | Builder `92b8cd6c` | Use only after the plan and write scope are checkpointed. |
| Small second opinions | Copilot Mini Worker `e74dd145` | Use for narrow helper checks where low cost matters more than depth. |
| OpenCode-specific checks | OpenCode Builder `a0f79bad` or Helper `cc51c5e6` | Keep bounded; avoid unverified OpenCode models for normal work. |

Recommended drills:

1. Route drill: choose the worker and checkpoint level for a mock request.
2. Evidence drill: summarize a completed task with ID, worker, status, files changed, verification, marker, and residual risk.
3. Failure drill: map a failed task to the Failure Catalog, then define the safe retry.

Verified clean drill: task `52cbb9bd` (`2026-06-07`) ran as Coordinator `default`, completed with `validation.ok=true`, marker `SWARMCLAW_OPERATOR_SUPPORT_CELL_CLEAN_DRILL_OK` in the first line, and stated no tools, reads, or writes. Use it as the reference shape for future pure planning drills.

Verified QA drill: task `88367b90` (`2026-06-07`) ran as Reviewer QA `c2cd6ff9` with quality gate enabled and marker `SWARMCLAW_REVIEWER_QA_OPERATOR_DRILL_OK`; it found the date-convention ambiguity. Task `8906baf8` confirmed the Europe/Sofia date convention fix with marker `SWARMCLAW_REVIEWER_QA_DATE_CONVENTION_OK` and `validation.ok=true`.

Verified parallel drill: task `eab3d1f4` (`2026-06-07`) ran as Coordinator `default` and passed with marker `SWARMCLAW_PARALLEL_DRILL_PLANNER_CORRECTED_OK`; task `263bc7b8` ran as Builder `92b8cd6c` and passed with marker `SWARMCLAW_PARALLEL_DRILL_BUILDER_CORRECTED_OK`; task `834c0b94` ran as Reviewer QA `c2cd6ff9` and passed with marker `SWARMCLAW_PARALLEL_DRILL_REVIEWER_EXACT_AGENT_OK`. Failed/misassigned learning artifacts: `9beeb223` exposed validator evidence wording, and `652d6e28` passed but ran as Coordinator, so it is not Reviewer QA evidence.

## Operator Intake

Before creating tasks, write a one-paragraph target:

```markdown
Target app:
Audience:
Must-have workflows:
Nice-to-haves:
Out of scope:
Repo/workspace path:
First screen users should see:
Acceptance criteria:
Checkpoint-required actions:
```

If any of these are unclear, create a read-only planning task first. Do not start implementation from a vague product idea.

## Safe Parallelism Rule

Run work in parallel only when scopes are independent.

Good parallel splits:

- frontend UI files vs backend API files after an API contract exists
- data model review vs visual design review
- read-only QA while implementation is running
- docs/handoff after code and QA are complete

Bad parallel splits:

- two workers editing the same component, route, schema, or state store
- frontend and backend proceeding before an API contract exists
- task B depending on task A's unfinished design
- workers changing provider routing, credentials, schedules, autonomy, or public exposure without checkpoint

Default to fewer, larger high-quality tasks. Split only when the split reduces risk or real elapsed time.

## Creation Rules

Create tasks through the GUI when possible:

1. Open `/tasks`.
2. Select the exact stored worker in the task form.
3. Create the task as backlog.
4. Close the sheet.
5. Queue with the task card's exact `Queue` button. Use exact accessible-name matching or a scoped card action; broad `Queue` text can match `Queued` controls.
6. Verify stored status and worker metadata, especially `agentId`, before counting the task as evidence.

If browser automation cannot type into form fields because the virtual clipboard is unavailable, use a checkpointed app service/API path, not raw DB writes. Create backlog, update to queued through the app path, then self-monitor to terminal status.

Avoid assignment-looking text inside the task body. Do not write `agent:`, `agent id:`, `assigned to`, `for agent`, or `@agent` in the prompt body. Set the worker in task metadata instead.

Exception: if GUI picker selection does not persist, a leading `@Reviewer` or `@Reviewer QA` mention can resolve Reviewer QA through the task mention parser. Verify the stored `agentId` is `c2cd6ff9` before queueing. Treat a passed review task with the wrong `agentId` as useful context only, not Reviewer QA evidence.

For pure reasoning/planning tasks, explicitly disable or relax the per-task quality gate and manually verify the marker, required sections, and constraints. The default GUI quality gate may require two evidence categories and can dead-letter useful planning output. Keep quality gates enabled for implementation and QA tasks.

Prompt hygiene:

- Do not let workers echo the prompt or say they are starting.
- For planning tasks that mention app delivery or feature slices, require `Source paths considered: docs/operations/...` and `Verification: ... ok`.
- Keep evidence markers in the first line and planning/review outputs short enough to avoid result truncation.

## Phase Plan

| Phase | Task | Worker Metadata | Parallel? | Completion Gate |
|---|---|---|---|---|
| 0 | Operator intake | Main Codex helper | No | Target paragraph and acceptance criteria exist. |
| 1 | Product and technical plan | Coordinator `default` or Builder `92b8cd6c` | No | Plan defines scope, architecture, file boundaries, test strategy, and task split. |
| 2 | Plan review | Reviewer QA `c2cd6ff9` | Yes, read-only after plan exists | Review says accept or lists blockers. |
| 3 | Implementation batch | Builder plus optional alternate worker | Yes, only with disjoint write scopes | Each implementation task reports files changed and verification. |
| 4 | Browser and regression QA | Reviewer QA `c2cd6ff9` | Yes, while operator reviews diffs | QA covers user workflows, errors, request failures, responsive behavior, and evidence. |
| 5 | Integration fix batch | Builder `92b8cd6c` | Usually no | QA findings resolved or accepted by Zmey. |
| 6 | Final handoff | Main Codex helper or Coordinator `default` | No | Short handoff, evidence ledger, agentmemory lessons only for verified facts. |

## Task Stencils

Use a unique marker per task:

```text
SWARMCLAW_APPBUILD_[ROLE]_[SHORT_GOAL]_OK
```

Result storage can truncate long task output. Put the marker in the first ten lines and keep planning/review results under 2,500 characters unless Zmey asks for a longer artifact.

### Planning Task

Set in task metadata:

```text
Worker: Coordinator default, or Builder 92b8cd6c if codebase architecture is needed
Status: backlog first, then queue
Priority: medium
Project: target project if already created and approved
```

Prompt body:

```markdown
Read-only planning task for a full app build.

Target:
[paste operator intake]

Rules:
- Follow AGENTS.md and the local SwarmClaw operator rules.
- Do not inspect or print secrets, auth JSON, full env files, tokens, credential files, private keys, or raw credential output.
- Keep SwarmClaw local-only; never expose port 3456 publicly.
- Do not change files, settings, providers, credentials, schedules, autonomy, state DB, env files, server processes, or public exposure.
- Do not delegate or create tasks.

Return:
0. Evidence marker in the first ten lines: SWARMCLAW_APPBUILD_PLAN_OK
1. Product scope and acceptance criteria.
2. Proposed architecture and key files/directories.
3. Proposed task split with disjoint write scopes.
4. Test and browser verification strategy.
5. Checkpoint-required actions.
6. Keep this result under 2,500 characters.
```

### Plan Review Task

Set in task metadata:

```text
Worker: Reviewer QA c2cd6ff9
Status: backlog first, then queue
Priority: medium
```

Prompt body:

```markdown
Read-only review of this app-build plan.

Plan:
[paste planning task result]

Acceptance criteria:
[paste target acceptance criteria]

Rules:
- Follow AGENTS.md and local-only SwarmClaw rules.
- Do not change files or state.
- Do not inspect secrets or credentials.
- Do not create, queue, retry, cancel, or edit tasks.

Check:
- Are scopes clear and non-overlapping?
- Is the implementation order sane?
- Are tests and browser checks enough?
- Are there hidden checkpoint-required actions?
- Are there local-only or secret-hygiene risks?

Return:
- Evidence marker in the first ten lines: SWARMCLAW_APPBUILD_PLAN_REVIEW_OK
- Findings ordered by severity.
- Recommendation: accept, request changes, or block.
- Keep this result under 2,500 characters.
```

### Implementation Task

Set in task metadata:

```text
Worker: Builder 92b8cd6c, unless an alternate verified worker has a disjoint scope
Status: backlog first, then queue
Priority: high
```

Prompt body:

```markdown
Implementation task for the app build.

Objective:
[specific feature or subsystem]

Allowed write scope:
[exact files/directories]

Read-only context:
[short plan excerpt and acceptance criteria]

Non-goals:
[what not to touch]

Rules:
- Follow AGENTS.md.
- Keep changes surgical and scoped to the allowed write scope.
- Do not inspect or print secrets, auth JSON, full env files, tokens, credential files, private keys, or raw credential output.
- Keep SwarmClaw local-only; never expose port 3456 publicly.
- Do not change .env.local, provider routing, state DB, tasks, schedules, autonomy, credentials, settings, server processes, or public exposure.
- Do not kill, restart, or replace the dev server on port 3456.
- If blocked, stop and report the blocker plus the safest next action.

Expected output:
- Evidence marker in the first ten lines: SWARMCLAW_APPBUILD_IMPL_[SHORT_GOAL]_OK
- Summary.
- Files changed.
- Verification commands/checks and results.
- Risks or follow-up.
```

### Browser QA Task

Set in task metadata:

```text
Worker: Reviewer QA c2cd6ff9
Status: backlog first, then queue
Priority: high
```

Prompt body:

```markdown
Read-only browser/regression QA for the app build.

Target URL or route:
[local URL or route]

Acceptance criteria:
[paste criteria]

Rules:
- Follow AGENTS.md and local-only SwarmClaw rules.
- Do not modify files, tasks, settings, credentials, schedules, autonomy, state DB, env files, or server processes.
- Do not inspect secrets or enter access keys.
- If authentication blocks the route, report the access gate as evidence and stop unless auth was explicitly approved.

Evidence required:
- Browser/tool used.
- Target URL or route.
- Final URL or route-specific ready signal.
- HTTP status if checked.
- Viewport if relevant.
- Page error count and request failure count if checked.
- Visual or concise DOM evidence when available.

Return:
- Evidence marker in the first ten lines: SWARMCLAW_APPBUILD_QA_OK
- Findings ordered by severity.
- Verification evidence.
- Recommendation: accept, request changes, or block.
- Keep this result under 2,500 characters unless artifact links require more.
```

### Integration Fix Task

Set in task metadata:

```text
Worker: Builder 92b8cd6c
Status: backlog first, then queue
Priority: high
```

Prompt body:

```markdown
Fix the accepted QA findings for the app build.

Findings to address:
[paste only accepted findings]

Allowed write scope:
[exact files/directories]

Rules:
- Follow AGENTS.md.
- Fix only the listed findings.
- Do not broaden scope without checkpoint.
- Do not inspect secrets or change restricted settings.

Expected output:
- Evidence marker in the first ten lines: SWARMCLAW_APPBUILD_FIXES_OK
- Summary of fixes.
- Files changed.
- Verification performed.
- Remaining risks.
```

### Final Handoff Task

Usually the main Codex helper should do this directly. If using SwarmClaw, set Coordinator `default` in metadata and keep it read-only.

Prompt body:

```markdown
Read-only final handoff synthesis for the app build.

Inputs:
- Target and acceptance criteria.
- Completed task IDs and markers.
- QA result.
- Final verification.

Rules:
- Do not change files or state.
- Keep the handoff concise.
- Do not include secrets, raw logs, env output, auth JSON, or credential details.

Return:
- Evidence marker in the first ten lines: SWARMCLAW_APPBUILD_HANDOFF_OK
- What shipped.
- Verification evidence.
- Known risks or deferred work.
- Exact task IDs and markers.
- Keep this result under 2,500 characters.
```

## Specialist Expansion

Do not create new agents by default. First use task prompts on existing workers.

Create or request a specialist only when:

- the role will recur across multiple app builds or projects
- the role needs stable tools/model/settings distinct from Builder or Reviewer QA
- a pinned skill or checklist is not enough
- Zmey approves the exact runtime change

Suggested specialist prompts before creating durable agents:

| Need | First Try | Durable Specialist Only If Repeated |
|---|---|---|
| Product scope | Coordinator planning task | Product Architect |
| UI system | Builder implementation task | Frontend Builder |
| API/data | Builder implementation task | Backend Builder or Data Engineer |
| Security | Reviewer QA read-only task | Security Reviewer |
| Release/Docker | Builder task with checkpoint gates | DevOps/Release |
| Test design | Reviewer QA task | QA Reviewer |

## Evidence Ledger

Maintain this table in the main operator thread or a short repo note during the run:

| Task ID | Worker | Scope | Status | Marker | Verification | Notes |
|---|---|---|---|---|---|---|
| | | | | | | |

Do not call the app build done until implementation, QA, final verification, and handoff are all accounted for.

## Finish Criteria

The run is complete only when:

- all required tasks completed or were deliberately deferred
- changed files stayed inside approved scopes
- final app behavior was checked in browser or tests
- QA findings were resolved or explicitly accepted by Zmey
- no secret-hygiene or local-only violation occurred
- SwarmClaw remains healthy and bound to localhost only
- durable lessons are saved to agentmemory only after verification
- the external handoff stays compact
