# SwarmClaw GUI Operator Manual

Last verified: 2026-06-06

Audience: Codex and other agents operating Zmey's local SwarmClaw instance.

Instance: `http://127.0.0.1:3456` on branch `docker-subscription-setup`, Docker image `swarmclaw-subscription:1.9.36`, compose file `compose.subscription.yml`.

This is an instance-specific operating manual. It is not a product replacement for `skills/swarmclaw/SKILL.md`, and that skill should remain the general SwarmClaw product skill.

For fast onboarding, start with `docs/operations/swarmclaw-next-agent-quickstart.md`. For known failure modes and prevention steps, use `docs/operations/swarmclaw-operator-failure-catalog.md`.

## Agent Quickstart

Before operating the GUI:

1. Search agentmemory for recent `SwarmClaw`, `agentmemory`, local subscription setup, and Codex memory hygiene notes.
2. Read `AGENTS.md` in the repo root and follow the repo rules.
3. Read `/home/zmey/2. Personal/Codex/swarmclaw-agent-handoff.md` if readable. Treat it as the current handoff source of truth for Zmey's local setup.
4. Read `docs/operations/swarmclaw-next-agent-quickstart.md` for the short boot path and `docs/operations/swarmclaw-operator-failure-catalog.md` before retrying or repairing failures.
5. Confirm health and local binding:
   - `curl -fsS http://127.0.0.1:3456/api/healthz`
   - `docker compose -f compose.subscription.yml ps`
   - Expected binding: `127.0.0.1:3456-3457->3456-3457/tcp`
6. Use the in-app browser in read-only mode before giving step-by-step GUI instructions.
7. Do not submit forms, start runs, trigger schedules, create/delete records, reveal secrets, or change settings unless Zmey explicitly checkpointed that exact action.
8. Do not kill, restart, replace, or rebind the dev server on port `3456` without asking first.

Never inspect or print secrets, auth JSON, full env files, tokens, credential files, private keys, credential table contents, or raw provider credential values. Do not run commands that dump full compose or environment config unless output is redacted first.

## What We Last Did

Memory and the handoff agree on this recent state:

- Codex is Zmey's main helper for properly configuring SwarmClaw.
- SwarmClaw is local-only and should stay local-only.
- The local subscription runtime is healthy on `127.0.0.1:3456`.
- The current work is on branch `docker-subscription-setup`.
- The active image is `swarmclaw-subscription:1.9.36`.
- Existing agents are Coordinator, Builder, Reviewer QA, OpenCode Builder, OpenCode Go Helper, and Copilot Mini Worker.
- The handoff names OpenCode Builder as `OpenCode Go Builder`; the live GUI currently shows `OpenCode Builder`. Treat this as a naming drift, not a provider change.
- Avoid `opencode-go/deepseek-v4-flash` for normal agent work because headless OpenCode runs can exit successfully without assistant text.
- Current Knowledge sources are `SwarmClaw Agent Handoff Guide`, `Zmey SwarmClaw Operating Policy`, and `SwarmClaw GUI Operator Manual`.
- Current project is `SwarmClaw Local Ops`.
- `Document verified provider and agent lineup` and `Create Knowledge sources for SwarmClaw local runbooks` are completed.
- `Builder read-only queue smoke test` failed due the quality gate despite the task producing a smoke marker.
- `SwarmClaw GUI operator manual read-only smoke` completed after direct queue/retry remediation, fresh task session creation, and prompt grounding with sanitized manual excerpts.
- `Test Coordinator delegation to worker agents` completed with evidence marker `SWARMCLAW_COORDINATOR_DELEGATION_SMOKE_OK`.
- Delegation caveat from that test: the Coordinator used a CLI delegation path that spawned runtime child `Feynman`, even though the worker response identified itself as Builder. Treat that as proof the CLI delegate path works, not proof that the stored `Builder` agent record was invoked.
- `Stored Builder direct assignment smoke` completed with evidence marker `SWARMCLAW_STORED_BUILDER_DIRECT_SMOKE_OK`. Stored metadata showed task agent `92b8cd6c`, session `88c1c828`, and stored Builder provider/model `codex-cli` / `gpt-5.5`.
- Direct managed task assignment is now the default operating path for worker work. Assign tasks to the exact stored agent ID and verify task/session metadata.
- A read-only browser sweep covered all 29 top-level app views. All routes loaded in safe-shell mode. Current attention items are the known failed task, a blocked Quality eval gate, Autonomy incidents related to recent task/quality failures, and a Logs warning that `CREDENTIAL_SECRET` differs between environment and the app's credential-secret file. No secret values were inspected.
- Direct-assignment worker smokes completed for Reviewer QA, Copilot Mini Worker, OpenCode Builder, and OpenCode Go Helper with markers `SWARMCLAW_REVIEWER_QA_DIRECT_SMOKE_OK`, `SWARMCLAW_COPILOT_MINI_DIRECT_SMOKE_OK`, `SWARMCLAW_OPENCODE_BUILDER_DIRECT_SMOKE_OK`, and `SWARMCLAW_OPENCODE_HELPER_DIRECT_SMOKE_OK`.
- Second-tranche failure triage classified the current warning surfaces. The failed Builder smoke is a validation-gate mismatch, not a provider failure. The Quality `Prime Number Function` gate is blocked because there are zero eval runs and zero eval baselines. Recent Autonomy incidents are known validation/dead-letter or user-stopped runs, with no active estop. Logs show post-run working-state/autonomy observation warnings because CLI-backed agents are not generation-compatible for that enrichment path.
- Source patch added and live-verified on 2026-06-06: optional working-state extraction and autonomy reflection now skip quietly when no generation-compatible model is configured, while deterministic working-state evidence and supervisor incidents still persist. Focused patched-source tests passed in a one-off container. Zmey rebuilt/recreated the service, live image `8042f32119f4` contains the patch, and Builder smoke task `4c4cd367` completed with marker `SWARMCLAW_POST_REBUILD_ENRICHMENT_SMOKE_OK` and no new missing-generation enrichment warnings after the log baseline.
- Coordinator subagent-routing caveat: a scoped 2026-06-06 configuration attempt proved the current Codex CLI Coordinator cannot become a true stored `spawn_subagent` coordinator. SwarmClaw normalizes all CLI providers, including `codex-cli`, as worker-only, forcing `role=worker` and `delegationEnabled=false`. The attempted `spawn_subagent` metadata was restored to the pre-change state.

