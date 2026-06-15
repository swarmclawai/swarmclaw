# SwarmClaw Project Onboarding Template

Last verified: 2026-06-15

Audience: Codex and future agents operating Zmey's local SwarmClaw instance.

Purpose: make SwarmClaw easy to plug into any project, understand the project safely, form a goal plan, and launch a direct-assignment parallel wave without product code changes or external orchestration frameworks.

This template is repo-local guidance. It does not create projects, tasks, Knowledge, skills, agents, schedules, autonomy, credentials, provider changes, state DB changes, or public exposure by itself.

Date convention: operator doc dates use Zmey's local Europe/Sofia calendar date unless a timestamp explicitly says UTC. Docker, task, and API timestamps may display UTC or epoch milliseconds.

## Truth Sources

Use these sources in order:

1. Live local runtime at `http://127.0.0.1:3456`.
2. Current handoff at `/home/zmey/2. Personal/Codex/swarmclaw-agent-handoff.md`.
3. Repo operator docs in `docs/operations/`.
4. Local UI/source mappings for Projects, Tasks, Knowledge, Skills, and workers.
5. agentmemory for verified durable lessons.

If sources conflict, prefer local runtime behavior for Zmey's instance and record the conflict.

## Operating Model

SwarmClaw should treat each external project as a project pack:

1. SwarmClaw Project metadata for the durable operating brief.
2. Sanitized Knowledge candidates for source material.
3. Read-only discovery tasks for current project truth.
4. A planning task that turns the goal into disjoint workstreams.
5. A Reviewer QA fan-in gate before implementation.
6. An evidence ledger and concise final handoff.

Default routing remains direct managed task assignment by exact stored worker ID. Do not rely on the stored Coordinator as a true automatic `spawn_subagent` coordinator in Zmey's current CLI-provider setup.

## Loop Engineering Fit

Use `docs/operations/swarmclaw-loop-engineering-plan.md` when project work
should continue across more than one wave. The onboarding template answers
"what project are we operating on"; the LoopSpec answers "how do we keep moving
without drifting, looping forever, or crossing safety boundaries."

For messy projects, create the LoopSpec after the first read-only discovery and
risk review, not before. Early loops should be conservative:

- one discovery or graph-refresh step,
- one independent risk/evaluator step,
- one fan-in decision,
- one explicit continue/retry/block choice.

Do not automate code-writing, DB access, live trading, deployment, schedules,
provider changes, autonomy, state repair, or public exposure from onboarding.

## Preflight

Before onboarding or operating a project:

- Search agentmemory for recent project and SwarmClaw lessons.
- Read the current handoff at `/home/zmey/2. Personal/Codex/swarmclaw-agent-handoff.md` if readable.
- Confirm SwarmClaw is local-only and healthy:
  - `docker compose -f compose.subscription.yml ps`
  - expected binding: `127.0.0.1:3456-3457->3456-3457/tcp`
  - `curl -fsS http://127.0.0.1:3456/api/healthz` when reachable
- If Docker reports healthy but the shell cannot reach the health endpoint, do not restart. Report the mismatch and use the GUI/browser if available.
- Confirm the external project repo path before any task that inspects project files.
- Do not inspect secrets, auth JSON, full env files, tokens, credential files, private keys, wallet files, exchange keys, cookies, or raw credential output.

## Project Metadata

Use the Projects page fields as the durable project brief.

| Field | What To Put There |
|---|---|
| Name | Short project name, for example `Crypto Trading Bot` or `MMA Sports Pipelines`. |
| Description | One-paragraph summary of the project and current state. |
| Objective | The durable outcome SwarmClaw is helping drive. |
| Audience | Primary user or stakeholder. |
| Pilot Priorities | Current top priorities, one per line. |
| Open Objectives | Durable next outcomes, not one-off chat prompts. |
| Capability Hints | Needed capabilities such as code review, data pipelines, backtests, browser QA, docs. |
| Credential Requirements | Names of required credential classes only, never values. |
| Success Metrics | How Zmey will judge progress. |
| Heartbeat Prompt | Optional recurring review prompt; do not enable schedules/autonomy without checkpoint. |

Keep values concise. Project metadata is an operating brief, not a transcript or full specification.

Example metadata for a high-risk financial project:

