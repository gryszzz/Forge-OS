# ForgeOS

ForgeOS is a wallet-native Kaspa dashboard for running an AI-assisted trading agent simulation.

It includes:
- Wallet connection (Kasware + Kaspium + Kastle + Ghost Wallet + demo mode)
- Agent creation wizard
- Strategy templates (accumulation-first presets)
- Multi-agent portfolio panel with shared risk budget allocator
- Decision engine panel (Kelly, Monte Carlo, risk/confidence gating)
- PnL attribution panel and alert routing panel
- Runtime network selector in topbar (mainnet/testnet profiles with session reset guard)
- Action queue with manual/auto signing flows
- Treasury fee split and logs
- Wallet operations panel (balance, UTXOs, withdraw flow)

## Who This Is For
- Builders prototyping Kaspa-native agent workflows
- Operators who want transparent signing and execution controls
- Contributors who need a clean React/TypeScript codebase to extend

## Tech Stack
- React 18
- TypeScript
- Vite
- Recharts

## Researcher Bootstrap
- Repo-level agent rules: `AGENTS.md`
- Kaspa resource index: `docs/kaspa/links.md`
- Master AI prompts: `docs/ai/kaspa-elite-engineer-mode.md`

<details>
<summary><strong>GitHub DIY Contributor Hacks (Useful Daily)</strong></summary>

### Stable References
- Press <kbd>y</kbd> on any GitHub file page to create a commit-pinned permalink before sharing line refs.
- Use line anchors in reviews/docs:
  - `src/quant/runQuantEngine.ts#L771`
  - `server/scheduler/index.mjs#L1410`

### Faster Repo Search
- Examples for GitHub code search:
  - `path:src/components/dashboard useExecutionQueue`
  - `path:server/scheduler "leaderFenceToken"`
  - `path:tests runQuantEngineOverlayCache`

### Review / Release Hygiene
- Compare two commits directly:
  - `/compare/<old_sha>...<new_sha>`
- Open “Blame” on a hotspot before refactors to understand coupling patterns.
- Attach failing Playwright screenshots/videos from Actions artifacts instead of only pasting text logs.

### Good PR Description Pattern
```md
## What changed
- ...

## Why
- ...

## Risk / regression surface
- ...

## Validation
- npm run ci
- npm run test:e2e
```

</details>

## Project Layout
- `forgeos-ui.tsx`: stable app export entry (re-exports `src/ForgeOS.tsx`)
- `src/ForgeOS.tsx`: root shell/topbar + view routing
- `src/components/ui/*`: base UI primitives (`Card`, `Btn`, `Inp`, etc.)
- `src/components/WalletGate.tsx`: wallet connect gate (Kasware/Kaspium/demo)
- `src/components/SigningModal.tsx`: signing confirmation modal
- `src/components/wizard/*`: agent setup/deploy flow
- `src/components/dashboard/*`: dashboard panels and core runtime UI
- `src/api/kaspaApi.ts`: Kaspa API calls
- `src/wallet/WalletAdapter.ts`: wallet mechanics (Kasware + Kaspium + Kastle + Ghost Wallet)
- `src/wallet/walletCapabilityRegistry.ts`: wallet capability registry + UI metadata (classes/capabilities/multi-output hints)
- `src/quant/runQuantEngine.ts`: AI decision call + strict JSON parse
- `src/log/seedLog.ts`: seeded log data + log colors
- `src/constants.ts`, `src/tokens.ts`, `src/helpers.ts`: constants/design/helpers

## Prerequisites
- Node.js 18+
- npm 9+
- Optional: Kasware extension installed and unlocked
- Optional: Kaspium mobile wallet

## Local Run
```bash
npm install
npm run dev
```

Open the URL printed by Vite (usually `http://localhost:5173`).

## Build and Preview
```bash
npm run build
npm run preview
```

## Pipeline Load Test (Scheduler + Callback Consumer + Tx Builder)
```bash
npm run load:pipeline
```

Optional tuning knobs:
```bash
LOAD_PIPELINE_AGENTS=24 LOAD_PIPELINE_TICKS=24 LOAD_PIPELINE_RECEIPTS=80 LOAD_PIPELINE_TX_BUILDS=40 LOAD_PIPELINE_CONCURRENCY=8 npm run load:pipeline
```

