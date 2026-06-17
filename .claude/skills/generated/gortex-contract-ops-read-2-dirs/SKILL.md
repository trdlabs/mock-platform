---
name: gortex-contract-ops-read-2-dirs
description: "Work in the contract/ops-read +2 dirs area — 10 symbols across 3 files (85% cohesion)"
---

# contract/ops-read +2 dirs

10 symbols | 3 files | 85% cohesion

## When to Use

Use this skill when working on files in:
- `src/contract/ops-read/dto.local.ts`
- `src/ops/handlers/runs.ts`
- `src/snapshot/readers/runs.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/contract/ops-read/dto.local.ts` | RunsPage |
| `src/ops/handlers/runs.ts` | handleRuns, asOf, cursor, bundle, filter |
| `src/snapshot/readers/runs.ts` | f, readRuns, bundle, RunsFilter |

## Entry Points

- `src/ops/handlers/runs.ts::handleRuns`
- `src/snapshot/readers/runs.ts::readRuns`

## How to Explore

```
get_communities with id: "community-29"
smart_context with task: "understand contract/ops-read +2 dirs", format: "gcx"
find_usages with id: "src/ops/handlers/runs.ts::handleRuns", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
