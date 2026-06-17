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

## CI guard

Every PR to `main` (and every push to `main`) runs `.github/workflows/ci.yml` — two parallel jobs:

- **checks:** `pnpm check` (typecheck + contract-isolation + tests) → `pnpm verify:no-forbidden-deps` → `pnpm verify:no-secrets`
- **docker:** `docker build` (public deps only, no registry/private access)

What it enforces, automatically:
- types + tests (`pnpm check`)
- `src/contract/**` import isolation
- no secrets / forbidden patterns in committed data files (`.json`/`.parquet`/`.env`/… anywhere; `src`/`test`/`docs` and `.gitkeep` excluded)
- no private/forbidden dependencies — runtime `dependencies` allowlist + a denylist (`trading-platform`, `pg`, `ccxt`, exchange SDKs) across the lockfile + a ban on `file:`/`link:`/`git+`/`workspace:` specifiers
- the image builds with public deps only

Run all of it locally with `pnpm check:ci`.

**Manual operator step (one-time):** enable branch protection on `main` requiring the **`checks`** and **`docker`** status checks before merge (GitHub → Settings → Branches → Branch protection rules). CI cannot set this itself.

## Surface B — Research Read (trading-lab, stdio MCP gateway)

`trading-lab` reads the mock through its current MCP-over-stdio path — point it at the gateway with env only, no lab code change:

```
TRADING_PLATFORM_INTEGRATION=mcp
TRADING_PLATFORM_GATEWAY_COMMAND=docker
TRADING_PLATFORM_GATEWAY_ARGS=run -i --rm -e MOCK_SNAPSHOT_REF=fixtures/2026-06-16-synthetic trading-mock-platform:dev node dist/src/bin/start-research-mcp.js
# optional access control (sha256-hex allowlist; empty = spawn-trusted):
#   pass MOCK_RESEARCH_TOKENS (expected) into the container and MOCK_RESEARCH_TOKEN (raw) via the spawn env
```

The gateway speaks the MCP-031 contract (`017.2`): `discover_research_contract`, `list_datasets` (empty — historical datasets are the future `/historical` scope), `get_run_status`, `get_run_result` are served read-only from the snapshot; `validate_module` / `submit_run` / `cancel_run` return `{ok:false, error}` with reason `backtesting_moved_to_trading_backtester` — **no backtesting is implemented or faked here**. stdout carries JSON-RPC only; all logs/audit go to stderr. Backtest/hypothesis execution belongs to the future `trading-backtester`.