```markdown
Name: Crypto Trading Bot
Description: Local project for improving trading signals and strategy discipline.
Objective: Improve signal quality, backtest validity, observability, and risk controls before any live-trading change.
Audience: Zmey as operator and maintainer.
Pilot Priorities:
- Map current signal pipeline read-only.
- Identify weak strategy/risk assumptions.
- Propose safe parallel workstreams.
Open Objectives:
- Produce a read-only project discovery report.
- Produce a trading-risk safety review.
- Produce a checkpointed orchestration plan.
Capability Hints:
- Repo analysis
- Backtest review
- Data pipeline review
- Risk-control review
- Test planning
Credential Requirements:
- Exchange API access exists outside agent scope unless separately approved.
- Market data credentials exist outside agent scope unless separately approved.
Success Metrics:
- No secret exposure.
- No live order or exchange action.
- Clear next parallel wave with blocked/high-risk actions separated.
Heartbeat Prompt:
- Review stale project tasks, unresolved safety blockers, unverified trading assumptions, and the next safest read-only action.
```

## Knowledge Candidates

Knowledge should contain source material, not secrets.

Good candidates:

- README and architecture notes.
- Sanitized strategy notes.
- Test and backtest command notes.
- Data schema docs.
- Pipeline diagrams.
- Runbooks.
- Known-issue lists.
- Non-secret sample reports.

Blocked by default:

- `.env` or full environment files.
- Credential files, auth JSON, tokens, cookies, private keys, wallet files.
- Raw exchange account exports.
- Secret-bearing logs.
- Private API responses that include account identifiers or keys.
- Any file whose sensitivity is unclear.

Adding or syncing Knowledge is a runtime change and requires a checkpoint after Zmey reviews the sanitized content.

## Graph Sidecar Discovery

Graphify may be used as an optional sidecar for repo understanding before
SwarmClaw task fan-out. It is a discovery aid, not the orchestrator and not a
replacement for SwarmClaw Projects, Tasks, Runs, Knowledge, or agentmemory.

Use Graphify when the project is large, messy, cross-language, or hard to map
with normal file inspection. This is especially useful for the crypto trading bot
and other already-developed projects where code paths, scripts, SQL schemas,
docs, and runtime conventions have drifted over time.

Default first-pass rules:

- Run scratch-first and project-scoped. Do not run global installers or
  `curl | bash`.
- Do not use Graphify's agent install/hooks/config mutation path without a
  separate checkpoint.
- Write outputs to a temporary local artifact first. Do not commit
  `graphify-out/` or add it to SwarmClaw Knowledge until reviewed.
- Use a `.graphifyignore` or equivalent scoped input list before the first run.
- Exclude `.env*`, credentials, cookies, auth JSON, wallets, private keys,
  tokens, DBs, DB dumps, datasets, logs, generated reports, model binaries,
  runtime captures, broad `output/`, broad `data/`, and any unclear sensitive
  surface.
- For DB-backed projects, allow schema-only or source-level SQL review after
  checkpoint. Do not point Graphify at large database files or raw production
  data.
- Keep any Graphify MCP or HTTP surface localhost-only. Never bind it to
  `0.0.0.0` on Zmey's machine without a separate exposure checkpoint.
- Review generated graph/report content for secrets and irrelevant noise before
  summarizing it into docs, Knowledge, or task prompts.

Recommended use by project:

| Project Type | Graphify Role | Default Scope | Blocked Scope |
|---|---|---|---|
| SwarmClaw platform | Map code relationships before product changes. | Workflow, Protocol, Task, Run, storage, and UI source paths. | `.env.local`, `state/`, provider credentials, runtime DBs, logs, generated artifacts. |
| Crypto trading bot | Map pipelines, strategy, risk, execution, tests, scripts, and schema docs. | Source, tests, README/runbooks, non-secret config schemas, source-like SQL. | Live trading actions, exchange/account calls, raw DBs, datasets, logs, credentials, wallets, outputs. |
| MMA sports pipelines | Map ingestion, parsing, feature generation, models, reports, tests. | Source, schemas, docs, tests, small non-secret fixtures. | Paid credentials, raw private datasets, scraping account secrets, production schedules. |

Graphify and agentmemory are complementary:

- Graphify answers: what exists in this repo and how pieces connect.
- agentmemory answers: what Zmey and prior agents decided, verified, deferred,
  fixed, or learned across sessions.

If the graph is useful, feed only sanitized summaries into SwarmClaw tasks:

1. Builder maps architecture from safe graph plus repo structure.
2. Reviewer QA reviews graph coverage, secret hygiene, and false confidence.
3. Coordinator or Builder drafts the project onboarding plan.
4. Reviewer QA fan-in accepts, requests changes, or blocks the first wave.

When using workflow bundles, embed sanitized predecessor summaries into fan-in
prompts or make them available as reviewed Knowledge/operator text. Dependency
edges alone may not give the fan-in worker access to prior outputs. Use neutral
labels such as `worker` in embedded evidence; assignment-like phrases such as
`Agent ID: ...` can be parsed as a new assignee and override the intended worker.