Optional Redis-backed path exercise (Lua queue/idempotency paths):
```bash
LOAD_PIPELINE_SCHEDULER_REDIS_URL=redis://127.0.0.1:6379 LOAD_PIPELINE_CALLBACK_REDIS_URL=redis://127.0.0.1:6379 npm run load:pipeline
```

Optional threshold assertions (fail harness on latency/error regressions):
```bash
LOAD_PIPELINE_MAX_TOTAL_ERRORS=0 LOAD_PIPELINE_MAX_ERROR_RATE_PCT=1 LOAD_PIPELINE_MAX_P95_SCHEDULER_TICK_MS=750 LOAD_PIPELINE_MAX_P95_RECEIPT_POST_MS=250 LOAD_PIPELINE_MAX_P95_TX_BUILDER_MS=2500 npm run load:pipeline
```

Tx-builder policy benchmarking (synthetic UTXO shapes / output counts):
```bash
npm run bench:tx-policy
TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_MODE=adaptive TX_POLICY_BENCH_CONFIRM_P95_MS=42000 TX_POLICY_BENCH_DAA_CONGESTION_PCT=85 npm run bench:tx-policy
```

Nightly CI load profile uses the same harness with Redis enabled (see `.github/workflows/nightly-load.yml`).

<details>
<summary><strong>Load Harness SLO Debug Tips (GitHub Actions + Local)</strong></summary>

- Start with a small local profile and thresholds, then move to Redis-backed CI.
- If `saturation` fails first, increase capacity only after confirming callback duplicate/stale fence counters remain `0`.
- Keep separate thresholds for:
  - local smoke
  - CI Redis smoke
  - nightly load
- Prefer trend comparison over a single run when tuning tx-builder p95.

</details>

## Domain Validation
```bash
npm run domain:check
```

## Domain Watch Mode
```bash
npm run domain:watch
```

Optional watch overrides:
```bash
DOMAIN_WATCH_INTERVAL_MINUTES=5 DOMAIN_WATCH_MAX_CHECKS=48 npm run domain:watch
```

Production assets are generated in `dist/`.

## Environment Variables
Defined in `.env.example`.

