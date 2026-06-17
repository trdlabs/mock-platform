---
name: gortex-snapshot-readers-4-dirs
description: "Work in the snapshot/readers +4 dirs area — 36 symbols across 10 files (82% cohesion)"
---

# snapshot/readers +4 dirs

36 symbols | 10 files | 82% cohesion

## When to Use

Use this skill when working on files in:
- `src/contract/ops-read/dto.local.ts`
- `src/contract/snapshot/bundle.ts`
- `src/events/replay.ts`
- `src/ops/handlers/coverage.ts`
- `src/ops/handlers/health.ts`
- `src/snapshot/readers/coverage.ts`
- `src/snapshot/readers/decisions.ts`
- `src/snapshot/readers/events.ts`
- `src/snapshot/readers/health.ts`
- `src/snapshot/readers/trades.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/contract/ops-read/dto.local.ts` | RuntimeHealthCollection, MarketServiceHealthSnapshot, SourceCoverageSnapshot, ExecutionHealthSnapshot |
| `src/contract/snapshot/bundle.ts` | SnapshotBundle |
| `src/events/replay.ts` | bundle, bundle |
| `src/ops/handlers/coverage.ts` | kind, source, b, handleCoverage |
| `src/ops/handlers/health.ts` | b, b, handleRuntimeHealth, handleMarketHealth, handleExecutionHealth, ... |
| `src/snapshot/readers/coverage.ts` | readCoverage, kind, source, b |
| `src/snapshot/readers/decisions.ts` | runId, readDecisions, bundle |
| `src/snapshot/readers/events.ts` | bundle, readEvents, runId |
| `src/snapshot/readers/health.ts` | readRuntimeHealth, b, readExecutionHealth, b, readMarketHealth, ... |
| `src/snapshot/readers/trades.ts` | runId, bundle, readTrades |

## Entry Points

- `src/ops/handlers/health.ts::handleMarketHealth`
- `src/ops/handlers/coverage.ts::handleCoverage`
- `src/ops/handlers/health.ts::handleExecutionHealth`
- `src/ops/handlers/health.ts::handleRuntimeHealth`
- `src/snapshot/readers/coverage.ts::readCoverage`

## How to Explore

```
get_communities with id: "community-13"
smart_context with task: "understand snapshot/readers +4 dirs", format: "gcx"
find_usages with id: "src/ops/handlers/health.ts::handleMarketHealth", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
