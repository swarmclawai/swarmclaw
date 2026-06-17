# Crypto Bot Operating Brief

Last verified: 2026-06-15
Status: remediation planning accepted by SwarmClaw fan-in task `209d1e87`;
the focused 65-field / 18-forbidden-selector test/docs checkpoint was applied
locally on 2026-06-15.
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
- Remediation planning tasks: `c028598a`, `38615719`, `ed891a79`,
  blocked fan-in `1636b59d`, count reconciliation `7e7931ff`, and final
  accepted fan-in `209d1e87`.

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
- Remediation fan-in `1636b59d` initially blocked because worker counts
  conflicted. Reconciliation task `7e7931ff` verified the authoritative source
  target as 65 `entry_runtime_contract_v1` fields and 18 forbidden selectors;
  task `209d1e87` accepted that basis for a focused test/docs checkpoint.
- R03-derived planning that cites 76 contract fields or 15 forbidden selectors
  is superseded and must be corrected to 65 and 18.
- Focused checkpoint applied: `tests/test_pumpfun_runtime_contract.py` now locks
  65 total contract fields, uniqueness, 18 forbidden selector fields, 13 fields
  per `s30/s60/s120` checkpoint, source-level artifact-list spreading, and the
  token-ready discovery-context boundary. `RUNTIME_VERIFICATION_STATUS.md` now
  reflects `ENABLE_MONITORING=True` and the aggregate-only
  `entry_runtime_contract_v1` handoff.

## SwarmClaw Operating Pattern

- Use direct task assignment by exact stored worker ID.
- Keep planning/review quality gates disabled or relaxed, then manually verify
  markers and constraints.
- Embed predecessor summaries into fan-in prompts or make them available as
  reviewed Knowledge/operator text.
- Avoid assignment-looking labels such as `Agent ID:` in embedded evidence; use
  neutral labels such as `worker`.
- Use `docs/operations/swarmclaw-loop-engineering-plan.md` before any repeated
  remediation loop. Crypto loops must define progress/stuck signals, retry caps,
  Reviewer QA evaluation, and explicit stop conditions before tasks are queued.

## Current Loop Engineering Targets

Keep the detailed evidence in the audit ledger and use this section only as a
compact current loop map.

| Loop | Invariant | Progress Signal | Stop Condition |
|---|---|---|---|
| Runtime contract/selector loop | `entry_runtime_contract_v1` remains 65 fields and 18 forbidden selectors. | Targeted test/docs evidence aligns to 65/18 and Reviewer QA accepts. | Tests pass plus QA accept, or same failure twice, count conflict, secret/DB/log boundary, or checkpoint-required action. |
| Shadow/paper/execute safety loop | Agents do not promote beyond paper/shadow or submit live orders. | Safety review confirms no live trading, exchange action, env override, schedule, or deployment change. | Any live-action request, credential/env need, runtime stack start, or safety contradiction. |

## Possible Later Additions

- TradingAgents-inspired research wave: parked for later. If revisited, use it
  only as a SwarmClaw-native debate/checkpoint/evidence pattern for pump.fun
  freshness, latency, security, creator/wallet, and paper/shadow analysis. Do
  not import `Buy/Sell/Hold`, position sizing, stock-style roles, generic ticker
  data, LangGraph orchestration, or execution authority.

## Next Actions

Next safest action: review the narrow crypto diff and decide whether to stage or
commit only the focused test/docs changes. Any broader crypto code wave, DB/log
research, runtime smoke, generated output inspection, live trading, deployment,
schedules, provider/autonomy changes, or broad repo cleanup still requires a
fresh checkpoint.

Sanitized Knowledge import is allowed only as a scoped orientation note that
preserves the limitations and checkpoint gates above.
