/**
 * env.ts — ЕДИНСТВЕННАЯ точка чтения process.env в репо (контракт env-schema.1,
 * control-center docs/architecture/contracts/env-schema.md, инициатива env-catalog item 5).
 *
 * Каждая переменная объявлена здесь один раз: zod-схема (тип/валидация) + метаданные
 * (description, secret, flag, owner_unit, consumers). Всё остальное импортирует `parseEnv` /
 * `loadEnv`; тест test/env/env-completeness.test.ts — гейт «Полнота схемы» (process.env вне
 * этого модуля = красный тест).
 *
 * Fail-fast: `loadEnv()` в entrypoint'ах валидирует env целиком, печатает ВСЕ невалидные
 * переменные разом в stderr (значения secret-переменных никогда не печатаются) и завершает
 * процесс с кодом 1.
 *
 * Экспорт схемы: `envSchemaDocument()` — детерминированный документ `env-schema.1`
 * (variables отсортированы по name, без timestamp'ов); печатается командой
 * `npm run env:schema` (scripts/env-schema.ts). ENV.md и .env.example генерируются из этой же
 * схемы (`npm run env:docs`) — руками не редактируются.
 */
import { z } from 'zod';

export const ENV_SCHEMA_VERSION = 'env-schema.1' as const;
export const REPO_ID = 'trading-mock-platform' as const;
export const GENERATED_FROM = 'src/env.ts' as const;
export const OWNER_UNIT = 'mock-platform' as const;

/** Дефолтный снапшот: T1 native-1m SSOT fixture. Одна константа на весь репо — вторая
 *  захардкоженная копия однажды заставила research-гейтвей тихо отдавать synthetic-фикстуру
 *  2024 года (см. историю src/access/config.ts). config.ts реэкспортирует эти константы. */
export const DEFAULT_SNAPSHOT_DIR = './data/snapshots';
export const DEFAULT_SNAPSHOT_REF = 'fixtures/2026-06-22-to-2026-06-28-vps';

export type EnvVarType = 'string' | 'int' | 'float' | 'bool' | 'enum' | 'url' | 'duration_ms' | 'csv';

interface EnvVarSpec<T> {
  readonly name: string;
  readonly type: EnvVarType;
  readonly required: boolean;
  /** Дефолт СТРОКОЙ, ровно как в .env; null = дефолта нет. Всегда null для secret/required. */
  readonly default: string | null;
  readonly description: string;
  readonly secret: boolean;
  readonly flag: boolean;
  readonly enumValues?: readonly string[];
  readonly ownerUnit: string;
  readonly consumers: readonly string[];
  /** Парсер сырой строки из process.env (уже после подстановки дефолта). */
  readonly schema: z.ZodType<T, z.ZodTypeDef, string>;
}

// ── zod-строители под типы контракта (семантика — env-schema.md, раздел «Семантика типов») ──

const positiveInt = (what: string): z.ZodType<number, z.ZodTypeDef, string> =>
  z
    .string()
    .regex(/^-?[0-9]+$/, `${what}: must be a base-10 integer`)
    .transform(Number)
    .refine((n) => Number.isSafeInteger(n) && n > 0, `${what}: must be a positive integer`);

/** Number()-семантика (как в историческом loadMockConfig), не parseFloat: '1abc' — ошибка. */
const positiveFloat = (what: string): z.ZodType<number, z.ZodTypeDef, string> =>
  z
    .string()
    .refine((v) => Number.isFinite(Number(v)) && Number(v) > 0, `${what}: must be a finite number > 0`)
    .transform(Number);

/** csv контракта: split(','), trim, пустые элементы отбрасываются; '' = пустой список. */
const csv: z.ZodType<string[], z.ZodTypeDef, string> = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const absoluteUrl = (what: string): z.ZodType<string, z.ZodTypeDef, string> =>
  z.string().refine((v) => {
    try {
      new URL(v);
      return true;
    } catch {
      return false;
    }
  }, `${what}: must be an absolute URL with a scheme (value redacted)`);

// ── Инвентаризация: ВСЕ переменные окружения репо, отсортированы по name ──

const spec = <T>(s: EnvVarSpec<T>): EnvVarSpec<T> => s;

