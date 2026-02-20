# Forge.OS

ForgeOS is a Kaspa-focused, wallet-native AI trading dashboard.

It provides:
- Wallet-gated access (Kasware, Kaspium, or demo mode)
- Saved Kaspium address memory scoped by active network profile
- Agent setup wizard
- AI decision panel (risk/confidence-based)
- Runtime network profile switcher (mainnet/testnet) from topbar
- Action queue with signing workflow
- Treasury fee split visibility
- Wallet and UTXO operations panel
- Accumulate-only execution mode (buy/stack discipline)
- Runtime mainnet/testnet profile switching (`?network=mainnet|testnet`)
- Dual-mode bootstrap: manifest-first in deployed environments, `/src/main.tsx` fallback for local dev

## Quick Start

### Prerequisites
- Node.js 18+
- npm 9+
- Optional: Kasware extension
- Optional: Kaspium mobile wallet

### Install
```bash
npm install
```

### Run (Development)
```bash
npm run dev
```

### Strict Validation
```bash
npm run ci
```

### Domain Config Guard
```bash
npm run verify:domain
```

### Domain Health Check
```bash
npm run domain:check
```

### Domain Auto-Watch
```bash
npm run domain:watch
```

### Build (Production)
```bash
npm run build
```

### Preview Build
```bash
npm run preview
```

## Environment
Create a `.env` file from `.env.example` and set values for your target environment.

Core Kaspa settings:
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

AI settings:
- `VITE_AI_API_URL`
- `VITE_AI_MODEL`
- `VITE_ANTHROPIC_API_KEY` (only if calling Anthropic directly from browser)
- `VITE_AI_FALLBACK_ENABLED` (default `true`, uses conservative deterministic fallback when AI endpoint is unavailable)

Monetization settings:
- `VITE_FREE_CYCLES_PER_DAY` (default `30`)
- `VITE_BILLING_UPGRADE_URL` (hosted checkout or subscription URL)
- `VITE_BILLING_CONTACT` (support/contact string shown in billing panel)
- `VITE_AUTO_CYCLE_SECONDS` (default `120`, minimum `15`)
- `VITE_LIVE_EXECUTION_DEFAULT` (`false` recommended for safe boot)

Runtime reliability defaults:
- WebSocket stream auto-reconnect with exponential backoff (dashboard shows retry state)
- Fallback decisions are clearly tagged in UI (`SOURCE FALLBACK`)
- Auto-approve is disabled on fallback decisions (manual sign path only)
- Daily free-cycle quota enforced at runtime; billing tab prompts upgrade when quota is exhausted
- Automatic cycle scheduler runs while agent status is `RUNNING`
- Live execution requires explicit arming in UI and readiness checks (real wallet + DAG live feed)
- Build-time hashed asset references with strict smoke validation over manifest import graph and dynamic chunk links

## Mainnet/Testnet Runtime Switch
- Default profile comes from `VITE_KAS_NETWORK`.
- You can override at runtime:
  - `https://<host>/?network=mainnet`
  - `https://<host>/?network=testnet`
- The app stores the active profile in browser local storage (`forgeos.network`).
- Wallet address validation, API/explorer defaults, treasury routing, and accumulation vault routing all follow the active profile.

## Production Readiness Checklist
1. Set repo-level Actions variables for all `VITE_KAS_*` values.
2. Configure `VITE_KAS_WS_URL` for real-time websocket feeds.
3. Configure `VITE_KAS_ENFORCE_WALLET_NETWORK=true` for strict wallet-network matching.
4. Configure network-specific treasury/vault addresses and fee split vars.
5. Use backend proxy for AI (`VITE_AI_API_URL`) to avoid exposing secrets.
6. Run `npm run ci` and ensure all workflows are green.
7. Validate wallet flows:
- Kasware connect/sign/send
- Kaspium deep-link + txid confirmation
8. Confirm GitHub Pages deploy succeeds and loads at:
- `https://gryszzz.github.io/Forge.OS/`

## Overnight Go-Live + Domain
1. Push to `main` to trigger deploy.
2. Domain is committed in `public/CNAME` (`forge-os.xyz`) and auto-copied into deploy artifacts.
3. In DNS provider, set records for root domain hosting on GitHub Pages:
- `A` -> `185.199.108.153`
- `A` -> `185.199.109.153`
- `A` -> `185.199.110.153`
- `A` -> `185.199.111.153`
- `AAAA` -> `2606:50c0:8000::153`
- `AAAA` -> `2606:50c0:8001::153`
- `AAAA` -> `2606:50c0:8002::153`
- `AAAA` -> `2606:50c0:8003::153`
4. Optional `www` support:
- `CNAME` `www` -> `gryszzz.github.io`
5. Keep repo variable `GH_PAGES_CNAME` either empty or exactly `forge-os.xyz` (workflow now prefers `public/CNAME` and warns on mismatch).
6. In GitHub repo Settings -> Pages, set Custom domain to `forge-os.xyz` and enable `Enforce HTTPS`.
7. Re-run `Deploy ForgeOS to GitHub Pages` workflow.
8. Verify:
- `https://gryszzz.github.io/Forge.OS/`
- `https://forge-os.xyz` (after DNS propagation)

If GitHub shows `InvalidDNSError`, use the runbook:
- `docs/ops/custom-domain.md`

## Core Docs
- Developer architecture: `README.dev.md`
- Kaspa raw links and resources: `docs/kaspa/links.md`
- AI researcher prompts: `docs/ai/kaspa-elite-engineer-mode.md`
- Custom domain operations: `docs/ops/custom-domain.md`
- Agent operating rules for this repo: `AGENTS.md`
