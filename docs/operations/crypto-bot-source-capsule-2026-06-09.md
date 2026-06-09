# Crypto Bot Source Capsule - 2026-06-09

Purpose: give SwarmClaw agents a small, sanitized source-of-truth packet for the
crypto trading bot before any broader cleanup, planning, or parallel work.

This capsule is read-only evidence for `Crypto Trading Bot`. It is not a
credential guide, trading instruction, deployment plan, or DB access plan.

## Source Scope

Target repo inspected:

- `state/workspace/projects/crypto-trading-bot/upgraded_ml_pipeline`

Safe files inspected:

- `ACTIVE_PIPELINE_MANIFEST.md`
- `DAILY_WORK_ZONES.md`
- `HANDOFF.md`
- `docs/current_runtime/README.md`
- `docs/current_runtime/RUNTIME_CREDENTIALS_OWNERSHIP.md`
- `docs/current_runtime/CONFIG_OWNERSHIP_REVIEW.md`
- `docs/current_runtime/RUNTIME_VERIFICATION_STATUS.md`
- `services/runtime_preflight.py`
- `services/pumpfun_runtime_contract.py`

Not inspected:

- `.env*`, ignored local JSON credentials, auth JSON, cookies, token files,
  private keys, wallets, DB files, datasets, logs, model binaries, runtime output,
  raw reports, or external APIs.

## Current Runtime Map

Local authority is `ACTIVE_PIPELINE_MANIFEST.md`, which explicitly says older
root startup/architecture docs are stale and should not be treated as runtime
authority. It points operators to `services/config.py`,
`live_trading/config.py`, `services/trading_service.py`,
`services/orchestrator.py`, and the manifest first.

Current safe runtime chain from the prior successful SwarmClaw discovery task:

1. `services.persistence_service`
2. `services.scoring_service`
3. `services.trading_service --mode paper`
4. `services.orchestrator`
5. `services.pumpfun_pregrad_discovery_service`

The manifest says current defaults are paper-oriented and pump.fun-first:

- `USE_UNIFIED_FETCHER = True`
- `ENABLE_MONITORING = True` in the manifest, while runtime verification notes
  mention monitoring can be disabled in the local verification context.
- `TRADING_MODE = "paper"`
- `ENTRY_STRATEGY_MODE = "exit_to_entry_coordinator"`
- `EXIT_TO_ENTRY_RUN_MODE = "shadow"` by default, so paper execution may be
  intentionally suppressed unless switched for paper validation.
- `PUMPFUN_TX_SCORER_ROLE = "pumpfun_primary"` with guarded fallback behavior.

## Work Zones

Green zones for current runtime work:

- `services/config.py`
- `services/token_discovery_service.py`
- `services/orchestrator.py`
- `services/unified_tx_fetcher.py`
- `services/scoring_service.py`
- `services/trading_service.py`
- `services/persistence_service.py`
- `services/persistence_helper.py`
- `services/restart_recovery.py`
- `live_trading/config.py`
- `live_trading/entry_detector_v2.py`
- `live_trading/paper_trader_v2.py`
- `live_trading/real_trader.py`
- `live_trading/trade_manager_v2.py`
- `live_trading/stage_exit_manager.py`
- `live_trading/token_capital.py`
- `live_trading/exit_to_entry_coordinator.py`
- `live_trading/token_scorer.py`
- `live_trading/token_scorer_optimized.py`

Yellow zones need dependency review first:

- `execution/`
- `data_collection/postgres_db.py`
- `data_collection/postgres_schema.sql`
- `detective_crypto/dexscreener_scraper.py`
- `live_trading/selenium_new_pairs.py`
- `test_data/security/`
- `config/runtime_config.py`
- selected model/config support paths

Red zones are no-touch by default:

- `LEGACY_CODE/`
- old live pipeline files
- historical research archives
- broad `output/`, `data/`, DB, log, dataset, and generated artifact folders

## Credential And Data Boundaries

`docs/current_runtime/RUNTIME_CREDENTIALS_OWNERSHIP.md` says runtime credentials
are loaded from environment variables or ignored local JSON files and are not
GitHub-publishable source. It also says automation should check only
presence/key shape and never print values.

