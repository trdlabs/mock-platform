// 100 (Д1) — проекция колонок по видам на стороне мока.
//
// Проверки намеренно зеркалят платформенный гейт verify_100_column_projection:
// пока `kinds` не въехал в общий conformance-харнесс (@trdlabs/sdk/conformance —
// требует релиза пакета и бампа пина в обоих репозиториях), «mock == real» по
// этому фильтру держится ДВУМЯ зеркальными наборами проверок, а не одним общим
// кодом. Это временно и хуже харнесса; когда харнесс обновится, отсюда уедут те
// проверки, которые он начнёт делать сам.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { handleRows } from '../../src/historical/handlers/rows.js';
import { buildHistoricalDiscover } from '../../src/historical/handlers/discover.js';
import { openSnapshot } from '../../src/snapshot/registry.js';
import { createApp } from '../../src/http/app.js';
import type { LoadedSnapshot } from '../../src/snapshot/loader.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';
import type { CanonicalRowV2 } from '../../src/contract/historical-read/dto.js';
import {
  HISTORICAL_PROJECTION_KINDS,
  IDENTITY_COLUMNS,
  COLUMNS_BY_KIND,
  type HistoricalProjectionKind,
} from '../../src/contract/historical-read/projection-kinds.js';
import { isOpsError } from '../../src/contract/common/errors.js';
import { isDayIntegrityRejection } from '../../src/contract/historical-read/day-integrity.js';

function row(symbol: string, minute_ts: number, i: number): CanonicalRowV2 {
  return {
    schema_version: 2,
    minute_ts,
    symbol,
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10 + i, turnover: 1005 + i,
    oi_total_usd: 1_000_000 + i,
    funding_rate: 0.0001,
    liq_long_usd: 5,
    liq_short_usd: 7,
    // Флаги нарочно РАЗНЫЕ: однородные значения не показали бы подставленный дефолт.
    has_oi: i % 2 === 0,
    has_funding: true,
    has_liquidations: i % 3 !== 0,
    taker_buy_volume_usd: 500 + i,
    taker_sell_volume_usd: 400 + i,
    has_taker_flow: i % 5 !== 0,
  };
}

const T0 = 60_000;
const N = 12;
const rows = Array.from({ length: N }, (_, i) => row('AAAUSDT', T0 + i * 60_000, i));
const bundle = { historical: { rowsBySymbol: { AAAUSDT: rows }, barsBySymbolAndTimeframe: {} } } as unknown as SnapshotBundle;
const emptyBundle = {} as unknown as SnapshotBundle;

// НЕЗАВИСИМЫЙ oracle: разбиение схемы по видам, выписанное здесь РУКАМИ и НЕ
// импортируемое из `projection-kinds`.
//
// Без него разбиение нигде не зафиксировано независимо: и `projectRow`, и
// ожидание теста брали бы `COLUMNS_BY_KIND`, поэтому ПЕРЕНОС колонки из одного
// вида в другой менял бы обе стороны разом. Объединение осталось бы теми же 19
// полями, проверка покрытия схемы промолчала бы, и табличный прогон остался бы
// зелёным. Проверено мутацией 2026-08-07 (`has_oi` из open_interest в funding):
// покраснела единственная проверка, где список был набран руками, — то есть
// защита существовала, но случайно.
//
// Расхождение этой таблицы с `COLUMNS_BY_KIND` — красный тест. Менять её надо
// осознанно и вместе со схемой, в этом и смысл.
const EXPECTED_COLUMNS: Readonly<Record<HistoricalProjectionKind, readonly string[]>> = {
  candles: ['open', 'high', 'low', 'close', 'volume', 'turnover'],
  open_interest: ['oi_total_usd', 'has_oi'],
  liquidations: ['liq_long_usd', 'liq_short_usd', 'has_liquidations'],
  taker_volume: ['taker_buy_volume_usd', 'taker_sell_volume_usd', 'has_taker_flow'],
  funding: ['funding_rate', 'has_funding'],
};

const CANDLES = ['open', 'high', 'low', 'close', 'volume', 'turnover'];
const NOT_CANDLES = [
  'oi_total_usd', 'has_oi', 'funding_rate', 'has_funding',
  'liq_long_usd', 'liq_short_usd', 'has_liquidations',
  'taker_buy_volume_usd', 'taker_sell_volume_usd', 'has_taker_flow',
];

const page = (kinds?: readonly string[]) => {
  const r = handleRows(bundle, { symbols: ['AAAUSDT'], ...(kinds ? { kinds } : {}) }, 0);
  if (isOpsError(r)) throw new Error(`unexpected OpsError: ${r.code}`);
  // Третий исход `handleRows` — отказ целостности ключа. Фикстура этого файла
  // дублей не содержит, поэтому исход недостижим; отсекается явно, чтобы он не
  // проехал в проверки проекции под видом страницы.
  if (isDayIntegrityRejection(r)) throw new Error(`unexpected day-integrity rejection: ${r.body.symbol}`);
  return r;
};

