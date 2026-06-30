# ops.4 → ops.5 Mirror — typed closeReason + closeReasonRaw — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror trading-platform ops-read `ops.5`: `ClosedTrade`/`TradeEvidence` gain a typed `closeReason: CloseReason | null` (10-member union) plus `closeReasonRaw: string | null`, and all fixtures are re-keyed from raw strings to canonical members so trading-lab's typed-closeReason live pass works.

**Architecture:** Bump the SDK seam 0.8.0 → 0.9.0 (flips `OPS_READ_CONTRACT_VERSION` to `ops.5` transitively). Add a mock-local mirror of the platform's pure `classifyCloseReason`. Re-key existing fixture data deterministically (no new VPS fetch) and teach the exporter to classify for future fetches. Forensic prices (entry/exit + lifecycle) already shipped in ops.4 (PR #19).

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), vitest, pnpm, `@trading-platform/sdk` (GitHub release tarball).

## Global Constraints

- Node 24 / pnpm 11; TypeScript strict; ESM — **all relative imports keep the `.js` suffix**.
- SDK pin (no vendor/, no registry/auth):
  `https://github.com/alexnikolskiy/trading-platform-sdk/releases/download/sdk-v0.9.0/trading-platform-sdk-0.9.0.tgz`.
- Contract isolation: **only** `src/contract/ops-read/dto.sdk.ts` may import `@trading-platform/sdk`. Other contract files import types from the local barrel `./dto.js` only.
- `OPS_READ_CONTRACT_VERSION` is owned by the SDK; `src/contract/ops-read/version.ts` and `src/snapshot/compat.ts` are **NOT edited** (ops.5 comes transitively).
- `compat.ts` is exact-match single-version; bundle JSON schema is `additionalProperties:false`. All 5 fixtures migrate in lockstep.
- `CloseReason` = `'take_profit_final' | 'take_profit_partial' | 'stop_loss' | 'breakeven' | 'trailing_stop' | 'signal_exit' | 'time_exit' | 'liquidation' | 'manual' | 'other'`.
- The mock's `classifyCloseReason` must be a byte-faithful copy of `trading-platform/src/operations/close_reason.ts` (so re-keyed values equal a fresh ops.5 fetch). Our fixture raws map: `tp2→take_profit_final`, `time_exit→time_exit`, `hard_stop→stop_loss`, `run_terminated→other`.
- `closeReasonRaw` preserves the original raw string; the `tradeLifecycleEvent.note` stays the raw reason (unchanged).
- Re-key is deterministic; no VPS/DB access in this work.

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `package.json` | SDK pin sdk-v0.9.0 | Modify |
| `scripts/verify_vendored_sdk.ts` | `EXPECTED_OPS_VERSION → ops.5` | Modify |
| `src/contract/ops-read/dto.sdk.ts` | re-export `CloseReason` | Modify |
| `src/contract/ops-read/close-reason.ts` | mock-local `classifyCloseReason` mirror | Create |
| `src/contract/snapshot/schema.ts` | closeReason enum + closeReasonRaw on closedTrade & tradeEvidence | Modify |
| `scripts/migrate-fixtures-ops5.ts` | deterministic re-key + ops.5 bump | Create |
| `tools/fetch-snapshot/trade-evidence-map.ts` | closeReasonRaw passthrough | Modify |
| `tools/fetch-snapshot/fetch-snapshot.ts` | classify closeReason + emit closeReasonRaw + manifest ops.5 | Modify |
| tests under `test/**` | classifier unit, schema, migration test updates | Create/Modify |

---

### Task 1: ops.5 lockstep migration (SDK + classifier + schema + re-key fixtures + tests)

Atomic: the SDK bump flips the version and breaks every fixture/test at once; a reviewer cannot accept half. Ends green on `pnpm typecheck && pnpm test`.

**Files:**
- Modify: `package.json`, `scripts/verify_vendored_sdk.ts`, `src/contract/ops-read/dto.sdk.ts`, `src/contract/snapshot/schema.ts`
- Create: `src/contract/ops-read/close-reason.ts`, `test/contract/close-reason.test.ts`, `scripts/migrate-fixtures-ops5.ts`
- Modify (tests): `test/snapshot/compat.test.ts`, `test/snapshot/loader.test.ts`, `test/snapshot/validate.test.ts`, `test/http/app.test.ts`, `test/ops/discover.test.ts`, `test/ops/trade-evidence.test.ts`, `test/snapshot/readers/trade-evidence.test.ts`
- Data: all 5 fixtures under `data/snapshots/fixtures/`

