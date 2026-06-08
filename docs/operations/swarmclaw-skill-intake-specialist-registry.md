# SwarmClaw Skill Intake And Specialist Registry

Last verified: 2026-06-08

Audience: Codex and future agents operating Zmey's local SwarmClaw instance.

Scope: repo-local operating reference for choosing, adapting, and testing skills and specialist agents. This document does not install skills, create agents, change provider routing, change credentials, or expose SwarmClaw beyond localhost.

## Operating Position

Use public skill collections as a source library, not as a bulk import. The default path is:

1. Identify a repeated workflow or specialist gap.
2. Shortlist candidate external skills.
3. Audit each candidate for source, license, local fit, secrets, network, dependencies, and command execution.
4. Adapt the useful procedure into a SwarmClaw-local skill or task template.
5. Test with direct managed task assignment.
6. Only after Zmey checkpoints it, install/pin the skill or create/update specialist agents.

This keeps SwarmClaw local-only, avoids importing external automation blindly, and makes each new capability observable through Tasks, Runs, Knowledge, and Memory.

## Sources Checked

Local sources:

- `docs/operations/swarmclaw-gui-operator-manual.md`
- `skills/tools/skills.md`
- `skills/swarmclaw/SKILL.md`
- `src/types/skill.ts`
- `src/lib/server/skills/skill-discovery.ts`
- `src/lib/server/session-tools/skills.ts`
- `src/lib/server/session-tools/skills-tool.ts`
- `src/lib/server/session-tools/manage-skills.test.ts`

Official docs:

- https://www.swarmclaw.ai/docs
- https://www.swarmclaw.ai/docs/agents
- https://www.swarmclaw.ai/docs/delegation
- https://www.swarmclaw.ai/docs/tasks
- https://www.swarmclaw.ai/docs/skills
- https://www.swarmclaw.ai/docs/knowledge
- https://www.swarmclaw.ai/docs/mcp-servers

External source library:

- https://github.com/ComposioHQ/awesome-claude-skills
- Raw README fetched from `https://raw.githubusercontent.com/ComposioHQ/awesome-claude-skills/master/README.md`

If these conflict, prefer local runtime behavior for Zmey's instance and record the conflict.

## Local Skill Model

SwarmClaw skills are markdown guidance artifacts, not magic tool access. Tools, MCP servers, connectors, and credentials are separate capability layers.

Current local discovery implementation:

| Layer | Source | Directory | Notes |
|---|---|---|---|
| 1 | Bundled | `skills/` | Tracked with the app. |
| 1 legacy | Bundled fallback | `data/skills/` | Legacy fallback still scanned by discovery. |
| 2 | Workspace | `$SWARMCLAW_HOME/skills/` or `~/.swarmclaw/skills/` | User-installed workspace skills. |
| 3 | Project | `<cwd>/skills/` | Project-local skills when a session cwd is supplied. |

Later layers override earlier layers on skill name collisions: project > workspace > bundled.

Managed skill records are stored separately and can be created, installed, attached, searched, selected, loaded, or run through `manage_skills` and `use_skill`. Remote skill installation is approval-gated in local tests. Discovered project skills can be materialized into managed storage and attached to the current agent.

Runtime prompt behavior is selective. Stored skills, active learned skills, and discovered filesystem skills can all be resolved, but only selected, attached/pinned, or `always` skills should be injected up front. Other ready skills stay discoverable and should be loaded on demand with `use_skill`.

CLI-backed task workers need extra care. The normal SwarmClaw chat layer can expose the `use_skill` runtime tool, but Codex CLI task execution does not expose that tool to the worker. For Codex CLI workers, use a stored managed skill pinned to the worker's `skillIds` when the skill body must be visible in the first task turn.

Known wording drift: `skills/tools/skills.md` describes built-in `skills/` and runtime `data/skills/` as the skill file locations. `src/lib/server/skills/skill-discovery.ts` is more current for runtime discovery and adds workspace/project layers.