const HOME = spec({
  name: 'HOME',
  type: 'string',
  required: false,
  default: null,
  description:
    'Системная $HOME (задаёт ОС). Читается только как дефолт пути SSH-ключа в tools/fetch-snapshot; объявлена ради полноты — env.ts единственная точка чтения process.env',
  secret: false,
  flag: false,
  ownerUnit: OWNER_UNIT,
  consumers: ['tools/fetch-snapshot/fetch-snapshot.ts'],
  schema: z.string(),
});

const MOCK_OPS_BIND = spec({
  name: 'MOCK_OPS_BIND',
  type: 'string',
  required: false,
  default: '127.0.0.1',
  description:
    'Адрес bind HTTP ops-сервера (Surface A). Loopback по умолчанию; non-loopback (напр. 0.0.0.0 в Docker) требует непустой MOCK_OPS_TOKENS — иначе fail-closed отказ старта',
  secret: false,
  flag: false,
  ownerUnit: OWNER_UNIT,
  consumers: ['src/access/config.ts'],
  schema: z.string(),
});

const MOCK_OPS_PORT = spec({
  name: 'MOCK_OPS_PORT',
  type: 'int',
  required: false,
  default: '8839',
  description:
    "Порт HTTP ops-сервера; дефолт совпадает с дефолтом TRADING_PLATFORM_READ_URL в trading-office",
  secret: false,
  flag: false,
  ownerUnit: OWNER_UNIT,
  consumers: ['src/access/config.ts'],
  schema: positiveInt('MOCK_OPS_PORT'),
});

const MOCK_OPS_TOKENS = spec({
  name: 'MOCK_OPS_TOKENS',
  type: 'csv',
  required: false,
  default: '',
  description:
    'Allowlist доступа к Surface A: sha256-hex ХЭШИ токенов через запятую (не сами токены — поэтому не secret). Пусто = доверие только loopback-клиентам',
  secret: false,
  flag: false,
  ownerUnit: OWNER_UNIT,
  consumers: ['src/access/config.ts'],
  schema: csv,
});

const MOCK_REPLAY_MODE = spec({
  name: 'MOCK_REPLAY_MODE',
  type: 'enum',
  required: false,
  default: 'loop',
  description: 'Режим WS-реплея /ops/events: once — один проход по кадрам, loop — по кругу',
  secret: false,
  flag: false,
  enumValues: ['once', 'loop'],
  ownerUnit: OWNER_UNIT,
  consumers: ['src/access/config.ts'],
  schema: z.enum(['once', 'loop']),
});

const MOCK_REPLAY_SPEED = spec({
  name: 'MOCK_REPLAY_SPEED',
  type: 'float',
  required: false,
  default: '1',
  description: 'Множитель скорости WS-реплея (> 0); 1 = реальное время кадров снапшота',
  secret: false,
  flag: false,
  ownerUnit: OWNER_UNIT,
  consumers: ['src/access/config.ts'],
  schema: positiveFloat('MOCK_REPLAY_SPEED'),
});

const MOCK_RESEARCH_TOKEN = spec({
  name: 'MOCK_RESEARCH_TOKEN',
  type: 'string',
  required: false,
  default: null,
  description:
    'Сырой bearer-токен, который research-гейтвей (Surface B, stdio MCP) предъявляет при старте; сверяется по sha256 с MOCK_RESEARCH_TOKENS. Не нужен при пустом allowlist (spawn-trusted)',
  secret: true,
  flag: false,
  ownerUnit: OWNER_UNIT,
  consumers: ['src/bin/start-research-mcp.ts'],
  schema: z.string(),
});

const MOCK_RESEARCH_TOKENS = spec({
  name: 'MOCK_RESEARCH_TOKENS',
  type: 'csv',
  required: false,
  default: '',
  description:
    'Allowlist доступа к research-гейтвею (Surface B): sha256-hex ХЭШИ токенов через запятую (зеркало семантики MOCK_OPS_TOKENS). Пусто = spawn-trusted',
  secret: false,
  flag: false,
  ownerUnit: OWNER_UNIT,
  consumers: ['src/access/research-access.ts', 'src/bin/start-research-mcp.ts'],
  schema: csv,
});

