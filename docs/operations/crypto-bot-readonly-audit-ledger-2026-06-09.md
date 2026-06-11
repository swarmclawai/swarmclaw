# Crypto Bot Read-Only Audit Ledger - 2026-06-09

Purpose: consolidate the first SwarmClaw read-only parallel audit wave for the
crypto trading bot and define the next safe action before any code-writing.

Scope: source/docs only. No env files, credential files, cookies, auth JSON, DB
files, logs, datasets, generated output, external APIs, live trading, schedules,
deploys, provider settings, autonomy settings, or writes were used.

## SwarmClaw Task Evidence

Bundle: `crypto-readonly-audit-2026-06-09`

| Task | Agent | Status | Marker quality | Disposition |
|---|---|---|---|---|
| `ca137bc` config ownership audit | Builder `92b8cd6c` | failed | prompt/progress only | superseded by operator capsule |
| `ca2553c` shadow paper lifecycle audit | OpenCode Builder `a0f79bad` | completed | useful finding, marker not first | use with correction |
| `ca31b69` aggregate contract audit | Copilot Mini `e74dd145` | failed | progress only | superseded by operator capsule |
| `ca47b9a` safe-chain coordination audit | OpenCode Helper `cc51c5e6` | failed | prompt/progress only | superseded by operator capsule |
| `cafe07a` original fan-in | Reviewer QA `c2cd6ff9` | cancelled | not run | superseded by capsule fan-in |
| `cafv10ee` capsule fan-in | Reviewer QA `c2cd6ff9` | failed | Codex CLI code 1, no output | superseded by backup fan-in |
| `cafv8eb1` short capsule fan-in | Reviewer QA `c2cd6ff9` | failed | Codex CLI/MCP init failure | superseded by backup fan-in |
| `cafo31b3` backup fan-in | OpenCode Builder `a0f79bad` | completed | `CRYPTO_AUDIT_FANIN_BLOCKED` | accepted as final fan-in |

Operational result: broad source-reading tasks still risk prompt/progress output
instead of marker-first reports. Continue using tiny evidence capsules for
Reviewer QA fan-in until worker prompt/result shaping is improved. If Reviewer
QA/Codex CLI fails during MCP initialization, use an OpenCode backup fan-in with
a no-repo-inspection capsule.

## Config Ownership Evidence

`services/config.py` makes the current mainline explicit:

- `USE_UNIFIED_FETCHER = True` at lines 88-91.
- `TRADING_MODE = "paper"` at line 107.
- `ENABLE_MONITORING = True` at lines 111-116.
- `ENTRY_STRATEGY_MODE = "exit_to_entry_coordinator"` and
  `EXIT_TO_ENTRY_RUN_MODE` defaulting to `"shadow"` at lines 118-126.
- `PUMPFUN_TX_SCORER_ROLE` defaults to `"pumpfun_primary"` at lines 418-431.
- `POSTGRES_PASSWORD` is loaded from the environment at line 650; no value was
  inspected.

`live_trading/config.py` confirms shared credential/config ownership is still
mixed:

- BirdEye credentials are local-only and loaded from env or ignored local JSON at
  lines 52-61.
- DexScreener credential/cookie ownership is part of the same deferred cleanup at
  lines 261-266.

`services/runtime_preflight.py` verifies imports, Redis/PostgreSQL TCP
reachability, and path existence at lines 57-104. It does not validate secret
values or authenticate feeds.

Config disposition: code-writing is blocked until a narrow config test/doc plan
states whether `ENABLE_MONITORING=True` in source or the runtime verification
note about disabled monitoring is authoritative for the current local context.

## Shadow Paper Lifecycle Evidence

Useful worker output from `ca2553c` found a real ambiguity, but overstated the
execution risk.

Verified source evidence:

- `TradingService` creates the coordinator whenever
  `ENTRY_STRATEGY_MODE == "exit_to_entry_coordinator"` and
  `EXIT_TO_ENTRY_RUN_MODE != "off"` at `services/trading_service.py` lines
  786-801.
