---
name: gortex-access-loadmockconfig
description: "Work in the access · loadMockConfig area — 8 symbols across 1 files (100% cohesion)"
---

# access · loadMockConfig

8 symbols | 1 files | 100% cohesion

## When to Use

Use this skill when working on files in:
- `src/access/config.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/access/config.ts` | port, MockConfig, tokenAllowlist, replaySpeed, replayMode, ... |

## Entry Points

- `src/access/config.ts::loadMockConfig`

## How to Explore

```
get_communities with id: "community-6"
smart_context with task: "understand access · loadMockConfig", format: "gcx"
find_usages with id: "src/access/config.ts::loadMockConfig", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
