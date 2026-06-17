---
name: gortex-ops-handlers
description: "Work in the ops/handlers area — 18 symbols across 1 files (96% cohesion)"
---

# ops/handlers

18 symbols | 1 files | 96% cohesion

## When to Use

Use this skill when working on files in:
- `src/ops/handlers/summary.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/ops/handlers/summary.ts` | bundle, t, reason, pnl, asOf, ... |

## Entry Points

- `src/ops/handlers/summary.ts::handleSummary`

## How to Explore

```
get_communities with id: "community-18"
smart_context with task: "understand ops/handlers", format: "gcx"
find_usages with id: "src/ops/handlers/summary.ts::handleSummary", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
