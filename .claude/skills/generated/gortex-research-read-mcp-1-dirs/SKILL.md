---
name: gortex-research-read-mcp-1-dirs
description: "Work in the research-read/mcp +1 dirs area — 28 symbols across 3 files (89% cohesion)"
---

# research-read/mcp +1 dirs

28 symbols | 3 files | 89% cohesion

## When to Use

Use this skill when working on files in:
- `src/contract/research-read/mcp/dto.ts`
- `src/research-read/mcp/errors.ts`
- `src/research-read/mcp/projections.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/contract/research-read/mcp/dto.ts` | GatewayErrorCategory, GatewayError, RunResultResult, RunStatus, RunStatusResult, ... |
| `src/research-read/mcp/errors.ts` | message, gatewayError, code, category |
| `src/research-read/mcp/projections.ts` | statusView, summary, status, status, research, ... |

## Entry Points

- `src/research-read/mcp/projections.ts::runResult`
- `src/research-read/mcp/projections.ts::runStatus`

## Connected Communities

- **contract/research-read +1 dirs** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-22"
smart_context with task: "understand research-read/mcp +1 dirs", format: "gcx"
find_usages with id: "src/research-read/mcp/projections.ts::runResult", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
