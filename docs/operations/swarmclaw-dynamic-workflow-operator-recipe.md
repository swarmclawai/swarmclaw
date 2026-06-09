# SwarmClaw Dynamic Workflow Operator Recipe

Last verified: 2026-06-09, local subscription image `swarmclaw-subscription:1.9.36`.

Purpose: operate SwarmClaw-native dynamic workflows safely through Protocols, Tasks, Runs, and the Workflow Bundles panel. This is the short runbook for future agents; use the GUI operator manual for page-by-page detail.

## Preconditions

- Read agentmemory and the external handoff before continuing prior work.
- Verify SwarmClaw is healthy and bound to `127.0.0.1:3456-3457`; never expose port `3456`.
- Do not inspect secrets, auth JSON, full env files, tokens, wallets, credential values, DB dumps, or private keys.
- Do not change providers, credentials, schedules, autonomy, state repair, public exposure, or `.env.local` without a checkpoint.
- Prefer direct task assignment for debugging. Use workflow bundles when the work needs repeatable fan-out, fan-in, evidence, or continuation.

## Safe Workflow Loop

1. Open `/protocols` and use **Workflow Bundles**.
2. Draft the goal first when risk or scope is unclear. Drafting must create no tasks.
3. Review the plan for scope, agent IDs, cwd, forbidden actions, expected markers, and checkpoints.
4. Create Backlog tasks first. Queue independent workers only after review.
5. Let dependent fan-in tasks unblock from completed workers. Do not mark a wave accepted until fan-in returns an explicit decision.
6. Use **Continue selected run** after all workflow tasks are terminal.
7. For bounded autopilot, enable **Continue until done** only after the current run is clean. Enable **Auto-create safe backlog** only for read-only, non-quarantined, checkpoint-free continuations.
8. Stop on any blocker, failed marker, blocked QA disposition, repeated same failure, or checkpoint-required action.

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

## Known Pitfalls

- F017: browser text entry can fail in task forms because the browser automation surface lacks virtual clipboard support. Do not loop retries; use manual GUI entry or a checkpointed app-service fallback.
- Workflow dependency edges are not continuation edges. Fan-in tasks must receive upstream result summaries, not reuse a worker's execution session.
- The task board Queue button can be brittle under browser automation. If visible clicking does not persist, stop and use a checkpointed service/API fallback rather than broad raw DB edits.
- Shell calls to protected workflow APIs may return `401`; prefer the authenticated GUI for protected actions.

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
2. Exclude DBs, datasets, logs, outputs, `.env*`, credentials, cookies, auth JSON, wallets, keys, and live trading actions.
3. Use two worker tasks plus one Reviewer QA fan-in before implementation.
4. Convert accepted findings into a project onboarding plan and a staging ledger.
5. Only after the ledger is accepted, discuss code-writing waves and isolation policy.

## Crypto Pilot Result

Run `cbwf0909` verified the first messy-project workflow drill:

- Discovery task `cbd901a1` completed with marker `CRYPTO_BOT_DISCOVERY_OK` and produced a useful repo/runtime map.
- Reviewer QA risk tasks `cbr901a2` and replacement `cbr901b4` stayed silent too long and emitted partial non-marker output when terminated.
- Fan-in `cbf901a3` was marked failed because its upstream risk evidence was superseded/incomplete.
- The next safe crypto step is not another broad risk review. Prepare a tiny source capsule from discovery findings, then run a narrow Reviewer QA task against that capsule or exact file list.