## Intake States

| State | Meaning | Allowed Action |
|---|---|---|
| Candidate | Listed as potentially useful. | Read README/source summary only. |
| Needs audit | Promising but not inspected deeply. | Audit individual `SKILL.md`, scripts, references, licenses, and dependencies. |
| Adapt approved | Procedure is useful but must be rewritten for local SwarmClaw. | Draft local skill or task template after checkpoint. |
| Install approved | Zmey approved installing or creating the runtime artifact. | Create local skill, refresh Skills, or attach to agent as scoped. |
| Blocked | Requires external auth, unsafe execution, unclear license, public exposure, or conflicts with local policy. | Do not install. Revisit only with explicit checkpoint. |
| Retired | No longer useful or superseded. | Leave archived note; do not use by default. |

Runtime install/import actions are separate from registry planning. `/api/skills/import` fetches and previews HTTP(S) skill content for normalization/audit, while managed skill create/update/delete and ClawHub installs persist records or write workspace skill bundles. Those are runtime changes and require a checkpoint.

## Intake Checklist

For each external skill or agent pack:

1. Source: URL, owner, date checked, and whether the exact `SKILL.md` was reviewed.
2. License: repository license and any per-skill license caveat.
3. Local fit: specific SwarmClaw workflow it improves.
4. Capability needs: files, shell, browser, web, MCP, connector, provider, or wallet.
5. Secrets risk: env vars, tokens, OAuth, auth JSON, cookies, private keys, or credential stores.
6. Network risk: public API calls, SaaS apps, hosted relays, external browsing, webhooks, or public deployment.
7. Execution risk: scripts, installs, package managers, destructive commands, file deletion, database writes, or deploys.
8. Prompt risk: too broad, too verbose, conflicting role instructions, or unclear activation trigger.
9. SwarmClaw rewrite: how it should map to local tools, Tasks, Knowledge, Memory, MCP, or agent prompts.
10. Verification: direct assigned task, expected marker, allowed write scope, and tests/screenshots/logs to check.

Never copy a public skill into runtime unchanged unless all checklist items are known and acceptable.

## Operator Intake Routine

Use this concise routine for each new specialist skill:

1. Name the repeated workflow or specialist gap.
2. Audit one source skill at a time: exact URL/blob, license, commands, dependencies, network, and secret risk.
3. Rewrite the useful procedure into SwarmClaw-local guidance; do not bulk import.
4. Stage as repo docs first, then a workspace skill only after checkpoint.
5. For CLI-backed workers, create a stored managed skill and pin it to the smallest useful agent set.
6. Live-test with direct task assignment and a unique evidence marker.
7. Add or refresh Knowledge only after the content is verified and sanitized.
8. Save one concise agentmemory lesson and keep the external handoff short.

Recommended registry fields for future audited entries:

- `source_url`
- `status`
- `adapted_swarmclaw_skill_name`
- `specialist_role`
- `safe_reads`
- `write_actions`
- `checkpoint_level`
- `blocked_actions`
- `verification_required`

## Risk Levels

| Level | Examples | Default |
|---|---|---|
| Low | Local markdown procedure, read-only workflow, test planning, code review checklist. | Can draft in repo docs. |
| Medium | Local skill creation, project-local skill, task template, browser-testing workflow. | Checkpoint before runtime install, filesystem write, or agent attachment. |
| High | External API automation, OAuth, MCP server registration, connector setup, provider routing, shell installers. | Explicit checkpoint, backup plan, and narrow scope. |
| Blocked | Public port exposure, credential inspection, raw auth JSON, secret-bearing env dumps, unreviewed destructive scripts. | Do not do. |

## Specialist Decision Rule

Choose the lightest durable artifact that solves the problem:

