---
name: gortex-ops-handlers-5-dirs
description: "Work in the ops/handlers +5 dirs area — 29 symbols across 9 files (89% cohesion)"
---

# ops/handlers +5 dirs

29 symbols | 9 files | 89% cohesion

## When to Use

Use this skill when working on files in:
- `src/contract/analysis/dto.ts`
- `src/contract/common/errors.ts`
- `src/contract/ops-read/dto.local.ts`
- `src/ops/handlers/analysis.ts`
- `src/ops/handlers/decisions.ts`
- `src/ops/handlers/events.ts`
- `src/ops/handlers/trades.ts`
- `src/ops/pagination.ts`
- `src/snapshot/readers/analysis.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/contract/analysis/dto.ts` | AnalysisSnapshot |
| `src/contract/common/errors.ts` | OpsError |
| `src/contract/ops-read/dto.local.ts` | DecisionsPage, TradesPage, EventsPage |
| `src/ops/handlers/analysis.ts` | runIdRaw, handleAnalysis, a, bundle, runId |
| `src/ops/handlers/decisions.ts` | asOf, handleDecisions, runId, bundle, cursor |
| `src/ops/handlers/events.ts` | asOf, cursor, bundle, runId, handleEvents |
| `src/ops/handlers/trades.ts` | asOf, bundle, runId, cursor, handleTrades |
| `src/ops/pagination.ts` | invalidCursor |
| `src/snapshot/readers/analysis.ts` | b, runId, readAnalysis |

## Entry Points

- `src/ops/handlers/trades.ts::handleTrades`
- `src/ops/handlers/decisions.ts::handleDecisions`
- `src/ops/handlers/events.ts::handleEvents`
- `src/ops/handlers/analysis.ts::handleAnalysis`

## How to Explore

```
get_communities with id: "community-20"
smart_context with task: "understand ops/handlers +5 dirs", format: "gcx"
find_usages with id: "src/ops/handlers/trades.ts::handleTrades", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
