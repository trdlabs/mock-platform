# ops.4 Mirror — entry/exit + trade-evidence/lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Зеркалить ops-read `ops.4` в trading-mock-platform: `ClosedTrade.entryPrice/exitPrice`, новый батч-endpoint `GET /ops/trade-evidence` с `TradeLifecycleEvent`, и запечь реальные ESPORTSUSDT цены+lifecycle в фикстуру `2026-06-16-to-18-extended`.

**Architecture:** Mock отдаёт заранее запечённые `bundle.json`; live-DB нет. Маппинг канонических событий в ops-форму делает экспортёр (`tools/fetch-snapshot`); runtime-хендлер отдаёт уже ops-shaped `TradeEvidence` из `bundle.tradeEvidenceByTrade`. Версия — lockstep: апгрейд SDK `0.5.0→0.8.0` транзитивно переводит `OPS_READ_CONTRACT_VERSION` в `ops.4` (через `dto.sdk.ts` → `version.ts` → `compat.ts`), поэтому все 5 фикстур мигрируют одновременно.

**Tech Stack:** TypeScript (strict, ESM, `.js` import-суффиксы), Hono, vitest, pnpm, `@trading-platform/sdk` (GitHub release tarball), `pg` (только в `tools/`, dynamic import).

## Global Constraints

- Node 24 / pnpm 11; TypeScript strict; ESM — **все относительные импорты с суффиксом `.js`**.
- SDK pinned как public GitHub release-asset URL (никаких `vendor/*.tgz`, никакого registry/auth):
  `https://github.com/alexnikolskiy/trading-platform-sdk/releases/download/sdk-v0.8.0/trading-platform-sdk-0.8.0.tgz`.
- Contract isolation: **только** `src/contract/ops-read/dto.sdk.ts` имеет право импортировать `@trading-platform/sdk` (машинно проверяется `verify:contract-isolation`). Остальные `src/contract/**` — dependency-free.
- Readers/handlers импортируют типы из barrel `../ops-read/dto.js`, **не** из `dto.sdk.js`.
- `OPS_READ_CONTRACT_VERSION` владеет SDK; `src/contract/ops-read/version.ts` и `src/snapshot/compat.ts` — **не редактируем** (станут `ops.4` транзитивно).
- `compat.ts` — exact-match на одну версию. Каждая фикстура валидируется `loadSnapshot` (schema `additionalProperties:false` + checksum + compat + secret-scan).
- Handler-тесты: импортировать `isOpsError` из `../../src/contract/common/errors.js` и сужать union (`if (isOpsError(p)) return;`) перед доступом к `.items`/`.nextCursor` — иначе падает `tsc`.
- Никаких `pg`/`ccxt`/exchange-SDK/private-platform в runtime-зависимостях (`verify:no-forbidden-deps`).
- Запрещён синтез событий `sl`/`stop_update`.
- Реальный fetch (DATABASE_URL + SSH к VPS) недоступен агенту — Task 6 запускает пользователь через `!`.

## File Structure

| Файл | Ответственность | Действие |
|------|-----------------|----------|
| `package.json` | SDK pin `sdk-v0.8.0` | Modify |
| `src/contract/ops-read/dto.sdk.ts` | реэкспорт ops.4 типов из SDK | Modify |
| `src/contract/ops-read/dto.local.ts` | алиас `TradeEvidencePage` | Modify |
| `src/contract/snapshot/bundle.ts` | TS-тип `tradeEvidenceByTrade` | Modify |
| `src/contract/snapshot/schema.ts` | JSON-схема: closedTrade entry/exit, tradeEvidence $defs, bundle key | Modify |
| `scripts/verify_vendored_sdk.ts` | `EXPECTED_OPS_VERSION → ops.4` | Modify |
| `scripts/migrate-fixtures-ops4.ts` | идемпотентная миграция фикстур на ops.4 | Create |
| `src/snapshot/readers/trade-evidence.ts` | батч-reader из бандла | Create |
| `src/ops/handlers/trade-evidence.ts` | хендлер cap-25 + envelope | Create |
| `src/http/app.ts` | route `/ops/trade-evidence` | Modify |
| `src/ops/handlers/discover.ts` | дескриптор ресурса | Modify |
| `tools/fetch-snapshot/trade-evidence-map.ts` | чистый маппер event_type→ops (тестируемый) | Create |
| `tools/fetch-snapshot/fetch-snapshot.ts` | trades-SQL + lifecycle-query + bundle/manifest | Modify |
| `scripts/make-extended-fixture.ts` | без изменений (deep-clone переносит новые поля) | — |
| тесты `test/**` | unit + миграционные апдейты | Create/Modify |

---

### Task 1: ops.4 lockstep-миграция (SDK + схема + типы + фикстуры + апдейт тестов)

Единый атомарный шаг: bump версии ломает все фикстуры/тесты сразу (exact-match), reviewer не может принять половину. Завершается зелёным `pnpm test`.

**Files:**
- Modify: `package.json`, `scripts/verify_vendored_sdk.ts`, `src/contract/ops-read/dto.sdk.ts`,
  `src/contract/ops-read/dto.local.ts`, `src/contract/snapshot/bundle.ts`, `src/contract/snapshot/schema.ts`
- Create: `scripts/migrate-fixtures-ops4.ts`
- Modify (tests): `test/snapshot/compat.test.ts`, `test/snapshot/loader.test.ts`, `test/http/app.test.ts`
- Data: все 5 фикстур под `data/snapshots/fixtures/`