Kaspa network:
- `VITE_KAS_API_MAINNET`
- `VITE_KAS_API_TESTNET`
- `VITE_KAS_API_FALLBACKS_MAINNET` (comma-separated backup endpoints)
- `VITE_KAS_API_FALLBACKS_TESTNET` (comma-separated backup endpoints)
- `VITE_KAS_EXPLORER_MAINNET`
- `VITE_KAS_EXPLORER_TESTNET`
- `VITE_KAS_WS_URL_MAINNET`
- `VITE_KAS_WS_URL_TESTNET`
- `VITE_KAS_API`
- `VITE_KAS_API_FALLBACKS` (comma-separated backup endpoints)
- `VITE_KAS_EXPLORER`
- `VITE_KAS_NETWORK`
- `VITE_KAS_NETWORK_LABEL`
- `VITE_KAS_WS_URL`
- `VITE_KASPIUM_DEEP_LINK_SCHEME`
- `VITE_KAS_ENFORCE_WALLET_NETWORK`
- `VITE_ACCUMULATE_ONLY`
- `VITE_TREASURY_ADDRESS_MAINNET`
- `VITE_TREASURY_ADDRESS_TESTNET`
- `VITE_ACCUMULATION_ADDRESS_MAINNET`
- `VITE_ACCUMULATION_ADDRESS_TESTNET`
- `VITE_FEE_RATE`
- `VITE_TREASURY_SPLIT`
- `SCHEDULER_AUTH_TOKEN` / `SCHEDULER_AUTH_TOKENS` (scheduler backend token auth)
- `SCHEDULER_AUTH_READS` (scheduler backend read protection toggle)
- `SCHEDULER_REDIS_URL` (scheduler Redis persistence + due-schedule backing)
- `SCHEDULER_REDIS_PREFIX`
- `SCHEDULER_SERVICE_TOKENS_JSON` (scoped service-token auth registry JSON)
- `SCHEDULER_JWT_HS256_SECRET` / `SCHEDULER_JWT_ISSUER` / `SCHEDULER_JWT_AUDIENCE` (HS256 JWT auth + claim checks)
- `SCHEDULER_OIDC_ISSUER` / `SCHEDULER_OIDC_DISCOVERY_TTL_MS` (OIDC discovery -> `jwks_uri`)
- `SCHEDULER_JWKS_URL` / `SCHEDULER_JWKS_CACHE_TTL_MS` (OIDC/JWKS JWT validation cache)
- `SCHEDULER_AUTH_HTTP_TIMEOUT_MS` (OIDC/JWKS auth fetch timeout)
- `SCHEDULER_JWKS_ALLOWED_KIDS` / `SCHEDULER_JWKS_REQUIRE_PINNED_KID` (JWKS key pinning / rotation policy)
- `SCHEDULER_QUOTA_WINDOW_MS`, `SCHEDULER_QUOTA_READ_MAX`, `SCHEDULER_QUOTA_WRITE_MAX`, `SCHEDULER_QUOTA_TICK_MAX`
- `SCHEDULER_REDIS_AUTHORITATIVE_QUEUE` (Redis due-schedule + leader-lock mode)
- `SCHEDULER_REDIS_RESET_EXEC_QUEUE_ON_BOOT` (legacy reset behavior; defaults false for cold-start recovery)
- `SCHEDULER_REDIS_EXEC_LEASE_TTL_MS`, `SCHEDULER_REDIS_EXEC_REQUEUE_BATCH` (Redis execution queue lease/requeue tuning)
- `SCHEDULER_CALLBACK_IDEMPOTENCY_TTL_MS` (callback dedupe/idempotency retention)
- `SCHEDULER_LEADER_LOCK_RENEW_JITTER_MS`, `SCHEDULER_LEADER_ACQUIRE_BACKOFF_MIN_MS`, `SCHEDULER_LEADER_ACQUIRE_BACKOFF_MAX_MS` (leader fencing lock behavior)
- `VITE_KASTLE_TX_BUILDER_URL` / `VITE_KASTLE_TX_BUILDER_TOKEN` / `VITE_KASTLE_TX_BUILDER_TIMEOUT_MS` (automatic Kastle txJson builder endpoint)
- `VITE_KASTLE_TX_BUILDER_STRICT` (fail instead of fallback on builder error)
- `VITE_EXECUTION_RECEIPT_IMPORT_ENABLED` / `VITE_EXECUTION_RECEIPT_API_URL` / `VITE_EXECUTION_RECEIPT_API_TOKEN` / `VITE_EXECUTION_RECEIPT_API_TIMEOUT_MS` (backend receipt import for UI queue + attribution)
- `VITE_EXECUTION_RECEIPT_SSE_ENABLED` / `VITE_EXECUTION_RECEIPT_SSE_URL` / `VITE_EXECUTION_RECEIPT_SSE_REPLAY` / `VITE_EXECUTION_RECEIPT_SSE_REPLAY_LIMIT` (backend receipt SSE import path)
- `VITE_PNL_REALIZED_MIN_CONFIRMATIONS` (minimum confirmations before counting execution as realized in PnL)
- `VITE_PNL_REALIZED_CONFIRMATION_POLICY_JSON` (tiered confirmation floor policy by action/risk/amount for realized PnL accounting)
- `VITE_RECEIPT_CONSISTENCY_DEGRADE_*` (downgrade realized attribution / optionally block auto-approve when backend-vs-chain receipt mismatch rate is high)
- `VITE_CALIBRATION_*` guardrail vars (calibration-based ACCUMULATE sizing reduction + auto-approve disable thresholds)
- `VITE_DECISION_AUDIT_SIGNER_URL` / `VITE_DECISION_AUDIT_SIGNER_TOKEN` / `VITE_DECISION_AUDIT_SIGNER_TIMEOUT_MS` / `VITE_DECISION_AUDIT_SIGNER_REQUIRED` (server-side cryptographic audit signing)
- `VITE_DECISION_AUDIT_SIGNER_PUBLIC_KEY_URL` / `VITE_DECISION_AUDIT_SIGNER_PUBLIC_KEY_CACHE_TTL_MS` / `VITE_DECISION_AUDIT_SIGNER_PINNED_FINGERPRINTS` / `VITE_DECISION_AUDIT_SIGNER_REQUIRE_PINNED` (UI-side signature verification + key pinning for decision audit records)
- `TX_BUILDER_LOCAL_WASM_ENABLED`, `TX_BUILDER_LOCAL_WASM_JSON_KIND`, `TX_BUILDER_KAS_API_MAINNET`, `TX_BUILDER_KAS_API_TESTNET` (local tx-builder mode)
- `TX_BUILDER_LOCAL_WASM_COIN_SELECTION`, `TX_BUILDER_LOCAL_WASM_MAX_INPUTS`, `TX_BUILDER_LOCAL_WASM_ESTIMATED_NETWORK_FEE_SOMPI`, `TX_BUILDER_LOCAL_WASM_PER_INPUT_FEE_BUFFER_SOMPI`, `TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_MODE`, `TX_BUILDER_LOCAL_WASM_PRIORITY_FEE_*` (local fee/coin-selection policy)
- `TX_BUILDER_CALLBACK_CONSUMER_SUMMARY_URL` / `TX_BUILDER_SCHEDULER_SUMMARY_URL` / `TX_BUILDER_TELEMETRY_SUMMARY_*` (adaptive fee telemetry auto-feed from backend summaries)
- `KASTLE_TX_BUILDER_COMMAND_UPSTREAM_URL` / `KASTLE_TX_BUILDER_COMMAND_UPSTREAM_TOKEN` (bundled `TX_BUILDER_COMMAND` HTTP bridge helper)
- `CALLBACK_CONSUMER_*` (reference downstream callback consumer + receipt ingestion starter)
- `AUDIT_SIGNER_*` (reference decision audit signer service; local-key or HSM/KMS command mode, optional hash-chained append-only JSONL audit export via `AUDIT_SIGNER_APPEND_LOG_PATH`)

