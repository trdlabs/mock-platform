# 2026-06-18 — Full Mock Demo Stack Roadmap

## Goal

Bring the public/mock stack to the point where:

- `trading-office` consumes a realistic read-only ops surface
- `trading-lab` consumes live bot-results and can run a full research loop
- `trading-backtester` runs on mock historical data instead of private/live data sources
- the whole stack can be launched as one coherent demo/research environment

## Current state

### Already in place

- `trading-mock-platform` exposes the read-only ops surface needed by `trading-office`:
  - runs
  - trades
  - summary
  - events
  - decisions
  - health
  - coverage
  - discover
  - WS replay on `/ops/events`
- `trading-lab` already consumes live bot-results via `BotResultsReadPort`
- `trading-lab` already wires bot-results into the research cycle
- `trading-lab` already extends that seam with operational events and decision log

### Main remaining gap

The system is still missing a complete **historical-data path** for mock-backed backtests.

That gap is not in the existing ops surface. It is in the missing historical seam between:

- `trading-mock-platform` as the historical read source
- `trading-backtester` as the backtest executor
- `trading-lab` as the research orchestrator that depends on backtest results

## Guiding constraints

- `trading-mock-platform` remains read-only and snapshot-backed
- `trading-mock-platform` does not execute backtests and does not simulate live trading
- backtest execution stays in `trading-backtester`
- historical market data must be provided through a dedicated seam, not mixed into ops-read
- demo mode must degrade explicitly with capability-aware errors instead of hidden fallbacks

## Phase 008 — Historical Read Surface in `trading-mock-platform` ✅ DONE 2026-06-18

### Goal

Add a snapshot-backed, read-only historical data surface that can serve as the data source for `trading-backtester`.

### Scope

- define a historical contract and capability descriptor
- add snapshot readers and DTO projection for historical resources
- expose HTTP endpoints for historical reads
- add deterministic fixtures/snapshots for historical windows
- expose discover/capability information for the historical surface

### Minimum resources

- bars/candles
- funding
- open interest
- liquidations
- coverage / availability metadata

### Recommended behavior

- windowed reads by symbol / timeframe / interval
- pagination where needed
- explicit `unsupported` / `unavailable` semantics
- deterministic response ordering and timestamps

### Out of scope

- executing a backtest
- live data ingestion
- exchange simulation
- mutable state

### Done when

`trading-mock-platform` can act as a real historical read source for a mock-mode backtester.

### Delivered

- `src/contract/historical-read/` — dto.ts (OhlcvBar, FundingEntry, OpenInterestEntry, LiquidationEntry, coverage, discover types), version.ts (`historical.1`), index.ts
- `HistoricalBundle` added to `SnapshotBundle` (optional field, backward-compatible)
- AJV schema updated with `historicalBundle` def + nested $defs for all new record types
- Snapshot readers: `readers/bars.ts`, `readers/funding.ts`, `readers/openInterest.ts`, `readers/liquidations.ts`
- HTTP handlers: `historical/handlers/{bars,funding,openInterest,liquidations,coverage,discover}.ts`
- Routes: `GET /historical/discover`, `/historical/bars`, `/historical/funding`, `/historical/open-interest`, `/historical/liquidations`, `/historical/coverage`
- Fixture: BTCUSDT 1h+1d bars (72+7), funding (9), open interest (18), liquidations (20) in `ops/bundle.json`
- All gates green: typecheck, 115 tests, contract-isolation, no-forbidden-deps, no-secrets

## Phase 009 — Historical Client in `trading-backtester` ✅ DONE 2026-06-18

### Goal

Teach `trading-backtester` to fetch historical inputs from `trading-mock-platform` instead of private or live providers.

### Scope

- add a historical client / adapter
- add env-gated source selection for mock mode
- validate capabilities before execution
- return explicit unsupported / unavailable errors when required resources are absent
- add integration tests against the mock historical surface

### Out of scope

- `trading-lab` orchestration changes
- new backtest algorithms
- any new market-data authoring workflow

### Done when

`trading-backtester` can execute real sandbox backtests on historical data served by `trading-mock-platform`.

## Phase 010 — Wire `trading-lab` to the Mock-Backed Backtester ✅ DONE 2026-06-18

### Goal

Make the full research loop work in demo/research mode without private platform dependencies.

### Scope

- route `trading-lab` to the mock-backed `trading-backtester`
- add or refine environment profiles for demo/research mode
- validate the end-to-end path:
  - hypothesis
  - build
  - backtest
  - result ingestion
- make capability failures explicit in the lab UX / handler path

### Done when

`trading-lab` can run a complete research cycle using:

- mock ops data
- mock historical data
- mock-backed backtest execution

with no dependency on the private trading platform.

## Phase 011 — Unified Demo Stack

### Goal

Provide one coherent startup profile for the whole public/mock system.

### Scope

- compose/profile wiring for:
  - `trading-mock-platform`
  - `trading-backtester`
  - `trading-lab`
  - `trading-office`
- aligned env vars and service URLs
- smoke and e2e checks for the integrated stack
- operator documentation in Russian

### Done when

A documented startup path brings up the full stack and proves that:

- `trading-office` reads mock ops data
- `trading-lab` reads mock/live-bot-results from the mock stack
- `trading-lab` can request backtests
- `trading-backtester` reads historical inputs from `trading-mock-platform`

## Recommended execution order

1. Phase 008 — historical read surface in `trading-mock-platform`
2. Phase 009 — historical client in `trading-backtester` ✅
3. Phase 010 — lab wiring to the mock-backed backtester
4. Phase 011 — unified demo stack

## Why this order

- the ops surface is already in comparatively good shape
- `trading-lab` bot-results consumption is already in place
- the blocking architectural gap is the absence of a mock-backed historical data path
- wiring `trading-lab` before historical data exists would create integration work without a usable backtest source

## Non-goals

- adding live execution
- moving backtest logic into `trading-mock-platform`
- turning the mock platform into a stateful trading simulator
- expanding ops-read further before the historical seam exists
