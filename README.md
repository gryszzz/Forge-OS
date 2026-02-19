# Forge.OS

ForgeOS is a Kaspa-focused, wallet-native AI trading dashboard prototype.

It provides:
- Wallet-gated access (Kasware or demo mode)
- Agent setup wizard
- AI decision panel (risk/confidence-based)
- Action queue with signing workflow
- Treasury fee split visibility
- Wallet and UTXO operations panel

## Quick Start

### Prerequisites
- Node.js 18+
- npm 9+
- Optional: Kasware extension

### Install
```bash
npm install
```

### Run (Development)
```bash
npm run dev
```

### Build (Production)
```bash
npm run build
```

### Preview Build
```bash
npm run preview
```

## How It Works
1. Connect wallet (Kasware or demo mode).
2. Configure and deploy an agent in the wizard.
3. Use Dashboard tabs:
- `Overview`: KPI/status summary
- `Intelligence`: latest quant decision output
- `Queue`: pending/signed/rejected actions
- `Treasury`: fee-routing and ledger
- `Wallet`: balances, UTXOs, withdrawals
- `Log`: event history
- `Controls`: execution/risk controls

## Important Notes
- Signing is wallet-native; keys are not stored by app code.
- AI endpoint calls may fail without backend auth/proxy wiring.
- Kaspa data calls have fallback simulation behavior for UI continuity.

## Release Packaging
```bash
npm run build
zip -r forgeos-vX.Y.Z-dist.zip dist
```

Use `GITHUB_RELEASE_TEMPLATE.md` when publishing a GitHub release.

## Developer Docs
For architecture and implementation details, see:
- `README.dev.md`
