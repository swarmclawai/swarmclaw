# SwarmClaw Parallel Wave Template

Last verified: 2026-06-08

Audience: Codex and future agents operating Zmey's local SwarmClaw instance.

Purpose: define a SwarmClaw-native orchestration pattern for running several direct-assigned tasks, one Reviewer QA fan-in gate, and one final operator summary.

This is a task-bundle template, not a product feature. It does not change SwarmClaw code, create durable agents, install skills, sync Knowledge, enable schedules, enable autonomy, change providers, change credentials, or expose ports.

Date convention: operator doc dates use Zmey's local Europe/Sofia calendar date unless a timestamp explicitly says UTC. Docker, task, and API timestamps may display UTC or epoch milliseconds.

## Core Pattern

Use a parallel wave only after intake, discovery, and review establish clear scopes.

```text
Operator intake
  -> read-only discovery
  -> risk/plan review
  -> Wave N worker tasks
  -> Reviewer QA fan-in
  -> operator merge/retry/defer decision
  -> next wave or final handoff
```

Default worker routing:

| Role | Stored ID | Default Use |
|---|---|---|
| Coordinator | `default` | Planning and synthesis convention only. |
| Builder | `92b8cd6c` | Primary implementation or architecture worker. |
| Reviewer QA | `c2cd6ff9` | Fan-in review, QA, quality gate, risk review. |
| Copilot Mini Worker | `e74dd145` | Narrow helper, docs, small second opinion. |
| OpenCode Builder | `a0f79bad` | Optional isolated worker after provider/model behavior is verified. |
| OpenCode Go Helper | `cc51c5e6` | Bounded helper work only. |

Current local constraint: the CLI-backed Coordinator is worker-only for stored orchestration, so direct task assignment by exact worker ID is the reliable path. Do not depend on automatic stored-agent `spawn_subagent` routing.

## When To Parallelize

Good wave candidates:

- Read-only discovery plus independent risk review.
- Frontend and backend after an API contract exists.
- Strategy/backtest review and observability review in separate files.
- Documentation/handoff while Reviewer QA checks the completed implementation.
- Independent bug fixes in different modules.

Bad wave candidates:

- Two workers editing the same component, state store, schema, or runtime service.
- Work that depends on an unfinished contract.
- Financial/live-trading actions.
- Provider, credential, schedule, autonomy, state DB, public exposure, or server lifecycle changes.
- Any task where the safety boundary is unclear.

If scopes are not disjoint, run serially.

## Wave Intake

Use this before creating tasks:

```markdown
Wave name:
Project:
Goal:
Inputs:
Allowed read scopes:
Allowed write scopes:
Forbidden actions:
Worker tasks:
Fan-in reviewer:
Required markers:
Verification commands/checks:
Checkpoint-required actions:
Fallback if a worker is blocked:
```

## Orchestration Evidence Ledger

Maintain this ledger in the main operator thread or a short repo note during the run.

| Wave ID | Task ID | Title | Worker ID | Worker Name | Phase | Scope | Dependencies | Status | Run/Session ID | Quality Gate | Marker | Files Changed | Verification Evidence | QA Disposition | Checkpoint Used | Risks/Follow-Up | Decision | Last Checked |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | | | | | | | | |

Optional worktree fields, only for checkpointed worktree waves:

| Task ID | Worktree Path | Branch | Base SHA | Merge Status | Cleanup Status |
|---|---|---|---|---|---|
| | | | | | |

Rules:

- Record exact task IDs and worker IDs.
- Record `files changed: none` for read-only tasks.
- Put markers in the first line of task results.
- Do not call a wave complete until fan-in review has accepted it or Zmey explicitly accepts remaining risk.
- If output is truncated, use the first-line marker and task detail view/report as evidence, then tighten future prompts.

## Task Creation Rules

Create tasks through the GUI when possible:

1. Open `/tasks` or the Project Work tab.
2. Click the unique `+ New Task` or project-scoped `New Task`.
3. Confirm the sheet heading is `New Task`, not `Edit Task`.
4. Confirm title and description fields are blank before typing.
5. Select the exact stored worker in task metadata.
6. Create as backlog.
7. Queue using the exact task card's `Queue` button.
8. Verify task metadata: `agentId`, project, status, and title.

Known caveat: browser automation can hit F017 virtual-clipboard failures when typing into task forms. If that happens, stop and ask before using an app route/API fallback.

Avoid assignment-looking text inside the task body. Set worker assignment in metadata, not by phrases such as `agent:`, `agent id:`, `assigned to`, `for agent`, or `@agent`.

## Quality Gate Policy