The manual is now indexed as an in-app Knowledge source and reflected in the external handoff. Treat future updates to either surface as checkpointed actions unless Zmey explicitly scopes them into the current task.

## Truth Source Policy

Use these sources in order:

1. Live GUI behavior on `http://127.0.0.1:3456`
2. Local source code and route/view mappings
3. Official SwarmClaw docs
4. Agentmemory and the external handoff

If sources conflict:

- Prefer local runtime behavior for operating Zmey's instance.
- Record the conflict explicitly.
- Do not average patterns.
- Ask Zmey before any state-changing action.

Known conflicts and caveats:

- Official Getting Started docs say a default `swarmclaw` command binds to `0.0.0.0:3456`; Zmey's Docker setup must stay bound to `127.0.0.1`.
- Official docs are mostly updated for v1.9.35, while this local image is v1.9.36.
- The GUI header can show an internal container address. Binding verification must come from Docker status, not from the header text alone.
- The docs use current `Extensions` terminology; do not introduce new `plugins` wording in this repo.
- Worker routing has two distinct paths in local source: `delegate` hands work to external CLI backends, while `spawn_subagent` targets stored SwarmClaw agents by `agentId`. Do not treat a CLI delegate runtime nickname as stored-agent evidence.
- The agent named Coordinator is an operating role by convention in this local setup, but the stored agent record is a worker-only Codex CLI record. Source prompt sections for coordinator workers depend on stored role/delegation settings, so UI/source metadata must be checked before relying on automatic coordinator orchestration.
- Current source constraint: `WORKER_ONLY_PROVIDER_IDS` includes all CLI providers. A true stored `spawn_subagent` coordinator therefore requires a non-worker provider coordinator or a code/product change, both of which require a separate checkpoint.

## Official Docs Cross-Check

Primary docs checked:

- Introduction: https://www.swarmclaw.ai/docs, updated for v1.9.35.
- Getting Started: https://www.swarmclaw.ai/docs/getting-started, updated for v1.9.35.
- Tasks: https://www.swarmclaw.ai/docs/tasks, updated for v1.9.35.
- Configuration: https://www.swarmclaw.ai/docs/configuration, updated for v1.9.34.
- Deployment: https://www.swarmclaw.ai/docs/deployment, updated for v1.9.35.

Operational docs also checked by category:

- Agents, Providers, Projects, Scheduling, Structured Sessions
- Memory, Knowledge, Connectors, Inbox, MCP Servers, Webhooks, Skills, Extensions
- Autonomy, Daemon, Activity, Cost Tracking, Wallets, OpenClaw Setup

Docs confirm that SwarmClaw is a powerful local runtime that can run commands, edit files, use browsers, call APIs, and spend wallet funds depending on enabled tools. That is why this manual treats GUI actions by risk level.

## Safety Matrix

| Level | Name | Allowed without checkpoint | Examples |
|---|---|---|---|
| R0 | Read-only | Yes | View dashboards, inspect tasks, read docs, read source mappings, view usage/activity, run health check, review masked GUI metadata |
| R1 | Low-risk local write | Usually | Edit this manual, use UI filters/search, collapse/expand sidebar, open details and cancel without saving |
| R2 | Execution or durable workspace change | Checkpoint first | Create/edit tasks, retry failed work, chat with agents for work, add Knowledge, edit projects, start structured sessions, post to Feed |
| R3 | Sensitive/high-impact | Explicit checkpoint required | Providers, secrets, wallets, schedules, autonomy, connectors, webhooks, MCP servers, extensions, settings, public exposure, state DB, `.env.local`, credentials |
| R4 | Forbidden without direct instruction | No | Expose port `3456` publicly, reveal secrets, inspect credential files/tables, kill/restart the dev server, destructive DB or state changes |

Checkpoint language should name the exact action, target page, affected records, expected risk, and rollback or backup plan.

## Navigation Map

Source of truth:

