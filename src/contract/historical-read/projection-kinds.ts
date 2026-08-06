// 100 (Д1) — виды проекции архивной строки: словарь фильтра `kinds` у /historical/rows.
//
// Объявлено здесь заново, а не импортировано из платформы: кросс-репозиторных
// импортов у мока нет по построению (verify_contract_isolation), контракт зеркалится
// так же, как остальные DTO. Совпадение с реальной платформой держит НЕ общий
// модуль, а conformance-харнесс из @trdlabs/sdk, который обе стороны гоняют против
// себя. Разъехавшийся словарь — это провалившийся харнесс, а не тихое расхождение.
//
// Имя `HistoricalProjectionKind`, а не `MarketDataKind`: последнее уже занято в
// @trdlabs/sdk под ДРУГУЮ величину (состояние покрытия фидов: openInterest /
// liquidations / funding / taker, camelCase, без свечей). Проволочный параметр
// при этом называется `kinds` с обеих сторон.

import type { CanonicalRowV2 } from './dto.sdk.js';

/** Порядок канонический: он же задаёт порядок колонок в ответе. */
export const HISTORICAL_PROJECTION_KINDS = [
  'candles',
  'open_interest',
  'liquidations',
  'taker_volume',
  'funding',
] as const;

export type HistoricalProjectionKind = (typeof HISTORICAL_PROJECTION_KINDS)[number];

export function isHistoricalProjectionKind(v: string): v is HistoricalProjectionKind {
  return (HISTORICAL_PROJECTION_KINDS as readonly string[]).includes(v);
}

/** Поля, которые есть в любом ответе: без них строку нельзя ни отнести, ни истолковать. */
export const IDENTITY_COLUMNS = ['schema_version', 'minute_ts', 'symbol'] as const;

/**
 * Вид → его колонки. Значение и флаг присутствия — в ОДНОЙ группе и врозь не
 * запрашиваются: строка с `oi_total_usd` без `has_oi` не позволила бы отличить
 * «источника не было» от «мы это не просили».
 */
export const COLUMNS_BY_KIND: Readonly<Record<HistoricalProjectionKind, readonly (keyof CanonicalRowV2)[]>> = {
  candles: ['open', 'high', 'low', 'close', 'volume', 'turnover'],
  open_interest: ['oi_total_usd', 'has_oi'],
  liquidations: ['liq_long_usd', 'liq_short_usd', 'has_liquidations'],
  taker_volume: ['taker_buy_volume_usd', 'taker_sell_volume_usd', 'has_taker_flow'],
  funding: ['funding_rate', 'has_funding'],
};

/**
 * Строка под проекцию: identity есть всегда, остальное — только если вид запрошен.
 * Непрошенное поле ОТСУТСТВУЕТ, а не приезжает `null`/`false`.
 */
export type ProjectedCanonicalRowV2 =
  Pick<CanonicalRowV2, 'schema_version' | 'minute_ts' | 'symbol'> & Partial<CanonicalRowV2>;

/**
 * Проекция строки. Поля именно УДАЛЯЮТСЯ (собирается новый объект), а не
 * затираются нулями: подставленный `has_oi: false` был бы утверждением о рынке,
 * которого никто не делал, и бэктест прочитал бы его как факт.
 */
export function projectRow(
  row: CanonicalRowV2,
  kinds?: readonly HistoricalProjectionKind[],
): ProjectedCanonicalRowV2 {
  if (kinds === undefined || kinds.length === 0) return row;
  const wanted = new Set<string>(IDENTITY_COLUMNS);
  for (const k of kinds) for (const c of COLUMNS_BY_KIND[k]) wanted.add(c as string);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) if (wanted.has(key)) out[key] = value;
  return out as ProjectedCanonicalRowV2;
}
