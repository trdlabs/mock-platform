import type { SnapshotBundle } from '../../contract/snapshot/bundle.js';
import type { RowsPage, CanonicalRowV2 } from '../../contract/historical-read/dto.js';
import type { PageEnvelope } from '../../contract/common/envelopes.js';
import {
  HISTORICAL_PROJECTION_KINDS,
  isHistoricalProjectionKind,
  projectRow,
  type HistoricalProjectionKind,
  type ProjectedCanonicalRowV2,
} from '../../contract/historical-read/projection-kinds.js';
import type { OpsError } from '../../contract/common/errors.js';
import { findDuplicateRowKey, type DayIntegrityRejection } from '../../contract/historical-read/day-integrity.js';
import { readRows, isKnownHistoricalSymbol, isCoarseOnlySymbol } from '../../snapshot/readers/rows.js';
import { hasMinuteGrainBars } from '../../snapshot/readers/rows-from-perkind.js';
import { paginate, invalidCursor } from '../../ops/pagination.js';

function unavailable(): OpsError {
  return { category: 'not_found', code: 'historical_unavailable', message: 'historical data not present in this snapshot' };
}

/** No minute-grain source to serve from — see the P1-2 note in readRows. Distinct code from
 *  `historical_unavailable`: the snapshot HAS historical data, just not at minute grain. The
 *  coarser bars stay in the snapshot and are described, with their own timeframe, by
 *  /historical/coverage and /historical/discover — there is no /historical/bars endpoint. */
function noMinuteGrain(symbols?: readonly string[]): OpsError {
  const scope = symbols !== undefined && symbols.length > 0
    ? `the requested symbol(s) ${[...symbols].sort().join(', ')} carry only coarser-than-minute bars`
    : 'this snapshot carries no minute-grain data';
  return {
    category: 'not_found',
    code: 'minute_rows_unavailable',
    message: `${scope}; /historical/rows serves minute rows only. `
      + 'The bars themselves remain in the snapshot — see /historical/coverage, which states their timeframe.',
  };
}

/** 100 (Д1): страница под проекцию. Без `kinds` совпадает с `RowsPage` строка в строку. */
export type ProjectedRowsPage = PageEnvelope<ProjectedCanonicalRowV2>;

/**
 * Незнакомый вид — ОТКАЗ, а не игнор, и мок обязан отказывать так же, как реальная
 * платформа. Молчаливо отдать меньше, чем просили, здесь опаснее всего: потребитель
 * это бэктестер, он прочитает отсутствие вида как рыночный факт («ликвидаций не
 * было»), а не как свою опечатку. Мок, который на такой запрос отвечает 200 с
 * полными строками, отладил бы потребителя ровно до первой встречи с продом.
 */
function unknownKinds(unknown: readonly string[]): OpsError {
  return {
    category: 'validation_error',
    code: 'unknown_kinds',
    message: `unknown kinds [${unknown.join(', ')}]; supported: ${HISTORICAL_PROJECTION_KINDS.join(', ')}`,
  };
}