const MOCK_SNAPSHOT_DB_URL = spec({
  name: 'MOCK_SNAPSHOT_DB_URL',
  type: 'url',
  required: false,
  default: null,
  description:
    'Postgres URL VPS для tools/fetch-snapshot (содержит пароль — НИКОГДА не argv, см. #40; альтернатива — --db-url-file с файлом 0600)',
  secret: true,
  flag: false,
  ownerUnit: OWNER_UNIT,
  consumers: ['tools/fetch-snapshot/fetch-snapshot.ts'],
  schema: absoluteUrl('MOCK_SNAPSHOT_DB_URL'),
});

const MOCK_SNAPSHOT_DIR = spec({
  name: 'MOCK_SNAPSHOT_DIR',
  type: 'string',
  required: false,
  default: DEFAULT_SNAPSHOT_DIR,
  description: 'Каталог снапшотов (data/snapshots в репо; в Docker монтируется томом)',
  secret: false,
  flag: false,
  ownerUnit: OWNER_UNIT,
  consumers: ['src/access/config.ts', 'src/bin/start-research-mcp.ts'],
  schema: z.string(),
});

const MOCK_SNAPSHOT_REF = spec({
  name: 'MOCK_SNAPSHOT_REF',
  type: 'string',
  required: false,
  default: DEFAULT_SNAPSHOT_REF,
  description:
    'Ref снапшота внутри MOCK_SNAPSHOT_DIR; дефолт — T1 native-1m SSOT-фикстура (одна константа на оба entrypoint\'а — вторая копия однажды разъехалась)',
  secret: false,
  flag: false,
  ownerUnit: OWNER_UNIT,
  consumers: ['src/access/config.ts', 'src/bin/start-research-mcp.ts'],
  schema: z.string(),
});

const PLATFORM_GOLDEN = spec({
  name: 'PLATFORM_GOLDEN',
  type: 'string',
  required: false,
  default: null,
  description:
    'Dev-переменная scripts/make-golden-fixture.ts: путь до platform historical-golden MANIFEST.json; без неё берётся vendored-копия test/conformance/_vendored',
  secret: false,
  flag: false,
  ownerUnit: OWNER_UNIT,
  consumers: ['scripts/make-golden-fixture.ts'],
  schema: z.string(),
});

const PLATFORM_REPO = spec({
  name: 'PLATFORM_REPO',
  type: 'string',
  required: false,
  default: null,
  description:
    'Dev-переменная scripts/verify_golden_sync.ts: путь до чекаута platform для кросс-репо сверки golden; без неё берётся сосед ../platform, недоступен — WARN-skip',
  secret: false,
  flag: false,
  ownerUnit: OWNER_UNIT,
  consumers: ['scripts/verify_golden_sync.ts'],
  schema: z.string(),
});

/** Все переменные репо, отсортированы по name (правило 2 валидатора контракта). */
const VARS: readonly EnvVarSpec<unknown>[] = [
  HOME,
  MOCK_OPS_BIND,
  MOCK_OPS_PORT,
  MOCK_OPS_TOKENS,
  MOCK_REPLAY_MODE,
  MOCK_REPLAY_SPEED,
  MOCK_RESEARCH_TOKEN,
  MOCK_RESEARCH_TOKENS,
  MOCK_SNAPSHOT_DB_URL,
  MOCK_SNAPSHOT_DIR,
  MOCK_SNAPSHOT_REF,
  PLATFORM_GOLDEN,
  PLATFORM_REPO,
];

// ── Типизированный env ──

export interface Env {
  readonly HOME: string | undefined;
  readonly MOCK_OPS_BIND: string;
  readonly MOCK_OPS_PORT: number;
  readonly MOCK_OPS_TOKENS: readonly string[];
  readonly MOCK_REPLAY_MODE: 'once' | 'loop';
  readonly MOCK_REPLAY_SPEED: number;
  readonly MOCK_RESEARCH_TOKEN: string | undefined;
  readonly MOCK_RESEARCH_TOKENS: readonly string[];
  readonly MOCK_SNAPSHOT_DB_URL: string | undefined;
  readonly MOCK_SNAPSHOT_DIR: string;
  readonly MOCK_SNAPSHOT_REF: string;
  readonly PLATFORM_GOLDEN: string | undefined;
  readonly PLATFORM_REPO: string | undefined;
}