Audit log verification:
```bash
npm run audit-log:verify -- --file ./forgeos-audit.jsonl --strict-signatures
```

Load harness / SLO tuning:
- `LOAD_PIPELINE_SCHEDULER_INSTANCES` (set `2` with Redis URLs to exercise multi-instance leader/fencing behavior)
- `LOAD_PIPELINE_MAX_CALLBACK_DUPLICATE_EVENTS` / `LOAD_PIPELINE_MAX_CALLBACK_STALE_FENCE_EVENTS` (multi-instance callback safety SLOs)
- `CALIBRATION_SLO_MAX_BRIER`, `CALIBRATION_SLO_MAX_EV_CAL_ERROR_PCT`, `CALIBRATION_SLO_MIN_REGIME_HIT_RATE_PCT`, `CALIBRATION_SLO_MIN_REGIME_HIT_SAMPLES` (replay calibration regression SLO test thresholds)
- Prometheus/Grafana ops files:
  - `ops/grafana/forgeos-operator-overview.json`
  - `ops/prometheus/forgeos-recording-rules.yml`
  - `ops/prometheus/forgeos-alert-rules.yml`

AI engine:
- `VITE_AI_API_URL` (default: Anthropic Messages API)
- `VITE_AI_MODEL`
- `VITE_ANTHROPIC_API_KEY` (required when calling Anthropic directly)
- `VITE_AI_FALLBACK_ENABLED` (`true` by default; deterministic conservative fallback if upstream AI is unavailable)
- `VITE_AI_OVERLAY_MODE` (`always` default; `adaptive` for scale/cost control, `off` disables overlay)
- `VITE_AI_OVERLAY_MIN_INTERVAL_MS` (AI overlay throttle per agent/state)
- `VITE_AI_OVERLAY_CACHE_TTL_MS` (cache reuse TTL for AI overlay)
- `VITE_AI_SOFT_TIMEOUT_MS` (soft AI timeout to protect cycle latency)
- `VITE_AI_MAX_ATTEMPTS` (retry attempts for transient AI transport/API failures)
- `VITE_QUANT_WORKER_ENABLED` (run quant+AI engine off main thread)
- `VITE_QUANT_WORKER_SOFT_TIMEOUT_MS` (worker timeout before fallback)

Monetization / quota:
- `VITE_FREE_CYCLES_PER_DAY` (free cycle limit, default `30`)
- `VITE_BILLING_UPGRADE_URL` (checkout URL used by billing panel CTA)
- `VITE_BILLING_CONTACT` (support label shown in billing panel)

Runtime override:
- Default profile is `VITE_KAS_NETWORK` (set to `mainnet` in `.env.example`).
- For production, configure network-scoped endpoint vars so runtime switching stays on the correct chain.
- Append `?network=mainnet` or `?network=testnet` to force a network profile without rebuilding.
- The app persists active selection in local storage key `forgeos.network`.

