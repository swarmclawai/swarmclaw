# Crypto Bot Graphify Summary 2026-06-11

Purpose: sanitized summary of the scratch-only Graphify code graph pilot for
Zmey's crypto trading bot. Use this as discovery input for SwarmClaw read-only
planning tasks. Do not import the raw graph or report into Knowledge.

## Scope

Repo path:

- `/home/zmey/1. Work/Docker/swarmclaw/state/workspace/projects/crypto-trading-bot/upgraded_ml_pipeline`

Scratch corpus:

- Active `.py` and `.sql` source only.
- Included: `services/`, `live_trading/`, `execution/`, `config/`,
  `data_collection/`, `detective_crypto/`, `tests/`, `utils/`, `migrations/`.
- Excluded: `.env*`, credentials, cookies, auth JSON, wallets, private keys,
  token JSON, DBs, data, test data, output, runtime logs, generated artifacts,
  model files, caches, `secrets/`, `LEGACY_CODE/`, and secret-named files.

Execution:

- Graphify `0.8.37`.
- `/tmp` clone and isolated `/tmp` virtualenv only.
- Provider API environment names unset for the Graphify process.
- `GRAPHIFY_QUERY_LOG_DISABLE=1`.
- No global install, hooks, Codex config mutation, MCP server, Knowledge import,
  provider change, runtime change, DB read, live trading action, or repo write.
- Scratch clone, virtualenv, corpus, and graph artifacts were removed after
  review.

## Result

- Files: 98 code files.
- Nodes: 2302.
- Edges: 4481.
- Communities: 123.
- Token cost: zero.
- Extraction was code-only AST graphing, not semantic model extraction.

## Sanitized Orientation

High-connectivity areas from the code graph:

- Runtime/trading core: `TradingService`, `RealTrader`, `PaperTrader`,
  `TradeManager`, `Position`, `ClosedTrade`.
- Entry and scoring: `EntryDetector`, `EntrySignal`, `ScoringService`,
  `TokenScorerOptimized`, `ExitToEntryCoordinator`.
- Safety and admission: `SecurityChecker`, `SecurityCheckResult`,
  `evaluate_pumpfun_security_snapshot`, `pumpfun_security_gate.py`.
- Persistence and coordination: `PersistenceService`, `PostgresDB`, Redis-facing
  helper code, service-level config.
- Execution surfaces: `JupiterExecutor`, EVM executor surfaces, trade tracking.

Useful symbol-heavy query patterns:

```text
PersistenceService ScoringService TradingService PumpFunPregradDiscoveryService PostgresDB active service chain
EntryDetector EntrySignal TradingService PaperTrader RealTrader JupiterExecutor safety gate execution path
SecurityChecker evaluate_pumpfun_security_snapshot scoring_service pumpfun security admission
```

Broad natural-language queries were less reliable. Prefer names from active
manifests, executable config, and known class/function names.

## Safety Findings

- Raw graph/report is not Knowledge-safe without sanitization because it records
  source-code labels and docstrings for sensitive handling surfaces.
- Count-only scans found no credential values, private keys, DSNs, or provider
  token patterns in the generated artifacts.
- The graph confirms why future project work must preserve financial safety
  gates: trading, execution, security, persistence, and wallet-adjacent logic
  are tightly connected.
- No DB files, raw datasets, generated reports, logs, JSON credential files,
  secret directories, or legacy archives were included.

## Operational Lesson

The first extraction attempt found zero files because the temp copy preserved the
`state/` prefix and the defensive `.graphifyignore` excluded `state/`. For
future pilots, build the temp corpus from the target repo root so copied paths
start at active-source directory names such as `services/` and `live_trading/`.

## Next SwarmClaw Wave

Use this summary as input for a read-only SwarmClaw wave:

1. Builder: architecture map from the sanitized Graphify result and active
   manifests.
2. Reviewer QA: graph coverage, secret hygiene, and false-confidence review.
3. Builder or Coordinator: project onboarding plan using SwarmClaw templates.
4. Reviewer QA: fan-in decision that accepts, requests changes, or blocks the
   next implementation wave.

Forbidden for that wave:

- Inspecting `.env*`, credentials, cookies, auth JSON, token JSON, private keys,
  wallets, DBs, data, test data, output, logs, generated artifacts, model files,
  `secrets/`, or `LEGACY_CODE/`.
- Running live trading, order placement, exchange/account calls, deployments,
  schedules, migrations, destructive cleanup, provider changes, autonomy
  changes, state repair, or public exposure changes.
