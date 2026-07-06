---
name: mock-snapshot-default-rollout
description: >-
  VPS snapshot → ecosystem default. Delegates to control-center (SSOT + rollout script).
  Use when fetching VPS slice or changing default mock fixture.
---

# Mock Snapshot Default Rollout (delegate)

This repo does **not** own ecosystem defaults. **Always** switch to control-center:

1. Read `../control-center/.cursor/skills/mock-snapshot-default-rollout/SKILL.md`
2. Run `../control-center/scripts/rollout-mock-default-snapshot.sh`

Do not patch lab env or `composition.ts` from mock-platform alone.
