// verify_golden_sync — proves the vendored platform historical golden has not drifted.
//
//  (1) sha256(local vendored copy) === recorded .sha256 (tamper detect).
//  (2) byte-compare the vendored copy against the live platform source (source-drift detect).
//
// ОБЕ ПРОВЕРКИ ОБЯЗАТЕЛЬНЫ. Вторая была «мягкой»: недостижимый источник давал WARN и
// ЗЕЛЁНЫЙ выход. Пропущенный гейт выглядит как пройденный, а этот пропускался тем чаще,
// чем меньше о нём знали, — в шапке ниже уже описан один такой период, когда путь вёл в
// постороннюю папку и сверка не выполнялась НИ РАЗУ.
//
// Второй раз это случилось из-за git worktree: путь считался от корня РАБОЧЕГО ДЕРЕВА,
// поэтому из `.claude/worktrees/<name>` сиблинг разрешался в
// `.claude/worktrees/platform` — каталог, которого не существует. Любая работа в дереве
// молча теряла сверку. Поэтому корень берётся из `--git-common-dir` (он указывает на
// главный чекаут независимо от того, откуда запущено), а недостижимость источника —
// отказ, а не предупреждение.
//
// The golden fixture's byte-identity source of truth is the platform repo
// (test/fixtures/historical-golden/MANIFEST.json). The SDK does not own it, so it cannot come
// from the npm package — it stays vendored, and this gate is what keeps it honest.
//
// This file used to be verify_harness_sync and also byte-compared a vendored copy of the
// conformance harness against a compile of the SDK repo. That half is gone: the harness now comes
// from the published `@trdlabs/sdk` npm package (mock-contract-parity item 5), so there is no
// vendored copy to drift and no sibling checkout to compile. The pin itself is gated by
// verify_sdk_pin.ts. Only the golden remains cross-repo, hence the rename — the old name outlived
// what the script does.
//
// Был .mjs на голом node; стал .ts под tsx, потому что PLATFORM_REPO теперь читается через
// типизированный src/env.ts (env-catalog item 5) — единственную точку чтения окружения в репо.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { loadEnv } from '../src/env.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const GOLDEN = join(repoRoot, 'test/conformance/_vendored/platform-historical-golden.json');
const GOLDEN_SHA_FILE = join(repoRoot, 'test/conformance/_vendored/platform-historical-golden.sha256');

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

function fail(msg: string): never {
  console.error(`verify_golden_sync: FAIL — ${msg}`);
  process.exit(1);
}

// Корень для поиска сиблинга — ГЛАВНЫЙ чекаут, а не текущее рабочее дерево.
//
// Абсолютный путь тут уже был однажды и вёл в постороннюю папку. Сиблинг от `repoRoot`
// его сменил и чинил тот случай, но завёл свой: из git worktree `repoRoot` — это
// `.claude/worktrees/<name>`, и сиблинг разрешается в `.claude/worktrees/platform`,
// которого не существует. `--git-common-dir` указывает на главный чекаут откуда угодно.
function mainCheckoutRoot(): string {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // `<главный чекаут>/.git` → сам чекаут. Пустой ответ означает «не git» — тогда
    // остаётся рабочее дерево, и ниже недостижимость всё равно станет отказом.
    return commonDir.length > 0 ? dirname(commonDir) : repoRoot;
  } catch {
    return repoRoot;
  }
}

const PLATFORM = loadEnv().PLATFORM_REPO ?? resolve(mainCheckoutRoot(), '../platform');

// --- HARD: vendored platform golden matches its recorded checksum ---
if (!existsSync(GOLDEN)) fail(`vendored golden missing: ${GOLDEN}`);
if (!existsSync(GOLDEN_SHA_FILE)) fail(`golden checksum file missing: ${GOLDEN_SHA_FILE}`);

const goldenBuf = readFileSync(GOLDEN);
const goldenSha = sha256(goldenBuf);
const recordedGoldenSha = readFileSync(GOLDEN_SHA_FILE, 'utf8').trim();
if (goldenSha !== recordedGoldenSha) {
  fail(`vendored golden sha256 mismatch (local tamper):\n  recorded ${recordedGoldenSha}\n  actual   ${goldenSha}`);
}

// Режим `--local-only`: выполнить ТОЛЬКО проверку (1).
//
// Он существует ради одного окружения — публичного CI этого репозитория, где источник
// (приватный `trdlabs/platform`) недостижим и достижим быть не может без секрета.
// Раньше там запускался полный гейт и молча зеленел, объявляя пройденным то, чего не
// делал. Теперь окружение, которое не может выполнить сверку, обязано СКАЗАТЬ об этом
// именем команды, а не кодом возврата.
//
// Сама cross-repo сверка от этого не исчезает: она переезжает в CI платформы, где есть
// источник и откуда публичный мок клонируется без единого секрета. Направление доступа
// работает только в эту сторону.
const LOCAL_ONLY = process.argv.includes('--local-only');
if (LOCAL_ONLY) {
  console.log('verify_golden_sync: OK (--local-only: сверена только вендоренная копия против своей sha256)');
  console.log('verify_golden_sync: cross-repo сверка ЗДЕСЬ НЕ ВЫПОЛНЯЛАСЬ — её делает CI платформы');
  process.exit(0);
}

// --- (2) cross-repo byte-identity against the live platform MANIFEST ---
const PLATFORM_GOLDEN = join(PLATFORM, 'test/fixtures/historical-golden/MANIFEST.json');
if (!existsSync(PLATFORM) || !existsSync(PLATFORM_GOLDEN)) {
  // ОТКАЗ, а не предупреждение. Недостижимый источник означает, что сверка НЕ
  // ВЫПОЛНЕНА, — а «не выполнена» и «выполнена и совпало» обязаны различаться кодом
  // возврата, иначе гейт доказывает только то, что его запустили.
  fail(
    `cross-repo сверка НЕ ВЫПОЛНЕНА: источник недостижим (${PLATFORM_GOLDEN}).
` +
      `  Это отказ, а не пропуск: вендоренная копия могла разойтись с платформой, и здесь это не проверено.
` +
      `  Почини одним из двух: сделай чекаут платформы рядом с главным чекаутом мока, либо задай PLATFORM_REPO=<путь>.`,
  );
} else {
  const platformGoldenBuf = readFileSync(PLATFORM_GOLDEN);
  if (sha256(platformGoldenBuf) !== goldenSha) {
    fail(`vendored golden drifted from platform source:\n  platform sha ${sha256(platformGoldenBuf)}\n  vendored sha ${goldenSha}\n  re-vendor: cp ${PLATFORM_GOLDEN} ${GOLDEN} && sha256 -> .sha256`);
  }
  console.log('verify_golden_sync: golden cross-repo byte-identity OK');
}

console.log('verify_golden_sync: OK');