Verified SwarmClaw platform pilot, 2026-06-10: a scratch-only Graphify run
against workflow/protocol/task orchestration source produced a useful code graph
without global install, hooks, MCP, Knowledge import, provider changes, or runtime
changes. Symbol-heavy queries were useful; broad natural-language queries were
noisy and should be scoped.

Verified crypto bot pilot, 2026-06-11: a scratch-only Graphify run against safe
code-only zones produced a useful sanitized summary. Final Reviewer QA task
`8edbdccb` accepted the next read-only onboarding wave from sanitized inputs and
blocked raw graph/report Knowledge import.

### Graph Refresh In Bounded Loops

Graph refresh is a named input phase, not an always-on actor.

Use it only when the LoopSpec calls for it:

- explicit operator request,
- first onboarding of a large or messy repo,
- accepted implementation wave that materially changes architecture,
- fan-in says the previous graph is stale, incomplete, or noisy.

Do not run Graphify on every loop iteration, schedule, heartbeat, file watcher,
or "continue until done" cycle. If a continuation proposes graph work, create at
most a scoped read-only backlog task with temporary artifacts. It must not queue
itself, mutate agent config, install hooks, start MCP/HTTP surfaces, sync
Knowledge, or choose the next wave.

Graph refresh evidence must include tool version, corpus root, include/exclude
list, counts, artifact path if retained temporarily, secret-hygiene result, and
Reviewer QA decision on coverage and false confidence.

## Artifact Decision Table

Choose the lightest artifact that makes the project operable.

| Need | Use | Notes |
|---|---|---|
| Durable operating brief | Project | Stores objective, audience, priorities, objectives, capabilities, metrics. |
| One-off work item | Task | Direct assign by exact stored worker ID. |
| Shared source material | Knowledge | Add only sanitized sources after checkpoint. |
| Repo relationship graph | Graphify sidecar artifact | Optional scratch-first discovery aid; review before commit or Knowledge import. |
| Repeated checklist or role behavior | Skill | Draft in repo docs first; runtime install/pin later only after checkpoint. |
| Stable specialist identity | Agent | Create only after repeated proof that a skill or task prompt is insufficient. |
| Recurring automation | Schedule or Mission | High-impact; checkpoint required. |
| Structured workflow | Session/Protocol | Use only after the sequence is known and safe. |
| External system capability | Connector, MCP server, Extension, Wallet | High-impact; checkpoint required. |
| Durable learned fact | agentmemory | Save only verified, non-secret decisions and outcomes. |

## Onboarding Phases

| Phase | Owner | Action | Write Scope | Completion Gate |
|---|---|---|---|---|
| 0 | Main Codex helper | Confirm repo path, project metadata, and safety constraints. | None | Zmey confirms source path or Knowledge-only mode. |
| 0.5 | Main Codex helper | Optional Graphify sidecar pilot for large or messy repos. | Temporary artifact only | Sanitized graph/report reviewed, or discarded as noisy/unsafe. |
| 1 | Builder `92b8cd6c` | Read-only project discovery. | None | Structure, key files, tests, risks, unknowns. |
| 2 | Reviewer QA `c2cd6ff9` | Read-only domain/risk review. | None | Safety risks and checkpoint-required actions listed. |
| 3 | Main Codex helper | Draft LoopSpec if work may need repeated waves. | None | Progress/stuck signals, invariant, retry policy, stop conditions, and checkpoint gates are explicit. |
| 4 | Coordinator `default` or Builder `92b8cd6c` | Orchestration plan. | None | Goal, workstreams, dependencies, first wave. |
| 5 | Reviewer QA `c2cd6ff9` | Fan-in review of plan and risks. | None | Accept, request changes, or block. |
| 6 | Main Codex helper | Final operator summary and next checkpoint. | Repo docs only if approved | Evidence ledger complete. |

Use `docs/operations/swarmclaw-parallel-wave-template.md` once the fan-in review accepts the first wave.

## Deferred Work Handling

When fan-in identifies code-writing candidates but Zmey chooses to defer them:

1. Record the candidates in the repo-local ledger or project notes.
2. Create backlog-only SwarmClaw tasks tagged `deferred`, `todo`, and
   `checkpoint-required`.
3. Keep those tasks out of the queue until Zmey gives a fresh checkpoint.
4. Do not treat deferred tasks as blockers for continued read-only project
   onboarding, operator documentation, or project planning.
