// Д3 (3.3б) — четыре состояния и пять кодов допуска на стороне мока.
//
// Ожидания выписаны ЗДЕСЬ и руками, не импортированы ни у платформы, ни у SDK.
// Совпадение real и mock доказывается тем, что обе стороны ПОРОЗНЬ сошлись с
// одной таблицей; списав друг у друга, они доказали бы только собственное
// самоподобие.

import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.js';
import type { SnapshotBundle } from '../../src/contract/snapshot/bundle.js';
import type { AvailabilityFixture } from '../../src/contract/historical-read/availability.js';

const DAY_MS = 86_400_000;
const FROM = Date.parse('2026-06-10T00:00:00Z');
const TO = Date.parse('2026-06-12T00:00:00Z') + DAY_MS - 1;

const READY: AvailabilityFixture = {
  state: 'ready',
  earliestAvailableDay: '2026-06-10',
  lastContiguousClosedDay: '2026-06-12',
  days: 3,
  archiveId: 'arch-mock',
  datasetId: 'ds-mock',
  availabilityId: `sha256:${'a'.repeat(64)}`,
  builtAtMs: 1_700_000_000_000,
};

function appWith(availability?: AvailabilityFixture) {
  const bundle = {
    historical: {
      barsBySymbolAndTimeframe: {},
      rowsBySymbol: {},
      ...(availability ? { availability } : {}),
    },
  } as unknown as SnapshotBundle;
  return createApp({
    snapshot: { bundle } as never,
    tokenAllowlist: [],
    replay: { mode: 'once', speed: 1 },
  }).app;
}