- `src/types/session.ts` defines the 29 `AppView` values.
- `src/lib/app/navigation.ts` maps each view to a route.
- `src/components/layout/sidebar-rail.tsx` groups the sidebar.
- `src/lib/app/view-constants.ts` defines labels, descriptions, create labels, and empty states.

The persistent rail also includes Search, the default-agent shortcut, Docs, Star on GitHub, Join Discord, Daemon, Notifications, Settings, and Profile controls. Treat Docs, GitHub, and Discord as external links; do not open or post externally unless that is part of the approved task.

### Workspace

| View | Label | URL |
|---|---|---|
| `home` | Home | `/home` |
| `agents` | Agents | `/agents`, `/agents/[id]` |
| `org_chart` | Org Chart | `/org-chart` |
| `inbox` | Inbox | `/inbox` |
| `chatrooms` | Chatrooms | `/chatrooms`, `/chatrooms/[id]` |
| `protocols` | Sessions | `/protocols` |
| `projects` | Projects | `/projects` |
| `swarmfeed` | Feed | `/swarmfeed` |
| `marketplace` | Marketplace | `/marketplace` |

### Execution

| View | Label | URL |
|---|---|---|
| `tasks` | Tasks | `/tasks` |
| `missions` | Missions | `/missions` |
| `schedules` | Schedules | `/schedules` |
| `memory` | Memory | `/memory` |
| `runs` | Runs | `/runs` |
| `quality` | Quality | `/quality` |

### Knowledge And Integrations

| View | Label | URL |
|---|---|---|
| `knowledge` | Knowledge | `/knowledge` |
| `skills` | Skills | `/skills` |
| `connectors` | Connectors | `/connectors` |
| `webhooks` | Webhooks | `/webhooks` |
| `mcp_servers` | MCP Servers | `/mcp-servers` |
| `extensions` | Extensions | `/extensions` |

### System And Admin

| View | Label | URL |
|---|---|---|
| `secrets` | Secrets | `/secrets` |
| `wallets` | Wallets | `/wallets` |
| `providers` | Providers | `/providers` |
| `usage` | Usage | `/usage` |
| `activity` | Activity | `/activity` |
| `autonomy` | Autonomy | `/autonomy` |
| `logs` | Logs | `/logs` |
| `settings` | Settings | `/settings` |

### Supporting Surfaces

| Surface | URL | Use |
|---|---|---|
| Root | `/` | Redirects to `/home` |
| Login | `/login` | Access-key gate; current authenticated GUI redirects to `/home` |
| Setup | `/setup` | First-run setup wizard; current configured GUI redirects to `/home` |
| User/Profile | `/user` | Profile/user selection surface; current configured GUI redirects to `/home` |
| Shared links | `/s/[token]` | Reference-only shared entity pages |

## Page Playbooks

Each playbook lists the normal operating purpose, visible controls observed or sourced, safe reads, write actions, approval level, and references.

### Workspace Pages

| Page | Purpose | Visible controls | Safe reads | Write actions | Approval | References |
|---|---|---|---|---|---|---|
| Home `/home` | Operations dashboard for agents, tasks, schedules, notifications, and recent activity. | 24h/7d range, Refresh, operation pulse, notification center, recent chats, recent activity. | Agent count, active task count, connectors count, cost trend, current blockers, unread notifications. | Launch actions from cards can open work surfaces or start follow-up flows. | R0 for viewing, R2 for launch actions. | `src/app/home/page.tsx`, Introduction docs. |
| Agents `/agents` | Agent chat, agent list, and per-agent configuration. | Agent search, Agent create button, chat/config tabs, filters, message box, context pack, memories, bookmarks. | Agent names, enabled status, provider/model labels, chat history summaries, configuration labels. | Send messages, create/edit agents, change routing/tools/memory/heartbeat, delete chats. | R2 for ordinary work chat, R3 for configuration. | `src/app/agents/page.tsx`, `src/app/agents/[id]/page.tsx`, Agents docs. |
| Org Chart `/org-chart` | Visual hierarchy and delegation topology. | Agent search, auto-layout, zoom, fit-to-screen, draggable agent nodes. | Current visual team/delegation layout. | Drag/drop reparenting changes delegation targets. | R2 minimum; R3 if delegation affects active agents. | `src/app/org-chart/page.tsx`, `src/lib/app/view-constants.ts`. |
| Inbox `/inbox` | External connector conversations separated from main chats. | Platform filters, connector selector, sender/search input. | Connector conversation list, isolated transcripts, platform health. | Replying, changing routing, owner/access adjustments. | R0 for review, R2/R3 for replies or routing. | `src/app/inbox/page.tsx`, Inbox docs. |
| Chatrooms `/chatrooms` | Multi-agent group chat. | New chatroom, chatrooms/sessions tabs, room list, member mentions. | Room list, members, transcript summaries. | Create rooms, send messages, use mentions to trigger agents. | R2. | `src/app/chatrooms/page.tsx`, Chatrooms docs. |
| Sessions `/protocols` | Bounded structured sessions and reusable protocol templates. | Start structured session, New template, visual builder, built-in templates, recent runs. | Template list, prior run metadata, artifacts/citations. | Start session, create/edit template, open live run. | R2; R3 if agents can execute tools. | `src/app/protocols/page.tsx`, Structured Sessions docs. |
| Projects `/projects` | Groups agents, tasks, schedules, goals, and operating context. | Search projects, New, project list/detail. | Project names, descriptions, task counts, linked agents/tasks. | Create/edit/delete projects, assign tasks/agents/schedules. | R2. | `src/app/projects/page.tsx`, Projects docs. |
| Feed `/swarmfeed` | Agent social feed. | Compose box, acting-as selector, Publish, search, tabs for posts/agents/channels/hashtags. | Feed contents, enabled agents, bookmarks/search. | Publish, reply, follow, repost, like. | R2; R3 if external/network posting is involved. | `src/features/swarmfeed/feed-page.tsx`, SwarmFeed docs. |
| Marketplace `/marketplace` | SwarmDock tasks/agents/skills marketplace. | Tasks/Agents tabs, marketplace browse areas. | Listings and public metadata. | Bidding, payments, installs, submissions. | R3. | `src/features/swarmdock/marketplace-page.tsx`, SwarmDock docs. |

