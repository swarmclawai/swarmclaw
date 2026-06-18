# SwarmClaw Operator Mastery Drill Plan

Last verified: 2026-06-18

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
| D04 | Done | Knowledge metadata checked without chunk/body dumps. Operator sources include GUI manual `c05dc18feaad931c`, failure catalog `75b590287831ac7e`, workflow recipe `9333a38a1e5f8a7e`, quickstart `70f893b23855027b`, loop plan `c413dab9a015b67c`, and mastery plan `cd1b9719ee881476`. After the 2026-06-18 Settings/Admin sync, verified chunk counts were quickstart 14, failure catalog 28, and mastery plan 14. | Verify by title/source ID/chunk count only; do not dump raw chunks. |
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

## 2026-06-17 Extended AppView Control Sweep

- Authenticated read-only browser sweep covered all 29 `AppView` routes from
  `src/lib/app/navigation.ts`: `/home`, `/agents`, `/org-chart`, `/inbox`,
  `/chatrooms`, `/protocols`, `/projects`, `/swarmfeed`, `/marketplace`,
  `/tasks`, `/missions`, `/schedules`, `/memory`, `/runs`, `/quality`,
  `/knowledge`, `/skills`, `/connectors`, `/webhooks`, `/mcp-servers`,
  `/extensions`, `/providers`, `/secrets`, `/wallets`, `/usage`, `/activity`,
  `/autonomy`, `/logs`, and `/settings`.
- Result: all 29 app views loaded with route-specific sidebar/control signals
  and zero new browser console errors. `/agents` redirected to
  `/agents/default`, which is expected for the default agent shortcut. Supporting
  authenticated reference routes `/user`, `/setup`, and `/login` redirected to
  `/home`, which is expected after setup/authentication.
- Readiness correction: the first pass showed that `domcontentloaded` can still
  capture only `Restoring agent workspace`; wait for the sidebar shell plus a
  route-specific signal before accepting a route as loaded. This is F005, not a
  new app failure.
- Deeper control checks covered `/protocols`, `/tasks`, `/runs`, `/quality`,
  `/knowledge`, `/agents`, `/projects`, `/providers`, `/secrets`, `/wallets`,
  `/autonomy`, and `/settings`. Sensitive pages were checked only by headings,
  buttons, and safe control labels; no secret values, provider keys, wallet
  material, logs, auth JSON, env files, or raw Knowledge chunks were inspected.

## 2026-06-17 Settings/Admin Deep Read-Only Drill

- Authenticated Settings drill switched only local Settings tabs and did not
  save or submit forms. Verified visible Settings sections: `General`,
  `Appearance`, `Agents & Automation`, `Memory & AI`, and `Integrations`.
- Read-only admin route checks covered `/providers`, `/secrets`, `/wallets`,
  `/autonomy`, `/schedules`, `/webhooks`, `/connectors`, `/mcp-servers`,
  `/extensions`, `/usage`, `/activity`, and `/logs`. All routes returned the
  expected pathname and zero new browser console errors.
- Sensitive handling: provider and integration pages were checked by provider
  names/status labels and model families only; no provider detail sheets were
  opened and no key values were read. Secrets/wallets/webhooks/connectors/MCP
  pages were checked by empty-state and create-control labels only. Autonomy was
  checked by safety-state headings and action labels only; no estop/resume
  controls were clicked.
- Operator method update: for admin drills, collect evidence from the main panel
  after the route heading. A raw snapshot can be dominated by sidebar labels and
  produce weak evidence even when the page is loaded correctly. For logs,
  activity, and usage, prefer filter/control names and aggregate counts over row
  bodies unless a specific failure investigation requires a narrow sanitized
  excerpt.

## 2026-06-18 Settings/Admin Knowledge Sync

- Synced the Settings/Admin drill doc delta into existing Knowledge sources:
  quickstart `70f893b23855027b`, failure catalog `75b590287831ac7e`, and
  mastery plan `cd1b9719ee881476`.
- Verification was metadata/search only. This sync covered only quickstart 14
  chunks, failure catalog 28 chunks, and mastery plan 14 chunks; other operator
  Knowledge sources were not changed in this pass. Search hits for
  Settings/Admin drill terms found the mastery plan and failure catalog. No raw
  chunks or secret-like content were printed.
- Temporary Docker image, sync scripts, and transformers cache were removed
  after verification; SwarmClaw remained healthy and bound only to
  `127.0.0.1:3456-3457`.

## 2026-06-18 Read-Only Subagent Audit

- Four sidecar agents reviewed docs, navigation/source, state metadata, and
  orchestration-plan gaps. All were read-only and closed after completion.
- Remaining product/operator gaps: isolate the dirty crypto runtime-contract
  patch before commit, exercise worktree-isolated parallel writes only after a
  checkpoint, decide whether repeated loop roles deserve durable agents/managed
  skills, and run a project-onboarding fan-in drill before code-writing waves.
