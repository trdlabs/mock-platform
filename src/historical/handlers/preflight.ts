// GET /historical/preflight — допуск окна и наблюдаемый clamp (Д3, 3.3б).
//
// Зеркало платформенного поведения, написанное НЕЗАВИСИМО. Совпадение с
// платформой доказывается сверкой обеих сторон с общей таблицей ожиданий, а не
// общим кодом: общий код доказал бы только то, что он сам себе равен.
//
// `/historical/rows` остаётся диагностическим и здесь тоже: policy-clamp живёт
// ровно в одном месте, иначе потребитель, отлаженный на моке, получил бы на
// проде другую границу допуска.

import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import {
  PREFLIGHT_STATUS_BY_CODE,
  type AvailabilityDescriptor,
  type AvailabilityFixture,
  type PreflightRejectCode,
  type PreflightResult,
} from '../../contract/historical-read/availability.js';

const DAY_MS = 86_400_000;

const dayStartMs = (date: string): number => Date.parse(`${date}T00:00:00.000Z`);
/** Последняя миллисекунда суток ВКЛЮЧИТЕЛЬНО — как и `/historical/coverage`. */
const dayEndMs = (date: string): number => dayStartMs(date) + DAY_MS - 1;

/**
 * Состояние снимка. Фикстура молчит — значит `not_initialized`.
 *
 * Умолчание именно такое, а не `empty`: у мока нет индекса закрытых дней, пока
 * фикстура его не объявила, и выдавать «закрытых дней нет» за «индекса нет»
 * значило бы стереть ровно то различие, ради которого состояний четыре.
 */
export function availabilityOf(bundle: SnapshotBundle): AvailabilityFixture {
  return bundle.historical?.availability ?? { state: 'not_initialized' };
}

export function buildAvailabilityDescriptor(fx: AvailabilityFixture): AvailabilityDescriptor {
  if (fx.state === 'not_initialized') return { state: 'not_initialized' };
  if (fx.state === 'invalid') return { state: 'invalid', reason: fx.reason ?? 'причина не названа' };
  const isReady = fx.state === 'ready';
  return {
    state: fx.state,
    earliestAvailableDay: isReady ? (fx.earliestAvailableDay ?? null) : null,
    lastContiguousClosedDay: isReady ? (fx.lastContiguousClosedDay ?? null) : null,
    days: fx.days ?? 0,
    datasetId: fx.datasetId ?? null,
    builtAtMs: fx.builtAtMs ?? 0,
  };
}

export interface PreflightOutcome {
  readonly status: number;
  readonly body: PreflightResult;
}

/**
 * Разрешить окно.
 *
 * Порядок проверок значим: форма запроса смотрится ДО состояния индекса. Иначе
 * кривое окно к ненастроенному сервису получало бы отказ про незавершённую
 * выкатку, и клиент чинил бы не то.
 */
export function handleHistoricalPreflight(
  bundle: SnapshotBundle,
  fromRaw: string | undefined,
  toRaw: string | undefined,
  nowMs: number,
): PreflightOutcome {
  const fx = availabilityOf(bundle);
  // `Number('')` — это НОЛЬ, а не NaN: пустой параметр через обычное приведение
  // стал бы законной границей 1970 года.
  const num = (v: string | undefined): number => (v === undefined || v === '' ? Number.NaN : Number(v));
  const requestedFromMs = num(fromRaw);
  const requestedToMs = num(toRaw);

  const reject = (code: PreflightRejectCode, message: string): PreflightOutcome => ({
    status: PREFLIGHT_STATUS_BY_CODE[code],
    body: { ok: false, code, message, availabilityState: fx.state },
  });

  if (
    !Number.isFinite(requestedFromMs) ||
    !Number.isFinite(requestedToMs) ||
    !Number.isSafeInteger(requestedFromMs) ||
    !Number.isSafeInteger(requestedToMs)
  ) {
    return reject('WINDOW_MALFORMED', 'границы окна должны быть целыми числами ms');
  }
  if (requestedFromMs > requestedToMs) {
    return reject('WINDOW_MALFORMED', `from (${requestedFromMs}) больше to (${requestedToMs})`);
  }

  if (fx.state === 'not_initialized') {
    return reject('AVAILABILITY_NOT_INITIALIZED', 'индекс доступности не опубликован');
  }
  if (fx.state === 'invalid') {
    return reject('AVAILABILITY_INVALID', `индексу нельзя верить: ${fx.reason ?? 'причина не названа'}`);
  }
  if (fx.state === 'empty' || fx.earliestAvailableDay === undefined || fx.lastContiguousClosedDay === undefined) {
    return reject('AVAILABILITY_EMPTY', 'закрытых дней нет: доступного интервала не существует');
  }

  const availableFromMs = dayStartMs(fx.earliestAvailableDay);
  const availableToMs = dayEndMs(fx.lastContiguousClosedDay);
  const effectiveFromMs = Math.max(requestedFromMs, availableFromMs);
  const effectiveToMs = Math.min(requestedToMs, availableToMs);
  if (effectiveFromMs > effectiveToMs) {
    return reject(
      'WINDOW_OUTSIDE_AVAILABLE',
      `окно [${requestedFromMs}, ${requestedToMs}] не пересекается с доступным [${availableFromMs}, ${availableToMs}]`,
    );
  }

  return {
    status: 200,
    body: {
      ok: true,
      requestedFromMs,
      requestedToMs,
      effectiveFromMs,
      effectiveToMs,
      availableFromMs,
      availableToMs,
      earliestAvailableDay: fx.earliestAvailableDay,
      lastContiguousClosedDay: fx.lastContiguousClosedDay,
      archiveId: fx.archiveId ?? null,
      datasetId: fx.datasetId ?? null,
      availabilityId: fx.availabilityId ?? `sha256:${'0'.repeat(64)}`,
      asOfMs: nowMs,
      clamped: effectiveFromMs !== requestedFromMs || effectiveToMs !== requestedToMs,
    },
  };
}