**Interfaces:**
- Produces: `TradeEvidence`, `TradeLifecycleEvent`, `OpsTradeLifecycleEventType` (реэкспорт из SDK через barrel `../ops-read/dto.js`); `TradeEvidencePage = PageEnvelope<TradeEvidence>`; `SnapshotBundle.tradeEvidenceByTrade: Readonly<Record<string, TradeEvidence>>`.

- [ ] **Step 1: Bump SDK pin + verify gate**

В `package.json` заменить строку зависимости:
```json
    "@trading-platform/sdk": "https://github.com/alexnikolskiy/trading-platform-sdk/releases/download/sdk-v0.8.0/trading-platform-sdk-0.8.0.tgz",
```
В `scripts/verify_vendored_sdk.ts`:
```ts
const EXPECTED_OPS_VERSION = 'ops.4';
```

- [ ] **Step 2: Install + verify SDK carries ops.4**

Run: `pnpm install && pnpm verify:vendored-sdk`
Expected: `vendored-sdk OK (@trading-platform/sdk ops-read ops.4)`

- [ ] **Step 3: Реэкспорт ops.4 типов в SDK-сшивке**

`src/contract/ops-read/dto.sdk.ts` — расширить type-реэкспорт:
```ts
export type {
  BotMode, BotRunStatus, TradeSide, OpsSeverity, BotRunStrategyRef,
  BotRunRecord, ClosedTrade, ClosedTradesAggregate, RunSummary,
  OperationalEvent, DecisionLogEntry,
  TradeEvidence, TradeLifecycleEvent, OpsTradeLifecycleEventType,
} from '@trading-platform/sdk/ops-read';
export { OPS_READ_CONTRACT_VERSION } from '@trading-platform/sdk/ops-read';
export type { OpsReadContractVersion } from '@trading-platform/sdk/ops-read';
```

- [ ] **Step 4: Алиас TradeEvidencePage**

`src/contract/ops-read/dto.local.ts` — добавить `TradeEvidence` в SDK-import и алиас. Изменить строку импорта типов из `./dto.sdk.js`:
```ts
import type { BotRunRecord, ClosedTrade, OperationalEvent, DecisionLogEntry, TradeEvidence } from './dto.sdk.js';
```
И в конце файла, рядом с прочими `*Page` алиасами:
```ts
export type TradeEvidencePage = PageEnvelope<TradeEvidence>;
```

- [ ] **Step 5: TS-тип бандла**

`src/contract/snapshot/bundle.ts` — в import-список из `../ops-read/dto.js` добавить `TradeEvidence`, и в `SnapshotBundle` (после `decisionsByRun`) добавить поле:
```ts
  readonly tradeEvidenceByTrade: Readonly<Record<string, TradeEvidence>>;
```
(в import: `BotRunRecord, ClosedTrade, OperationalEvent, DecisionLogEntry, TradeEvidence, RuntimeHealthCollection, ...`)

- [ ] **Step 6: JSON-схема — closedTrade entry/exit + tradeEvidence $defs + bundle key**

`src/contract/snapshot/schema.ts`:

(a) В `$defs.closedTrade` — `required` и `properties` получают `entryPrice`/`exitPrice`:
```ts
    closedTrade: {
      type: 'object', additionalProperties: false,
      required: ['tradeId', 'runId', 'symbol', 'side', 'openedAtMs', 'closedAtMs', 'entryPrice', 'exitPrice', 'realizedPnl', 'pnlPct', 'isWin', 'closeReason'],
      properties: {
        tradeId: { type: 'string' }, runId: { type: 'string' }, symbol: { type: 'string' },
        side: { enum: ['long', 'short'] }, openedAtMs: { type: 'number' }, closedAtMs: { type: ['number', 'null'] },
        entryPrice: { type: ['string', 'null'] }, exitPrice: { type: ['string', 'null'] },
        realizedPnl: { type: 'string' }, pnlPct: { type: 'string' }, isWin: { type: ['boolean', 'null'] },
        closeReason: { type: ['string', 'null'] },
      },
    },
```

(b) Добавить два новых `$defs` (например после `closedTrade`):
```ts
    tradeLifecycleEvent: {
      type: 'object', additionalProperties: false,
      required: ['tsMs', 'type', 'price', 'qty'],
      properties: {
        tsMs: { type: 'number' },
        type: { enum: ['entry', 'dca', 'tp', 'sl', 'exit', 'stop_update'] },
        price: { type: ['string', 'null'] },
        qty: { type: ['string', 'null'] },
        note: { type: ['string', 'null'] },
      },
    },
    tradeEvidence: {
      type: 'object', additionalProperties: false,
      required: ['tradeId', 'runId', 'symbol', 'side', 'openedAtMs', 'closedAtMs', 'entryPrice', 'exitPrice', 'realizedPnl', 'pnlPct', 'closeReason', 'lifecycle'],
      properties: {
        tradeId: { type: 'string' }, runId: { type: 'string' }, symbol: { type: 'string' },
        side: { enum: ['long', 'short'] }, openedAtMs: { type: 'number' }, closedAtMs: { type: ['number', 'null'] },
        entryPrice: { type: ['string', 'null'] }, exitPrice: { type: ['string', 'null'] },
        realizedPnl: { type: 'string' }, pnlPct: { type: 'string' }, closeReason: { type: ['string', 'null'] },
        lifecycle: { type: 'array', items: { $ref: '#/$defs/tradeLifecycleEvent' } },
      },
    },
```

