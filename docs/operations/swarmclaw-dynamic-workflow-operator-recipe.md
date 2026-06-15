# SwarmClaw Dynamic Workflow Operator Recipe

Last verified: 2026-06-15, local subscription image `swarmclaw-subscription:1.9.36`.

Purpose: operate SwarmClaw-native dynamic workflows safely through Protocols, Tasks, Runs, and the Workflow Bundles panel. This is the short runbook for future agents; use the GUI operator manual for page-by-page detail.

For loop-engineering policy, use
`docs/operations/swarmclaw-loop-engineering-plan.md`. This recipe is the
operator runbook; the loop plan defines LoopSpec fields, progress/stuck signals,
retry caps, evaluator separation, Graphify sidecar rules, and productization
phases. For ready-to-copy loop shapes, use
`docs/operations/swarmclaw-loop-template-catalog.md`.

## Preconditions

- Read agentmemory and the external handoff before continuing prior work.
- Verify SwarmClaw is healthy and bound to `127.0.0.1:3456-3457`; never expose port `3456`.
- Do not inspect secrets, auth JSON, full env files, tokens, wallets, credential values, DB dumps, or private keys.
- Do not change providers, credentials, schedules, autonomy, state repair, public exposure, or `.env.local` without a checkpoint.
- Prefer direct task assignment for debugging. Use workflow bundles when the work needs repeatable fan-out, fan-in, evidence, or continuation.

## Safe Workflow Loop

1. Open `/protocols` and use **Workflow Bundles**.
2. For repeated, multi-wave, or auto-continuing work, draft a LoopSpec first:
   goal, truth sources,
   scope, forbidden actions, evaluator, progress signal, stuck signal, retry
   policy, stop conditions, and budget/fuses.
3. For an unknown messy project, a first read-only discovery/risk review can be
   pre-loop intake. Write the LoopSpec before launching a second wave or any
   continuation.
4. Draft the workflow when risk or scope is unclear. Drafting must create no
   tasks.
5. Review the plan for scope, agent IDs, cwd, forbidden actions, expected
   markers, progress/stuck criteria, retries, stop conditions, and checkpoints.
6. Create Backlog tasks first. Queue independent workers only after review.
7. Let dependent fan-in tasks unblock from completed workers. Do not mark a
   wave accepted until fan-in returns an explicit decision.
8. Use **Continue selected run** after all workflow tasks are terminal.
9. For bounded autopilot, enable **Continue until done** only after the current
   run is clean. Enable **Auto-create safe backlog** only for read-only,
   non-quarantined, checkpoint-free continuations.
10. Stop on any blocker, failed marker, blocked QA disposition, repeated same
   failure, missing progress signal, quarantine signal, safety violation, or
   checkpoint-required action.

## Loop Engineering Rules

- A loop must have a concrete progress signal and a concrete stuck signal before
  launch.
- A worker must not be the only evaluator of its own output.
- Retry the same failure class once by default, twice maximum, then hand off to
  Zmey with evidence.
- Deterministic checks should decide deterministic questions. Use model workers
  for judgment, synthesis, and adversarial review.
- Loop continuation is draft-only unless the LoopSpec explicitly permits safe
  backlog creation.
- Graphify can refresh context for a loop, but raw graph/report output is not a
  trusted source until reviewed and sanitized.
- Worktree writes remain checkpoint-required and must record branch, base SHA,
  merge order, and cleanup status.

## Evidence Contract

Every workflow task should require:

- first-line marker,
- exact task ID and agent ID,
- inspected scope,
- files changed,
- verification evidence,
- blockers,
- decision or next action.

The ledger is accepted only when markers match, QA/fan-in does not block, and no forbidden action appears in task output.

## Verified Wave 1-3 Smoke

Run `bf0f448e` verified the core path:

- Created three backlog workflow tasks: discovery `39bc3361`, safety review `446457e1`, fan-in `c7c21fa7`.
- Queued independent workers, then fan-in unblocked from both worker results.
- Fan-in completed with marker `WF-IMPLEMENTATION-FAN-IN`, validation ok, files changed `none`, and accepted the next read-only wave.
- Clicking **Continue selected run** marked the workflow run completed with summary: `Workflow continuation marked the run completed after all workflow tasks finished.`
- Docker health after rebuild remained healthy and local-only on `127.0.0.1:3456-3457`.

## Graphify Sidecar Pilot

2026-06-10 SwarmClaw platform scratch pilot:

- Cloned Graphify to `/tmp` and installed it only into an isolated `/tmp`
  virtualenv. No global install, hooks, Codex config mutation, MCP server,
  Knowledge import, provider change, or SwarmClaw runtime change.
- Built a temporary corpus from workflow/protocol/task orchestration source only:
  `src/lib/server/workflows`, `src/lib/server/protocols`,
  `src/lib/server/tasks`, workflow/protocol API routes, workflow UI query
  files, and workflow/protocol types.
- Ran code-only extraction with provider API environment names unset and
  `GRAPHIFY_QUERY_LOG_DISABLE=1`.
- Result: 70 code files, 558 nodes, 1052 edges, 43 communities, zero token cost.
- Useful query style: symbol-heavy queries such as
  `createWorkflowBundle createProtocolRun createProtocolDispatchedTask workflow bundle task dispatch protocol run`.
- Weak query style: broad natural-language queries can match generic nodes like
  `task()` and need scoping.