| Need | Best Artifact | Why |
|---|---|---|
| One-off expert behavior | Task prompt | Fast and does not change runtime state. |
| Repeated workflow or checklist | Skill | Reusable guidance without a new identity. |
| Repeated role with stable tools/model/settings | Agent | Durable owner for task assignment and QA. |
| Shared reference material | Knowledge | Grounded source library, citations, and lifecycle. |
| Durable learned decision or operator preference | agentmemory | Cross-session recall for agents. |
| External system access | MCP server, connector, or extension | Capability layer, not a skill. Requires checkpoint. |

For Zmey's local setup, default to direct managed task assignment. The stored Coordinator is currently a Codex CLI worker-only record, so do not rely on it as a true automatic `spawn_subagent` coordinator.

## Current Worker Routing

Use exact stored-agent assignment for normal work:

| Agent | ID | Default Use |
|---|---|---|
| Builder | `92b8cd6c` | Primary implementation and local repo tasks. |
| Reviewer QA | `c2cd6ff9` | Reviews, test plans, quality triage, regression checks. |
| Copilot Mini Worker | `e74dd145` | Lightweight coding or summarization tasks. |
| OpenCode Builder | `a0f79bad` | Alternate implementation worker when provider/model is appropriate. |
| OpenCode Go Helper | `cc51c5e6` | Alternate helper for bounded tasks. |
| Coordinator | `default` | Human-facing coordination convention only; not true stored subagent orchestration in the current CLI-provider setup. |

Avoid `opencode-go/deepseek-v4-flash` for normal agent work because headless runs can exit successfully without assistant text.

## Parallel Agenting Workflow

Use this when the target is large enough to split, such as building a full app.

1. Define the deliverable in one paragraph.
2. Split into independent workstreams with disjoint write scopes.
3. Create one directly assigned SwarmClaw task per workstream.
4. Give each task:
   - exact agent ID
   - purpose and non-goals
   - allowed files or read-only scope
   - constraints from `AGENTS.md`
   - expected evidence marker
   - verification commands or UI checks
   - handoff requirements
5. Run implementation tasks in parallel only when their write scopes do not collide.
6. Run QA/review tasks read-only while implementation is ongoing, then rerun targeted QA after integration.
7. Monitor `/tasks`, `/runs`, `/quality`, and `/logs`.
8. Consolidate outputs in the main operator thread.
9. Save durable lessons to agentmemory only after the result is verified.
10. Add or refresh Knowledge only after Zmey checkpoints it.

Do not use parallel agents as a substitute for clear ownership. Each subtask needs a concrete definition of done.

## Full App Example

For a request like "create a fully fledged app", use phases like this:

| Phase | Specialist | Artifact | Parallelism |
|---|---|---|---|
| Product brief | Product Architect | Task prompt or future skill | First, because it defines scope. |
| Technical plan | Software Architect | Skill-backed task | Can run after brief; should gate implementation. |
| Frontend | Frontend Builder | Direct assigned task | Parallel with backend if API contract is stable. |
| Backend/API | Backend Builder | Direct assigned task | Parallel with frontend after contract. |
| Data model | Data Engineer | Direct assigned task | Parallel if schema is scoped. |
| QA | Reviewer QA | Read-only review, then test task | Runs during and after implementation. |
| Security | Security Reviewer | Read-only review | Runs after meaningful code exists. |
| DevOps | DevOps/Release | Task prompt or future skill | Runs after app shape and test strategy are known. |
| Docs/handoff | Operator | Repo doc, task handoff, agentmemory | Final consolidation. |

If multiple agents write to one repo, use either non-overlapping files or checkpoint a worktree strategy first. Worktrees can help but are not the default until the workflow is audited for this instance.

## Initial Candidate Registry

These are intake candidates from `ComposioHQ/awesome-claude-skills`. Status is conservative because only the README-level listing was checked in this pass unless noted.