(c) В `BUNDLE_SCHEMA.required` добавить `'tradeEvidenceByTrade'`; в `BUNDLE_SCHEMA.properties` (рядом с `decisionsByRun`):
```ts
    tradeEvidenceByTrade: { type: 'object', additionalProperties: { $ref: '#/$defs/tradeEvidence' } },
```

- [ ] **Step 7: Скрипт миграции фикстур (идемпотентный, preserving)**

Create `scripts/migrate-fixtures-ops4.ts`:
```ts
/**
 * migrate-fixtures-ops4 — привести committed-фикстуры к ops.4 shape БЕЗ потери данных:
 * каждому ClosedTrade добавить entryPrice/exitPrice (null ТОЛЬКО если поле отсутствует —
 * существующие значения сохраняются), гарантировать bundle.tradeEvidenceByTrade (если нет — {}),
 * проставить manifest.opsReadContractVersion='ops.4', пересчитать checksums.json, прогнать loadSnapshot.
 * Идемпотентно: повторный прогон на фикстуре с реальными ценами их НЕ затрёт.
 *
 * Usage: pnpm --config.verify-deps-before-run=false exec tsx scripts/migrate-fixtures-ops4.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Hex } from '../src/snapshot/checksums.js';
import { loadSnapshot } from '../src/snapshot/loader.js';

// Только standalone-фикстуры. 2026-06-16-to-18-extended деривится из real-all отдельно
// (scripts/make-extended-fixture.ts) и здесь НЕ трогается.
const FIXTURES = [
  '2026-06-12-real-top5',
  '2026-06-16-synthetic',
  'historical-golden',
  '2026-06-18-real-all',
];

interface BundleLike {
  tradesByRun?: Record<string, Array<Record<string, unknown>>>;
  tradeEvidenceByTrade?: Record<string, unknown>;
  [k: string]: unknown;
}

function migrateOne(ref: string): void {
  const root = join(process.cwd(), 'data/snapshots/fixtures', ref);
  const bundlePath = join(root, 'ops', 'bundle.json');
  const manifestPath = join(root, 'manifest.json');

  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as BundleLike;

  for (const trades of Object.values(bundle.tradesByRun ?? {})) {
    for (const t of trades) {
      if (!('entryPrice' in t)) t['entryPrice'] = null;
      if (!('exitPrice' in t)) t['exitPrice'] = null;
    }
  }
  if (bundle.tradeEvidenceByTrade === undefined) bundle.tradeEvidenceByTrade = {};

  const bundleStr = JSON.stringify(bundle);
  writeFileSync(bundlePath, bundleStr);
  writeFileSync(join(root, 'checksums.json'), JSON.stringify({ 'ops/bundle.json': sha256Hex(bundleStr) }, null, 2));

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { versions: Record<string, string> };
  manifest.versions['opsReadContractVersion'] = 'ops.4';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  loadSnapshot(root); // self-validation: schema + checksum + compat + secret-scan
  console.log(`migrated '${ref}' → ops.4`);
}

function main(): void {
  for (const ref of FIXTURES) migrateOne(ref);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

> Замечание: пишем `JSON.stringify(bundle)` (compact, без indent) — так же, как `make-extended-fixture.ts`, чтобы checksum совпадал с тем, что читает loader. Manifest пишем с indent (как исходные фикстуры). `loadSnapshot` внутри валидирует — если схема не сойдётся, скрипт упадёт здесь.

- [ ] **Step 8: Прогнать миграцию + ре-деривацию extended**

Run:
```bash
pnpm --config.verify-deps-before-run=false exec tsx scripts/migrate-fixtures-ops4.ts
pnpm --config.verify-deps-before-run=false exec tsx scripts/make-extended-fixture.ts
```
Expected: `migrated '...' → ops.4` ×4, затем `extended fixture '2026-06-16-to-18-extended' written: ...`. Ни одного throw.

- [ ] **Step 9: Обновить тесты, пиннящие ops.3 / форму бандла**

В `test/snapshot/compat.test.ts`: в `base` — `opsReadContractVersion: 'ops.4'`; тест «accepts ... EXACTLY match» теперь зелёный; тест «fails closed on an OLDER ops-read minor» — заменить `'ops.2'` на `'ops.3'` и regex на `/unsupported opsReadContractVersion 'ops\.3'/i` (ops.3 теперь несовместим). Тест `ops.99` остаётся.

В `test/snapshot/loader.test.ts`: во всех трёх manifest-литералах `opsReadContractVersion: 'ops.3'` → `'ops.4'`; в happy-path `bundle` и в `leaked` bundle добавить `tradeEvidenceByTrade: {}` (рядом с `decisionsByRun: {}`).

В `test/http/app.test.ts`: в manifest-литерале `opsReadContractVersion: 'ops.3'` → `'ops.4'`; в `bundle`-литерале добавить `tradeEvidenceByTrade: {}`; ассерт discover `.toBe('ops.3')` → `.toBe('ops.4')`.

- [ ] **Step 10: Найти остаточные ops.3 в тестах**

Run (через gortex `search_text` при имплементации): искать `ops.3` под `test/`. Любой оставшийся manifest-литерал привести к `ops.4`.

- [ ] **Step 11: Полный прогон**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (все fixture-guard тесты, loader/compat/app зелёные).

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(ops4): lockstep migrate ops.3→ops.4 — entry/exit + tradeEvidenceByTrade schema + fixtures"
```

