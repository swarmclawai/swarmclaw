# SwarmClaw Operator Mastery Drill Plan

Last verified: 2026-06-17

Audience: Codex and future agents operating Zmey's local SwarmClaw instance.

Purpose: a repeatable mastery suite for proving SwarmClaw can be operated
professionally from the GUI and supporting evidence surfaces. This plan is
sanitized. Do not add secrets, raw credential output, auth JSON, full env files,
private keys, raw DB dumps, or raw logs.

## Operating Rules

- Start by reading `AGENTS.md`, the concise external handoff, this plan, the
  next-agent quickstart, and the failure catalog.
- Confirm SwarmClaw is healthy and bound to `127.0.0.1:3456-3457` before and
  after state-changing drills.
- Use the authenticated in-app browser for GUI operation.
- Use full `Task`/`New Task` forms for executable tasks. Do not use board
  quick-add for executable work; see F044.
- Keep task outputs marker-first and under about 2,500 characters.
- Ask/checkpoint before credentials, providers, schedules, autonomy, state
  repair, public exposure, destructive cleanup, live trading, DB writes, or
  durable managed-agent/skill changes.

## Drill Suite

| ID | Drill | Goal | Scope | State change | Acceptance |
|---|---|---|---|---|---|
| D01 | Task lifecycle depth | Prove full-form create, exact-agent verification, queue, monitor, result, and validation. | `/tasks`, `/runs`, task metadata. | Creates one read-only task. | Task completes with marker, exact task ID, exact worker ID, files changed `none`, verification, blockers, and local-only health remains OK. |
| D02 | Workflow bundle operation | Prove Workflow Bundles controls, selected ledger, draft/backlog/continue affordances, and safe continuation boundaries. | `/protocols`; existing runs unless explicitly creating a scratch run. | Read-only by default. | Required controls visible; selected ledger has status/task evidence; no tasks created in read-only mode. |
| D03 | Runs, Quality, Logs triage | Trace completed and failed execution evidence to a failure-catalog decision. | `/runs`, `/quality`, `/logs`, task metadata. | Read-only. | A completed task and a known failure are mapped to status, run/session, validation/failure family, and next safe action. |
| D04 | Knowledge operations | Prove current operator Knowledge records are ready, searchable, and understood. | `/knowledge`; source metadata/search only. | Read-only unless checkpointed sync/update is requested. | GUI/search or service metadata shows source IDs, ready status, chunk counts, and non-secret hit counts for expected terms. |
| D05 | Agent routing | Verify active worker roster, exact IDs, and safe default use of each worker. | `/agents`, `/org-chart`, task metadata. | Read-only unless creating worker smoke tasks. | Worker IDs and roles match quickstart; Coordinator remains planning/triage unless product changes are checkpointed. |
| D06 | Parallel-agent wave | Prove two-worker read-only fan-out plus Reviewer QA fan-in or equivalent ledger review. | `/tasks`, `/runs`, failure catalog. | Creates read-only tasks only after checkpoint. | Independent worker evidence plus fan-in/review decision with task IDs, worker IDs, markers, files changed, verification, and blockers. |
| D07 | Project onboarding | Prove a project can be plugged into SwarmClaw safely. | `/projects`, project template, safe Knowledge candidates. | Read-only by default. | Project objective/scope/safety gates are mapped; next wave has clear allowed scope, non-goals, and checkpoint triggers. |
| D08 | Sensitive/admin read-only | Know every admin page without changing risky state. | `/providers`, `/secrets`, `/wallets`, `/autonomy`, `/schedules`, `/settings`. | Read-only only. | Route-specific controls/headings are visible; no values are revealed and no config is changed. |
| D09 | Browser automation reliability | Prove robust locators, route readiness, form entry, and F017/F042 avoidance. | In-app browser across drill routes. | None beyond approved drill tasks. | Uses scoped route controls, exact URLs, stored metadata verification, and no broad body-text auth conclusions. |
| D10 | Handoff quality | Make the next agent's path trivial. | Repo docs, external handoff, agentmemory. | Docs/memory update after verification. | This plan, failure catalog, handoff, and memory contain concise verified outcomes and no raw sensitive data. |

## 2026-06-17 Mastery Pass Ledger