| Candidate | Source | Proposed Local Use | Status | Risk Notes |
|---|---|---|---|---|
| `subagent-driven-development` | https://github.com/NeoLabHQ/context-engineering-kit/tree/master/plugins/sadd/skills/subagent-driven-development | Adapt into a SwarmClaw parallel task decomposition skill. | Runtime skill active | Exact `SKILL.md` blob `c5693fae070ed2c7f621e07ed25d1761c2134d1c`; repo license GPL-3.0; local rewrite uses direct task assignment. Repo-layer skill lives at `skills/swarmclaw-parallel-agenting/SKILL.md`; live no-rebuild copy lives at `state/skills/swarmclaw-parallel-agenting/SKILL.md`. Managed stored skill `081f0f20` is pinned to Builder `92b8cd6c` so Codex CLI task prompts receive the skill body. Verified tasks: draft planning `fd8004f3`, review `0f3074eb`, first live smoke `02572e83` exposed the CLI `use_skill` limitation, pinned retest `70463df1` completed with `SWARMCLAW_PARALLEL_PINNED_SKILL_OK`. |
| `software-architecture` | https://github.com/NeoLabHQ/context-engineering-kit/tree/master/plugins/ddd/skills/software-architecture | Architecture review and design-plan checklist. | Needs audit | Watch for overbroad methodology and unsupported assumptions. |
| `test-driven-development` | https://github.com/obra/superpowers/tree/main/skills/test-driven-development | Implementation workflow for Builder tasks. | Needs audit | Should be simplified to repo-specific test conventions. |
| `Webapp Testing` | https://github.com/ComposioHQ/awesome-claude-skills/tree/master/webapp-testing | Browser/Playwright validation workflow for local apps. | Runtime skill active | Exact `SKILL.md` blob `4726215301db64a0cc4d41fc3219c61f37a30f4a`; per-skill Apache-2.0 license blob `7a4a3ea2424c09fbe48d455aed1eaa94d9124835`; upstream `with_server.py` blob `431f2eba16b268b7f3e2ae4daae9db41c0289b6d` audited but not imported because server lifecycle is checkpoint-required for port 3456. Repo-layer skill lives at `skills/swarmclaw-webapp-testing/SKILL.md`; live workspace copy lives at `state/skills/swarmclaw-webapp-testing/SKILL.md`. Managed stored skill `0a246b88` is pinned to Reviewer QA `c2cd6ff9`. Smoke task `e8a3be21` completed with `SWARMCLAW_WEBAPP_TESTING_PINNED_SKILL_OK` and found the missing-browser gap. Zmey checkpointed the fix; `Dockerfile.subscription` now bakes Playwright Chromium and dependencies into `swarmclaw-subscription:1.9.36`. Rebuilt-image smoke task `a1c59af7` completed with `SWARMCLAW_WEBAPP_TESTING_REBUILT_IMAGE_OK`. Worker browser checks can verify unauthenticated render/access-gate behavior; authenticated GUI checks still require the main operator browser or a separately approved auth/profile strategy. |
| `systematic-debugging` / `root-cause-tracing` | https://github.com/obra/superpowers/tree/main/skills/systematic-debugging | Debugging failures without cycling on symptoms. | Needs audit | Use the root-cause tracing guidance inside the systematic-debugging skill; keep logs sanitized. |
| `review-implementing` | https://github.com/mhattingpete/claude-skills-marketplace/tree/main/engineering-workflow-plugin/skills/review-implementing | Reviewer QA implementation-plan review. | Needs audit | Should become a review checklist, not an extra approval bureaucracy. |
| `test-fixing` | https://github.com/mhattingpete/claude-skills-marketplace/tree/main/engineering-workflow-plugin/skills/test-fixing | Failed-test triage worker prompt. | Needs audit | Must require root-cause evidence, not blind patching. |
| `using-git-worktrees` | https://github.com/obra/superpowers/blob/main/skills/using-git-worktrees/ | Optional parallel write isolation. | Pending | Worktrees can help, but local SwarmClaw task state and repo hygiene need a checkpointed policy. |
| `MCP Builder` | https://github.com/ComposioHQ/awesome-claude-skills/tree/master/mcp-builder | Build MCP servers when a project explicitly needs one. | Pending | MCP registration and external access are R3. |
| `Playwright Browser Automation` | https://github.com/lackeyjb/playwright-skill | Frontend validation inspiration. | Pending | May duplicate existing Codex/SwarmClaw browser tooling. |
| `great_cto` | https://github.com/avelikiy/great_cto | Specialist taxonomy inspiration. | Inspiration only | Plugin/subagent pack is Claude Code-specific and too broad for direct import. |
| `Septim Agents Pack` | https://septimlabs.com/tools/agents?utm_source=awesome-claude-skills&utm_medium=awesome-list&utm_campaign=oss-backlink | Role naming and coverage inspiration. | Inspiration only | External agent pack, not SwarmClaw-native; do not drop into runtime. |
| `Connect` / app automation skills | https://github.com/ComposioHQ/awesome-claude-skills/tree/master/connect | External SaaS automation ideas. | Blocked by default | Requires Composio/plugin setup, external auth, and real actions across SaaS apps. |
| SaaS automation skills | https://github.com/ComposioHQ/awesome-claude-skills#app-automation-via-composio | Future connector/MCP workflows. | Blocked by default | OAuth/API keys, external network, and possible destructive business actions. |
| External/browser-cookie automation | Various entries such as Chrome Relay, OpenWeb, Jules, LangSmith Fetch, n8n, Mercury, Google Workspace, Gmail, and Slack | Future integration ideas only. | Blocked by default | Requires hosted services, external auth, cookies, remote agents, or real SaaS actions. |
| Security/fuzzing skills | https://github.com/ComposioHQ/awesome-claude-skills#security--systems | Security review inspiration. | Pending | Fuzzing and forensics can be intrusive; require explicit scope. |
| `postgres` | https://github.com/sanjay3290/ai-skills/tree/main/skills/postgres | Read-only database investigation if a project uses Postgres. | Blocked until scoped | DB credentials and query scope require checkpoint. |

