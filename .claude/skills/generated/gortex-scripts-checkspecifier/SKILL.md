---
name: gortex-scripts-checkspecifier
description: "Work in the scripts · checkSpecifier area — 12 symbols across 1 files (100% cohesion)"
---

# scripts · checkSpecifier

12 symbols | 1 files | 100% cohesion

## When to Use

Use this skill when working on files in:
- `scripts/verify_vendored_sdk.ts`

## Key Files

| File | Symbols |
|------|---------|
| `scripts/verify_vendored_sdk.ts` | errs, m, main, errs, e, ... |

## Entry Points

- `scripts/verify_vendored_sdk.ts::main`
- `scripts/verify_vendored_sdk.ts::checkSpecifier`

## How to Explore

```
get_communities with id: "community-3"
smart_context with task: "understand scripts · checkSpecifier", format: "gcx"
find_usages with id: "scripts/verify_vendored_sdk.ts::main", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