### Execution Pages

| Page | Purpose | Visible controls | Safe reads | Write actions | Approval | References |
|---|---|---|---|---|---|---|
| Tasks `/tasks` | Durable task board for agent work. | Board/List view, filters, search, New Task, Import GitHub, add-to-column inputs, task cards, status queues. | Statuses, assignments, tags, dependencies, results, logs, handoff packets. | Create/edit/retry/cancel/archive tasks, change status/agent/project, import issues. | R2; R3 if task can spend, run tools, or touch state. | `src/app/tasks/page.tsx`, Tasks docs. |
| Missions `/missions` | Autonomous goal-driven runs with budgets and reports. | Mission create, template gallery, filters, install template, pause/resume/cancel controls when present. | Mission status, budgets, reports, timeline, end reasons. | Start/pause/resume/cancel mission, edit budgets/reports. | R3. | `src/app/missions/page.tsx`, Mission docs in local source, Autonomy docs. |
| Schedules `/schedules` | Cron, interval, and one-time automation. | New Schedule, Live/Archived/Runs/History tabs, status/cadence/agent/delivery filters, Run now/pause/resume/edit/archive when present. | Schedule list, next run, run history, preflight state. | Create/edit/run/pause/resume/archive/restore/purge. | R3. | `src/app/schedules/page.tsx`, Scheduling docs. |
| Memory `/memory` | Long-term agent memory store. | Search, scope/tier filters, memory list/detail/graph tabs. | Memory counts, categories, scopes, durable/pinned status, non-sensitive summaries. | Pin/share/edit/archive/delete memories or run cleanup. | R2; R3 if sensitive memory may be exposed or deleted. | `src/app/memory/page.tsx`, Memory docs. |
| Runs `/runs` | Live run queue and execution history. | Status tabs, source filter, search, run rows. | Queued/running/completed/failed runs, duration, source, result/error summaries. | Cancel pending run, retry or copy/use handoff where exposed. | R2; R3 if retry triggers risky execution. | `src/app/runs/page.tsx`, Tasks docs, Quality docs. |
| Quality `/quality` | Evals, approvals, run review, release readiness, and operator attention. | Refresh, Overview, Eval Lab, Approval Desk, Run Review, 24h/7d pulse. | Failed work, pending approvals, eval history, run evidence, ship gate status. | Approve/reject requests, run evals, launch QA missions. | R3. | `src/app/quality/page.tsx`, Cost/Activity/Autonomy docs. |

### Knowledge And Integration Pages

| Page | Purpose | Visible controls | Safe reads | Write actions | Approval | References |
|---|---|---|---|---|---|---|
| Knowledge `/knowledge` | Shared source material indexed for agent grounding. | New Source, Maintain, archived toggle, tag filters, source cards, chunk/detail views. | Source titles, tags, chunk counts, hygiene status, provenance. | Add/sync/archive/restore/supersede/delete source, upload file, index URL/manual text. | R2; checkpoint before adding or editing Knowledge sources. | `src/app/knowledge/page.tsx`, Knowledge docs. |
| Skills `/skills` | Reusable instruction sets and reviewed skill drafts. | New skill, Browse ClawHub, Edit, draft from current chat, library/ClawHub tabs, filters. | Installed skill names, descriptions, draft counts, marketplace metadata. | Create/edit/delete skills, approve/reject drafts, install skills. | R3 because skills alter agent behavior. | `src/app/skills/page.tsx`, Skills docs. |
| Connectors `/connectors` | External chat bridges. | Add Connector, connector list, platform setup forms when opened. | Connector count, platform labels, health metadata. | Create/enable/disable connectors, route channels to agents, change credentials. | R3. | `src/app/connectors/page.tsx`, Connectors docs. |
| Webhooks `/webhooks` | Inbound HTTP event triggers. | Add Webhook, webhook list, route/filter controls when opened. | Webhook count, non-secret status, delivery metadata. | Create/delete webhook, change filters/routes/secrets, trigger external ingress. | R3. | `src/app/webhooks/page.tsx`, Webhooks docs. |
| MCP Servers `/mcp-servers` | External MCP tool server registry and agent tool exposure. | Add MCP Server, registry/test/discover controls when opened. | Server names, transport type, assigned agents, tool names if non-sensitive. | Add/test/invoke/delete MCP servers, assign tools to agents. | R3. | `src/app/mcp-servers/page.tsx`, MCP Servers docs. |
| Extensions `/extensions` | External extension manager. | Extension create, installed/marketplace tabs, search, toggles, install/edit/delete controls. | Installed extension names/descriptions and enabled flags. | Install/enable/disable/delete extensions, install dependencies. | R3. | `src/app/extensions/page.tsx`, Extensions docs. |

