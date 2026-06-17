---
name: gortex-contract-research-read-1-dirs
description: "Work in the contract/research-read +1 dirs area — 11 symbols across 2 files (95% cohesion)"
---

# contract/research-read +1 dirs

11 symbols | 2 files | 95% cohesion

## When to Use

Use this skill when working on files in:
- `src/contract/research-read/dto.ts`
- `src/research-read/mcp/projections.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/contract/research-read/dto.ts` | ResearchMetrics |
| `src/research-read/mcp/projections.ts` | mdd, toNum, s, n, pnl, ... |

## Entry Points

- `src/research-read/mcp/projections.ts::projectMetrics`

## How to Explore

```
get_communities with id: "community-23"
smart_context with task: "understand contract/research-read +1 dirs", format: "gcx"
find_usages with id: "src/research-read/mcp/projections.ts::projectMetrics", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