---

### Task 2: trade-evidence reader

**Files:**
- Create: `src/snapshot/readers/trade-evidence.ts`
- Test: `test/snapshot/readers/trade-evidence.test.ts`

**Interfaces:**
- Consumes: `SnapshotBundle.tradeEvidenceByTrade` (Task 1), `TradeEvidence` (barrel).
- Produces: `readTradeEvidence(bundle: SnapshotBundle, tradeIds: readonly string[]): readonly TradeEvidence[]`.

- [ ] **Step 1: Failing test**

`test/snapshot/readers/trade-evidence.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readTradeEvidence } from '../../../src/snapshot/readers/trade-evidence.js';
import type { SnapshotBundle } from '../../../src/contract/snapshot/bundle.js';

const ev = (tradeId: string) => ({ tradeId, runId: 'r1', symbol: 'ESPORTSUSDT', side: 'long',
  openedAtMs: 1, closedAtMs: 2, entryPrice: '0.1', exitPrice: '0.09', realizedPnl: '-1', pnlPct: '-10',
  closeReason: 'stop_loss', lifecycle: [] });
const bundle = { tradeEvidenceByTrade: { t1: ev('t1'), t2: ev('t2') } } as unknown as SnapshotBundle;

describe('readTradeEvidence', () => {
  it('returns evidence in request order, skipping unknown ids', () => {
    const out = readTradeEvidence(bundle, ['t2', 'tX', 't1']);
    expect(out.map((e) => e.tradeId)).toEqual(['t2', 't1']);
  });
  it('returns empty for no matches', () => {
    expect(readTradeEvidence(bundle, ['nope'])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — fails**

Run: `pnpm vitest run test/snapshot/readers/trade-evidence.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/snapshot/readers/trade-evidence.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { TradeEvidence } from '../../contract/ops-read/dto.js';

/** Батч-выборка per-trade evidence из бандла; порядок = порядок запроса, отсутствующие опускаются. */
export function readTradeEvidence(
  bundle: SnapshotBundle,
  tradeIds: readonly string[],
): readonly TradeEvidence[] {
  const out: TradeEvidence[] = [];
  for (const id of tradeIds) {
    const ev = bundle.tradeEvidenceByTrade[id];
    if (ev) out.push(ev);
  }
  return out;
}
```

- [ ] **Step 4: Run — passes**

Run: `pnpm vitest run test/snapshot/readers/trade-evidence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/readers/trade-evidence.ts test/snapshot/readers/trade-evidence.test.ts
git commit -m "feat(ops4): trade-evidence snapshot reader"
```

---

### Task 3: trade-evidence handler

**Files:**
- Create: `src/ops/handlers/trade-evidence.ts`
- Test: `test/ops/trade-evidence.test.ts`

**Interfaces:**
- Consumes: `readTradeEvidence` (Task 2), `TradeEvidencePage` (Task 1), `OpsError`.
- Produces: `handleTradeEvidence(bundle: SnapshotBundle, tradeIdsCsv: string, asOf: number): TradeEvidencePage | OpsError`.

- [ ] **Step 1: Failing test**

`test/ops/trade-evidence.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { handleTradeEvidence } from '../../src/ops/handlers/trade-evidence.js';
import { isOpsError } from '../../src/contract/common/errors.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';

const ev = (tradeId: string) => ({ tradeId, runId: 'r1', symbol: 'ESPORTSUSDT', side: 'long',
  openedAtMs: 1, closedAtMs: 2, entryPrice: '0.1', exitPrice: '0.09', realizedPnl: '-1', pnlPct: '-10',
  closeReason: 'stop_loss', lifecycle: [{ tsMs: 1, type: 'entry', price: '0.1', qty: '5', note: null }] });
const bundle = { tradeEvidenceByTrade: { t1: ev('t1') } } as unknown as SnapshotBundle;

describe('handleTradeEvidence', () => {
  it('returns a single-page envelope with nextCursor null', () => {
    const p = handleTradeEvidence(bundle, 't1', 100);
    expect(isOpsError(p)).toBe(false);
    if (isOpsError(p)) return;
    expect(p.items).toHaveLength(1);
    expect(p.items[0]!.lifecycle).toHaveLength(1);
    expect(p.nextCursor).toBeNull();
    expect(p.asOf).toBe(100);
  });
  it('rejects empty tradeIds', () => {
    const p = handleTradeEvidence(bundle, '   ', 100);
    expect(isOpsError(p)).toBe(true);
    if (!isOpsError(p)) return;
    expect(p.code).toBe('missing_trade_ids');
  });
  it('rejects more than 25 tradeIds', () => {
    const csv = Array.from({ length: 26 }, (_, i) => `t${i}`).join(',');
    const p = handleTradeEvidence(bundle, csv, 100);
    expect(isOpsError(p)).toBe(true);
    if (!isOpsError(p)) return;
    expect(p.code).toBe('too_many_trade_ids');
  });
});
```

- [ ] **Step 2: Run — fails**

Run: `pnpm vitest run test/ops/trade-evidence.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/ops/handlers/trade-evidence.ts`:
```ts
import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { TradeEvidencePage } from '../../contract/ops-read/dto.js';
import type { OpsError } from '../../contract/common/errors.js';
import { readTradeEvidence } from '../../snapshot/readers/trade-evidence.js';