- Metadata hygiene finding: 181 tasks exist, with no running/queued task
  statuses and no dangling project/agent/protocol/blocker references. One
  protocol run is paused, stale liveness metadata exists on terminal tasks, and
  one extra project workspace directory exists. Treat this as F048: inspect the
  paused run first, then plan a separate checkpointed hygiene pass.
- Next safe GUI mastery drills: mobile/collapsed sidebar and active states,
  command palette/search-only behavior with no command execution, global sheet
  open/close behavior, notifications and profile sheet open/close,
  `/protocols/builder/[templateId]` render,
  `/s/bad-token` invalid-share handling, and passive deep checks for Missions,
  Protocols, Tasks, Quality, and Autonomy.

## 2026-06-18 F048 Metadata Hygiene Pass

- Done after checkpoint: created DB backup
  `state/data/swarmclaw-before-f048-liveness-20260618-071209.db`, reconciled
  terminal task `liveness.state` values to the terminal task status, and removed
  the temporary repair script.
- Verified by counts only: terminal task liveness mismatch is now `0`; aggregate
  status/liveness counts are `completed/completed 135`, `failed/failed 20`,
  `archived/archived 21`, `cancelled/cancelled 1`, and open backlog tasks remain
  `backlog/none 4`.
- Protocol run aggregate stayed unchanged: `7 completed`, `1 failed`, and
  `1 paused`. The paused `072a8e34` run still represents the checkpointed
  marker-mismatch workflow evidence from F047.
- Workspace-directory review: `state/workspace/projects/crypto-trading-bot` was
  not deleted or archived. It is an intentional large source workspace used by
  the crypto project; project metadata does not support mapping arbitrary
  workspace paths, so task `cwd` must carry that path explicitly when needed.
- No secrets, raw task bodies, raw logs, auth JSON, env files, or credential
  values were inspected as part of the repair.

## 2026-06-18 Read-Only Mastery Drill Attempt

| Drill | Status | Evidence | Next action |
|---|---|---|---|
| Passive app route checks | Done | `/tasks`, `/protocols`, `/missions`, `/quality`, and `/autonomy` rendered route-specific controls with zero app console errors. Sensitive controls were not clicked. | Keep these as current confidence evidence. |
| Command palette/search-only | Blocked | The automation browser became unauthenticated and showed only the access-check shell, so the Search control was not available. | Resume only after Zmey logs in or approves a secret-safe auth method. |
| Mobile/collapsed sidebar | Blocked | Route navigation reached the shell but not the authenticated app body. The first locator pass is invalid evidence, not an app failure. | Re-run with authenticated browser and route-specific ready signals after auth is restored. |
| New Task sheet open/close | Blocked | The authenticated `/tasks` body was not available in the automation tab. No task was created or edited. | Re-run full-form open/close without saving after auth is restored. |
| Notifications/profile open-close | Blocked | The notification/profile controls were not available because the automation tab was unauthenticated. | Re-run open/close only; do not click notification rows, mark-all controls, Save, or sign-out actions. |
| Protocol builder render | Blocked | Direct navigation did not reach an authenticated builder surface. | Re-run `/protocols/builder/facilitated_discussion` render-only after auth is restored. |
| Invalid share route | Blocked | Direct navigation was inconclusive from the access-check shell. | Re-run `/s/bad-token` as a reference-only route after auth is restored. |

Auth safety update: this pass exposed F049. Direct `/api/auth` probes must be
status-only or redacted because an unauthenticated first-time/access-gate state
can return generated access material. If the in-app browser is unauthenticated,
do not read auth files, local storage, cookies, `.env.local`, or response
bodies to bypass the gate. Ask Zmey to authenticate the browser or checkpoint a
secret-safe auth method.

## 2026-06-18 Authenticated Read-Only Mastery Completion

- Zmey restored the authenticated in-app browser. Authenticated readiness was
  verified from route-specific controls: sidebar links, `Search`, `Tasks`,
  `Protocols`, `Home`, no access-check shell, and zero app console errors.
- Command palette drill passed: opened from `Search ⌘K`, showed entries such as
  `Default Agent Shortcut`, `Provider Credentials`, and `Go to Tasks`, filled
  the focused search input with `tasks`, verified `Tasks`/`Go to Tasks` search
  signals, and closed with Escape. No command was executed.
- Mobile read-only drill passed at `390x844`: `/home` rendered the SwarmClaw
  Operations Pulse and `/tasks` rendered Task Board signals with zero app
  console errors. Viewport was reset afterward.
- New Task sheet drill passed: opened the top `Task` button, verified
  dialog-scoped `New Task`, title, agent, quality, and cancel controls, then
  closed with `Cancel`. No task was created, edited, queued, or saved.
- Notifications drill passed: opened and closed the Notifications panel, saw
  unread count and `Mark all read`, and did not click notification rows or
  mark-all controls.
- Profile drill passed: opened and closed the profile sheet, saw `Profile`,
  Avatar, `Save`, and `Sign in as different user`, and did not save or sign
  out.