## Specialist Registry

Future specialist agents should be created only when recurring work justifies a durable role. Until then, use task prompts assigned to existing agents.

First real app-build pilot recommendation (`2026-06-07`): do not create new durable specialist agents yet. Use existing agents plus scoped prompts: Coordinator `default` for product scope, Builder `92b8cd6c` for architecture/implementation planning, Reviewer QA `c2cd6ff9` for QA/release gates and browser review, and only split to OpenCode Builder `a0f79bad` after file scopes are disjoint and contracts are stable. Public skill sources still support later audit candidates such as `software-architecture`, `test-driven-development`, `systematic-debugging`, `review-implementing`, and `test-fixing`, but they should be adapted one at a time after the pilot exposes repeated pain.

Project orchestration update (`2026-06-08`): use `docs/operations/swarmclaw-project-onboarding-template.md` to plug SwarmClaw into a project and `docs/operations/swarmclaw-parallel-wave-template.md` to run task waves. These are task-template-first operating artifacts. They do not install runtime skills, create agents, sync Knowledge, enable worktrees, or change SwarmClaw configuration by themselves.

## Project Orchestration Specialist Layer

Use these as task templates first. Promote any role to a managed skill or durable agent only after repeated successful use and a separate checkpoint.

| Specialist Layer | Use It For | First Artifact | Default Worker | Runtime Promotion Gate |
|---|---|---|---|---|
| Product Architect | Vague goals, target audience, scope, milestones, acceptance criteria. | Project onboarding prompt. | Coordinator `default` or Builder `92b8cd6c`. | Promote only if product-scoping tasks recur across projects. |
| Software Architect | Architecture, module boundaries, data flow, API contracts, workstream split. | Architecture/wave-plan prompt. | Builder `92b8cd6c`, with Reviewer QA critique. | Promote after several accepted architecture plans. |
| TDD Builder | Implementation slices that need tests first or regression locks. | Implementation slice prompt with test-first requirement. | Builder `92b8cd6c`. | Promote after repo-specific test workflow is stable. |
| Debugger | Failed task/test triage, root-cause analysis, retry planning. | Debug/risk review prompt. | Reviewer QA `c2cd6ff9` for diagnosis, Builder for fixes. | Promote after repeated failures show a reusable debug routine. |
| Browser QA | Browser-visible behavior, local UI smoke, route checks, page/request failures. | Browser QA prompt or existing webapp-testing skill. | Reviewer QA `c2cd6ff9`. | Existing runtime skill may be reused; new role requires checkpoint. |
| Release Gate | Final verification, evidence ledger, risks, deploy/release readiness. | Fan-in review and final operator summary. | Reviewer QA `c2cd6ff9`, then main Codex. | Promote only when releases become frequent and checklist-stable. |