### System And Admin Pages

| Page | Purpose | Visible controls | Safe reads | Write actions | Approval | References |
|---|---|---|---|---|---|---|
| Secrets `/secrets` | Encrypted secret metadata and secret editor. | Add Secret, secret list/sheet. | Count and non-sensitive labels only. Never inspect values. | Add/edit/delete secrets or scopes. | R3. | `src/app/secrets/page.tsx`, Configuration docs. |
| Wallets `/wallets` | Agent wallets and transaction capacity. | Generate Wallet, wallet list/actions when present. | Wallet count and non-sensitive policy metadata only. | Generate/copy/delete wallets, change limits, approve transactions. | R3. | `src/app/wallets/page.tsx`, Wallets docs. |
| Providers `/providers` | Provider and gateway configuration. | Provider create, Gateway, Refresh Fleet, provider cards/settings. | Provider names, model labels, health status, masked diagnostics. | Add/edit/delete providers, credentials, models, routing, gateway tokens. | R3. | `src/app/providers/page.tsx`, Providers docs. |
| Usage `/usage` | Token, cost, request, provider, agent, and task metrics. | 24h/7d/30d range, charts, provider/agent/task breakdowns. | Costs, token counts, completion rate, provider risk, workflow friction. | Export if present, budget edits if linked elsewhere. | R0 for dashboard, R2/R3 for budget changes. | `src/app/usage/page.tsx`, Cost Tracking docs. |
| Activity `/activity` | Audit trail of entity mutations. | Entity type filters, live event list. | Recent changes, actor, entity type, timestamp, incident entries. | None normally. | R0. | `src/app/activity/page.tsx`, Activity docs. |
| Autonomy `/autonomy` | Runtime safety controls, estops, incidents, restore/resume flows. | Refresh, Engage autonomy estop, Engage full estop, resume approval requirement, incident cards. | Current safety state, incidents, reflections, orchestrator visibility. | Estop/resume/restore, autonomy settings, incident remediation actions. | R3. | `src/app/autonomy/page.tsx`, Autonomy docs. |
| Logs `/logs` | Application logs and debug view. | Level filters, search, live mode, expand entries. | Counts and high-level non-sensitive error summaries. Avoid raw log payloads. | Copy/export/delete/clear if exposed. | R0 for sanitized review, R2/R3 for exports or payload inspection. | `src/app/logs/page.tsx`, Observability docs. |
| Settings `/settings` | Global preferences and runtime configuration. | General/Appearance/Agents & Automation/Memory & AI sections, search, advanced controls. | Labels and current non-sensitive settings only. | Defaults, provider/secrets/autonomy/heartbeat/embeddings/search/voice/tool policy. | R3. | `src/app/settings/page.tsx`, Configuration docs. |

### Supporting Pages

| Page | Purpose | Safe use | Approval | References |
|---|---|---|---|---|
| `/login` | Access-key gate. Current authenticated local GUI redirects to `/home`. | Observe whether auth is required. Do not request or paste keys unless Zmey explicitly provides them for that page. | R3 for auth handling. | `src/app/login/page.tsx`, Getting Started docs. |
| `/setup` | First-run setup wizard. Current configured local GUI redirects to `/home`. | Confirm setup is complete. | R3 for any wizard step. | `src/app/setup/page.tsx`, Getting Started docs. |
| `/user` | Profile/user surface reached from bottom avatar. Current direct route redirects to `/home`. | View profile surface only if Zmey asks. | R1/R2 depending on fields changed. | `src/app/user/page.tsx`. |
| `/s/[token]` | Public shared entity view. | Reference-only review of shared content. | R0; R3 before creating public shares. | `src/app/s/[token]/page.tsx`. |

## Common Workflows

### Inspect Current Status

1. Confirm health with `/api/healthz`.
2. Confirm Docker binding is `127.0.0.1`, not public.
3. Open `/home`.
4. Read Operations Pulse, Needs Attention, Running Tasks, Upcoming Schedules, Recent Activity, and Notifications.
5. If an item looks actionable, navigate to the specific page and inspect before recommending a change.

No checkpoint needed unless acting on an item.

### Review A Failed Task

1. Open `/tasks`.
2. Switch to List view when triaging failures; it avoids horizontal board columns and shows the failed task, error, system comment, agent validation comment, and `View` action in one vertical surface.
3. Filter or search for the failed task.
4. Open the task details and read status, assigned agent, result, comments, run links, and artifacts.
5. Cross-check `/runs` for the execution record and `/quality` for approval or validation context.
6. Summarize cause, evidence, and the smallest safe next action.
7. Ask before retrying, changing status, editing task content, or changing quality gates.