- It warns that paper trade execution is disabled in shadow mode at lines
  813-820.
- The coordinator tick loop comment says it should execute only in execute mode
  at lines 2551-2555, then calls `get_entry_candidates()` and submits entries for
  returned candidates at lines 2575-2607.
- `ExitToEntryCoordinator.get_entry_candidates()` returns `[]` only for `"off"`
  at lines 1046-1057, but later records shadow candidates without appending them
  to executable results at lines 1211-1223.
- `TradingService._append_coordinator_entry_audit()` has a shadow-only selection
  path for audit rows at lines 1538-1565.

Lifecycle disposition: likely shadow-mode execution is blocked indirectly inside
the coordinator, but the contract is non-local and easy to misread. Before any
strategy work, add a regression test or local guard proving that
`EXIT_TO_ENTRY_RUN_MODE="shadow"` never calls `submit_entry_signal()`.

## Aggregate Contract Evidence

`services/pumpfun_runtime_contract.py` defines aggregate-only fields and a
forbidden selector set, including token addresses, creators, wallets, pools,
transaction hashes, raw BirdEye data, and raw transaction data.

Source evidence:

- `unified_tx_fetcher.py` imports `build_entry_runtime_contract_context()` and
  merges it into discovery context at lines 1394-1448.
- `trading_service.py` imports `ENTRY_RUNTIME_CONTRACT_FIELDS`, includes those
  fields in audit/intake field sets, and copies only those contract fields from
  discovery context at lines 182-197, 1123-1150, and 1678-1688.
- Identity fields such as token and symbol still exist as operational message or
  audit metadata in `unified_tx_fetcher.py` lines 746-752 and
  `trading_service.py` lines 1136-1142. That is not automatically a selector
  violation, but it means future audits must distinguish operational identity
  metadata from model/selector inputs.

Contract disposition: no confirmed contract violation from the inspected line
windows, but code-writing remains blocked until consumers of
`ENTRY_RUNTIME_CONTRACT_FIELDS` are covered by a focused regression or static
check that forbidden selector fields are not used for runtime entry selection.

## Safe Chain Evidence

The active chain is supported by source and runtime docs:

- `persistence_service.py` consumes Redis queues and writes to PostgreSQL, with
  service startup at lines 330-343.
- `scoring_service.py` listens for score requests and publishes score results at
  lines 941-953 and 3133-3145.
- `unified_tx_fetcher.py` stores `txs:{token}`, publishes `CHANNEL_TOKEN_READY`,
  publishes fresh `CHANNEL_NEW_TXS`, sends score requests, and waits for score
  results at lines 741-744, 884-911, and 1000-1040.
- `orchestrator.py` is the current unified-fetcher lifecycle manager, and the old
  subprocess fetch path is retained only as a fail-loud legacy guard at lines
  63-69 and 126-139.
- `RUNTIME_VERIFICATION_STATUS.md` records passed focused checks for preflight,
  scoring roundtrip, unified-fetcher bootstrap, monitoring publish, and trading
  bootstrap at lines 13-29.

Remaining unverified areas are still exactly the hard parts listed in
`RUNTIME_VERIFICATION_STATUS.md` lines 34-39: long-running service coordination,
real discovery input, external API fetch execution, and paper-trading lifecycle
after fresh transactions arrive.

## Fan-In Decision

Decision: `CRYPTO_AUDIT_FANIN_BLOCKED` for code-writing without a checkpoint.
Backup fan-in task `cafo31b3` completed with this marker and accepted the
operator ledger.

Reason: the audit found enough source evidence to plan the next code slice, but
not enough verification evidence to safely implement strategy changes
automatically. The next code-writing candidate is narrow and test-first:

1. Add a regression test proving shadow mode cannot call `submit_entry_signal()`.
2. If the test exposes a real gap, add a local guard in
   `TradingService.coordinator_tick_loop()` before entry submission.
3. Update the current runtime docs to resolve the monitoring/default mismatch.
4. Add or update a static contract test for aggregate-only selector fields.

