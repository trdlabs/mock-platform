// Контракт доступности бэктеста и допуска окна (Д3, 3.3б) — сторона мока.
//
// Типы и таблица статусов выписаны ЗДЕСЬ и вручную. Импортировать их у платформы
// или у SDK нельзя по двум причинам сразу: контрактная изоляция мока это
// запрещает, и — важнее — оракул, выведенный из проверяемой реализации, краснеет
// только вместе с ней. Совпадение real и mock доказывается тем, что обе стороны
// порознь сошлись с ОДНОЙ таблицей ожиданий, а не тем, что одна списала у другой.

/** Состояние индекса доступности. Четыре, и ни одно не сводится к другому. */
export type AvailabilityState = 'ready' | 'empty' | 'not_initialized' | 'invalid';

export const AVAILABILITY_STATES: readonly AvailabilityState[] = [
  'ready',
  'empty',
  'not_initialized',
  'invalid',
];

export type PreflightRejectCode =
  | 'AVAILABILITY_NOT_INITIALIZED'
  | 'AVAILABILITY_INVALID'
  | 'AVAILABILITY_EMPTY'
  | 'WINDOW_MALFORMED'
  | 'WINDOW_OUTSIDE_AVAILABLE';

/**
 * ТОЧНЫЙ статус для каждого кода — ровно один, а не «один из допустимых».
 *
 * 400 — виноват запрос; 409 — виноват момент (данных ещё или уже нет);
 * 503 — виноват сервис: он не может сказать, чем располагает.
 */
export const PREFLIGHT_STATUS_BY_CODE: Readonly<Record<PreflightRejectCode, number>> = {
  WINDOW_MALFORMED: 400,
  WINDOW_OUTSIDE_AVAILABLE: 409,
  AVAILABILITY_EMPTY: 409,
  AVAILABILITY_NOT_INITIALIZED: 503,
  AVAILABILITY_INVALID: 503,
};

/** Что мок сообщает в `/historical/discover` — диагностически. */
export type AvailabilityDescriptor =
  | {
      readonly state: 'ready' | 'empty';
      readonly earliestAvailableDay: string | null;
      readonly lastContiguousClosedDay: string | null;
      readonly days: number;
      readonly datasetId: string | null;
      readonly builtAtMs: number;
    }
  | { readonly state: 'not_initialized' }
  | { readonly state: 'invalid'; readonly reason: string };

export interface PreflightSuccess {
  readonly ok: true;
  readonly requestedFromMs: number;
  readonly requestedToMs: number;
  readonly effectiveFromMs: number;
  readonly effectiveToMs: number;
  readonly availableFromMs: number;
  readonly availableToMs: number;
  readonly earliestAvailableDay: string;
  readonly lastContiguousClosedDay: string;
  readonly archiveId: string | null;
  readonly datasetId: string | null;
  readonly availabilityId: string;
  readonly asOfMs: number;
  readonly clamped: boolean;
}

export interface PreflightReject {
  readonly ok: false;
  readonly code: PreflightRejectCode;
  readonly message: string;
  readonly availabilityState: AvailabilityState;
}

export type PreflightResult = PreflightSuccess | PreflightReject;

/**
 * Конфигурация доступности снимка.
 *
 * Задаётся ФИКСТУРОЙ, а не HTTP-командой: у настоящей платформы способа сменить
 * состояние по HTTP нет, и заводить его у мока значило бы дать потребителю
 * поверхность, которой на проде не существует.
 */
export interface AvailabilityFixture {
  readonly state: AvailabilityState;
  readonly earliestAvailableDay?: string;
  readonly lastContiguousClosedDay?: string;
  readonly days?: number;
  readonly archiveId?: string | null;
  readonly datasetId?: string | null;
  readonly availabilityId?: string;
  readonly builtAtMs?: number;
  /** Причина для `invalid`. */
  readonly reason?: string;
}
