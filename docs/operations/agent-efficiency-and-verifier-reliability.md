# Agent Efficiency and Verifier Reliability

Purpose: SwarmClaw operating note for Zmey-style Hermes orchestration. Parent assistant should orchestrate and summarize; workers/subagents should do meaningful heavy work; verifier trust must be measured over repeated perfect audited runs.

Canonical Hermes-side artifacts:

- `~/.hermes/subagent-quality/agent-efficiency-operating-system.md`
- `~/.hermes/subagent-quality/efficiency-ledger.md`
- `~/.hermes/subagent-quality/verifier-trust-ledger.md`
- `~/.hermes/subagent-quality/prompt-templates.md`
- `~/.hermes/skills/autonomous-ai-agents/subagent-orchestration-verifier-reliability/SKILL.md`

## SwarmClaw-specific default

For non-trivial SwarmClaw work:

1. Build a compact known-facts block from current repo/session state.
2. Delegate meaningful/heavy lanes to Hermes-side subagents:
   - scout/research;
   - implementation planning;
   - implementation worker when edits are worker-scale;
   - verifier;
   - challenger verifier for high-risk claims.
3. Parent synthesizes worker outputs, checks decisive evidence, commits/checkpoints, and reports.
4. Record efficiency and verifier reliability outcomes.

Parent should not personally do worker-scale inspection/implementation unless:

- the task is tiny;
- subagents failed/disagreed and direct investigation is needed;
- action is sensitive/high-risk;
- user explicitly requests parent-only work.

## Trust thresholds

Verifier trust is scoped by task class.

| Level | Requirement | Use |
|---|---|---|
| L0 Untrusted | New or recently failed verifier prompt | Treat as lead only; parent audits closely. |
| L1 Useful signal | 3 consecutive perfect scoped audited runs | Strong lead; still spot-check. |
| L2 Strong signal | 10 consecutive perfect scoped audited runs | Reduced audit on low-risk tasks. |
| L3 Operationally trusted | 25 consecutive perfect scoped audited runs across varied cases | Spot-check plus deterministic checks; high-risk still audited. |

False PASS resets/demotes trust. False PASS includes claiming success without evidence, accepting mocked paths as real proof, verifying the wrong branch/env/file, or missing a material acceptance criterion.

## Required worker output schema

```text
STATUS: completed | partial | blocked
SCOPE READ / INPUTS USED
KEY FINDINGS
EVIDENCE: path:line, URL, command, output excerpt
RISKS / GAPS
RECOMMENDED NEXT STEP
VERIFIED / INFERRED / NEEDS PARENT VERIFICATION
QUALITY SELF-CHECK: ambiguity + next prompt improvement
```

Verifier schema:

```text
VERDICT: pass | fail | partial | inconclusive
REQUIREMENT MAP: requirement -> PASS/FAIL/UNKNOWN -> evidence
EVIDENCE CHECKED
COMMANDS RUN + OUTPUT SUMMARY
FILES/SOURCES INSPECTED
WHAT WAS NOT VERIFIED
MISSES / RISKS
PARENT MUST CHECK
QUALITY SELF-CHECK
```

## Efficiency metrics to record

- parent tool calls;
- subagent count;
- worker API/tool calls where available;
- duplicate/repeated reads, searches, and commands;
- late delegation;
- over-delegation;
- parent heavy-lifting that should have been delegated;
- verifier catches/misses;
- user correction after final.

## Current bootstrap example

2026-06-19 native subagent hardening:

- Step 1 commit `cace40ec`: fixed `joinPolicy:first` to wait for first successful branch by delegating to `quorumSettled(1, { cancelRemaining: true })`.
- Step 2 commit `40cf7057`: added lower-level `spawnSwarm().quorumSettled(1)` tests for early failure, later success, no-success fallback, `cancelRemaining` true/false, and aggregate ordering/counts.
- Verifier lesson: Step 2 verifier caught a real TypeScript mock-handle issue; this increased trust for the TypeScript behavior/test verifier pattern.
- Efficiency lesson: parent still performed too much implementation; future similar tasks should delegate implementation/test patching earlier and reserve parent for synthesis, spot-checking, and commit/checkpoint actions.

## Mini-retro trigger

After any significant SwarmClaw run, ask internally:

```text
Did I delegate early enough?
Did workers have narrow independent scopes?
Did prompts require evidence and known-facts context?
Did any tool call repeat known information?
Did verifier verdict match parent audit?
Where was most time spent?
What prompt/skill/ledger update prevents recurrence?
```

Record the answer in the Hermes-side efficiency ledger and, if the lesson is SwarmClaw-specific, in the appropriate `docs/operations/` note.