Read-only smoke caveat: a task can produce the requested marker and still fail validation if the quality gate requires evidence signals the prompt forbids. `Builder read-only queue smoke test` returned `BUILDER_QUEUE_SMOKE_OK` but failed because the gate saw only one of two required evidence signal types. Before queueing a read-only smoke, either disable or relax the quality gate with approval, or include validator-friendly non-invasive evidence requirements in the prompt. For browser smokes, require concrete details such as the browser tool, target route, HTTP status, final URL or ready signal, and page/request failure counts.

### Monitor A Run

1. Open `/runs`.
2. Filter by queued/running/failed/completed or source.
3. Inspect run duration, source, result/error summary, and linked task/session.
4. If evidence is insufficient, check `/quality` Run Review.
5. Do not cancel or retry without checkpoint.

### Manage Knowledge

1. Open `/knowledge`.
2. Inspect source titles, tags, chunk counts, hygiene status, and provenance.
3. Use docs and handoff to decide whether a source belongs in Knowledge or memory.
4. Ask before adding, editing, syncing, archiving, superseding, or deleting any source.
5. This manual is already indexed as `SwarmClaw GUI Operator Manual`. Future manual syncs, edits, archive/delete actions, or source replacements require checkpoint.

### Triage Quality Incidents

1. Open `/quality`.
2. Check Operations Pulse, Run Review, Approval Desk, and release-readiness panels.
3. Open `/activity` to see when the incident was recorded.
4. Open `/runs` or `/tasks` for linked evidence.
5. Recommend either read-only investigation, task retry, task status reconciliation, or config change.
6. Config changes, approvals, evals, and retries require checkpoint.

### Operate The Task Board

1. Open `/tasks`.
2. Use board/list view depending on whether status or detail matters.
3. Inspect task status, assignment, project, tags, dependencies, comments, artifacts, and run history.
4. For new work, draft the exact task title, agent, project, tags, status, and acceptance criteria before creating it.
5. New Task creates a backlog task by default. To run it, close the sheet and use the card's `Queue` button, then verify the stored status moved to `queued` or `running`.
6. Ask before creating, queueing, retrying, cancelling, completing, archiving, or importing tasks.

### Browser Automation Pitfalls

1. After direct navigation, `domcontentloaded` is not enough. Wait for route-specific app text before extracting headings, buttons, or state; otherwise a probe can see an almost empty shell and produce false negatives.
2. Text entry can fail in the in-app browser when the virtual clipboard layer is unavailable. If `fill`, `type`, or DOM typing fails, use character-by-character keypress into the focused field for short fields.
3. Task-board role locators can match hidden or duplicated controls. Do not click a generic `Queue`, `View`, or `Archive` button until the current DOM or visible snapshot proves the button belongs to the intended task card.
4. Board columns can extend horizontally beyond the current viewport. Coordinate clicks on cards in right-side columns can fail with an offscreen element point. Prefer List view, a scoped locator after enumerating visible task headings, or a source-backed route/service path after checkpoint.
5. Broad `document.body` text is not reliable for verifying task search filters because task titles can remain in the sidebar, offscreen columns, and detail surfaces. Verify a scoped board/list container, status count, or sanitized task metadata instead.
6. Prefer `dom_cua.get_visible_dom()` node IDs or a visible-button filter with parent text verification for task-card actions.
7. Coordinate clicks and CUA drag/drop can silently fail on the board. Dragging a card from Backlog to Queued is not proof that the task moved.
8. After any queue/retry/status action, verify the task status from both the GUI and sanitized task metadata. If status does not change, treat the action as failed and do not assume execution started.
9. The in-app browser's protected page evaluation surface may not expose `fetch`; do not assume it can perform authenticated API writes. Prefer visible GUI controls first.
10. If the GUI path is blocked by automation limits, ask Zmey before using a more direct API or state-repair path.

### CLI Task Knowledge Pitfalls

1. A CLI-backed task run can have searchable in-app Knowledge available in SwarmClaw while the CLI agent still reports that the source is not available as an MCP resource. Do not assume the CLI can browse Knowledge sources directly.
2. When a CLI-backed task must use a specific Knowledge source, include a short sanitized excerpt, the Knowledge source title, and the repo path in the task description. Tell the agent to use the excerpt instead of MCP resource discovery.
3. If a read-only smoke task has a quality gate, align the prompt with the validator. For non-invasive evidence, include a safe source path such as `docs/operations/swarmclaw-gui-operator-manual.md` and a verification phrase such as `Verification: knowledge retrieval test passed`.
4. Failed task retries reuse the previous task session by default. If the previous session contains stale blocked reasoning, a scoped state repair may need to clear only that task's `sessionId` and `checkpoint` before retrying. This is R3 state repair and requires a checkpoint.
5. Prefer the normal service lifecycle for task changes: `updateTaskFromRoute()` for task updates and `retryTaskFromRoute()` for failed-task retries. Use direct repository patches only for fields not exposed by the route schema, and verify before and after with sanitized metadata.
6. Do not create or queue normal task work by importing route services from a one-off shell process. That shortcut can bypass the live app/API context and interact badly with daemon orphan recovery, producing `process_lost` failures. Use the GUI or authenticated app/API path; if a diagnostic service path is checkpointed, self-monitor it to terminal state and verify sanitized metadata.
7. CLI-backed agents can complete task execution while post-run working-state extraction and autonomy observation fail. Current observed root cause: no generation-compatible model is configured for the CLI agent/session in the enrichment path. This affects post-run summaries/autonomy observations, not the task's assistant response. Fixing it requires a checkpoint because it touches provider/model routing or product behavior.