describe('100 (Д1): словарь видов покрывает схему', () => {
  it('объединение identity и пяти видов = ровно 19 канонических полей', () => {
    const covered = new Set<string>(IDENTITY_COLUMNS);
    for (const k of HISTORICAL_PROJECTION_KINDS) for (const c of COLUMNS_BY_KIND[k]) covered.add(c as string);
    const actual = Object.keys(rows[0]!).sort();
    expect([...covered].sort()).toEqual(actual);
    expect(actual).toHaveLength(19);
  });

  it('видов ровно пять и порядок канонический', () => {
    expect([...HISTORICAL_PROJECTION_KINDS]).toEqual([
      'candles', 'open_interest', 'liquidations', 'taker_volume', 'funding',
    ]);
  });

  // Единственное место, где разбиение схемы по видам зафиксировано НЕЗАВИСИМО от
  // словаря, которым пользуется реализация. Ловит перенос колонки между видами —
  // мутацию, при которой объединение остаётся теми же 19 полями.
  it('разбиение по видам совпадает с независимым списком теста', () => {
    for (const k of HISTORICAL_PROJECTION_KINDS) {
      expect(new Set(COLUMNS_BY_KIND[k] as readonly string[])).toEqual(new Set(EXPECTED_COLUMNS[k]));
    }
  });
});

describe('100 (Д1): проекция удаляет поля, а не обнуляет их', () => {
  it('непрошенные поля ОТСУТСТВУЮТ (проверка через in, не по значению)', () => {
    const projected = page(['candles']);
    expect(projected.items).toHaveLength(N);
    for (const r of projected.items) {
      for (const f of NOT_CANDLES) expect(f in r).toBe(false);
      for (const f of CANDLES) expect(f in r).toBe(true);
      for (const f of IDENTITY_COLUMNS) expect(f in r).toBe(true);
    }
  });

  it('значения запрошенных полей совпадают с полным чтением', () => {
    const full = page();
    const projected = page(['candles', 'open_interest']);
    const byKey = new Map(full.items.map((r) => [`${r.minute_ts}|${r.symbol}`, r]));
    for (const r of projected.items) {
      const f = byKey.get(`${r.minute_ts}|${r.symbol}`)!;
      for (const k of [...CANDLES, 'oi_total_usd', 'has_oi']) {
        expect(r[k as keyof typeof r]).toEqual(f[k as keyof typeof f]);
      }
    }
  });

  it('без параметра отдаются все 19 полей, как до 100', () => {
    for (const r of page().items) expect(Object.keys(r)).toHaveLength(19);
  });

  // Табличный прогон по ВСЕМ пяти видам, а не по трём удобным. До этого
  // `liquidations` и `taker_volume` жили только в статической проверке словаря:
  // опечатка в их колонках прошла бы мимо тестов, а зеркальность контракта
  // именно на них и держится. Таблица строится ИЗ словаря, поэтому шестой вид
  // нельзя будет добавить, не получив для него проверку автоматически.
  it.each(HISTORICAL_PROJECTION_KINDS.map((k) => [k] as const))(
    'вид %s: отдаются ровно его колонки и identity, остальные отсутствуют',
    (kind: HistoricalProjectionKind) => {
      // Ожидание — из НЕЗАВИСИМОГО списка, не из словаря реализации.
      const wanted = new Set<string>([...IDENTITY_COLUMNS, ...EXPECTED_COLUMNS[kind]]);
      const projected = page([kind]);
      expect(projected.items).toHaveLength(N);
      const full = new Map(page().items.map((r) => [`${r.minute_ts}|${r.symbol}`, r]));
      for (const r of projected.items) {
        expect(new Set(Object.keys(r))).toEqual(wanted);
        const f = full.get(`${r.minute_ts}|${r.symbol}`)!;
        for (const c of EXPECTED_COLUMNS[kind]) {
          expect(r[c as keyof typeof r]).toEqual(f[c as keyof typeof f]);
        }
      }
    },
  );

  it('пары видов дают ровно объединение их колонок', () => {
    const pairs: (readonly [(typeof HISTORICAL_PROJECTION_KINDS)[number], (typeof HISTORICAL_PROJECTION_KINDS)[number]])[] = [
      ['liquidations', 'taker_volume'],
      ['open_interest', 'funding'],
      ['candles', 'liquidations'],
    ];
    for (const [a, b] of pairs) {
      const wanted = new Set<string>([...IDENTITY_COLUMNS, ...EXPECTED_COLUMNS[a], ...EXPECTED_COLUMNS[b]]);
      for (const r of page([a, b]).items) expect(new Set(Object.keys(r))).toEqual(wanted);
    }
  });

  it('порядок видов не влияет на результат', () => {
    expect(page(['candles', 'funding']).items).toEqual(page(['funding', 'candles']).items);
  });

  it('пагинация и её курсор от набора видов не зависят', () => {
    const a = handleRows(bundle, { symbols: ['AAAUSDT'], limit: 5 }, 0);
    const b = handleRows(bundle, { symbols: ['AAAUSDT'], limit: 5, kinds: ['candles'] }, 0);
    if (isOpsError(a) || isOpsError(b)) throw new Error('unexpected OpsError');
    if (isDayIntegrityRejection(a) || isDayIntegrityRejection(b)) throw new Error('unexpected day-integrity rejection');
    expect(b.nextCursor).toEqual(a.nextCursor);
    expect(b.items.map((r) => [r.minute_ts, r.symbol])).toEqual(a.items.map((r) => [r.minute_ts, r.symbol]));
  });
});

