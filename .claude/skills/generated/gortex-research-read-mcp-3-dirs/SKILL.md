---
name: gortex-research-read-mcp-3-dirs
description: "Work in the research-read/mcp +3 dirs area — 20 symbols across 6 files (91% cohesion)"
---

# research-read/mcp +3 dirs

20 symbols | 6 files | 91% cohesion

## When to Use

Use this skill when working on files in:
- `src/contract/research-read/dto.ts`
- `src/contract/research-read/mcp/dto.ts`
- `src/research-read/capabilities.ts`
- `src/research-read/mcp/errors.ts`
- `src/research-read/mcp/projections.ts`
- `src/research-read/mcp/server.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/contract/research-read/dto.ts` | ResearchCapabilityDescriptor |
| `src/contract/research-read/mcp/dto.ts` | ListDatasetsResult, GatewayFailure |
| `src/research-read/capabilities.ts` | researchCapabilities |
| `src/research-read/mcp/errors.ts` | backtestUnavailable |
| `src/research-read/mcp/projections.ts` | listDatasets, discoverDescriptor |
| `src/research-read/mcp/server.ts` | ctx, McpToolResult, a, args, ctx, ... |

## Entry Points

- `src/research-read/mcp/server.ts::dispatchTool`
- `src/research-read/mcp/server.ts::buildResearchServer`

## Connected Communities

- **research-read/mcp +1 dirs** (4 cross-edges)

## How to Explore

```
get_communities with id: "community-24"
smart_context with task: "understand research-read/mcp +3 dirs", format: "gcx"
find_usages with id: "src/research-read/mcp/server.ts::dispatchTool", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