**Interfaces:**
- Produces: `classifyCloseReason(raw: string | null): CloseReason | null` (from `src/contract/ops-read/close-reason.js`); `CloseReason` re-exported from the barrel `../ops-read/dto.js`; fixtures carry `closeReason ∈ {10 members | null}` + `closeReasonRaw: string | null`.

- [ ] **Step 1: Bump SDK pin + verify gate**

`package.json` — replace the dependency line:
```json
    "@trading-platform/sdk": "https://github.com/alexnikolskiy/trading-platform-sdk/releases/download/sdk-v0.9.0/trading-platform-sdk-0.9.0.tgz",
```
`scripts/verify_vendored_sdk.ts`:
```ts
const EXPECTED_OPS_VERSION = 'ops.5';
```

- [ ] **Step 2: Install + verify**

Run: `pnpm install && pnpm verify:vendored-sdk`
Expected: `vendored-sdk OK (@trading-platform/sdk ops-read ops.5)`

- [ ] **Step 3: Re-export `CloseReason` from the SDK seam**

`src/contract/ops-read/dto.sdk.ts` — add `CloseReason` to the type re-export block (alongside `ClosedTrade`, `TradeEvidence`, etc.):
```ts
export type {
  BotMode, BotRunStatus, TradeSide, OpsSeverity, BotRunStrategyRef,
  BotRunRecord, ClosedTrade, ClosedTradesAggregate, RunSummary,
  OperationalEvent, DecisionLogEntry,
  TradeEvidence, TradeLifecycleEvent, OpsTradeLifecycleEventType, CloseReason,
} from '@trading-platform/sdk/ops-read';
```
(`closeReasonRaw` is a field of `ClosedTrade`/`TradeEvidence`; it arrives with those types — no separate re-export.)

- [ ] **Step 4: Failing test for the classifier mirror**

`test/contract/close-reason.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { classifyCloseReason } from '../../src/contract/ops-read/close-reason.js';

describe('classifyCloseReason (mirror of platform close_reason.ts)', () => {
  it('maps the take-profit ladder', () => {
    expect(classifyCloseReason('tp2')).toBe('take_profit_final');
    expect(classifyCloseReason('tp_final')).toBe('take_profit_final');
    expect(classifyCloseReason('tp1')).toBe('take_profit_partial');
  });
  it('maps stops, time, signal, and the rest', () => {
    expect(classifyCloseReason('hard_stop')).toBe('stop_loss');
    expect(classifyCloseReason('stop_loss')).toBe('stop_loss');
    expect(classifyCloseReason('sl')).toBe('stop_loss');
    expect(classifyCloseReason('time_exit')).toBe('time_exit');
    expect(classifyCloseReason('be_stop')).toBe('breakeven');
    expect(classifyCloseReason('trailing')).toBe('trailing_stop');
    expect(classifyCloseReason('fail_fast')).toBe('signal_exit');
    expect(classifyCloseReason('liquidation')).toBe('liquidation');
    expect(classifyCloseReason('manual')).toBe('manual');
  });
  it('sends unknown / reconcile to other, and null/empty to null', () => {
    expect(classifyCloseReason('run_terminated')).toBe('other');
    expect(classifyCloseReason('something_new')).toBe('other');
    expect(classifyCloseReason(null)).toBeNull();
    expect(classifyCloseReason('   ')).toBeNull();
  });
});
```

- [ ] **Step 5: Run — fails**

Run: `pnpm vitest run test/contract/close-reason.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 6: Implement the classifier mirror**

`src/contract/ops-read/close-reason.ts` (byte-faithful copy of `trading-platform/src/operations/close_reason.ts`; imports only the `CloseReason` type from the local barrel — no SDK import, so contract isolation holds):
```ts
// ops.5 — mock-local mirror of trading-platform/src/operations/close_reason.ts.
// Pure: maps a recorded RAW close_reason string to the closed CloseReason union; unclassifiable → 'other'
// (raw preserved in closeReasonRaw). No DB, no SDK import — only the CloseReason type from the barrel.
import type { CloseReason } from './dto.js';