5. If the deferred work touches financial, credential, deployment, provider,
   schedule, autonomy, database, or public-exposure surfaces, repeat the
   checkpoint requirement in the task description.

Verified crypto example: deferred tasks `ctodo5a37`, `ctodoac45`,
`ctodo29df`, and `ctodo99ba` are backlog-only TODOs under the Crypto Trading Bot
project. They must not be queued until Zmey approves a narrow test-first crypto
repo patch.

## Generic Intake

Use this before task creation:

```markdown
Project name:
Project repo path or Knowledge-only source:
Current project state:
Current goal:
Audience/operator:
Must-have outcomes:
Out of scope:
Known sensitive surfaces:
Allowed read scope:
Allowed write scope:
Tests or validation commands:
Success metrics:
Checkpoint-required actions:
Loop needed:
Loop invariant:
Loop progress signal:
Loop stuck signal:
Loop stop conditions:
```

If repo path is missing, stop before creating repo-inspection tasks.

## Crypto Trading Bot Gates

Crypto projects are high risk because agent mistakes can affect money, credentials, and live trading.

Allowed without extra checkpoint:

- Read non-secret source files.
- Inspect repo structure.
- Review strategy code and tests without executing live trading.
- Review backtest design and historical result methodology.
- Draft risk-control checklists.
- Propose paper-trading or simulation improvements.
- Propose safer task splits.

Checkpoint required:

- Any live exchange call.
- Any order placement, cancellation, account query, balance query, or position query.
- Any credential, wallet, key, token, cookie, or auth file access.
- Any `.env` or full environment inspection.
- Any schedule/autonomy change.
- Any deployment or service restart.
- Any provider routing or model setting change.
- Any database migration, state repair, or destructive cleanup.
- Any change that could alter live trading behavior.

Forbidden in read-only drill tasks:

- Live trading actions.
- Exchange API calls.
- Wallet/private-key inspection.
- Credential table/file inspection.
- Full env dumps.
- Schedule or autonomy activation.
- Deployment or server restart.

## MMA Sports Pipeline Gates

MMA and sports pipelines are usually lower financial risk than live trading, but still need data-integrity gates.

Allowed without extra checkpoint:

- Read non-secret source files.
- Inspect pipeline structure.
- Review schemas, parsers, data quality checks, feature generation, and test coverage.
- Propose model-evaluation and reporting improvements.

Checkpoint required:

- Paid data source credentials.
- External account/API writes.
- Production schedules.
- Public publishing.
- Destructive database writes.
- Scraping behavior that may violate site terms or rate limits.

## Read-Only Task Stencils

Set worker assignment in task metadata. Avoid assignment-looking language inside the prompt body.

### Project Discovery

Metadata:

```text
Worker: Builder 92b8cd6c
Status: backlog first, then queue
Quality gate: disabled or relaxed for pure discovery
```

Prompt:

```markdown
Read-only project discovery.

Project:
[name]

Repo path:
[absolute path]

Goal:
[current goal]

Rules:
- Follow AGENTS.md and local SwarmClaw operator rules.
- Inspect only non-secret project files needed for discovery.
- Do not inspect or print secrets, auth JSON, full env files, tokens, credential files, private keys, wallet files, cookies, raw credential output, or credential tables.
- Do not modify files, tasks, state, schedules, autonomy, credentials, provider routing, env files, server processes, or public exposure.
- Do not install dependencies, start or stop services, run live trading, exchange API calls, deployments, migrations, or destructive commands.
- If a needed file may be sensitive, stop and list it as a blocked input.

Return:
0. Evidence marker in the first ten lines: SWARMCLAW_PROJECT_DISCOVERY_OK
1. Repo structure and main modules.
2. Key commands found without running risky actions.
3. Data flow or request flow.
4. Current tests or validation hooks.
5. Secret/safety surfaces avoided.
6. `Files changed: none`.
7. `Secrets inspected: none`.
8. Unknowns/blockers.
9. Keep this result under 2,500 characters.
```

Crypto drill marker override: use `SWARMCLAW_CRYPTO_DISCOVERY_OK`.

### Domain Risk Review

Metadata:

```text
Worker: Reviewer QA c2cd6ff9
Status: backlog first, then queue
Quality gate: disabled or relaxed for pure review
```

Prompt:

