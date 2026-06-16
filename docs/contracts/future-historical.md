# Future Historical Data Seam — Design Only

> **Status: DESIGN ONLY — not implemented in this repo.**
>
> This document records the intended seam for a future `/historical/*` adapter so that
> the design is captured before implementation begins. No historical endpoints exist in
> the current codebase. Do not add any `/historical/*` routes, backtest execution, or
> dataset lifecycle management here.

---

## Context and constraint

`trading-mock-platform` is a **read-only snapshot mirror**. It does not execute trades,
run backtests, or manage any mutable state. Backtest and hypothesis execution belong to
the future separate `trading-backtester` service.

The current Research Read surface (Surface B) exposes read-only views of existing bot
results from the snapshot — `listBotResults`, `getRunSummary`, `listTrades`,
`listDecisions`, `getAnalysisContext`. Every mutating or backtest tool is listed as
`unavailable` with reason `backtesting_moved_to_trading_backtester`.

---

## Intended future seam: `/historical/discover`

When a historical data surface is added to this mock (to support `trading-backtester`
requesting bar/tick data for its own use), the entry point is:

```
GET /historical/discover
```

This follows the same pattern as `/ops/discover`: it returns a capability descriptor
listing which datasets are available in the current snapshot, what time ranges they
cover, and what request parameters they accept. It does NOT initiate any computation.

---

## Dataset request and export lifecycle (design sketch)

The historical surface is intended to be a **read-only pull interface** — the backtester
requests data and the mock serves it from the snapshot bundle. The lifecycle:

1. **Discovery** — `GET /historical/discover` returns available datasets (symbols, kinds,
   time ranges) from the snapshot's market-bar/tick sections (not yet present in the
   `SnapshotBundle` schema).

2. **Synchronous fetch (small ranges)** — `GET /historical/bars?symbol=...&from=...&to=...`
   returns a paginated `PageEnvelope<BarRecord>` directly, for datasets that fit in a
   single HTTP response.

3. **Async export job (large ranges)** — `POST /historical/export` submits a dataset
   extraction request and returns a job ID. `GET /historical/export/:id` polls status;
   when `status: "ready"`, a download URL or streaming endpoint is provided. The mock
   never writes to the backtester's job store — it only serves the data.

---

## Async job boundary

The mock is responsible for serving historical data; the backtester is responsible for
its own job lifecycle (submission, status tracking, result storage). Specifically:

- The mock does NOT store backtest run state, parameters, or results.
- The mock does NOT call back into the backtester.
- If the backtester crashes mid-download, it re-requests from the mock — the mock is
  stateless with respect to any given request.
- The async export job (step 3 above) is internal to the mock: it tracks its own
  preparation state (e.g. serializing a large Parquet slice), not the backtester's
  hypothesis lifecycle.

---

## Contract layer isolation

The `src/contract/**` layer is import-clean and extractable — it imports nothing from
outside `src/contract/` and no npm packages. Adding a `/historical/*` adapter follows
the same pattern:

- Define `src/contract/historical/dto.ts` (bar/tick shapes, dataset descriptor).
- Define `src/contract/historical/version.ts` (`historical.1`).
- Add to `src/contract/index.ts`.
- Add `src/snapshot/readers/historical.ts` (reads `bundle.historicalByDataset` once
  that key is added to `SnapshotBundle`).
- Add `src/ops/handlers/historical.ts` (or a separate `src/historical/handlers/` dir).
- Wire into `src/http/app.ts`.

The Ops Read surface (`/ops/*`) is entirely unaffected — the contract layer's isolation
guarantee means historical code cannot accidentally import into Ops Read handlers.

---

## What this repo will never do

Even after the `/historical/*` adapter is added:

- It will NOT submit backtest runs to any system.
- It will NOT store backtest results, metrics, or parameters.
- It will NOT contact any exchange or live data feed.
- It will NOT run any market simulation or replay-as-backtest logic.
- Backtesting lifecycle (`submitOverlayRun`, `validateModule`, `getBacktestResult`)
  remains `unavailable` with reason `backtesting_moved_to_trading_backtester`.