### Prepare Agent Work

1. Confirm the intended agent and provider/model from `/agents`.
2. Check the handoff for preferred routing and provider caveats.
3. Use direct managed task assignment to the exact stored agent ID as the default for worker work.
4. Use Coordinator for planning, triage, synthesis, and project operations.
5. Use Builder or Reviewer QA for substantive work only after the task is clear.
6. Prefer Copilot Mini Worker for cheap second opinions where appropriate.
7. Avoid `opencode-go/deepseek-v4-flash` unless explicitly testing that provider behavior.
8. Ask before sending work that can run tools, spend budget, change state, or contact external services.

### Delegate Or Route Worker Work

1. Decide whether the work needs a stored SwarmClaw agent or an external CLI helper.
2. For exact stored-agent routing, use `spawn_subagent` with an explicit `agentId`, or create/assign a managed task using the target agent's exact ID. This is the right path when the operator must prove that `Builder`, `Reviewer QA`, or another stored agent record performed the work.
3. For external CLI coding helpers, `delegate` can hand work to Codex, Claude, OpenCode, Gemini, Copilot, Droid, Cursor, or Qwen backends. This proves the backend handoff path, not stored-agent assignment.
4. A runtime child nickname can differ from the stored SwarmClaw agent list. In the completed Coordinator smoke test, the child runtime was named `Feynman` while the worker response identified as Builder.
5. For delegation smoke tests, require safe evidence markers, verify the linked task/session metadata, and record whether evidence came from stored-agent routing or generic CLI delegation.
6. If the requested target is ambiguous, inspect `/agents` and source-backed task/session metadata before claiming which agent handled the work.
7. Current local proof: direct task assignment to Builder `92b8cd6c` completed and is stored-agent evidence.
8. Current local proof: direct task assignment also completed for Reviewer QA, Copilot Mini Worker, OpenCode Builder, and OpenCode Go Helper.
9. Current local constraint: Coordinator-driven `spawn_subagent` is not available with the current Codex CLI Coordinator because CLI providers are normalized as worker-only. Do not try to force this via agent settings; the 2026-06-06 attempt was restored after normalization blocked `role=coordinator` and `delegationEnabled=true`.

## Current Local Instance Snapshot

Verified on 2026-06-06.

### Health And Exposure

| Item | State |
|---|---|
| Health endpoint | `{"ok":true,"service":"swarmclaw"}` |
| Docker service | `swarmclaw-swarmclaw-1` healthy |
| Image | `swarmclaw-subscription:1.9.36` |
| Published ports | `127.0.0.1:3456-3457->3456-3457/tcp` |
| Public exposure | None observed |

### Agents

| Agent | Provider | Model | Notes |
|---|---|---|---|
| Builder | `codex-cli` | `gpt-5.5` | Worker |
| Coordinator | `codex-cli` | `gpt-5.5` | Default shortcut and planning/triage coordinator |
| Copilot Mini Worker | `copilot-cli` | `gpt-5-mini` | Cheap second-opinion route |
| OpenCode Builder | `opencode-cli` | `opencode-go/qwen3.7-plus` | Handoff name drift: `OpenCode Go Builder` |
| OpenCode Go Helper | `opencode-cli` | `opencode-go/minimax-m2.7` | Helper/small OpenCode route |
| Reviewer QA | `codex-cli` | `gpt-5.5` | Review/QA route |

All observed heartbeat flags were off.

### Projects, Tasks, Knowledge, Integrations

| Surface | Snapshot |
|---|---|
| Project | `SwarmClaw Local Ops` |
| Tasks | 10 total: 9 completed, 1 failed, 0 backlog |
| Completed tasks | `Create Knowledge sources for SwarmClaw local runbooks`; `Document verified provider and agent lineup`; `SwarmClaw GUI operator manual read-only smoke`; `Test Coordinator delegation to worker agents`; `Stored Builder direct assignment smoke`; `Reviewer QA direct assignment smoke`; `Copilot Mini Worker direct assignment smoke`; `OpenCode Builder direct assignment smoke`; `OpenCode Go Helper direct assignment smoke` |
| Failed task | `Builder read-only queue smoke test` |
| Backlog task | None observed |
| Knowledge sources | `SwarmClaw Agent Handoff Guide`; `Zmey SwarmClaw Operating Policy`; `SwarmClaw GUI Operator Manual` |
| Schedules | 0 |
| Connectors | 0 |
| MCP servers | 0 |
| Webhooks | 0 |
| Chatrooms | 0 |
| Structured session runs | 0 |
| Missions | 0 |
| Shared links | 0 |
| Extensions | 6 installed in GUI, observed off in the extension list |
| Notifications | Recent supervisor run/task incidents visible |

### Current Test Coverage