Do not create durable specialist agents during initial project onboarding. A specialist identity is justified only when a task prompt or skill is not enough because the role needs stable tools, model settings, project binding, or repeated independent ownership.

| Specialist | When To Use | First Artifact | Likely Worker |
|---|---|---|---|
| Product Architect | Vague product/app ideas need scope, milestones, and acceptance criteria. | Task prompt; later product-planning skill. | Builder or Reviewer QA, depending on read/write scope. |
| Software Architect | Architecture, data flow, module boundaries, API contracts. | Adapted `software-architecture` skill. | Builder for plan, Reviewer QA for critique. |
| Frontend Builder | UI implementation, browser-visible behavior, accessibility checks. | Task prompt plus future webapp testing skill. | Builder or OpenCode Builder. |
| Backend Builder | API routes, services, persistence, queue/runtime behavior. | Task prompt with repo-specific conventions. | Builder. |
| Data Engineer | Schema, migrations, storage normalization, analytics. | Task prompt; skill only if repeated. | Builder with Reviewer QA read-only review. |
| QA Reviewer | Test strategy, regression checks, failure triage. | Adapted `test-fixing` and `review-implementing` skills. | Reviewer QA. |
| Security Reviewer | Secrets hygiene, auth surfaces, dependency and exposure review. | Checklist skill after audit. | Reviewer QA or a future specialist. |
| DevOps/Release | Docker, deployment, release gates, CI, local-only checks. | Task prompt; future release skill. | Builder, with operator checkpoint for high-risk changes. |
| Knowledge Librarian | Maintain Knowledge sources, docs, handoffs, memory hygiene. | Task prompt; future knowledge-hygiene skill. | Main operator with checkpoint. |
| SwarmClaw Operator | GUI operation, task routing, run monitoring, incident triage. | `swarmclaw-gui-operator` skill plus GUI manual. | Main Codex helper. |

## First Runtime Skill Candidates

Runtime skill activation status:

1. `swarmclaw-parallel-agenting`
   - Purpose: decompose large work into direct assigned SwarmClaw tasks with disjoint scopes.
   - Based on: this registry plus audited `subagent-driven-development`.
   - Current repo-layer skill: `skills/swarmclaw-parallel-agenting/SKILL.md`.
   - Live workspace skill copy: `state/skills/swarmclaw-parallel-agenting/SKILL.md`.
   - Managed stored skill: `081f0f20`, pinned to Builder `92b8cd6c` for CLI prompt injection.
   - Draft/audit copy: `docs/operations/skill-drafts/swarmclaw-parallel-agenting/SKILL.md`.
   - Test: completed read-only planning task `fd8004f3` and Reviewer QA review task `0f3074eb`; first live Codex CLI smoke `02572e83` proved discoverable-only skills are not enough for CLI workers; pinned retest `70463df1` completed with `SWARMCLAW_PARALLEL_PINNED_SKILL_OK`.

