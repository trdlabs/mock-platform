# trading-mock-platform

Standalone, read-only, snapshot-backed mock of the **read surfaces** of the private `trading-platform`.
Lets `trading-office` (and, in a later increment, `trading-lab`) run in demo/course/research environments
without the private live platform, exchanges, credentials, prod DB, or VPS.

## Surfaces
- **Surface A — Ops Read** (consumer: trading-office): HTTP GET (`ops.3` parity) + WS `/ops/events` replay,
  plus Tier-2 `/ops/runs/:id/analysis` (`ops.4`, capability-aware).
- **Surface B — Research Read** (consumer: trading-lab): contract + snapshot→DTO adapter + read-only
  capability descriptor. Transport (MCP/HTTP) is a future increment — this feature ships the seam only.

It does NOT execute or simulate trading or backtesting, hold credentials, reach an exchange/prod DB, or
ingest live data. Backtest/hypothesis execution belongs to the future separate `trading-backtester`.

## Run
```bash
cp .env.example .env
pnpm install && pnpm build
MOCK_SNAPSHOT_REF=fixtures/2026-06-16-synthetic pnpm start
curl -s localhost:8839/ops/discover
```

## Point trading-office at the mock (no code change)
```
OFFICE_CONNECTOR_MODE=trading-lab
OFFICE_PLATFORM_ENABLED=true
TRADING_PLATFORM_READ_URL=http://localhost:8839
TRADING_PLATFORM_READ_TOKEN=<non-empty>
```

## Consumers (framing)
- trading-office = direct Ops Read HTTP consumer.
- trading-lab = platform bot-results/research-read consumer via the current SDK/MCP path (mock integration deferred here).
- trading-backtester = future separate executor for hypothesis/backtest lifecycle.

## Safety
Read-only; sha256-hashed token allowlist; loopback by default; fail-closed if bound non-loopback without a token.
Snapshots are verified on load (manifest + checksums + version-compat + secret-scan). The exporter/sanitizer
runs operator-side near the private platform and is out of scope here — see `docs/contracts/`.