export class EnvValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`invalid environment:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/** Парсит и валидирует ВЕСЬ env разом (safeParse per-var, все ошибки копятся).
 *  Значения secret-переменных в сообщениях об ошибках не появляются. */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const issues: string[] = [];

  function take<T>(s: EnvVarSpec<T>): T | undefined {
    const rawValue = raw[s.name] ?? (s.default === null ? undefined : s.default);
    if (rawValue === undefined) {
      if (s.required) issues.push(`${s.name}: required but not set`);
      return undefined;
    }
    const parsed = s.schema.safeParse(rawValue);
    if (!parsed.success) {
      const reason = parsed.error.issues.map((i) => i.message).join('; ');
      const shown = s.secret ? '(value redacted)' : `'${rawValue}'`;
      issues.push(`${s.name}: invalid value ${shown} — ${reason}`);
      return undefined;
    }
    return parsed.data;
  }

  const env: Env = {
    HOME: take(HOME),
    MOCK_OPS_BIND: take(MOCK_OPS_BIND) as string,
    MOCK_OPS_PORT: take(MOCK_OPS_PORT) as number,
    MOCK_OPS_TOKENS: take(MOCK_OPS_TOKENS) as readonly string[],
    MOCK_REPLAY_MODE: take(MOCK_REPLAY_MODE) as 'once' | 'loop',
    MOCK_REPLAY_SPEED: take(MOCK_REPLAY_SPEED) as number,
    MOCK_RESEARCH_TOKEN: take(MOCK_RESEARCH_TOKEN),
    MOCK_RESEARCH_TOKENS: take(MOCK_RESEARCH_TOKENS) as readonly string[],
    MOCK_SNAPSHOT_DB_URL: take(MOCK_SNAPSHOT_DB_URL),
    MOCK_SNAPSHOT_DIR: take(MOCK_SNAPSHOT_DIR) as string,
    MOCK_SNAPSHOT_REF: take(MOCK_SNAPSHOT_REF) as string,
    PLATFORM_GOLDEN: take(PLATFORM_GOLDEN),
    PLATFORM_REPO: take(PLATFORM_REPO),
  };

  if (issues.length > 0) throw new EnvValidationError(issues);
  return env;
}

/** Fail-fast чтение process.env для entrypoint'ов: при невалидном env печатает все ошибки в
 *  stderr (stdout не трогаем — у research-гейтвея он занят JSON-RPC) и выходит с кодом 1. */
export function loadEnv(): Env {
  try {
    return parseEnv(process.env);
  } catch (e) {
    if (e instanceof EnvValidationError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}

// ── Экспорт документа env-schema.1 ──

export interface EnvSchemaVariable {
  readonly name: string;
  readonly type: EnvVarType;
  readonly required: boolean;
  readonly default: string | null;
  readonly description: string;
  readonly secret: boolean;
  readonly flag: boolean;
  readonly enum_values?: readonly string[];
  readonly owner_unit: string;
  readonly consumers: readonly string[];
}

export interface EnvSchemaDocument {
  readonly schema_version: typeof ENV_SCHEMA_VERSION;
  readonly repo: typeof REPO_ID;
  readonly generated_from: typeof GENERATED_FROM;
  readonly variables: readonly EnvSchemaVariable[];
}

/** Детерминированный документ env-schema.1 (порядок ключей и variables фиксирован —
 *  одинаковый env.ts даёт байт-в-байт одинаковый JSON.stringify(..., null, 2)). */
export function envSchemaDocument(): EnvSchemaDocument {
  return {
    schema_version: ENV_SCHEMA_VERSION,
    repo: REPO_ID,
    generated_from: GENERATED_FROM,
    variables: VARS.map((s) => ({
      name: s.name,
      type: s.type,
      required: s.required,
      default: s.default,
      description: s.description,
      secret: s.secret,
      flag: s.flag,
      ...(s.enumValues ? { enum_values: [...s.enumValues] } : {}),
      owner_unit: s.ownerUnit,
      consumers: [...s.consumers],
    })),
  };
}