export function classifyCloseReason(raw: string | null): CloseReason | null {
  if (raw == null) return null;
  const r = raw.trim().toLowerCase();
  if (r === '') return null;

  if (r === 'tp2' || r === 'tp_final' || r === 'take_profit_final' || r.includes('final')) return 'take_profit_final';
  if (r === 'tp1' || r.startsWith('tp1') || r === 'take_profit_partial' || r.includes('partial')) return 'take_profit_partial';
  if (r === 'breakeven' || r === 'be' || r === 'be_stop' || r.includes('break_even') || r.includes('breakeven')) return 'breakeven';
  if (r.includes('trail')) return 'trailing_stop';
  if (r === 'hard_stop' || r === 'stop_loss' || r === 'sl' || r === 'stop' || r.includes('hard_stop') || r.includes('stop_loss')) return 'stop_loss';
  if (r === 'time_exit' || r === 'time' || r.includes('max_hold') || r.includes('timeout') || r.includes('time_stop')) return 'time_exit';
  if (r === 'fail_fast' || r.includes('fail_fast') || r.includes('signal') || r.includes('reversal') || r.includes('exit_now')) return 'signal_exit';
  if (r.includes('liquidat')) return 'liquidation';
  if (r === 'manual' || r === 'user' || r === 'operator' || r.includes('manual')) return 'manual';

  return 'other';
}
```

- [ ] **Step 7: Run — passes**

Run: `pnpm vitest run test/contract/close-reason.test.ts`
Expected: PASS.

- [ ] **Step 8: Schema — closeReason enum + closeReasonRaw**

`src/contract/snapshot/schema.ts`. First add a shared enum array near the top of the file (after the `MANIFEST_SCHEMA`/before `BUNDLE_SCHEMA`, or just above `$defs`):
```ts
const CLOSE_REASON_ENUM = [
  'take_profit_final', 'take_profit_partial', 'stop_loss', 'breakeven', 'trailing_stop',
  'signal_exit', 'time_exit', 'liquidation', 'manual', 'other', null,
] as const;
```
In `$defs.closedTrade`: add `'closeReasonRaw'` to `required` (after `'closeReason'`), change the `closeReason` property, and add `closeReasonRaw`:
```ts
      // required: [..., 'isWin', 'closeReason', 'closeReasonRaw'],
        closeReason: { enum: CLOSE_REASON_ENUM },
        closeReasonRaw: { type: ['string', 'null'] },
```
In `$defs.tradeEvidence`: add `'closeReasonRaw'` to `required` (after `'closeReason'`), and:
```ts
        closeReason: { enum: CLOSE_REASON_ENUM },
        closeReasonRaw: { type: ['string', 'null'] },
        lifecycle: { type: 'array', items: { $ref: '#/$defs/tradeLifecycleEvent' } },