2. `swarmclaw-root-cause-tracing`
   - Purpose: debug failed SwarmClaw tasks/runs/log incidents without repeating failed fixes.
   - Based on: local failure lessons plus audited `root-cause-tracing`.
   - Test: classify the known failed Builder smoke without retrying it.

3. `swarmclaw-webapp-testing`
   - Purpose: browser-driven verification of local web apps while respecting localhost-only constraints.
   - Based on: GUI operator manual plus audited `Webapp Testing`.
   - Current repo-layer skill: `skills/swarmclaw-webapp-testing/SKILL.md`.
   - Live workspace skill copy: `state/skills/swarmclaw-webapp-testing/SKILL.md`.
   - Managed stored skill: `0a246b88`, pinned to Reviewer QA `c2cd6ff9` for CLI prompt injection.
   - Test: direct read-only smoke task `e8a3be21` completed with `SWARMCLAW_WEBAPP_TESTING_PINNED_SKILL_OK`. It verified prompt injection and produced an HTTP/readiness browser-test plan for `/knowledge`; it also exposed the missing Chromium/system browser binary. Browser-runtime task `9c960e1b` proved the live container fix. After rebuild/recreate from patched `Dockerfile.subscription`, rebuilt-image smoke task `a1c59af7` completed with `SWARMCLAW_WEBAPP_TESTING_REBUILT_IMAGE_OK`, proving Playwright Chromium launches from the rebuilt image. The unauthenticated worker browser redirects protected GUI routes to `/login`; do not enter access keys or inspect `.env.local` without a separate checkpoint.

4. `swarmclaw-gui-operator`
   - Purpose: teach future agents the safe local GUI operating loop, task routing defaults, failure triage, evidence requirements, and concise handoff practice.
   - Based on: the GUI operator manual, next-agent quickstart, failure catalog, and verified live task lessons.
   - Current repo-layer skill: `skills/swarmclaw-gui-operator/SKILL.md`.
   - Live workspace skill copy: `state/skills/swarmclaw-gui-operator/SKILL.md`.
   - Managed stored skill: `73f99789`, pinned to Coordinator `default` only. Do not pin it to implementation workers unless Zmey approves that exact expansion.
   - Knowledge sources: `70f893b23855027b` SwarmClaw Next-Agent Quickstart, `75b590287831ac7e` SwarmClaw Operator Failure Catalog, `1af2f3323854cd70` SwarmClaw GUI Operator Skill, and `50fd7be4d1722887` SwarmClaw Parallel App Build Template. Existing GUI manual source `c05dc18feaad931c` is now file-backed from `state/operator-knowledge/swarmclaw-gui-operator-manual.md`.
   - Test: filtered DB verification confirmed the Knowledge sources are ready and indexed, managed skill `73f99789` exists, and Coordinator `default` has skill IDs `a5c94626` and `73f99789`. GUI `/knowledge` shows the new operator sources.

Do not create remaining candidate skills until Zmey approves the exact runtime location, content, and agent attachment plan.

Runtime checkpoints must cover the exact operation: adding/editing/deleting managed skills, importing by URL, installing from ClawHub, writing workspace/project skill directories, promoting/dismissing/deleting learned skills, changing an agent's pinned `skillIds`, changing OpenClaw skill allowlists, or changing skill recommendation settings.

## Maintenance

Update this registry when:

- a candidate skill is individually audited
- a local SwarmClaw skill is created, changed, pinned, or retired
- a specialist agent is created or materially reconfigured
- a parallel task run reveals a durable routing lesson
- official SwarmClaw skill/delegation docs change

After updates:

1. Run a secret-pattern scan on this file.
2. Verify health and Docker local binding.
3. If the update changes operating practice, save one concise agentmemory lesson.
4. Update the external handoff with at most one short line if Zmey wants it reflected there.
5. Add or refresh this as in-app Knowledge only after checkpoint.