export function handleRows(
  bundle: SnapshotBundle,
  params: {
    symbols?: readonly string[]; fromMs?: number; toMs?: number; limit?: number;
    kinds?: undefined;
  },
  asOf: number,
  cursor?: string,
): RowsPage | DayIntegrityRejection | OpsError;
export function handleRows(
  bundle: SnapshotBundle,
  params: {
    symbols?: readonly string[]; fromMs?: number; toMs?: number; limit?: number;
    kinds?: readonly string[];
  },
  asOf: number,
  cursor?: string,
): ProjectedRowsPage | DayIntegrityRejection | OpsError;
export function handleRows(
  bundle: SnapshotBundle,
  params: {
    symbols?: readonly string[] | undefined; fromMs?: number | undefined;
    toMs?: number | undefined; limit?: number | undefined;
    kinds?: readonly string[] | undefined;
  },
  asOf: number,
  cursor?: string,
): RowsPage | ProjectedRowsPage | DayIntegrityRejection | OpsError {
  // `| undefined` в типе параметра обязателен под exactOptionalPropertyTypes: без
  // него сигнатура реализации не принимает `kinds?: undefined` из первой перегрузки.
  // ВАЛИДАЦИЯ ФОРМЫ ЗАПРОСА — ДО ЛЮБЫХ РАННИХ ВЫХОДОВ. Отказ, который отменяется
  // тем, что в снимке не оказалось данных (или что символ незнаком), — не отказ;
  // ровно этот дефект чинился на платформе тем же порядком проверок.
  let kinds: readonly HistoricalProjectionKind[] | undefined;
  if (params.kinds !== undefined && params.kinds.length > 0) {
    const bad = params.kinds.filter((k) => !isHistoricalProjectionKind(k));
    if (bad.length > 0) return unknownKinds(bad);
    kinds = params.kinds as readonly HistoricalProjectionKind[];
  }

  if (!bundle.historical) return unavailable();

  const hist = bundle.historical;
  const { fromMs, toMs, limit } = params;
  const symbols = params.symbols ?? [];

  // The symbol list is de-duplicated first: platform resolves the request through a Set, so
  // `symbols=BTC,BTC` selects one symbol rather than emitting each row twice. Without this the
  // duplicated rows also break the strict global order below, since two rows can then share
  // both minute_ts and symbol.
  const requested = [...new Set(symbols)];

  // Fail loudly rather than serving an empty page when nothing in scope can back minute rows:
  // an empty page is indistinguishable from "your window matched nothing", which is exactly the
  // silent divergence this guard exists to remove (audit P1-2).
  //
  // The check is scoped to the REQUEST, not the snapshot: a mixed snapshot may hold native
  // minute rows for one symbol and only 1h bars for another, and asking for just the latter
  // must fail rather than look like an empty window. A request naming at least one
  // minute-capable symbol is served; coarse-only symbols in it simply contribute nothing.
  const known = requested.filter((s) => isKnownHistoricalSymbol(hist, s));
  if (known.length > 0) {
    if (known.every((s) => isCoarseOnlySymbol(hist, s))) return noMinuteGrain(known);
  } else {
    // Nothing requested resolves to a symbol in this snapshot (unknown symbols, or no symbols
    // at all). Unknown symbols must stay a graceful empty page whenever the resource itself is
    // available, so fall back to the snapshot-wide question discover answers.
    const minuteGrainAvailable = Object.values(hist.rowsBySymbol ?? {}).some((r) => r.length > 0)
      || Object.keys(hist.barsBySymbolAndTimeframe ?? {}).some((s) => hasMinuteGrainBars(hist, s));
    if (!minuteGrainAvailable) return noMinuteGrain();
  }

  // ЦЕЛОСТНОСТЬ ПРОВЕРЯЕТСЯ НАД ВСЕМ ЗАТРОНУТЫМ ДНЁМ ПО ВСЕМ СИМВОЛАМ — до
  // фильтров symbols/fromMs/toMs/kinds и до пагинации.
  //
  // Первая редакция проверяла отфильтрованный набор, и мок отдавал 200 на чистое
  // окно повреждённого дня, тогда как платформа отказывала: она грузит день
  // целиком. Расхождение нашёл conformance-харнесс — две реализации одного
  // контракта разошлись молча, и именно для этого харнесс и существует.
  //
  // Область — ДЕНЬ, а не запрос: недостоверен день, и знание об этом не должно
  // зависеть от того, какое окно и какие символы спросили. Дубль у соседнего
  // символа блокирует запрос так же, как свой.
  //
  // Текущие UTC-сутки исключаются: открытый день ещё дописывается, «весь день»
  // для него не существует как величина, и он остаётся request-scoped.
  {
    const todayUtc = new Date(asOf).toISOString().slice(0, 10);
    const daysTouched = new Set<string>();
    const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
    for (const s of Object.keys(hist.rowsBySymbol ?? {})) {
      for (const r of hist.rowsBySymbol![s] ?? []) {
        const inWindow = (fromMs === undefined || r.minute_ts >= fromMs) && (toMs === undefined || r.minute_ts < toMs);
        if (inWindow) daysTouched.add(dayOf(r.minute_ts));
      }
    }
    const dayRows: CanonicalRowV2[] = [];
    for (const s of Object.keys(hist.rowsBySymbol ?? {})) {
      for (const r of hist.rowsBySymbol![s] ?? []) {
        const d = dayOf(r.minute_ts);
        if (d !== todayUtc && daysTouched.has(d)) dayRows.push(r);
      }
    }
    dayRows.sort((a, b) => a.minute_ts - b.minute_ts || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
    const dayDuplicate = findDuplicateRowKey(dayRows);
    if (dayDuplicate !== null) return dayDuplicate;
  }

  // Gather rows for every requested symbol. Unknown symbols contribute nothing
  // (readRows returns []) — no match yields an empty page.
  const rows: CanonicalRowV2[] = [];
  for (const symbol of requested) {
    rows.push(...readRows(bundle, {
      symbol,
      ...(fromMs !== undefined ? { fromMs } : {}),
      ...(toMs !== undefined ? { toMs } : {}),
    }));
  }

  // A multi-symbol response is one globally ordered stream — (minute_ts ASC, symbol ASC) —
  // not a per-symbol concatenation echoing the caller's symbol order (control-center audit
  // P1-1; platform storage/historical/http/historical-http-app). Sorting happens BEFORE
  // pagination so the order is a property of the whole result set, not of a single page.
  rows.sort((a, b) =>
    a.minute_ts - b.minute_ts || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
  );

  // Остаточная проверка — для ОТКРЫТОГО дня, который в day-wide проход выше не
  // входит: там «весь день» не определён, и область отказа request-scoped.
  // Для закрытых дней она избыточна и никогда не срабатывает — их уже проверили.
  //
  // Целостность ключа — ПОСЛЕ сортировки и ДО проекции с пагинацией.
  //
  // Место то же, что на платформе, и по той же причине: на уровне страницы дубль
  // виден не всегда, а только когда граница страницы не легла между копиями.
  // Проверка страницы объявляла бы набор исправным ровно в тех запросах, где он
  // уже соврал, — а число отданных строк продолжало бы зависеть от `limit`.
  //
  // Дедуп здесь запрещён: выбрать «правильную» из двух строк по данным нельзя,
  // состав источников в строку не попадает. Починка идёт через repair с evidence.
  const duplicate = findDuplicateRowKey(rows);
  if (duplicate !== null) return duplicate;

  // Проекция применяется ПОСЛЕ сортировки и ДО пагинации: порядок задаётся парой
  // (minute_ts, symbol), а она входит в identity и из проекции не выпадает — ни
  // порядок, ни курсор от набора видов не зависят.
  const projected: ProjectedCanonicalRowV2[] = kinds === undefined
    ? rows
    : rows.map((r) => projectRow(r, kinds));

  try {
    return paginate(projected, cursor, limit, {
      asOf,
      window: {
        ...(fromMs !== undefined ? { fromMs } : {}),
        ...(toMs !== undefined ? { toMs } : {}),
      },
    });
  } catch {
    return invalidCursor();
  }
}