Required checkpoint before code-writing: Zmey approval for a test-first crypto
repo patch touching only the verified green-zone files.

## Graphify Sidecar Follow-Up

2026-06-11 code-only Graphify pilot completed as scratch-only discovery. The
pilot copied only active `.py` and `.sql` source from `services/`,
`live_trading/`, `execution/`, `config/`, `data_collection/`,
`detective_crypto/`, `tests/`, `utils/`, and `migrations/` into `/tmp`, then ran
Graphify with provider API environment names unset and query logging disabled.
Result: 98 code files, 2302 nodes, 4481 edges, 123 communities, zero token cost.

Do not import the raw Graphify graph/report into Knowledge. It contains
secret-handling labels from source code such as credential, cookie, API-key, and
wallet function/docstring names. Count-only scans found no credential values,
private keys, DSNs, or provider token patterns. Use only sanitized summaries or
symbol-heavy graph queries as discovery input for the next read-only SwarmClaw
wave.

### Graphify-Informed SwarmClaw Review Wave

Workflow run `930f36cc` validated the sanitized Graphify summary as input for
the next read-only onboarding wave, with important operator caveats.

| Task | Agent | Status | Marker | Disposition |
|---|---|---|---|---|
| `bcb9aa86` architecture map | Builder `92b8cd6c` | completed | `CRYPTO_GRAPHIFY_ARCH_MAP_OK` | useful, but blocked on missing mounted summary |
| `e1036431` hygiene review | Reviewer QA `c2cd6ff9` | completed | `CRYPTO_GRAPHIFY_HYGIENE_REVIEW_OK` | blocked raw graph use and requested accessible sanitized summary |
| `14272a35` onboarding plan | Builder `92b8cd6c` | completed | `CRYPTO_GRAPHIFY_ONBOARDING_PLAN_OK` | proposed read-only waves, no code-writing |
| `b1b1e4bc` original fan-in | Reviewer QA `c2cd6ff9` | completed | `CRYPTO_GRAPHIFY_FANIN_REVIEW_OK` | blocked because upstream outputs were not accessible in workspace |
| `4cff2a98` remedial fan-in | intended Reviewer QA | completed | mixed | invalidated by retry/assignee mismatch |
| `68908d9c` final fan-in | Builder `92b8cd6c` | completed | `CRYPTO_GRAPHIFY_FINAL_FANIN_OK` | accepted read-only onboarding, but wrong worker |
| `8edbdccb` final QA fan-in | Reviewer QA `c2cd6ff9` | completed | `CRYPTO_GRAPHIFY_QA_FINAL_OK` | accepted next read-only onboarding wave |

Final QA decision: accept only a strictly read-only onboarding wave using the
sanitized Graphify summary, active manifests, and config references. Do not
import raw Graphify graph/report artifacts into Knowledge. Do not use this as
proof of raw graph safety beyond the sanitized assertions already recorded.

Operator findings:

- Protocol fan-in tasks need upstream outputs embedded or otherwise made
  accessible; dependency edges alone did not provide predecessor evidence.
- Pure planning/review tasks should disable or relax implementation-style
  quality gates and validate markers manually.
- Task descriptions containing phrases like `Agent ID: ...` can trigger
  description-based assignment resolution and override the explicit worker.
  Use neutral evidence labels such as `worker` in embedded task summaries.

## Deferred TODOs

Status: deferred by Zmey on 2026-06-09. Do not start these until Zmey gives a
fresh code-writing checkpoint for the crypto repo.

- TODO: add a regression test proving shadow mode cannot call
  `submit_entry_signal()`.
- TODO: if the shadow-mode regression exposes a real gap, add a local guard in
  `TradingService.coordinator_tick_loop()` before entry submission.
- TODO: update current runtime docs to resolve the `ENABLE_MONITORING` source
  default versus runtime-verification note mismatch.
- TODO: add or update a static contract test proving aggregate-only selector
  fields exclude forbidden identity/raw fields from runtime entry selection.
