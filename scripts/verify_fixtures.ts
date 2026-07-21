import { Ajv } from 'ajv';

export const MINUTE_MS = 60_000;

export interface CoverageDoc {
  schemaVersion: 'fixture-coverage.1';
  period: { fromMs: number; toMs: number };
  symbols: string[];
  totalGapBudgetMinutes: number;
  maxConsecutiveGapMinutes: number;
}

const COVERAGE_SCHEMA = {
  $id: 'fixture-coverage',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'period', 'symbols', 'totalGapBudgetMinutes', 'maxConsecutiveGapMinutes'],
  properties: {
    schemaVersion: { const: 'fixture-coverage.1' },
    period: {
      type: 'object',
      additionalProperties: false,
      required: ['fromMs', 'toMs'],
      properties: {
        fromMs: { type: 'integer', minimum: 0, multipleOf: MINUTE_MS },
        toMs: { type: 'integer', minimum: 0, multipleOf: MINUTE_MS },
      },
    },
    symbols: { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 5, uniqueItems: true },
    totalGapBudgetMinutes: { type: 'integer', minimum: 0 },
    maxConsecutiveGapMinutes: { type: 'integer', minimum: 0 },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(COVERAGE_SCHEMA);

/** AJV structural validation plus the one cross-field rule AJV can't express (toMs > fromMs).
 *  Returns [] when the sidecar is valid. */
export function validateCoverageDoc(doc: unknown): string[] {
  if (!validateSchema(doc)) return [`sidecar schema invalid: ${ajv.errorsText(validateSchema.errors)}`];
  const c = doc as CoverageDoc;
  return c.period.toMs > c.period.fromMs
    ? []
    : [`period.toMs ${c.period.toMs} must exceed fromMs ${c.period.fromMs}`];
}
