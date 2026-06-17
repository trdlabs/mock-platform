---
name: gortex-ops-paginate
description: "Work in the ops · paginate area — 16 symbols across 1 files (100% cohesion)"
---

# ops · paginate

16 symbols | 1 files | 100% cohesion

## When to Use

Use this skill when working on files in:
- `src/ops/pagination.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/ops/pagination.ts` | cursor, obj, encodeCursor, opts, lim, ... |

## Entry Points

- `src/ops/pagination.ts::paginate`

## How to Explore

```
get_communities with id: "community-21"
smart_context with task: "understand ops · paginate", format: "gcx"
find_usages with id: "src/ops/pagination.ts::paginate", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
