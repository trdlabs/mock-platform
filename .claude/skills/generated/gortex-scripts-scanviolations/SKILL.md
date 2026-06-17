---
name: gortex-scripts-scanviolations
description: "Work in the scripts · scanViolations area — 21 symbols across 1 files (100% cohesion)"
---

# scripts · scanViolations

21 symbols | 1 files | 100% cohesion

## When to Use

Use this skill when working on files in:
- `scripts/verify_contract_isolation.ts`

## Key Files

| File | Symbols |
|------|---------|
| `scripts/verify_contract_isolation.ts` | name, climbs, scanViolations, main, m, ... |

## Entry Points

- `scripts/verify_contract_isolation.ts::main`
- `scripts/verify_contract_isolation.ts::violationFor`
- `scripts/verify_contract_isolation.ts::walk`
- `scripts/verify_contract_isolation.ts::scanViolations`

## How to Explore

```
get_communities with id: "community-0"
smart_context with task: "understand scripts · scanViolations", format: "gcx"
find_usages with id: "scripts/verify_contract_isolation.ts::main", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
