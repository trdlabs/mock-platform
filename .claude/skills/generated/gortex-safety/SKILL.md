---
name: gortex-safety
description: "Work in the safety area — 9 symbols across 1 files (100% cohesion)"
---

# safety

9 symbols | 1 files | 100% cohesion

## When to Use

Use this skill when working on files in:
- `src/safety/secret-scan.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/safety/secret-scan.ts` | re, name, content, content, scanText, ... |

## Entry Points

- `src/safety/secret-scan.ts::scanForSecrets`

## How to Explore

```
get_communities with id: "community-25"
smart_context with task: "understand safety", format: "gcx"
find_usages with id: "src/safety/secret-scan.ts::scanForSecrets", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
