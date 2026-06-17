---
name: gortex-research-read-mcp
description: "Work in the research-read/mcp area — 11 symbols across 2 files (100% cohesion)"
---

# research-read/mcp

11 symbols | 2 files | 100% cohesion

## When to Use

Use this skill when working on files in:
- `test/research-read/mcp/integration.test.ts`
- `test/research-read/mcp/server.test.ts`

## Key Files

| File | Symbols |
|------|---------|
| `test/research-read/mcp/integration.test.ts` | parseToolResult, res, name, callTool, content, ... |
| `test/research-read/mcp/server.test.ts` | parse, res |

## How to Explore

```
get_communities with id: "community-33"
smart_context with task: "understand research-read/mcp", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