- Supporting route drills passed: `/protocols/builder/facilitated_discussion`
  rendered `Facilitated Discussion` with zero app console errors, and
  `/s/bad-token` produced a reference-only `404`/Home surface with zero app
  console errors.
- Browser tool output included a repeated Statsig networking line from the
  automation environment. Treat this as F050 when `tab.dev.logs()` reports zero
  app console errors.

## 2026-06-18 Broad Remaining Route Sweep

- Completed a read-only follow-up sweep for less-tested GUI surfaces using
  route-specific and main-panel evidence. No forms were submitted, no detail
  sheets were opened on sensitive/admin records, no settings were changed, and
  no Knowledge source was synced or edited.
- Verified with zero app console errors: `/agents/default`, `/org-chart`,
  `/inbox`, `/chatrooms`, `/projects`, `/swarmfeed`, `/marketplace`,
  `/missions`, `/schedules`, `/memory`, `/runs`, `/knowledge`, `/skills`,
  `/connectors`, `/webhooks`, `/mcp-servers`, `/extensions`, `/usage`,
  `/activity`, and `/settings`.
- Main-panel evidence highlights: Projects showed `Crypto Trading Bot` and
  `SwarmClaw Local Ops`; Runs showed status filters and run rows; Connectors,
  Webhooks, and MCP Servers showed empty-state/add controls; Activity showed
  audit-trail rows and filters; Schedules showed live/archive/runs/history
  tabs and empty-state scheduler controls; Memory showed scope/tier controls
  and agent/global memory counts; Inbox and Chatrooms showed empty-state
  conversation controls; SwarmFeed showed compose/search/feed controls without
  publishing.
- Operator lesson reinforced: broad route sweeps can match sidebar labels or
  task/log snippets. Count a route as verified only after a main-panel heading,
  route-specific control, scoped placeholder, empty-state label, or stable row
  signal is observed. This is F005, not a new failure family.

## 2026-06-18 Finish-Rule Closure Pass

- New operator rule adopted: after each checkpointed operator step, sync changed
  operator docs into in-app Knowledge, run controlled read-only filter/search
  drills, and run one small live direct-assignment task drill before calling the
  step done.
- Preflight remained healthy and local-only:
  `/api/healthz` returned ok and Docker reported
  `127.0.0.1:3456-3457->3456-3457/tcp`.
- Knowledge sync completed for existing operator sources without raw chunk
  dumps: quickstart `70f893b23855027b`, failure catalog
  `75b590287831ac7e`, mastery plan `cd1b9719ee881476`, loop plan
  `c413dab9a015b67c`, workflow recipe `9333a38a1e5f8a7e`, and GUI manual
  `c05dc18feaad931c`. Metadata/search-only verification used terms including
  `F050`, `Statsig`, `remaining route sweep`, `authenticated mastery`, and
  `Knowledge sync`.
- Controlled read-only GUI filter/search drills passed: `/tasks` search for
  `F043`, `/runs` Failed/All plus search clear/reset, `/knowledge` search for
  `F050`, and `/schedules` status/cadence/agent filter reset. No forms were
  submitted and no raw logs, secret values, provider keys, wallet material, or
  raw Knowledge chunks were inspected.
- Live direct-assignment task drill passed through the GUI full task form:
  task `ed87e5b0`, Builder `92b8cd6c`, project `SwarmClaw Local Ops`
  `bad5cf13`, session `6c38b4e5`, marker
  `SWARMCLAW_FINISH_RULE_DIRECT_ASSIGNMENT_OK`, files changed `none`,
  validation `ok=true`.
- The drill also exposed a fresh F048 recurrence: task `ed87e5b0` stored
  terminal status `completed` while its persisted `liveness.state` remained
  `queued`. Source fix added in `task-lifecycle.ts` so terminal completion and
  failure helpers refresh liveness when status changes; focused test
  `src/lib/server/tasks/task-lifecycle.test.ts` passed 9/9 in an isolated
  build-stage image, and focused ESLint on the changed task files passed.
- After checkpoint, rebuilt/recreated only the local `swarmclaw` service,
  verified health and `127.0.0.1:3456-3457` binding, backed up the DB to
  `state/data/swarmclaw-before-f048-ed87e5b0-liveness-20260618.db`, and repaired
  only task `ed87e5b0` by ID/counts.
- Live fix verification passed: task `d37e8317`, Builder `92b8cd6c`, project
  `bad5cf13`, session `a63f7d17`, marker
  `SWARMCLAW_LIVENESS_FIX_DIRECT_ASSIGNMENT_OK`, files changed `none`,
  validation `ok=true`, and stored terminal state `completed|completed`.
  Terminal-task liveness mismatch count is `0` after the repair and live smoke.
- Observation: during execution, task `d37e8317` transiently showed
  `running|queued` before terminal completion corrected to
  `completed|completed`. Treat this as a lower-priority display/liveness gap
  unless it produces an operator-visible failure; F048 terminal drift is fixed.