/** Жёсткий потолок батча (Surface A) — защита от неограниченного fan-out. */
const MAX_TRADE_IDS = 25;

export function handleTradeEvidence(
  bundle: SnapshotBundle,
  tradeIdsCsv: string,
  asOf: number,
): TradeEvidencePage | OpsError {
  const ids = tradeIdsCsv.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (ids.length === 0) {
    return { category: 'validation_error', code: 'missing_trade_ids', message: 'tradeIds is required (comma-separated, <=25)' };
  }
  if (ids.length > MAX_TRADE_IDS) {
    return { category: 'validation_error', code: 'too_many_trade_ids', message: `at most ${MAX_TRADE_IDS} tradeIds per request` };
  }
  // Батч-by-id: single-page envelope, nextCursor null (НЕ курсорная пагинация).
  return { items: readTradeEvidence(bundle, ids), nextCursor: null, asOf, window: {}, freshness: 'fresh' };
}
```

- [ ] **Step 4: Run — passes**

Run: `pnpm vitest run test/ops/trade-evidence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ops/handlers/trade-evidence.ts test/ops/trade-evidence.test.ts
git commit -m "feat(ops4): trade-evidence ops handler (batch cap-25, single-page)"
```

---

### Task 4: HTTP route + discover descriptor

**Files:**
- Modify: `src/http/app.ts`, `src/ops/handlers/discover.ts`
- Modify (test): `test/http/app.test.ts`, `test/ops/discover.test.ts`

**Interfaces:**
- Consumes: `handleTradeEvidence` (Task 3), `OPS_READ_CONTRACT_VERSION='ops.4'`.

- [ ] **Step 1: Failing test (route + discover)**

В `test/http/app.test.ts` добавить (используя существующий `makeApp()`):
```ts
it('GET /ops/trade-evidence returns evidence items for known tradeIds', async () => {
  const res = await makeApp().request('/ops/trade-evidence?tradeIds=t1');
  expect(res.status).toBe(200);
  const body = await res.json() as { items: unknown[]; nextCursor: null };
  expect(Array.isArray(body.items)).toBe(true);
  expect(body.nextCursor).toBeNull();
});
it('GET /ops/trade-evidence 400 missing_trade_ids when tradeIds absent', async () => {
  const res = await makeApp().request('/ops/trade-evidence');
  expect(res.status).toBe(400);
  expect((await res.json() as { code: string }).code).toBe('missing_trade_ids');
});
it('discover advertises ops.4 and the trade-evidence resource', async () => {
  const res = await makeApp().request('/ops/discover');
  const body = await res.json() as { opsContractVersion: string; resources: { name: string }[] };
  expect(body.opsContractVersion).toBe('ops.4');
  expect(body.resources.some((r) => r.name === 'trade-evidence')).toBe(true);
});
```
> Если `makeApp()`/`snap` в `app.test.ts` строит `tradeEvidenceByTrade`, добавить туда `t1` evidence; иначе первый тест проверяет пустой `items` — тогда заменить ассерт на `expect(body.items).toEqual([])`. Сверить с фактическим литералом при имплементации.

В `test/ops/discover.test.ts` добавить ассерт: ресурс `trade-evidence` присутствует, `pagination` = `null`, `supportedFilters` = `['tradeIds']`.

- [ ] **Step 2: Run — fails**

Run: `pnpm vitest run test/http/app.test.ts test/ops/discover.test.ts`
Expected: FAIL (404 на route / ресурс отсутствует).

- [ ] **Step 3: Implement route**

`src/http/app.ts`: добавить импорт рядом с `handleTrades`:
```ts
import { handleTradeEvidence } from '../ops/handlers/trade-evidence.js';
```
И зарегистрировать route сразу после `/ops/trades`:
```ts
  app.get('/ops/trade-evidence', (c) => respond(c, handleTradeEvidence(bundle, c.req.query('tradeIds') ?? '', now())));
```

- [ ] **Step 4: Implement discover descriptor**

`src/ops/handlers/discover.ts`: в массив `RESOURCES` добавить (после `trades`):
```ts
  { name: 'trade-evidence', supportedFilters: ['tradeIds'], pagination: null,
    fields: ['tradeId', 'runId', 'symbol', 'side', 'entryPrice', 'exitPrice', 'realizedPnl', 'pnlPct', 'closeReason', 'lifecycle'] },
```

- [ ] **Step 5: Run — passes**

Run: `pnpm vitest run test/http/app.test.ts test/ops/discover.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/http/app.ts src/ops/handlers/discover.ts test/http/app.test.ts test/ops/discover.test.ts
git commit -m "feat(ops4): /ops/trade-evidence route + discover descriptor"
```

---

### Task 5: fetch-snapshot экспортёр (entry/exit SQL + lifecycle query + bundle/manifest)

**Files:**
- Create: `tools/fetch-snapshot/trade-evidence-map.ts`
- Test: `test/tools/trade-evidence-map.test.ts`
- Modify: `tools/fetch-snapshot/fetch-snapshot.ts`

**Interfaces:**
- Produces (pure, testable): `mapEventType`, `toLifecycleEvent`, `buildTradeEvidenceByTrade`.
- Маппинг: `trade_opened→entry`, `trade_scaled_in→dca`, `tp1_armed|tp_armed→tp`, `trade_closed→exit`;
  `price = type==='tp' ? triggerPrice : fillPrice`; `qty` (для tp = null, т.к. arm-событие не несёт qty);
  `note = reason ?? null`; неизвестный `event_type` — skip.

- [ ] **Step 1: Failing test для чистого маппера**

`test/tools/trade-evidence-map.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mapEventType, toLifecycleEvent, buildTradeEvidenceByTrade } from '../../tools/fetch-snapshot/trade-evidence-map.js';