```
(Leave `$defs.tradeLifecycleEvent` unchanged.) Note: if the `... as const` on the schema object rejects the spread/array reference, inline the array literal directly into both `enum:` sites instead.

- [ ] **Step 9: Migration script (deterministic re-key)**

`scripts/migrate-fixtures-ops5.ts`:
```ts
/**
 * migrate-fixtures-ops5 — re-key committed fixtures from raw close_reason strings to the canonical
 * CloseReason union (ops.5). For every ClosedTrade and TradeEvidence: closeReasonRaw = the original raw,
 * closeReason = classifyCloseReason(raw). Idempotent (always derived from raw). Bumps manifest
 * opsReadContractVersion → ops.5, re-checksums, self-validates via loadSnapshot. Deterministic, no VPS.
 *
 * Usage: pnpm --config.verify-deps-before-run=false exec tsx scripts/migrate-fixtures-ops5.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/snapshot/checksums.js';
import { loadSnapshot } from '../src/snapshot/loader.js';
import { classifyCloseReason } from '../src/contract/ops-read/close-reason.js';

const FIXTURES = [
  '2026-06-12-real-top5',
  '2026-06-16-synthetic',
  'historical-golden',
  '2026-06-18-real-all',
];

type Obj = Record<string, unknown>;

function rekey(obj: Obj): void {
  const raw = (obj['closeReasonRaw'] ?? obj['closeReason']) as string | null;
  obj['closeReasonRaw'] = raw ?? null;
  obj['closeReason'] = classifyCloseReason(raw ?? null);
}

function migrateOne(ref: string): void {
  const root = join(process.cwd(), 'data/snapshots/fixtures', ref);
  const bundlePath = join(root, 'ops', 'bundle.json');
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as {
    tradesByRun?: Record<string, Obj[]>;
    tradeEvidenceByTrade?: Record<string, Obj>;
  };

  for (const trades of Object.values(bundle.tradesByRun ?? {})) for (const t of trades) rekey(t);
  for (const ev of Object.values(bundle.tradeEvidenceByTrade ?? {})) rekey(ev);

  const bundleStr = JSON.stringify(bundle);
  writeFileSync(bundlePath, bundleStr);
  writeFileSync(join(root, 'checksums.json'), JSON.stringify({ 'ops/bundle.json': sha256Hex(bundleStr) }, null, 2));

  const mp = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(mp, 'utf8')) as { versions: Record<string, string> };
  manifest.versions['opsReadContractVersion'] = 'ops.5';
  writeFileSync(mp, JSON.stringify(manifest, null, 2));

  loadSnapshot(root); // schema + checksum + compat + secret-scan
  console.log(`re-keyed '${ref}' → ops.5`);
}

function main(): void { for (const ref of FIXTURES) migrateOne(ref); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 10: Run migration + re-derive extended**

Run:
```bash
pnpm --config.verify-deps-before-run=false exec tsx scripts/migrate-fixtures-ops5.ts
pnpm --config.verify-deps-before-run=false exec tsx scripts/make-extended-fixture.ts
```
Expected: `re-keyed '...' → ops.5` ×4, then `extended fixture '2026-06-16-to-18-extended' written: ...`. No throw.

- [ ] **Step 11: Update tests pinning ops.4 / lacking closeReasonRaw**

- `test/snapshot/compat.test.ts`: `base.opsReadContractVersion: 'ops.4' → 'ops.5'`; the "OLDER minor" case `'ops.3' → 'ops.4'` and its regex `/unsupported opsReadContractVersion 'ops\.4'/i`.
- `test/snapshot/loader.test.ts`: all manifest literals `opsReadContractVersion: 'ops.4' → 'ops.5'`.
- `test/snapshot/validate.test.ts`: manifest version → ops.5; in the populated `tradeEvidenceByTrade.t1` and any ClosedTrade literal, set `closeReason: 'stop_loss'` (canonical) and add `closeReasonRaw: 'hard_stop'`; the negative case asserting rejection still holds. Add one case: a ClosedTrade/evidence with `closeReason: 'tp2'` (raw, not a canonical member) → expect rejection (`.toThrow(/bundle failed schema/i)`).
- `test/http/app.test.ts`: manifest `ops.4 → ops.5`; discover assertion `.toBe('ops.4') → .toBe('ops.5')`; in the `t1` evidence bundle literal add `closeReasonRaw: 'tp2'` and keep `closeReason: 'stop_loss'`→ change to a canonical value (it already is `stop_loss`); add `closeReasonRaw`.
- `test/ops/discover.test.ts`: any `ops.4` assertion → `ops.5` (if present).
- `test/ops/trade-evidence.test.ts` and `test/snapshot/readers/trade-evidence.test.ts`: the inline `ev(...)` factory's `closeReason: 'stop_loss'` is canonical-valid; add `closeReasonRaw: 'hard_stop'` so the literals match the ops.5 shape (these are `as unknown as` casts, so this is for fidelity, not typecheck).
- Then search `test/` for any remaining `ops.4` manifest literal and bump to `ops.5`.

- [ ] **Step 12: Full run**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (classifier + schema + all fixture guards + handler/reader/app green).

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat(ops5): lockstep migrate ops.4→ops.5 — typed closeReason + closeReasonRaw + classifier mirror + re-keyed fixtures"
```

---

### Task 2: exporter ops.5-aware (classify closeReason + emit closeReasonRaw)

For future VPS fetches: the exporter must classify and emit both fields (re-key in Task 1 already fixed the committed data).

**Files:**
- Modify: `tools/fetch-snapshot/trade-evidence-map.ts`, `tools/fetch-snapshot/fetch-snapshot.ts`
- Modify (test): `test/tools/trade-evidence-map.test.ts`

**Interfaces:**
- Consumes: `classifyCloseReason` (Task 1) from `../../src/contract/ops-read/close-reason.js`.
- Produces: exporter output carries `closeReason` (canonical) + `closeReasonRaw` (raw) on `ClosedTrade` and `TradeEvidence`; manifest `ops.5`.

- [ ] **Step 1: Mapper carries closeReasonRaw (failing test)**

In `test/tools/trade-evidence-map.test.ts`, extend the `buildTradeEvidenceByTrade` test: give the trade row `closeReason: 'stop_loss'` **and** `closeReasonRaw: 'hard_stop'`, and assert the output preserves both:
```ts
    // trades[0] now also has closeReasonRaw: 'hard_stop'
    expect(out['t1']!.closeReason).toBe('stop_loss');
    expect(out['t1']!.closeReasonRaw).toBe('hard_stop');
```
(Update the `trades` literal in that test to include `closeReasonRaw: 'hard_stop'`.)

- [ ] **Step 2: Run — fails**

Run: `pnpm vitest run test/tools/trade-evidence-map.test.ts`
Expected: FAIL (`closeReasonRaw` undefined on output).

- [ ] **Step 3: Add closeReasonRaw to the mapper types + passthrough**

`tools/fetch-snapshot/trade-evidence-map.ts`:
- In `EvidenceTradeRow`, add after `closeReason`:
```ts
  readonly closeReasonRaw: string | null;
```
- In `buildTradeEvidenceByTrade`, in the `out[t.tradeId] = {...}` object, add `closeReasonRaw: t.closeReasonRaw,` next to `closeReason: t.closeReason,`. (`TradeEvidenceOut extends EvidenceTradeRow`, so the field is already on the output type once added to the row.)

- [ ] **Step 4: Run — passes**

Run: `pnpm vitest run test/tools/trade-evidence-map.test.ts`
Expected: PASS.

- [ ] **Step 5: fetch-snapshot — classify + emit closeReasonRaw + manifest ops.5**

`tools/fetch-snapshot/fetch-snapshot.ts`:
- Add import near the top:
```ts
import { classifyCloseReason } from '../../src/contract/ops-read/close-reason.js';
```
- In the local `interface ClosedTrade`, add after `closeReason`:
```ts
  closeReasonRaw: string | null;
```
- In the trades SQL, rename the close-reason alias to raw:
```sql
        close_reason  AS "closeReasonRaw"
```
  and update the `client.query<{...}>` row type: replace `closeReason: string | null;` with `closeReasonRaw: string | null;`.
- In the `tradesByRun[...].push({...})`, replace `closeReason: t.closeReason ?? null,` with:
```ts
          closeReasonRaw: t.closeReasonRaw ?? null,
          closeReason: classifyCloseReason(t.closeReasonRaw ?? null),
```
- In `evidenceTradeRows` map, replace `closeReason: t.closeReason ?? null,` with:
```ts
      closeReasonRaw: t.closeReasonRaw ?? null,
      closeReason: classifyCloseReason(t.closeReasonRaw ?? null),
```
- In `writeSnapshot` manifest: `opsReadContractVersion: 'ops.4' → 'ops.5'`.

- [ ] **Step 6: Typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tools/fetch-snapshot/ test/tools/trade-evidence-map.test.ts
git commit -m "feat(ops5): fetch-snapshot classifies closeReason + emits closeReasonRaw (manifest ops.5)"
```

---

### Acceptance verification (after both tasks)

Run: `pnpm check:ci` → expect 18x tests + all gates green (vendored-sdk **ops.5**, forbidden-deps, no-secrets, contract-isolation, harness-sync).

HTTP smoke on the extended fixture:
```bash
MOCK_SNAPSHOT_REF=fixtures/2026-06-16-to-18-extended MOCK_OPS_PORT=8839 pnpm dev &   # run_in_background
curl -s localhost:8839/ops/discover | grep -o '"opsContractVersion":"ops.5"'        # → ops.5
# pick a runId from /ops/runs, then:
curl -s 'localhost:8839/ops/trades?runId=<RID>' | grep -o '"closeReason":"[a-z_]*"' | sort -u   # canonical members only
curl -s 'localhost:8839/ops/trades?runId=<RID>' | grep -o '"closeReasonRaw":"[a-z0-9_]*"' | head  # raw preserved
```
Expected: `ops.5`; `closeReason` values are canonical (`take_profit_final`, `time_exit`, `stop_loss`, `other`) — never raw `tp2`; `closeReasonRaw` carries the raw strings. Winners span ≥2 canonical reasons (`take_profit_final` + `time_exit`).

---

## Self-Review

**Spec coverage:**
- SDK 0.8.0→0.9.0 + dto.sdk CloseReason + verify_vendored_sdk ops.5 → Task 1 Steps 1-3. ✓
- Classifier mirror + unit test → Task 1 Steps 4-7. ✓
- Schema closeReason enum + closeReasonRaw → Task 1 Step 8. ✓
- Lockstep re-key of all 5 fixtures → Task 1 Steps 9-10. ✓
- Test updates (compat/loader/validate/app/discover/handler/reader) → Task 1 Step 11. ✓
- Exporter classify + closeReasonRaw + manifest ops.5 → Task 2. ✓
- Acceptance (canonical closeReason + closeReasonRaw, ≥2 typed winners, discover ops.5, gates) → Acceptance section. ✓

**Placeholder scan:** `<RID>` in the acceptance smoke is a runtime id from `/ops/runs`, not a plan placeholder. No TBD/TODO.

**Type consistency:** `classifyCloseReason(raw: string | null): CloseReason | null` is the single signature used by the classifier file, the migration script, and the exporter. `closeReasonRaw: string | null` is the one field name across schema, mapper (`EvidenceTradeRow`/`TradeEvidenceOut`), fetch-snapshot row type + ClosedTrade interface, and fixtures. `CloseReason` enum members match the spec list verbatim in both the classifier and the schema `CLOSE_REASON_ENUM`.