- Pure planning, discovery, and read-only review tasks may disable or relax the per-task quality gate.
- Implementation and QA tasks should keep evidence requirements strict.
- Each task result should stay under about 2,500 characters unless it links to an artifact.
- Each task must put its marker and evidence labels in the first ten lines.

## Messy Repo Recovery Pattern

If a parallel read-only wave against a messy repo returns prompt echoes,
progress-only output, missing first-line markers, or silent liveness failures,
stop expanding the worker scope.

Use this recovery path instead:

1. Preserve task IDs, agent IDs, statuses, and any useful findings.
2. Cancel or supersede fan-in tasks that depend on failed/incomplete upstream
   evidence.
3. Have the main operator prepare a tiny source/evidence capsule from exact safe
   files and line windows.
4. Run a capsule-only fan-in task that does not inspect the repo.
5. If Reviewer QA/Codex CLI fails during runtime initialization, do one short
   retry. If it repeats, use OpenCode backup fan-in with a no-repo-inspection
   capsule and record the Codex tasks as runtime-blocked.
6. Convert checkpoint-required code candidates into backlog TODO tasks instead
   of starting implementation.

Verified crypto example:

- Broad audit tasks `ca137bc`, `ca31b69`, and `ca47b9a` produced prompt or
  progress-only output.
- Reviewer QA/Codex fan-in retries `cafv10ee` and `cafv8eb1` failed due runtime
  errors, not audit content.
- OpenCode backup fan-in `cafo31b3` completed with
  `CRYPTO_AUDIT_FANIN_BLOCKED`.
- Deferred TODO tasks `ctodo5a37`, `ctodoac45`, `ctodo29df`, and `ctodo99ba`
  were created as backlog-only items under the Crypto Trading Bot project.

## Worktree Isolation Policy

Worktrees are not the default. This pass documents the policy only.

Use worktrees only after Zmey checkpoints the exact wave.

Local rule: this policy overrides generic coding-agent advice that recommends worktrees for parallel fixes by default. For Zmey's SwarmClaw, worktrees are useful but not automatic because task state, cleanup, merge ownership, and local safety gates must be explicit.

Minimum policy before use:

- Each implementation worker gets one dedicated worktree and branch.
- Each worktree records its base SHA before work starts.
- Branch naming uses a predictable prefix, for example `swarmclaw-wave/<project>/<scope>`.
- Each worker receives a disjoint write scope.
- Each worker records branch, worktree path, files changed, tests, and merge notes in the evidence ledger.
- Main Codex performs or supervises merge order.
- Conflicts are resolved serially by one owner.
- Temporary worktrees are removed after merge, defer, or abandon.
- Worktree cleanup is verified.

Do not use worktrees for:

- Secrets or credential work.
- Live trading or exchange access.
- Provider routing.
- Schedules or autonomy.
- State DB repair.
- Public exposure changes.
- Server restart/replacement.

## Task Stencils

Set worker assignment in task metadata. The prompt body should name the work, constraints, and output format, not the assignment mechanism.

### Read-Only Discovery

Metadata:

```text
Worker: Builder 92b8cd6c
Status: backlog first, then queue
Quality gate: disabled or relaxed for pure discovery
```

Prompt:

```markdown
Read-only discovery task for this wave.

Project:
[project name]

Input:
[repo path or sanitized Knowledge/source summary]

Scope:
[allowed read scope]

Rules:
- Follow AGENTS.md and local SwarmClaw operator rules.
- Do not change files or state.
- Do not inspect or print secrets, auth JSON, full env files, tokens, credential files, private keys, wallet files, cookies, raw credential output, or credential tables.
- Do not run live trading, exchange calls, schedules, deployment, migrations, destructive commands, or server lifecycle actions.
- If a needed file may be sensitive, stop and report it as blocked.

Return:
0. Evidence marker in the first ten lines: SWARMCLAW_WAVE_DISCOVERY_OK
1. Files/areas inspected.
2. Key facts relevant to the wave.
3. Unknowns and blockers.
4. Files changed: none.
5. Keep this result under 2,500 characters.
```

### Architecture Or Plan

Metadata:

```text
Worker: Coordinator default or Builder 92b8cd6c
Status: backlog first, then queue
Quality gate: disabled or relaxed for pure planning
```

Prompt:

```markdown
Read-only architecture and wave plan.

Inputs:
[discovery, goal, constraints]

Rules:
- Follow AGENTS.md and local SwarmClaw operator rules.
- Do not change files or state.
- Do not create, edit, queue, retry, cancel, or archive tasks.
- Do not inspect secrets or credentials.
- Do not run live trading, exchange calls, schedules, deployment, migrations, destructive commands, or server lifecycle actions.

Return:
0. Evidence marker in the first ten lines: SWARMCLAW_WAVE_PLAN_OK
1. Proposed wave scope.
2. Worker tasks with disjoint read/write scopes.
3. Dependencies and blockers.
4. Verification strategy.
5. Checkpoint-required actions.
6. Files changed: none.
7. Keep this result under 2,500 characters.
```