describe('mapEventType', () => {
  it('maps canonical event_type to ops lifecycle type', () => {
    expect(mapEventType('trade_opened')).toBe('entry');
    expect(mapEventType('trade_scaled_in')).toBe('dca');
    expect(mapEventType('tp1_armed')).toBe('tp');
    expect(mapEventType('tp_armed')).toBe('tp');
    expect(mapEventType('trade_closed')).toBe('exit');
    expect(mapEventType('weird')).toBeNull();
  });
});

describe('toLifecycleEvent', () => {
  it('uses trigger_price for tp (arm) events and fill_price otherwise', () => {
    const tp = toLifecycleEvent({ tradeId: 't', eventType: 'tp_armed', tsMs: 5, fillPrice: null, triggerPrice: '0.12', qty: null, reason: 'arm_breakeven' });
    expect(tp).toEqual({ tsMs: 5, type: 'tp', price: '0.12', qty: null, note: 'arm_breakeven' });
    const open = toLifecycleEvent({ tradeId: 't', eventType: 'trade_opened', tsMs: 1, fillPrice: '0.1', triggerPrice: null, qty: '5', reason: 'signal' });
    expect(open).toEqual({ tsMs: 1, type: 'entry', price: '0.1', qty: '5', note: 'signal' });
  });
  it('returns null for unknown event types', () => {
    expect(toLifecycleEvent({ tradeId: 't', eventType: 'noise', tsMs: 1, fillPrice: null, triggerPrice: null, qty: null, reason: null })).toBeNull();
  });
});

describe('buildTradeEvidenceByTrade', () => {
  it('groups lifecycle by trade in input order and skips unknown events', () => {
    const trades = [{ tradeId: 't1', runId: 'r1', symbol: 'ESPORTSUSDT', side: 'long' as const,
      openedAtMs: 1, closedAtMs: 9, entryPrice: '0.1', exitPrice: '0.09', realizedPnl: '-1', pnlPct: '-10', closeReason: 'stop_loss' }];
    const life = [
      { tradeId: 't1', eventType: 'trade_opened', tsMs: 1, fillPrice: '0.1', triggerPrice: null, qty: '5', reason: 'signal' },
      { tradeId: 't1', eventType: 'noise', tsMs: 2, fillPrice: null, triggerPrice: null, qty: null, reason: null },
      { tradeId: 't1', eventType: 'trade_closed', tsMs: 9, fillPrice: '0.09', triggerPrice: null, qty: '5', reason: 'stop_loss' },
    ];
    const out = buildTradeEvidenceByTrade(trades, life);
    expect(Object.keys(out)).toEqual(['t1']);
    expect(out['t1']!.lifecycle.map((e) => e.type)).toEqual(['entry', 'exit']);
    expect(out['t1']!.entryPrice).toBe('0.1');
  });
});
```

- [ ] **Step 2: Run — fails**

Run: `pnpm vitest run test/tools/trade-evidence-map.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement pure mapper**

`tools/fetch-snapshot/trade-evidence-map.ts`:
```ts
// Чистый маппер canonical → ops trade-evidence (зеркало get-trade-evidence.ts платформы).
// Используется экспортёром fetch-snapshot; не импортирует pg и не делает IO.

export type OpsLifecycleType = 'entry' | 'dca' | 'tp' | 'sl' | 'exit' | 'stop_update';

export interface EvidenceLifecycleRow {
  readonly tradeId: string;
  readonly eventType: string;
  readonly tsMs: number;
  readonly fillPrice: string | null;
  readonly triggerPrice: string | null;
  readonly qty: string | null;
  readonly reason: string | null;
}

export interface EvidenceTradeRow {
  readonly tradeId: string;
  readonly runId: string;
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly openedAtMs: number;
  readonly closedAtMs: number;
  readonly entryPrice: string | null;
  readonly exitPrice: string | null;
  readonly realizedPnl: string;
  readonly pnlPct: string;
  readonly closeReason: string | null;
}

export interface LifecycleEvt {
  readonly tsMs: number;
  readonly type: OpsLifecycleType;
  readonly price: string | null;
  readonly qty: string | null;
  readonly note: string | null;
}

export interface TradeEvidenceOut extends Omit<EvidenceTradeRow, never> {
  readonly lifecycle: LifecycleEvt[];
}

/** canonical event_type → ops lifecycle-тип; null для неизвестного (defensive skip). */
export function mapEventType(eventType: string): OpsLifecycleType | null {
  switch (eventType) {
    case 'trade_opened': return 'entry';
    case 'trade_scaled_in': return 'dca';
    case 'tp1_armed':
    case 'tp_armed': return 'tp';
    case 'trade_closed': return 'exit';
    default: return null;
  }
}

export function toLifecycleEvent(ev: EvidenceLifecycleRow): LifecycleEvt | null {
  const type = mapEventType(ev.eventType);
  if (type === null) return null;
  // arm-события (tp) несут trigger_price, fill-события — fill_price.
  const price = type === 'tp' ? ev.triggerPrice : ev.fillPrice;
  return { tsMs: ev.tsMs, type, price: price ?? null, qty: ev.qty ?? null, note: ev.reason ?? null };
}

export function buildTradeEvidenceByTrade(
  tradeRows: readonly EvidenceTradeRow[],
  lifecycleRows: readonly EvidenceLifecycleRow[],
): Record<string, TradeEvidenceOut> {
  const byTrade = new Map<string, LifecycleEvt[]>();
  for (const r of lifecycleRows) {
    const evt = toLifecycleEvent(r);
    if (evt === null) continue;
    const list = byTrade.get(r.tradeId) ?? [];
    list.push(evt);
    byTrade.set(r.tradeId, list);
  }
  const out: Record<string, TradeEvidenceOut> = {};
  for (const t of tradeRows) {
    out[t.tradeId] = {
      tradeId: t.tradeId, runId: t.runId, symbol: t.symbol, side: t.side,
      openedAtMs: t.openedAtMs, closedAtMs: t.closedAtMs,
      entryPrice: t.entryPrice, exitPrice: t.exitPrice,
      realizedPnl: t.realizedPnl, pnlPct: t.pnlPct, closeReason: t.closeReason,
      lifecycle: byTrade.get(t.tradeId) ?? [],
    };
  }
  return out;
}
```

