// Целостность ключа дня (Д3) — форма отказа `/historical/rows`.
//
// Зеркало платформенного поведения, написанное НЕЗАВИСИМО. Совпадение
// доказывается сверкой обеих сторон с общей таблицей ожиданий conformance-
// харнесса, а не общим кодом: общий код доказал бы только то, что он сам себе
// равен.
//
// Контракт чтения объявляет `(minute_ts, symbol)` тотальным порядком — на нём
// построен keyset-курсор. Дубль эту тотальность отменяет, и последствие не
// «минута приходит дважды», а хуже: курсор роняет вторую копию, если граница
// страницы легла между копиями, и возвращает, если не легла. Один запрос отдаёт
// разное число строк при разном `limit`.
//
// Мок обязан отказывать так же, как прод. Мок, отдающий на такой набор 200,
// отладил бы потребителя ровно до первой встречи с настоящим архивом.

/** Ровно один статус и ровно один код. */
export const DAY_INTEGRITY_STATUS = 409;
export const DAY_INTEGRITY_CODE = 'DUPLICATE_ROW_KEY' as const;

/**
 * Тело отказа. Набор полей ТОЧНЫЙ — лишнее поле такое же расхождение контракта,
 * как недостающее.
 *
 * `permanent` и `retryFromStart` объявлены явно, а не выводятся из кода: под
 * 409 у этого эндпоинта живёт и второй факт (смена поколения), который как раз
 * разрешается повтором, и различить их потребитель должен по телу.
 */
export interface DayIntegrityRejectionBody {
  readonly error: 'day integrity violated';
  readonly code: typeof DAY_INTEGRITY_CODE;
  readonly permanent: true;
  readonly retryFromStart: false;
  readonly date: string;
  readonly symbol: string;
  readonly minuteTs: number;
  /** У снимка sidecar'ов нет — поколение всегда `null`, и это законный случай. */
  readonly generation: number | null;
}

export interface DayIntegrityRejection {
  readonly kind: 'day_integrity_rejection';
  readonly status: typeof DAY_INTEGRITY_STATUS;
  readonly body: DayIntegrityRejectionBody;
}

export function isDayIntegrityRejection(v: unknown): v is DayIntegrityRejection {
  return typeof v === 'object' && v !== null && (v as { kind?: unknown }).kind === 'day_integrity_rejection';
}

/** Минимум, который нужен проверке. */
interface RowKey {
  readonly minute_ts: number;
  readonly symbol: string;
}

/**
 * Первый повтор ключа в ОТСОРТИРОВАННОМ наборе, либо `null`.
 *
 * Вызывается после сортировки и ДО пагинации: на уровне страницы дубль виден не
 * всегда, а только когда граница страницы не легла между копиями, — то есть
 * проверка объявляла бы набор исправным ровно в тех запросах, где он уже соврал.
 */
export function findDuplicateRowKey(rows: readonly RowKey[]): DayIntegrityRejection | null {
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1] as RowKey;
    const cur = rows[i] as RowKey;
    if (cur.minute_ts === prev.minute_ts && cur.symbol === prev.symbol) {
      return {
        kind: 'day_integrity_rejection',
        status: DAY_INTEGRITY_STATUS,
        body: {
          error: 'day integrity violated',
          code: DAY_INTEGRITY_CODE,
          permanent: true,
          retryFromStart: false,
          date: new Date(cur.minute_ts).toISOString().slice(0, 10),
          symbol: cur.symbol,
          minuteTs: cur.minute_ts,
          generation: null,
        },
      };
    }
  }
  return null;
}