- Secret hygiene: generated report/graph contained no secret values; only
  policy/report language such as `Token cost`.

2026-06-11 crypto bot code-only scratch pilot:

- Used Graphify `0.8.37` from a `/tmp` clone and isolated `/tmp` virtualenv.
  No global install, hooks, Codex config mutation, MCP server, Knowledge import,
  provider change, runtime change, DB read, live trading action, or repo write.
- Built a temporary corpus from active source zones only: `services/`,
  `live_trading/`, `execution/`, `config/`, `data_collection/`,
  `detective_crypto/`, `tests/`, `utils/`, and `migrations/`.
- Included only `.py` and `.sql`; excluded caches, `.env*`, `data/`,
  `test_data/`, `output/`, runtime logs, `secrets/`, `LEGACY_CODE/`, JSON,
  DBs, models, generated artifacts, and secret-named files.
- First extraction attempt was blocked by an over-broad temp `.graphifyignore`
  that excluded the copied `state/` prefix. Fix: build the temp corpus from the
  target repo root so copied paths start at active-source directory names.
- Result: 98 code files, 2302 nodes, 4481 edges, 123 communities, zero token
  cost.
- Useful query style: symbol-heavy queries around active concepts, for example
  `PersistenceService ScoringService TradingService PumpFunPregradDiscoveryService PostgresDB`
  or `SecurityChecker evaluate_pumpfun_security_snapshot scoring_service`.
- Raw graph/report should not be imported into Knowledge without sanitization:
  it contains secret-handling labels from source code, such as credential,
  cookie, API-key, and wallet function/docstring names, though count-only scans
  found no credential values, private keys, DSNs, or provider token patterns.
- Follow-up workflow run `930f36cc` completed architecture, hygiene, onboarding,
  and fan-in tasks. Final Reviewer QA task `8edbdccb` returned
  `CRYPTO_GRAPHIFY_QA_FINAL_OK` and accepted only a strictly read-only
  onboarding wave from sanitized inputs.

## Known Pitfalls

- F017: browser text entry can fail in task forms because the browser automation surface lacks virtual clipboard support. Do not loop retries on `fill`, `type`, CUA typing, DOM typing, or file upload. Use character-by-character `locator.press()` for short fields; use manual GUI entry or a checkpointed app-service fallback for large content.
- Workflow dependency edges are not continuation edges. Fan-in tasks must receive upstream result summaries, not reuse a worker's execution session.
- The task board Queue button can be brittle under browser automation. If visible clicking does not persist, stop and use a checkpointed service/API fallback rather than broad raw DB edits.
- Shell calls to protected workflow APIs may return `401`; prefer the authenticated GUI for protected actions.
- Task creation resolves assignment-like text in descriptions. Embedded
  evidence containing strings such as `Agent ID: ...` can override an explicit
  `agentId`; use neutral labels like `worker` when summarizing predecessor
  outputs.
- Planning, audit, and fan-in tasks often fail implementation-style quality
  gates even when their content is valid. Disable or relax quality gates for
  pure reasoning tasks, keep first-line markers, and manually validate evidence.

## Checkpoint Triggers

Ask Zmey before:

- reading or using credentials,
- live trading or exchange/API calls,
- DB writes or large DB attachment,
- deployment or schedule changes,
- provider routing or autonomy changes,
- destructive cleanup,
- public exposure changes,
- worktree-based parallel writes,
- auto-creating non-read-only continuation work.

## Next Safe Project Pattern

For a messy project such as the crypto bot:

1. Start read-only discovery with source/docs only.
2. If the repo is large or hard to map, run an optional Graphify sidecar pilot
   scratch-first against safe source/docs only. Do not install hooks, mutate
   agent config, commit `graphify-out/`, expose a Graphify server, or import the
   graph into Knowledge until the artifact is reviewed.
3. Exclude DBs, datasets, logs, outputs, `.env*`, credentials, cookies, auth JSON, wallets, keys, and live trading actions.
4. Use two worker tasks plus one Reviewer QA fan-in before implementation.
5. Convert accepted findings into a project onboarding plan and a staging ledger.
6. Only after the ledger is accepted, discuss code-writing waves and isolation policy.

## Crypto Pilot Result

Run `cbwf0909` verified the first messy-project workflow drill:

- Discovery task `cbd901a1` completed with marker `CRYPTO_BOT_DISCOVERY_OK` and produced a useful repo/runtime map.
- Reviewer QA risk tasks `cbr901a2` and replacement `cbr901b4` stayed silent too long and emitted partial non-marker output when terminated.
- Fan-in `cbf901a3` was marked failed because its upstream risk evidence was superseded/incomplete.
- The successful recovery path is a tiny source capsule, not another broad risk review. Capsule QA task `ccqa2752` completed with marker `CRYPTO_CAPSULE_QA_OK`, accepted the next read-only audit bundle, and confirmed no repo, env, DB, log, credential, external API, generated output, schedule, deployment, provider, or autonomy inspection/change.
- Follow-up read-only audit bundle `crypto-readonly-audit-2026-06-09` produced final backup fan-in task `cafo31b3` with marker `CRYPTO_AUDIT_FANIN_BLOCKED`. Code-writing is blocked until Zmey approves a narrow test-first crypto patch: shadow-mode regression/local guard if needed, monitoring/default docs update, and aggregate-selector static test.