`docs/current_runtime/CONFIG_OWNERSHIP_REVIEW.md` says the remaining active
`services -> live_trading/config.py` dependency is mainly the shared runtime
credential/config pool, which should not be moved casually.

`services/pumpfun_runtime_contract.py` defines an aggregate-only runtime contract
for pump.fun front-door candidates. Its forbidden selector fields include token
addresses, symbols, creators, wallets, pools, transaction hashes, raw BirdEye
data, and raw transaction data. SwarmClaw task prompts should preserve this
boundary.

## Verification Status

`docs/current_runtime/RUNTIME_VERIFICATION_STATUS.md` says focused checks have
passed for:

- `python -m services.runtime_preflight`
- scoring roundtrip over Redis
- unified-fetcher bootstrap path
- monitoring publish path
- trading bootstrap path

Remaining unverified areas are broader live service coordination over time, real
discovery input, external API fetch execution, and paper-trading lifecycle after
fresh transactions arrive.

`services/runtime_preflight.py` checks Python imports, Redis/PostgreSQL TCP
reachability, and model/security paths. It does not validate secret values or
authenticate to live feeds.

## SwarmClaw Task Rules For This Project

Use direct assignment by default.

Safe first SwarmClaw tasks:

- read-only runtime wiring audit
- source/docs inventory
- publication hygiene review
- test/verification plan
- Reviewer QA fan-in

Forbidden without a checkpoint:

- reading or printing env values, credential files, cookies, tokens, private keys,
  wallet material, DB dumps, raw logs, or auth JSON
- live trading, order placement, exchange/API actions, schedule changes, deploys,
  provider changes, autonomy changes, server exposure changes, destructive
  cleanup, or DB writes
- broad history push or broad `git add`

First implementation wave should be read-only and capsule-driven. Agents should
cite task IDs, agent IDs, inspected safe areas, blockers, and `files changed:
none`.

## Reviewer QA Prompt Seed

Use only this capsule. Do not inspect the crypto repo, env files, DBs, credential
files, logs, external APIs, or generated output.

Required output:

1. First line exactly: `CRYPTO_CAPSULE_QA_OK` or `CRYPTO_CAPSULE_QA_BLOCKED`
2. `task id: <id>`
3. `agent id: c2cd6ff9`
4. `safe next wave: <accepted/blocked>`
5. Top 5 risks in the capsule
6. Missing evidence that must be gathered before code-writing
7. Recommended first parallel audit bundle
8. `files changed: none`

## SwarmClaw QA Result

Task `ccqa2752`, Reviewer QA `c2cd6ff9`, completed from this capsule with first
line marker `CRYPTO_CAPSULE_QA_OK`.

Decision: safe next wave accepted, but code-writing remains blocked until the
first parallel audit bundle gathers missing source-level evidence.

Top accepted risks:

- manifest/runtime verification conflict around monitoring state
- shadow-mode paper execution can make bootstrap success look stronger than it
  is
- broader live service coordination, real discovery input, external fetches, and
  fresh-transaction paper lifecycle remain unverified
- credential/config ownership is still coupled through `live_trading/config.py`
- aggregate-only runtime contract boundaries can be violated by consumers if
  not checked explicitly

Recommended first parallel audit bundle:

- config ownership and manifest/default mismatch audit:
  `services/config.py`, `live_trading/config.py`, `services/runtime_preflight.py`
- shadow-mode and paper lifecycle audit:
  `services/orchestrator.py`, `services/trading_service.py`,
  `live_trading/exit_to_entry_coordinator.py`
- aggregate-only contract compliance audit:
  `services/pumpfun_runtime_contract.py` plus green-zone callers
- safe-chain coordination audit:
  `services/unified_tx_fetcher.py`, `services/scoring_service.py`,
  `services/persistence_service.py`

Verification: task output said no repo, env files, DBs, logs, credentials,
external APIs, generated output, schedules, deploys, provider settings, or
autonomy settings were inspected or changed.
