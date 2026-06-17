---
name: gortex-snapshot-loadsnapshot
description: "Work in the snapshot · loadSnapshot area — 19 symbols across 3 files (93% cohesion)"
---

# snapshot · loadSnapshot

19 symbols | 3 files | 93% cohesion

## When to Use

Use this skill when working on files in:
- `src/snapshot/loader.ts`
- `src/snapshot/registry.ts`
- `src/snapshot/validate.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/snapshot/loader.ts` | bundle, manifestStr, expected, bundleStr, loadSnapshot, ... |
| `src/snapshot/registry.ts` | openSnapshot, rootDir, ref |
| `src/snapshot/validate.ts` | assertValidManifest, obj, obj, assertValidBundle |

## Entry Points

- `src/snapshot/loader.ts::loadSnapshot`
- `src/snapshot/registry.ts::openSnapshot`

## Connected Communities

- **contract/snapshot +1 dirs** (1 cross-edges)
- **snapshot · verifyChecksum** (1 cross-edges)

## How to Explore

```
get_communities with id: "community-30"
smart_context with task: "understand snapshot · loadSnapshot", format: "gcx"
find_usages with id: "src/snapshot/loader.ts::loadSnapshot", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
