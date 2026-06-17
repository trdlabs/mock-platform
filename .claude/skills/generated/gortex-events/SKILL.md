---
name: gortex-events
description: "Work in the events area — 20 symbols across 2 files (94% cohesion)"
---

# events

20 symbols | 2 files | 94% cohesion

## When to Use

Use this skill when working on files in:
- `src/events/replay.ts`
- `src/events/ws-adapter.ts`

## Key Files

| File | Symbols |
|------|---------|
| `src/events/replay.ts` | projectionFor, LiveUpdate, resource, speed, prevOffset, ... |
| `src/events/ws-adapter.ts` | step, timers, steps, opts, ReplayOptions, ... |

## Entry Points

- `src/events/ws-adapter.ts::startReplay`
- `src/events/replay.ts::buildReplaySequence`

## How to Explore

```
get_communities with id: "community-14"
smart_context with task: "understand events", format: "gcx"
find_usages with id: "src/events/ws-adapter.ts::startReplay", format: "gcx"
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
