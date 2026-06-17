---
name: gortex-scripts-extof
description: "Work in the scripts · extOf area — 9 symbols across 1 files (100% cohesion)"
---

# scripts · extOf

9 symbols | 1 files | 100% cohesion

## When to Use

Use this skill when working on files in:
- `scripts/verify_no_secrets.ts`

## Key Files

| File | Symbols |
|------|---------|
| `scripts/verify_no_secrets.ts` | path, basename, i, p, extOf, ... |

## Entry Points

- `scripts/verify_no_secrets.ts::inScope`

## How to Explore

```
get_communities with id: "community-1"
smart_context with task: "understand scripts · extOf", format: "gcx"
find_usages with id: "scripts/verify_no_secrets.ts::inScope", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