- [ ] **Step 4: Run — passes**

Run: `pnpm vitest run test/tools/trade-evidence-map.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire mapper into fetch-snapshot.ts**

В `tools/fetch-snapshot/fetch-snapshot.ts`:

(a) Импорт сверху (рядом с прочими):
```ts
import { buildTradeEvidenceByTrade, type EvidenceTradeRow, type EvidenceLifecycleRow, type TradeEvidenceOut } from './trade-evidence-map.js';
```

(b) В локальный `interface ClosedTrade` добавить поля (после `closedAtMs`):
```ts
  entryPrice: string | null;
  exitPrice: string | null;
```

(c) В `interface OpsData` добавить:
```ts
  tradeEvidenceByTrade: Record<string, TradeEvidenceOut>;
```

(d) Trades-SQL: в `SELECT` добавить два каста (после `closed_at_ms`):
```sql
        avg_entry::text  AS "entryPrice",
        exit_price::text AS "exitPrice",
```
и расширить row-тип `client.query<{...}>` полями `entryPrice: string | null; exitPrice: string | null;`. В пуше в `tradesByRun` добавить `entryPrice: t.entryPrice, exitPrice: t.exitPrice,`. Также накапливать плоский список для evidence:
```ts
    const evidenceTradeRows: EvidenceTradeRow[] = tradesRes.rows.map((t) => ({
      tradeId: t.tradeId, runId: t.runId, symbol: t.symbol, side: t.side as 'long' | 'short',
      openedAtMs: Number(t.openedAtMs), closedAtMs: Number(t.closedAtMs),
      entryPrice: t.entryPrice, exitPrice: t.exitPrice,
      realizedPnl: t.realizedPnl ?? '0', pnlPct: t.pnlPct ?? '0', closeReason: t.closeReason ?? null,
    }));
```

(e) Новый lifecycle-запрос (после decisions-запроса, перед `return`):
```ts
    // ── trade_lifecycle_event (ops.4 Surface A) ──
    const tradeIds = evidenceTradeRows.map((t) => t.tradeId);
    let tradeEvidenceByTrade: Record<string, TradeEvidenceOut> = {};
    if (tradeIds.length > 0) {
      console.log(`[pg] Querying trade_lifecycle_event for ${tradeIds.length} trade(s)…`);
      const lifeRes = await client.query<{
        tradeId: string; eventType: string; tsMs: string;
        fillPrice: string | null; triggerPrice: string | null; qty: string | null; reason: string | null;
      }>(`
        SELECT
          trade_id            AS "tradeId",
          event_type          AS "eventType",
          business_ts_ms::text AS "tsMs",
          fill_price::text     AS "fillPrice",
          trigger_price::text  AS "triggerPrice",
          qty::text            AS "qty",
          reason
        FROM canonical.trade_lifecycle_event
        WHERE trade_id = ANY($1)
        ORDER BY trade_id, sequence_in_trade ASC
      `, [tradeIds]);
      const lifecycleRows: EvidenceLifecycleRow[] = lifeRes.rows.map((r) => ({
        tradeId: r.tradeId, eventType: r.eventType, tsMs: Number(r.tsMs),
        fillPrice: r.fillPrice, triggerPrice: r.triggerPrice, qty: r.qty, reason: r.reason,
      }));
      tradeEvidenceByTrade = buildTradeEvidenceByTrade(evidenceTradeRows, lifecycleRows);
    }
```

(f) В обоих `return`-ах `fetchOps` добавить ключ: пустой ранний return →
`return { runs: [], tradesByRun: {}, eventsByRun: {}, decisionsByRun: {}, tradeEvidenceByTrade: {} };`
финальный return → `return { runs, tradesByRun, eventsByRun, decisionsByRun, tradeEvidenceByTrade };`

(g) `buildBundle` — в объект-литерал бандла добавить (рядом с `decisionsByRun`):
```ts
    tradeEvidenceByTrade: ops.tradeEvidenceByTrade,
```

(h) `mergeWithExisting` — после строки merge `decisionsByRun` добавить:
```ts
  merged['tradeEvidenceByTrade'] = mergeDict((existing['tradeEvidenceByTrade'] as Record<string, unknown>) ?? {}, (newBundle['tradeEvidenceByTrade'] as Record<string, unknown>) ?? {});