| Drill | Status | Evidence | Follow-up |
|---|---|---|---|
| D01 | Done | Full-form task `a682c0ad`, Builder `92b8cd6c`, session `7e89761d`, marker `SWARMCLAW_MASTERY_D01_TASK_LIFECYCLE_V2_OK`, files changed `none`, completed. First attempt `859ce5bc` proved F045: default `minEvidenceItems=2` can dead-letter pure smoke output. | Superseded failed task `859ce5bc` archived on 2026-06-17. For pure read-only smoke tasks, set `Min Evidence Signals` to `1` or explicitly relax/disable the gate after checkpoint. |
| D02 | Done | Authenticated `/protocols` route showed Workflow Bundle controls: `workflow-title-input`, `workflow-cwd-input`, `workflow-goal-input`, `workflow-allowed-scopes-input`, `workflow-draft-plan`, `workflow-create-backlog`, `workflow-review-approved`, `workflow-continue-selected-run`, `workflow-continue-until-done`, and `workflow-auto-create-safe-backlog`. Run `dbc47bed` then verified read-only draft-no-task behavior, approved backlog launch, worker fan-out, auto-woken fan-in, run completion, and safe auto-backlog continuation to run `52efa735`. | Keep workflow creation/continuation checkpointed unless the current task explicitly approves it. Avoid implementation classifier words in read-only workflow goals; see F046. |
| D03 | Done | Completed runtime attempts found for D01/D06 sessions: `a682c0ad:attempt-1`, `3d217136:attempt-1`, `181c87c4:attempt-1`, `2f28696f:attempt-1`. Failure triage mapped `18849f25` to F044 and `859ce5bc` to F045. | Superseded task `18849f25` archived on 2026-06-17 after F044 was documented and corrected. Do not repair/archive unrelated failed tasks without checkpoint. |
| D04 | Done | Knowledge metadata checked without chunk/body dumps. Operator sources include GUI manual `c05dc18feaad931c` with 65 chunks, failure catalog `75b590287831ac7e` with 26 chunks, workflow recipe `9333a38a1e5f8a7e` with 15 chunks, quickstart `70f893b23855027b` with 12 chunks, loop plan `c413dab9a015b67c` with 24 chunks, and mastery plan `cd1b9719ee881476` with 10 chunks. | Verify by title/source ID/chunk count only; do not dump raw chunks. |
| D05 | Done | Agent roster verified from metadata: Builder `92b8cd6c`, Coordinator `default`, Reviewer QA `c2cd6ff9`, OpenCode Builder `a0f79bad`, OpenCode Go Helper `cc51c5e6`, Copilot Mini Worker `e74dd145`. `/agents/default` and `/org-chart` authenticated routes were visible. | Use explicit Agent picker for multi-word workers such as Reviewer QA; see F023. |
| D06 | Done | Worker A `3d217136`, Builder `92b8cd6c`, session `2df922d9`, marker `SWARMCLAW_MASTERY_D06_WORKER_A_OK`. Worker B corrected `181c87c4`, Reviewer QA `c2cd6ff9`, session `899c54a2`, marker `SWARMCLAW_MASTERY_D06_WORKER_B_V2_OK`. Fan-in `2f28696f`, Reviewer QA `c2cd6ff9`, session `952aa7fe`, marker `SWARMCLAW_MASTERY_D06_FANIN_OK`, accepted wave. | Misrouted unqueued task `5de0521a` archived on 2026-06-17 after F023 was documented and corrected. |
| D07 | Done | `/projects` authenticated route visible. Metadata shows `SwarmClaw Local Ops` (`bad5cf13`) and `Crypto Trading Bot` (`94e77f5e`) with sanitized objective/description lengths only. | Project-specific write/research waves still require scoped approval and safety gates. |
| D08 | Done | Authenticated read-only route checks covered `/providers`, `/secrets`, `/wallets`, `/autonomy`, `/schedules`, and `/settings`. Controls/headings were visible; no values were revealed and no settings changed. | Keep all admin/sensitive pages read-only unless Zmey approves a named state change. |
| D09 | Done | Browser operation used exact URLs, scoped route controls, task-card accessible names, dialog-scoped fields, explicit Agent picker, stored metadata verification, and no broad body-text auth conclusions. Continuation drill also verified keypress fallback with `Control+A` plus `Meta+A` before `Backspace`, and task-sheet Queue/Archive actions when card-hover buttons were unreliable. | If F017 returns, stop clipboard-backed entry and use keypress for short fields or checkpointed service/API fallback. Prefer sheet footer task actions and verify stored status after every queue/archive. |
| D10 | Done | Added this repo-local drill plan, linked it from the quickstart, updated F023/F045 in the failure catalog, queued live task evidence through SwarmClaw, and synced sanitized operator Knowledge sources. | Keep external handoff concise; save only verified non-secret memory. |

## Re-run Checklist

1. Confirm health and local-only binding.
2. Capture pre-drill task count and selected run status where relevant.
3. Execute the drills in D01-D10 order.
4. Update the ledger with task IDs, run/session IDs, source IDs, markers,
   route controls, and blockers.
5. Add or update failure-catalog rows only after root cause and recovery are
   verified.
6. Save only concise, verified, non-secret outcomes to agentmemory.

## 2026-06-17 Failure-Recovery Addendum

- Completed workflow cleanup through the GUI: runs `52efa735`, `3cab8150`,
  `930f36cc`, and `941ed65d` are now stored as `completed`.
- Preserved four intentional crypto TODO backlog tasks; old Wave 2 planner
  smoke backlog tasks `a200eb58`, `3708e5bf`, and `2205aab4` were archived
  through the GUI.
- Legacy run `072a8e34` is the live verification evidence for F047 after the
  approved rebuild/recreate. The run is now stored as `paused` with checkpoint
  reason and `workflow_continue` event `132d6b48`.
- Source and runtime fix verified: focused workflow tests passed 11/11, ESLint
  passed on the touched workflow files in a temporary Docker test image, and
  live image `5e47249c7dbc` stayed healthy and local-only.

## 2026-06-17 Post-Rebuild Confidence Sweep

- Authenticated read-only GUI route sweep passed for `/home`, `/protocols`,
  `/tasks`, `/runs`, `/quality`, `/knowledge`, `/agents`, `/org-chart`,
  `/projects`, `/logs`, `/providers`, `/secrets`, `/wallets`, `/autonomy`,
  `/schedules`, and `/settings`.
- Route checks used headings, scoped controls, stable `data-testid` values, and
  console error counts. No secret values, raw logs, auth JSON, full env files,
  credential values, wallet/private-key material, or raw Knowledge chunks were
  inspected.
- Metadata cross-checks: four backlog tasks remain the intentional crypto TODOs,
  protocol runs are `7 completed / 1 paused / 1 failed`, F047 Knowledge chunks
  are indexed across the operator sources, and project metadata was checked by
  ID/name plus description/objective lengths only.