const call = async (fx: AvailabilityFixture | undefined, path: string) => {
  const res = await appWith(fx).request(`http://mock${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const REJECT_KEYS = ['availabilityState', 'code', 'message', 'ok'];
const SUCCESS_KEYS = [
  'archiveId', 'asOfMs', 'availabilityId', 'availableFromMs', 'availableToMs', 'clamped',
  'datasetId', 'earliestAvailableDay', 'effectiveFromMs', 'effectiveToMs',
  'lastContiguousClosedDay', 'ok', 'requestedFromMs', 'requestedToMs',
];

describe('/historical/preflight — четыре состояния, пять кодов', () => {
  it('умолчание фикстуры — not_initialized, а не empty', async () => {
    // Разное: «индекса нет» против «закрытых дней нет». Слив их, потребитель не
    // отличил бы пустой архив от ненастроенного сервиса.
    const d = await call(undefined, '/historical/discover');
    expect(d.body.availability).toEqual({ state: 'not_initialized' });
  });

  it.each([
    ['not_initialized', { state: 'not_initialized' } as AvailabilityFixture, 503, 'AVAILABILITY_NOT_INITIALIZED'],
    ['invalid', { state: 'invalid', reason: 'битый' } as AvailabilityFixture, 503, 'AVAILABILITY_INVALID'],
    ['empty', { state: 'empty' } as AvailabilityFixture, 409, 'AVAILABILITY_EMPTY'],
  ])('%s → %d/%s и ровно четыре поля', async (state, fx, status, code) => {
    const r = await call(fx, `/historical/preflight?fromMs=${FROM}&toMs=${TO}`);
    expect(r.status).toBe(status);
    expect(r.body.code).toBe(code);
    expect(r.body.ok).toBe(false);
    expect(r.body.availabilityState).toBe(state);
    expect(Object.keys(r.body).sort()).toEqual(REJECT_KEYS);
  });

  it('три состояния дают три РАЗНЫХ кода', async () => {
    const codes = new Set<unknown>();
    for (const fx of [
      { state: 'not_initialized' } as AvailabilityFixture,
      { state: 'invalid', reason: 'x' } as AvailabilityFixture,
      { state: 'empty' } as AvailabilityFixture,
    ]) {
      codes.add((await call(fx, `/historical/preflight?fromMs=${FROM}&toMs=${TO}`)).body.code);
    }
    expect(codes.size).toBe(3);
  });

  it('ready: окно шире доступного обрезается наблюдаемо', async () => {
    const r = await call(READY, `/historical/preflight?fromMs=0&toMs=9999999999999`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.clamped).toBe(true);
    // Запрошенное возвращается КАК БЫЛО — иначе в evidence прогона попал бы
    // период, которого никто не просил.
    expect(r.body.requestedFromMs).toBe(0);
    expect(r.body.requestedToMs).toBe(9999999999999);
    expect(r.body.effectiveFromMs).toBe(FROM);
    expect(r.body.effectiveToMs).toBe(TO);
    expect(Object.keys(r.body).sort()).toEqual(SUCCESS_KEYS);
  });

  it('ready: точное совпадение с границами не считается обрезкой', async () => {
    const exact = await call(READY, `/historical/preflight?fromMs=${FROM}&toMs=${TO}`);
    expect(exact.body.clamped).toBe(false);
    // Разделяющий негатив: на миллисекунду дальше — уже обрезка.
    const plus = await call(READY, `/historical/preflight?fromMs=${FROM}&toMs=${TO + 1}`);
    expect(plus.body.clamped).toBe(true);
    expect(plus.body.effectiveToMs).toBe(TO);
  });

  it('ready: пустое пересечение отвергается, а не отдаётся пустым успехом', async () => {
    const r = await call(READY, `/historical/preflight?fromMs=${TO + 1}&toMs=${TO + DAY_MS}`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('WINDOW_OUTSIDE_AVAILABLE');
    expect(Object.keys(r.body).sort()).toEqual(REJECT_KEYS);
  });

  it('решение несёт идентичность', async () => {
    const r = await call(READY, `/historical/preflight?fromMs=${FROM}&toMs=${TO}`);
    expect(r.body.archiveId).toBe('arch-mock');
    expect(r.body.datasetId).toBe('ds-mock');
    expect(r.body.availabilityId).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Часы у мока настоящие: проверяем, что момент решения назван и правдоподобен.
    expect(Number.isSafeInteger(r.body.asOfMs)).toBe(true);
    expect(Math.abs(Number(r.body.asOfMs) - Date.now())).toBeLessThan(60_000);
  });

  it.each([
    ['кривое окно', '?fromMs=нет&toMs=тоже'],
    ['без параметров', ''],
    ['пустые параметры', '?fromMs=&toMs='],
    ['from > to', `?fromMs=${TO}&toMs=${FROM}`],
    ['нецелое', `?fromMs=${FROM}.5&toMs=${TO}`],
  ])('%s → 400 WINDOW_MALFORMED в любом состоянии', async (_label, qs) => {
    // Форма запроса проверяется ДО состояния индекса: иначе клиент с опечаткой
    // получал бы отказ про незавершённую выкатку и чинил бы не то.
    for (const fx of [READY, { state: 'not_initialized' } as AvailabilityFixture]) {
      const r = await call(fx, `/historical/preflight${qs}`);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('WINDOW_MALFORMED');
      expect(Object.keys(r.body).sort()).toEqual(REJECT_KEYS);
    }
  });

  it('discover сообщает состояние и не отказывает даже при invalid', async () => {
    for (const [fx, state] of [
      [READY, 'ready'],
      [{ state: 'empty' } as AvailabilityFixture, 'empty'],
      [{ state: 'not_initialized' } as AvailabilityFixture, 'not_initialized'],
      [{ state: 'invalid', reason: 'битый' } as AvailabilityFixture, 'invalid'],
    ] as const) {
      const d = await call(fx, '/historical/discover');
      expect(d.status).toBe(200);
      expect((d.body.availability as { state: string }).state).toBe(state);
    }
  });

  it('/historical/rows остаётся диагностическим', async () => {
    // Policy-clamp живёт ровно в одном месте. Иначе потребитель, отлаженный на
    // моке, получил бы на проде другую границу допуска.
    const res = await appWith({ state: 'not_initialized' })
      .request('http://mock/historical/rows?symbols=BTCUSDT&fromMs=0&toMs=9999999999999');
    // Фикстура пустая, поэтому символа нет — но важно ДРУГОЕ: ответ не является
    // отказом допуска. Ни статуса допуска, ни его кода в нём быть не должно.
    expect([503, 409]).not.toContain(res.status);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    expect(body.code).not.toMatch(/^AVAILABILITY_/);
  });
});