describe('100 (Д1): незнакомый вид — отказ, и отказ не отменяется второй ошибкой', () => {
  it('незнакомый вид → validation_error', () => {
    const r = handleRows(bundle, { symbols: ['AAAUSDT'], kinds: ['bogus'] }, 0);
    expect(isOpsError(r) && r.category).toBe('validation_error');
    expect(isOpsError(r) && r.code).toBe('unknown_kinds');
  });

  it('незнакомый вид + незнакомый символ → всё равно отказ по виду', () => {
    const r = handleRows(bundle, { symbols: ['НЕТТАКОГО'], kinds: ['bogus'] }, 0);
    expect(isOpsError(r) && r.code).toBe('unknown_kinds');
  });

  it('незнакомый вид + снимок без истории → всё равно отказ по виду, а не not_found', () => {
    const r = handleRows(emptyBundle, { symbols: ['AAAUSDT'], kinds: ['bogus'] }, 0);
    expect(isOpsError(r) && r.code).toBe('unknown_kinds');
  });

  it('незнакомый символ без ошибок формы остаётся пустой страницей', () => {
    const r = handleRows(bundle, { symbols: ['НЕТТАКОГО'] }, 0);
    expect(isOpsError(r)).toBe(false);
  });
});

describe('100 (Д1): discover объявляет фильтр и словарь', () => {
  it('rows объявляет kinds в supportedFilters и сам словарь', () => {
    const d = buildHistoricalDiscover(bundle);
    const rowsRes = d.resources.find((r) => r.name === 'rows')!;
    expect(rowsRes.supportedFilters).toContain('kinds');
    expect(rowsRes.kinds).toEqual([...HISTORICAL_PROJECTION_KINDS]);
  });
});

describe('100 (Д1): HTTP-граница мока ведёт себя как платформа', () => {
  let snap: LoadedSnapshot;
  let server: ReturnType<typeof serve>;
  let baseUrl: string;

  beforeAll(async () => {
    snap = openSnapshot('data/snapshots/fixtures', 'historical-golden');
    const { app } = createApp({ snapshot: snap, tokenAllowlist: [], replay: { mode: 'once', speed: 1 } });
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  type Body = { items: Record<string, unknown>[] };
  type Discover = { resources: { name: string; supportedFilters: string[]; kinds?: string[] }[] };

  it('kinds=candles → 200, есть свечи, нет OI', async () => {
    const res = await fetch(`${baseUrl}/historical/rows?symbols=BTCUSDT&kinds=candles`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.items.length).toBeGreaterThan(0);
    expect('close' in body.items[0]!).toBe(true);
    expect('oi_total_usd' in body.items[0]!).toBe(false);
  });

  it('kinds=bogus → 400', async () => {
    const res = await fetch(`${baseUrl}/historical/rows?symbols=BTCUSDT&kinds=bogus`);
    expect(res.status).toBe(400);
  });

  it('kinds=bogus с незнакомым символом → всё равно 400', async () => {
    const res = await fetch(`${baseUrl}/historical/rows?symbols=НЕТТАКОГО&kinds=bogus`);
    expect(res.status).toBe(400);
  });

  // Тот же табличный прогон, но через настоящую HTTP-границу: разбор CSV и
  // сборка ответа — отдельный от обработчика код, и мимо него проекция тоже
  // может протечь.
  it.each(HISTORICAL_PROJECTION_KINDS.map((k) => [k] as const))(
    'HTTP, вид %s: в ответе ровно его колонки и identity',
    async (kind: HistoricalProjectionKind) => {
      const wanted = new Set<string>([...IDENTITY_COLUMNS, ...EXPECTED_COLUMNS[kind]]);
      const res = await fetch(`${baseUrl}/historical/rows?symbols=BTCUSDT&kinds=${kind}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Body;
      expect(body.items.length).toBeGreaterThan(0);
      for (const r of body.items) expect(new Set(Object.keys(r))).toEqual(wanted);
    },
  );

  it('без kinds — все 19 полей, как до 100', async () => {
    const res = await fetch(`${baseUrl}/historical/rows?symbols=BTCUSDT`);
    const body = (await res.json()) as Body;
    expect(Object.keys(body.items[0]!)).toHaveLength(19);
  });

  it('discover по HTTP объявляет словарь видов', async () => {
    const d = (await (await fetch(`${baseUrl}/historical/discover`)).json()) as Discover;
    const rowsRes = d.resources.find((r) => r.name === 'rows')!;
    expect(rowsRes.supportedFilters).toContain('kinds');
    expect(rowsRes.kinds).toEqual([...HISTORICAL_PROJECTION_KINDS]);
  });
});