### Implementation Slice

Metadata:

```text
Worker: Builder 92b8cd6c unless another worker has a verified disjoint scope
Status: backlog first, then queue
Quality gate: enabled
```

Prompt:

```markdown
Implementation slice for this wave.

Objective:
[specific objective]

Allowed write scope:
[exact files/directories]

Read-only context:
[short plan excerpt]

Non-goals:
[what not to touch]

Rules:
- Follow AGENTS.md.
- Keep changes surgical and inside the allowed write scope.
- Do not inspect or print secrets, auth JSON, full env files, tokens, credential files, private keys, wallet files, cookies, raw credential output, or credential tables.
- Do not change provider routing, state DB, tasks, schedules, autonomy, credentials, settings, env files, server processes, or public exposure.
- Do not run live trading, exchange calls, deployments, destructive commands, or server lifecycle actions.
- If blocked, stop and report the blocker plus the safest next action.

Return:
0. Evidence marker in the first ten lines: SWARMCLAW_WAVE_IMPL_[SHORT_GOAL]_OK
1. Summary.
2. Files changed.
3. Verification performed.
4. Remaining risks.
```

### QA Or Risk Review

Metadata:

```text
Worker: Reviewer QA c2cd6ff9
Status: backlog first, then queue
Quality gate: enabled for implementation QA; disabled or relaxed for pure plan review
```

Prompt:

```markdown
Read-only QA/risk review for this wave.

Inputs:
[plan, task outputs, acceptance criteria]

Rules:
- Follow AGENTS.md and local SwarmClaw operator rules.
- Do not change files or state.
- Do not inspect secrets or credentials.
- Do not run live trading, exchange calls, schedules, deployment, migrations, destructive commands, or server lifecycle actions.

Check:
- Scope compliance.
- Evidence quality.
- Tests/verification.
- Safety violations.
- Hidden checkpoint requirements.
- Whether the wave can move forward.

Return:
0. Evidence marker in the first ten lines: SWARMCLAW_WAVE_QA_REVIEW_OK
1. Findings ordered by severity.
2. Accept, request changes, or block.
3. Required follow-up.
4. Files changed: none.
5. Keep this result under 2,500 characters.
```

### Fan-In Review

Metadata:

```text
Worker: Reviewer QA c2cd6ff9
Status: backlog first, then queue
Quality gate: disabled or relaxed for pure synthesis
```

Prompt:

```markdown
Read-only fan-in review for this wave.

Evidence ledger:
[paste current ledger rows]

Task outputs:
[paste concise task summaries or task IDs]

Rules:
- Follow AGENTS.md and local SwarmClaw operator rules.
- Do not change files or state.
- Do not create, edit, queue, retry, cancel, or archive tasks.
- Do not inspect secrets or credentials.
- Do not run live trading, exchange calls, schedules, deployment, migrations, destructive commands, or server lifecycle actions.

Return:
0. Evidence marker in the first ten lines: SWARMCLAW_WAVE_FAN_IN_OK
1. Wave decision: accept, request changes, block, or defer.
2. Missing evidence, if any.
3. Merge/retry/defer recommendation.
4. Next safest action.
5. Files changed: none.
6. Keep this result under 2,500 characters.
```

### Final Operator Summary

Usually main Codex writes this directly. Use a task only if a read-only SwarmClaw record is needed.

```markdown
Wave:
Project:
Goal:
Task IDs:
Workers:
Markers:
Files changed:
Verification:
Fan-in decision:
Blocked/checkpoint actions:
Merge/retry/defer decision:
Next safest action:
No-secret verification:
Local-only verification:
```

## Validation Checklist

Before launching a wave:

- Project and goal are defined.
- Safety gates are explicit.
- Worker assignments are exact metadata IDs.
- Scopes are disjoint or read-only.
- Markers are unique and first-line.
- Quality-gate policy matches task type.
- Checkpoint-required actions are separated.
- Worktree use is off unless explicitly approved.

Before closing a wave:

- Every task has terminal status or an explicit blocker.
- Every accepted result has task ID, worker ID, marker, and evidence.
- Files changed match the allowed scopes.
- Reviewer QA fan-in accepted or blocked with concrete findings.
- No secret, credential, schedule, autonomy, provider, public exposure, or server lifecycle violation occurred.
- The evidence ledger is complete.
- Durable memory is saved only after verification.