- Read-only browser sweep: all 29 top-level `AppView` routes loaded in safe-shell mode.
- Direct managed task assignment: Builder, Reviewer QA, Copilot Mini Worker, OpenCode Builder, and OpenCode Go Helper have completed direct-assignment smokes with safe evidence markers.
- Worker runtime smoke: after `Dockerfile.subscription` added `python3` to the runner image and the container was recreated, task `a0c4a84d` completed with `validation.ok=true`; Builder `92b8cd6c` verified `/usr/bin/python3` and `Python 3.11.2`.
- Coordinator: soft/manual planning coordinator only. The current Codex CLI stored agent remains worker-only and does not provide true stored `spawn_subagent` orchestration.
- Current attention items: the known failed Builder smoke task, Quality's blocked eval gate for `Prime Number Function`, historical Autonomy incidents related to task/quality failures, and a sanitized Logs warning about mismatched credential-secret sources.

### Current Failure-Signal Classification

| Signal | Classification | Evidence | Next safe action |
|---|---|---|---|
| `Builder read-only queue smoke test` failed | Validation mismatch | Linked run completed with `BUILDER_QUEUE_SMOKE_OK`, then dead-lettered because the quality gate found only 1 of 2 required evidence signals. | Leave as known failed evidence or retry with validator-friendly prompt after checkpoint. |
| Quality gate: `Prime Number Function` | Expected unrun eval blocker | `state/data/eval-runs.db` currently has 0 eval runs and 0 eval baselines; source gate fails when no completed eval runs are available. | Checkpoint before running evals or setting baselines. |
| Autonomy incidents | Known historical incidents | 8 incidents: validation/dead-letter entries for `d11bcc7c` and `bldsmk01`, plus 2 older user-stopped runs; no active estop observed. | Read-only monitor unless Zmey wants incident cleanup or remediation. |
| Logs: working-state/autonomy observation warnings | Fixed and live-verified | Source logs previously reported no generation-compatible model for CLI-backed agent sessions. Patch added in `src/lib/server/working-state/extraction.ts` and `src/lib/server/autonomy/supervisor-reflection.ts`; focused tests passed, image `8042f32119f4` contains the patch, and smoke task `4c4cd367` produced no new matching warnings after line 947 of `state/data/app.log`. | Continue monitoring future CLI tasks. |
| Worker Python runtime missing | Fixed and live-verified | `Dockerfile.subscription` runner stage now installs `python3`; recreated image `swarmclaw-subscription:1.9.36` ran task `a0c4a84d` successfully with `Python 3.11.2`. | Keep `python3` in runner image; after future image changes, rerun a safe worker runtime smoke before Python-dependent project work. |
| Logs: `CREDENTIAL_SECRET` mismatch warning | Credential-source warning | Source code uses the environment value when it differs from the persisted credential-secret file. No values inspected. | Checkpoint and backup before any credential/env alignment. |

### Memory

The GUI showed 70 memories, including 49 global entries. Do not dump raw memory rows as part of routine operation; inspect summaries only and avoid storing or exposing secrets.

## Maintenance

Update this manual when:

- A new `AppView` is added or removed.
- Routes change in `src/lib/app/navigation.ts`.
- Sidebar groups change in `src/components/layout/sidebar-rail.tsx`.
- Official docs update with behavior that affects local operation.
- Zmey changes local policy, provider routing, autonomy, schedules, or exposure settings.
- The handoff gains a durable policy that future GUI operators must follow.
- The next-agent quickstart, failure catalog, or `swarmclaw-gui-operator` skill changes.

Maintenance steps:

1. Re-run memory and handoff checks.
2. Reconfirm health and local-only Docker binding.
3. Compare `src/types/session.ts`, `src/lib/app/navigation.ts`, `src/lib/app/view-constants.ts`, and `src/components/layout/sidebar-rail.tsx`.
4. Visit each GUI route in safe-shell mode.
5. Cross-check official docs.
6. Update this manual.
7. Verify all 29 `AppView` values, routes, and sidebar items are represented.
8. Run a secret-string scan against this file.
9. Review `git diff -- docs/operations/swarmclaw-gui-operator-manual.md`. If the file is still untracked, review `git diff --no-index -- /dev/null docs/operations/swarmclaw-gui-operator-manual.md`.
10. Checkpoint separately before adding or editing in-app Knowledge, updating the external handoff, or saving a durable agentmemory note unless Zmey has explicitly scoped those actions into the current task.

## Validation Checklist

For this version:

- All 29 `AppView` values from `src/types/session.ts` are represented.
- Every route from `src/lib/app/navigation.ts` is represented.
- Every sidebar item from `src/components/layout/sidebar-rail.tsx` is represented.
- Every page playbook includes purpose, visible controls, safe reads, write actions, approval level, and references.
- Supporting routes `/login`, `/setup`, `/user`, and `/s/[token]` are covered.
- Official docs are referenced for core concepts: tasks, schedules, providers, projects, memory, knowledge, connectors, MCP servers, autonomy, deployment, and configuration.
- Sensitive pages are documented by controls and workflow only.
- No secrets, auth JSON, full env files, tokens, private keys, credential values, or raw credential table contents are included.
- SwarmClaw health and local-only Docker binding were checked before the walkthrough.
