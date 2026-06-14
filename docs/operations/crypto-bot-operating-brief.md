# Crypto Bot Operating Brief

Last verified: 2026-06-14
Status: contract trace fan-in accepted by SwarmClaw task `6f78749c` for the next read-only planning step only.
Purpose: give Codex and future SwarmClaw workers a concise, sanitized operating
brief for Zmey's crypto trading bot.

## Use Policy

- Default mode is read-only source/docs analysis.
- Do not inspect `.env*`, credentials, cookies, auth JSON, token JSON, private
  keys, wallets, DBs, datasets, logs, generated output, model files, `secrets/`,
  `LEGACY_CODE/`, or raw Graphify artifacts.
- Do not start runtime services, live trading, exchange/Jupiter/Kyber calls,
  migrations, deployments, schedules, provider changes, autonomy changes, or
  artifact-producing validation without a fresh checkpoint.
- Treat Graphify as orientation only; manifests, config, active source, and
  accepted SwarmClaw fan-in decisions are stronger truth sources.

## Truth Sources

- `docs/operations/crypto-bot-source-capsule-2026-06-09.md`
- `docs/operations/crypto-bot-readonly-audit-ledger-2026-06-09.md`
- `docs/operations/crypto-bot-graphify-summary-2026-06-11.md`
- Onboarding tasks: `c030facb`, `db866e2f`, `4e6612ae`, `200521ea`,
  `098f9adc`, and final fan-in `9b1c3037`.
- Contract trace tasks: `cfd16de6`, `794dae24`, `e282952d`, `1e7b00cd`,
  and final fan-in `6f78749c`.

## Current Runtime Map

Accepted onboarding evidence maps the current chain as:

```text
persistence_service -> scoring_service -> trading_service --mode paper -> orchestrator -> pumpfun_pregrad_discovery_service
```

Important defaults from accepted worker evidence:

- `TRADING_MODE="paper"`
- `USE_UNIFIED_FETCHER=True`
- `EXIT_TO_ENTRY_RUN_MODE="shadow"`
- lane allowlist `pregrad_capture_primary`
- pump.fun security pass required

Dependency sketch:

- Pump.fun discovery publishes actionable tokens and metadata.
- Orchestrator consumes `tradeable_tokens`, starts unified fetchers, and manages
  Redis rate allocation.
- Unified fetcher emits scoring requests/results plus `token_ready` and
  `new_txs`.
- Scoring uses optimized scorer, security checker/fallbacks, shadow scorers, and
  pump.fun security snapshots.
- Trading consumes `token_ready` and `new_txs` through paper trader, trade
  manager, entry detector, and optional exit-to-entry coordinator.

## Safe And Blocked Scopes

Safe read-only scopes:

- Active `services/`, selected active `live_trading/`, `execution/`, `config/`,
  `data_collection/`, `detective_crypto/`, `utils/`, `migrations/`, README
  files, requirements files, `pyproject.toml`, `pytest.ini`, and focused tests
  after inspection.

Checkpoint-required scopes:

- Secrets/env/cookies/token JSON/wallets/DBs/logs/output/model files.
- Runtime stack starts, `--mode real`, exchange/Jupiter/Kyber tests,
  `EXIT_TO_ENTRY_RUN_MODE=execute`, security-gate/scorer-bypass env changes.
- Migrations, deployments, schedules, provider/autonomy changes, publication,
  staging, or push.

## Current Findings

- Real-money path exists behind a CLI switch; `--mode real` and RealTrader
  execution surfaces are checkpoint-blocked.
- RealTrader/Jupiter/Kyber paths are real exchange surfaces, not mock-only.
- Paper/shadow defaults must not be assumed if environment overrides are active.
- Runtime health, Redis/Postgres state, dynamic env overrides, model correctness,
  API behavior, trade artifacts, and DB contents remain unverified.
- Graphify/source-only evidence is orientation, not operational proof.
- Contract trace fan-in accepted the next read-only planning step around
  `entry_runtime_contract_v1` fan-in, the `token_ready` publisher/consumer
  boundary, missing tests/docs coverage, and safety-map caveats.
- The accepted contract trace is not approval for runtime promotion, live
  execution, repo mutation, secret/config inspection, or claims that coverage
  gaps are fixed.

## SwarmClaw Operating Pattern

- Use direct task assignment by exact stored worker ID.
- Keep planning/review quality gates disabled or relaxed, then manually verify
  markers and constraints.
- Embed predecessor summaries into fan-in prompts or make them available as
  reviewed Knowledge/operator text.
- Avoid assignment-looking labels such as `Agent ID:` in embedded evidence; use
  neutral labels such as `worker`.

## Next Actions

Next safest action: draft a read-only remediation plan prioritizing
`token_ready` runtime-boundary payload tests, forbidden selector completeness,
checkpoint field-count coverage, `docs/current_runtime` contract references,
and the stale `ENABLE_MONITORING` conflict noted by task `1e7b00cd`.

First possible code-writing candidates remain deferred until checkpoint:

- Safe README/runbook cleanup.
- Test matrix labels for unit/integration/live.
- Contract-test strengthening.
- Runtime payload validation helpers.

Sanitized Knowledge import is allowed only as a scoped orientation note that
preserves the limitations and checkpoint gates above.