```markdown
Read-only project risk review.

Inputs:
[project brief and discovery result]

Rules:
- Follow AGENTS.md and local SwarmClaw operator rules.
- Do not modify files or state.
- Do not inspect secrets, credentials, auth JSON, full env files, tokens, private keys, wallet files, cookies, or credential tables.
- Do not install dependencies, start or stop services, run live trading, exchange calls, schedules, deployment, migrations, or destructive commands.

Check:
- High-risk execution paths.
- Credential and secret boundaries.
- Live-action risks.
- Data integrity risks.
- Testing and backtest validity risks.
- Checkpoint-required actions.
- For crypto: live-vs-paper gate, order path, position sizing, leverage/margin, max loss/drawdown, stop loss, duplicate order/idempotency, exchange failure handling, rate limits, stale data, reconnect behavior, simulation/backtest separation, and kill switch.

Return:
0. Evidence marker in the first ten lines: SWARMCLAW_PROJECT_RISK_REVIEW_OK
1. Findings ordered by severity.
2. Actions allowed read-only.
3. Actions requiring Zmey checkpoint.
4. Recommended safety constraints for the first parallel wave.
5. `Files changed: none`.
6. `Secrets inspected: none`.
7. For crypto, `Trade path executed: no`.
8. Keep this result under 2,500 characters.
```

Crypto drill marker override: use `SWARMCLAW_CRYPTO_RISK_REVIEW_OK`.

### Orchestration Plan

Metadata:

```text
Worker: Coordinator default, or Builder 92b8cd6c when code architecture depth is needed
Status: backlog first, then queue
Quality gate: disabled or relaxed for pure planning
```

Prompt:

```markdown
Read-only project orchestration plan.

Inputs:
[project brief, discovery result, risk review]

Rules:
- Follow AGENTS.md and local SwarmClaw operator rules.
- Do not modify files or state.
- Do not create, edit, queue, retry, or cancel tasks.
- Do not inspect secrets or credentials.
- Do not run live trading, exchange calls, schedules, deployment, migrations, or destructive commands.

Return:
0. Evidence marker in the first ten lines: SWARMCLAW_PROJECT_ORCHESTRATION_PLAN_OK
1. Goal summary.
2. Proposed workstreams with disjoint scopes.
3. Dependencies and blockers.
4. Suggested workers by metadata ID.
5. First parallel wave proposal.
6. Checkpoint-required actions.
7. Fallback if repo path or required files are missing.
8. `Files changed: none`.
9. `Secrets inspected: none`.
10. Keep this result under 2,500 characters.
```

Crypto drill marker override: use `SWARMCLAW_CRYPTO_ORCHESTRATION_PLAN_OK`.

### Fan-In Review

Metadata:

```text
Worker: Reviewer QA c2cd6ff9
Status: backlog first, then queue
Quality gate: disabled or relaxed for pure review
```

Prompt:

```markdown
Read-only fan-in review for a project orchestration plan.

Inputs:
[discovery, risk review, orchestration plan]

Rules:
- Follow AGENTS.md and local SwarmClaw operator rules.
- Do not modify files or state.
- Do not create, edit, queue, retry, or cancel tasks.
- Do not inspect secrets or credentials.
- Do not run live trading, exchange calls, schedules, deployment, migrations, or destructive commands.

Check:
- Is the proposed wave safe?
- Are write scopes disjoint or explicitly read-only?
- Are financial/live-action risks blocked?
- Are tests and evidence gates sufficient?
- Are any hidden checkpoint requirements missing?

Return:
0. Evidence marker in the first ten lines: SWARMCLAW_PROJECT_FAN_IN_REVIEW_OK
1. Recommendation: accept, request changes, or block.
2. Findings ordered by severity.
3. Contradictions or missing evidence across inputs.
4. Required edits before implementation, if any.
5. Source task IDs and markers when available.
6. `Files changed: none`.
7. `Secrets inspected: none`.
8. First safe next action.
9. Keep this result under 2,500 characters.
```

Crypto drill marker override: use `SWARMCLAW_CRYPTO_FANIN_REVIEW_OK`.

## Final Operator Summary

Main Codex writes the final summary after the drill:

```markdown
Project:
Repo path or Knowledge-only source:
Task IDs and workers:
Markers:
Discovery summary:
Risk summary:
Accepted first wave:
Blocked/checkpoint actions:
Next safest action:
No-secret verification:
Local-only verification:
```

Save durable agentmemory only after the task outputs are verified. Keep the external handoff concise and update it only for durable setup changes.

## Finish Criteria

Onboarding is complete when:

- Project source and safety boundaries are clear.
- Discovery and risk review completed or produced actionable blockers.
- The plan has disjoint workstreams or explicitly explains why work must be serial.
- Reviewer QA accepted or blocked the first wave.
- Evidence markers, task IDs, and worker IDs are recorded.
- No secrets, credentials, live actions, schedules, autonomy, provider settings, or public exposure were touched.
