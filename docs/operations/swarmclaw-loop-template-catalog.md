# SwarmClaw Loop Template Catalog

Last verified: 2026-06-15

Audience: Codex and future agents operating Zmey's local SwarmClaw instance.

Purpose: reusable LoopSpec starters for safe SwarmClaw workflow operation. These
templates do not change providers, credentials, schedules, autonomy, state,
Knowledge, managed skills, or server lifecycle. Create backlog tasks first and
queue only after operator review.

## Shared LoopSpec Header

Use this header before creating any repeated or multi-wave workflow:

```markdown
Loop ID: <short stable id>
Loop name: <human name>
Project:
Goal:
Iteration: 1
Invariant:
Allowed read scope:
Allowed write scope:
Forbidden actions:
Checkpoint-required actions:
Evaluator role: Reviewer QA
Progress signal:
Stuck signal:
Deterministic checks:
Evaluator checks:
Retry policy: one targeted retry; two maximum for the same failure class
Continuation policy: draft_only
Stop states: done, checkpoint, blocked, needs_human, budget_exhausted, quarantined, retry, defer
Budget/fuses:
Ledger fields: taskId, agentId, marker, status, filesChanged, verification, blockers, qaDisposition
```

Initial messy-project discovery can be a pre-loop intake step. Once the work
needs repeated waves, continuation, or parallel fan-in, write the LoopSpec
before launch.

## Read-Only Project Understanding

Use for onboarding a messy repo without code writes.

- Invariant: source/docs only; no secrets, DBs, logs, outputs, credentials, or
  runtime side effects.
- Workers: Builder discovery, Reviewer QA risk review, optional docs/test
  inventory.
- Evaluator: Reviewer QA fan-in.
- Progress: accepted architecture map, active/stale file classification, clear
  blockers, no secret-bearing output.
- Stop: accepted onboarding plan, unsafe source request, missing repo path, or
  repeated silent worker.
- Default continuation: draft-only next read-only wave.

## Implementation With Reviewer Fan-In

Use after read-only discovery has accepted exact files and tests.

- Invariant: writes stay inside approved files and preserve project safety
  rules.
- Workers: one implementation worker per disjoint scope.
- Evaluator: Reviewer QA fan-in plus deterministic tests.
- Progress: targeted diff, passing relevant checks, no forbidden files changed.
- Stop: tests pass and review accepts, merge conflict, failing same check twice,
  or checkpoint-required action.
- Worktree policy: checkpoint-required for parallel writes.

## Test-Fix Loop

Use when failures are concrete and local tests can reproduce them.

- Invariant: fix the failing behavior, not unrelated code.
- Workers: Debugger or TDD Builder for one failure class at a time.
- Evaluator: deterministic test command plus Reviewer QA if the behavior is
  user-facing or safety-sensitive.
- Progress: failing check becomes passing, no new focused failures, regression
  test added when appropriate.
- Stop: green focused check, missing dependency environment, repeated same
  failure, or broader design decision required.

## Bug Hunt Loop

Use when the failure source is uncertain.

- Invariant: do not patch until the failure class is identified.
- Workers: one source-trace worker, one log/symptom reviewer if logs are
  sanitized, one risk reviewer for safety boundaries.
- Evaluator: Reviewer QA decides whether evidence supports a patch.
- Progress: narrowed cause, reproduction path, exact file/function candidates.
- Stop: root cause identified, evidence conflicts, secret/log quarantine, or no
  new findings after one retry.

## Graph Refresh Loop

Use Graphify only as a scratch sidecar input.

- Invariant: graph artifacts are untrusted until reviewed and sanitized.
- Workers: graph operator, source summarizer, Reviewer QA hygiene review.
- Evaluator: Reviewer QA accepts or rejects the sanitized summary.
- Progress: useful symbol-heavy map, no credential values, no raw graph import.
- Stop: sanitized summary accepted, graph is noisy, graph contains unsafe
  material, or tool proposes hooks/MCP/watch/global install without checkpoint.
- Cleanup: remove scratch artifacts unless Zmey approves retaining a sanitized
  report.

## Release Gate Loop

Use before committing, pushing, publishing, or deploying.

- Invariant: publish only reviewed source/docs/tests/manifests; no secrets,
  generated data, DBs, logs, model binaries, or local-only artifacts.
- Workers: source inventory, ignore/large-file review, test plan, publication
  risk review.
- Evaluator: Reviewer QA final gate.
- Progress: staging ledger classifies every candidate path.
- Stop: clean staged diff and checks pass, blocked-sensitive path found, remote
  missing, or checkpoint-required publish action.

## Crypto Safety Review Loop

Use for crypto trading bot research or cleanup.

- Invariant: paper/read-only unless Zmey separately approves live trading.
- Forbidden: exchange calls, live orders, credentials, wallets/private keys,
  DB writes, schedule/deploy/provider/autonomy changes, secret/env inspection.
- Workers: architecture map, trading-risk safety review, persistence/dataflow
  review, test/guard review.
- Evaluator: Reviewer QA fan-in.
- Progress: accepted risk ledger, exact code/test candidates, no live actions.
- Stop: next safe read-only wave accepted, code-writing checkpoint required,
  unsafe credential/live-order request, or count/contract conflict.

## Loop Repair / Recovery

Use when a workflow is already running without clear stop rules.

1. Stop queueing new tasks.
2. Preserve task IDs, agent IDs, markers, statuses, and current blockers.
3. Draft a retroactive LoopSpec from actual evidence.
4. Run Reviewer QA or main Codex fan-in against the retroactive LoopSpec.
5. Classify the state: done, retry, checkpoint, blocked, quarantined, or defer.
6. Continue only after the corrected LoopSpec is accepted.

## Knowledge-Safe Review Checklist

Before adding any loop template or summary to in-app Knowledge:

- Remove raw logs, env values, credentials, tokens, auth JSON, DB rows, wallet
  material, and private keys.
- Keep task IDs and markers only when useful and non-sensitive.
- Prefer durable rules, templates, and accepted outcomes over transcripts.
- Ask Zmey before mutating Knowledge state.