## How To Use
1. Launch app with `npm run dev`.
2. Connect wallet:
- `Kasware` for extension flow
- `Kastle` for extension flow
- `Ghost Wallet` for custom provider bridge flow
- `Tangem` for hardware bridge/manual txid flow
- `OneKey` for hardware bridge/manual txid flow
- `Kaspium` for mobile deep-link flow
- `Demo Mode` for UI simulation without extension
3. Create agent in Wizard:
- name, ROI target, capital per cycle, risk, execution mode
4. Deploy agent (sign step appears).
5. In Dashboard:
- `Overview`: status, KPIs, quick controls
- `Intelligence`: decision output and rationale
- `Queue`: pending/signed/rejected actions
- `Treasury`: fee routing and ledger
- `Wallet`: balances/UTXOs/withdraw workflow
- `Log`: full runtime events
- `Controls`: execution and risk toggles

## Wallet Mechanics
- `WalletAdapter.detect()` reports wallet support:
- `kasware` (extension)
- `kastle` (extension)
- `ghost` (provider bridge probe on connect)
- `tangem` (hardware bridge/manual txid)
- `onekey` (hardware bridge/manual txid)
- `kaspium` (deep-link flow)
- Kasware connect path:
- `requestAccounts()`
- `getNetwork()`
- strict network/profile match when `VITE_KAS_ENFORCE_WALLET_NETWORK=true`
- Kasware send path:
- `sendKaspa(toAddress, sompi)`
- Kastle send path:
- `sendKaspa(toAddress, sompi)`
- Kastle raw multi-output path (feature-flagged):
- `signAndBroadcastTx(networkId, txJson)` via adapter capability detection
- txJson can come from `VITE_KASTLE_TX_BUILDER_URL` (recommended), an injected builder bridge (`window.__FORGEOS_KASTLE_BUILD_TX_JSON__`), or manual operator paste prompt
- Ghost Wallet send path:
- provider `transact(outputs, fee?, inputs?)` bridge call (Forge.OS uses multi-output when treasury-combined send is supported/eligible)
- Tangem / OneKey send path:
- external sign/broadcast in hardware app/device with manual txid handoff back into Forge.OS
- Kaspium connect path:
- user enters address matching configured network prefixes
- adapter stores session with provider `kaspium`
- Kaspium send path:
- deep-link generated from `KASPIUM_DEEP_LINK_SCHEME` with `kaspa:` URI fallback
- app prompts user to paste broadcast `txid`
- `txid` format is validated before acceptance
- Demo mode:
- simulates transaction signatures/txids locally

## Execution Modes
- `manual`: every action requires signature
- `autonomous`: auto-signs actions below threshold; above threshold queues for manual sign
- `notify`: decisions generated, no execution broadcast
- `accumulate-only`: when `VITE_ACCUMULATE_ONLY=true`, non-accumulate actions are forced to hold
- safety override: when decision source is fallback, auto-approve is disabled for that cycle and manual sign path is required

## Fee Routing
Defined in `src/constants.ts`:
- `FEE_RATE` (env: `VITE_FEE_RATE`, default `0.20`)
- `TREASURY_SPLIT` (env: `VITE_TREASURY_SPLIT`, default `0.30`)
- `AGENT_SPLIT = 1 - TREASURY_SPLIT`
- Treasury and accumulation addresses are network-specific via env vars.

Dashboard logs and treasury panel display split accounting each cycle.

## AI Engine Notes
`src/quant/runQuantEngine.ts` supports a hybrid pattern:
- Deterministic local quant core (primary decision engine: features/regime/risk/Kelly)
- Optional real AI overlay (bounded by quant-core risk envelope; adaptive or always-on)

AI transport supports two patterns:
- Direct Anthropic call (`VITE_AI_API_URL` points to `api.anthropic.com`):
- requires `x-api-key` (`VITE_ANTHROPIC_API_KEY`)
- requires `anthropic-version` header
- Backend proxy call (`VITE_AI_API_URL` points to your server):
- app sends `{ prompt, agent, kasData }`
- server returns either `{ decision }` or direct decision JSON

Recommendation for production:
- Keep AI keys server-side.
- Route AI requests through backend proxy.
- Starter queue/rate-limit proxy example: `server/ai-proxy/index.mjs`
- Scheduler shared-cache + auth/JWT/JWKS/quotas/Redis-authoritative (due + execution queue) starter example: `server/scheduler/index.mjs`
- Kastle tx-builder starter example: `server/tx-builder/index.mjs`
- Callback consumer reference service (fence/idempotency + execution receipt ingestion): `server/callback-consumer/index.mjs`
- Audit signer reference service (cryptographic decision-audit signatures): `server/audit-signer/index.mjs`
- Keep decision sanitization enabled (default) and enforce wallet-side signing.
- For maximum AI involvement use `VITE_AI_OVERLAY_MODE=always`; for scale/cost control use `adaptive`.
- For strict real-AI-only operation, also set `VITE_AI_FALLBACK_ENABLED=false` (engine will error if AI transport is unavailable).