```

(i) `writeSnapshot` manifest — `opsReadContractVersion: 'ops.3'` → `'ops.4'`.

- [ ] **Step 6: Typecheck + suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (mapper-тест + всё прежнее).

- [ ] **Step 7: Commit**

```bash
git add tools/fetch-snapshot/ test/tools/trade-evidence-map.test.ts
git commit -m "feat(ops4): fetch-snapshot exports entry/exit + tradeEvidenceByTrade (ops.4 manifest)"
```

---

### Task 6: Реальный fetch (запускает пользователь) + ре-деривация extended + приёмка

**Files:** только данные — `data/snapshots/fixtures/2026-06-18-real-all/**`, `2026-06-16-to-18-extended/**`.

- [ ] **Step 1: Пользователь запускает реальный fetch через `!`**

Команда (`--mode add` обновляет ops-данные реальными entry/exit + lifecycle, сохраняя существующий historical; manifest перештампуется на ops.4 Task 5-кодом). Значения `<...>` — из окружения пользователя (DATABASE_URL/VPS host — те же, что при исходном запечении real-all):
```
! pnpm fetch:snapshot --vps <VPS_HOST> --db-url <DATABASE_URL> --from 2026-06-18 --to 2026-06-18 --ref 2026-06-18-real-all --no-parquet --mode add
```
Ожидаемо в выводе: `[pg] Found N closed trade(s)`, `[pg] Querying trade_lifecycle_event…`, `[snapshot] Written → …/2026-06-18-real-all`.

> Если historical нужно тоже обновить — вместо `--no-parquet --mode add` использовать исходную parquet-команду (`--parquet-root <...>`, mode replace). Для приёмки ops.4 достаточно `--mode add`.

- [ ] **Step 2: Ре-деривация extended**

Run: `! pnpm --config.verify-deps-before-run=false exec tsx scripts/make-extended-fixture.ts`
Expected: `extended fixture '2026-06-16-to-18-extended' written: …`.

- [ ] **Step 3: Приёмка — гейты**

Run: `pnpm check:ci`
Expected: PASS (typecheck, contract-isolation, test, no-forbidden-deps, no-secrets, vendored-sdk ops.4, harness-sync).

- [ ] **Step 4: Приёмка — HTTP smoke на extended**

```bash
MOCK_SNAPSHOT_REF=fixtures/2026-06-16-to-18-extended pnpm dev &
sleep 2
curl -s localhost:8839/ops/discover | grep -o '"opsContractVersion":"ops.4"' && echo DISCOVER_OK
curl -s 'localhost:8839/ops/runs' # → найти runId, затем:
curl -s 'localhost:8839/ops/trades?runId=<RID>' | grep -o '"symbol":"ESPORTSUSDT"[^}]*"entryPrice":"[^"]*"' && echo TRADES_ENTRY_OK
# взять tradeId ESPORTSUSDT-лузера из /ops/trades, затем:
curl -s 'localhost:8839/ops/trade-evidence?tradeIds=<TID>' | grep -o '"lifecycle":\[' && echo LIFECYCLE_OK
kill %1
```
Expected: `DISCOVER_OK`, `TRADES_ENTRY_OK` (реальная цена, не null), `LIFECYCLE_OK` (непустой lifecycle).

- [ ] **Step 5: Commit фикстур**

```bash
git add data/snapshots/fixtures/2026-06-18-real-all data/snapshots/fixtures/2026-06-16-to-18-extended
git commit -m "feat(ops4): re-bake real-all + extended with real ESPORTSUSDT entry/exit + lifecycle"
```

---

## Self-Review

**Spec coverage:**
- ClosedTrade entry/exit → Task 1 (schema/bundle/SDK) + Task 5 (SQL). ✓
- `/ops/trade-evidence` батч cap-25 envelope → Task 3 + Task 4. ✓
- TradeEvidence/TradeLifecycleEvent типы → Task 1 (SDK seam). ✓
- lifecycle маппинг (no synthesis) → Task 5 (pure mapper, unit-tested). ✓
- fetch-snapshot trades-SQL + lifecycle query + tradeEvidenceByTrade → Task 5. ✓
- bundle.ts + schema additionalProperties:false → Task 1. ✓
- dto.local/dto.sdk реэкспорт из SDK 0.8.0 → Task 1. ✓
- version ops.4 + vendored SDK + verify_vendored_sdk → Task 1. ✓
- fetch real-all + make-extended + checksums + manifest ops.4 → Task 5 (manifest) + Task 6 (данные). ✓
- discover ops.4 + trade-evidence → Task 4. ✓
- миграция остальных фикстур (lockstep) → Task 1. ✓

**Placeholder scan:** Значения `<VPS_HOST>`/`<DATABASE_URL>`/`<RID>`/`<TID>` в Task 6 — легитимно user/runtime-supplied (секреты и id из живого ответа), не плейсхолдеры реализации.

**Type consistency:** `readTradeEvidence` (Task 2) ↔ вызывается в `handleTradeEvidence` (Task 3); `TradeEvidencePage` (Task 1) ↔ возврат хендлера; `buildTradeEvidenceByTrade`/`EvidenceTradeRow`/`EvidenceLifecycleRow` (Task 5) согласованы между маппером, тестом и `fetch-snapshot.ts`. `tradeEvidenceByTrade` — одно имя везде (bundle.ts, schema.ts, reader, exporter, merge).