## Kaspa Data Sources
`src/api/kaspaApi.ts` uses:
- `GET /info/price`
- `GET /addresses/:address/balance`
- `GET /addresses/:address/utxos`
- `GET /info/blockdag`

On failure, dashboard falls back to simulated DAG data so UI remains usable.

## CI Validation
Workflow: `.github/workflows/ci.yml`

Runs on push/PR and enforces:
- `npm run typecheck`
- `npm run build`
- `npm run smoke`

## GitHub Pages Deployment
Workflow: `.github/workflows/deploy-pages.yml`

Behavior:
- Builds on `main` pushes.
- Base path auto-mode:
- if `public/CNAME` exists, use root base path (`/`)
- otherwise use project base path (`/${{ github.event.repository.name }}/`)
- Adds `.nojekyll` to `dist/`.
- Publishes artifact with `actions/deploy-pages`.

Expected URL for current user/repo:
- `https://gryszzz.github.io/Forge.OS/`

## Go-Live Checklist
1. Set GitHub Actions repository variables for all `VITE_KAS_*` values.
2. Set a production websocket endpoint for `VITE_KAS_WS_URL`.
3. Point `VITE_AI_API_URL` to backend proxy.
4. Keep `VITE_ANTHROPIC_API_KEY` out of public client deployments whenever possible.
5. Verify pages build and deploy are green in GitHub Actions.
6. Validate wallet flows on production URL:
- Kasware connect/sign
- Kaspium deep-link + txid handoff
7. Run final checks:
```bash
npm run build
npm run preview
npm run domain:check
```

## Release / Packaging
A release template exists at:
- `GITHUB_RELEASE_TEMPLATE.md`

Typical flow:
```bash
npm run build
zip -r forgeos-vX.Y.Z-dist.zip dist
```

Then create GitHub release and attach:
- `forgeos-vX.Y.Z-dist.zip`

## Troubleshooting
- App does not start:
- verify Node version (`node -v`)
- run `npm install` again
- Kasware not detected:
- install/unlock extension, refresh page
- Kaspium send not opening wallet:
- verify mobile deep-link support and `KASPIUM_DEEP_LINK_SCHEME`
- AI errors in Intelligence panel:
- confirm `VITE_AI_API_URL` + auth/proxy configuration
- Build warning about chunk size:
- non-blocking for now; optimize later with code-splitting
- GitHub Pages `InvalidDNSError`:
- use `docs/ops/custom-domain.md` and verify delegation/records with `npm run domain:check`

## Troubleshooting By Symptom (Contributor Fast Map)

| Symptom | Likely Surface | Fastest Check |
| --- | --- | --- |
| Wallet adapter breaks only one provider | `src/wallet/WalletAdapter.ts` provider branch | Run wallet adapter tests + inspect provider-specific path |
| Queue truth badge looks wrong | `useExecutionQueue` receipt lifecycle merge | Check queue item `receipt_*` fields and provenance source |
| PnL “realized” feels too optimistic | `pnlAttribution` + confirmation policy | Check `VITE_PNL_REALIZED_*` and consistency degradation policy |
| Scheduler works locally but duplicates under scale | leader lock / callback fence | Run Redis scheduler integration tests and callback-consumer metrics |
| E2E fails after UI copy/layout change | brittle selectors | Update Playwright selectors to `data-testid` or resilient labels |
| Build is green but Pages is stale | deploy artifact mismatch | `npm run domain:check` + inspect live `manifest.json` entry hash |

## Security Notes
- Private keys are not handled by this app directly.
- Signing is delegated to wallet provider UI.
- For production, move external AI API calls server-side and store secrets in backend env vars.


## Kaspa Ecosystem References
- `https://github.com/K-Kluster/kaspa-js/`
- `https://github.com/kaspanet/silverscript`
- `https://kaspa.stream/`
- `https://kaspa.org/kaspium-v1-0-1-release/`
- `https://kasware.xyz`
