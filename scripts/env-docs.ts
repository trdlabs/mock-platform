/**
 * env-docs — `npm run env:docs`: генерирует ENV.md и .env.example из схемы src/env.ts.
 * Оба артефакта ПРОИЗВОДНЫЕ — руками не редактируются (контракт env-schema.1, раздел
 * «Генерация»); дрейф ловит test/env/env-docs.test.ts (перегенерация обязана дать те же байты).
 * Секреты: только имя и форма — значение живёт в SOPS/age-контуре (b2c-ops-hardening item 3).
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { envSchemaDocument, type EnvSchemaDocument, type EnvSchemaVariable } from '../src/env.js';

const SECRET_NOTE = 'secret — значение в SOPS/age-контуре, см. b2c-ops-hardening item 3';

function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function defaultCell(v: EnvSchemaVariable): string {
  if (v.secret) return '—';
  if (v.default === null) return '—';
  return v.default === '' ? "`''` (пусто)" : `\`${v.default}\``;
}

export function renderEnvMd(doc: EnvSchemaDocument): string {
  const lines: string[] = [
    '# Переменные окружения — trading-mock-platform',
    '',
    '<!-- СГЕНЕРИРОВАНО из src/env.ts командой `pnpm env:docs` — НЕ редактировать руками. -->',
    '<!-- Дрейф-гейт: test/env/env-docs.test.ts. Машинный экспорт: `pnpm env:schema`. -->',
    '',
    `Контракт: \`env-schema.1\` (control-center docs/architecture/contracts/env-schema.md). ` +
      `Единственная точка чтения \`process.env\` — \`${doc.generated_from}\`; невалидный env валит ` +
      `процесс на старте со списком всех ошибок разом.`,
    '',
    '| Имя | Тип | Обяз. | Дефолт | Secret | Flag | Описание |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const v of doc.variables) {
    const type = v.enum_values ? `enum: ${v.enum_values.map((e) => `\`${e}\``).join(' \\| ')}` : `\`${v.type}\``;
    lines.push(
      `| \`${v.name}\` | ${type} | ${v.required ? 'да' : 'нет'} | ${defaultCell(v)} | ` +
        `${v.secret ? 'да' : 'нет'} | ${v.flag ? 'да' : 'нет'} | ${mdCell(v.description)} |`,
    );
  }
  lines.push(
    '',
    'Секреты: в каталоге/примерах — только имя и форма, никогда значение ' +
      `(${SECRET_NOTE.replace('secret — ', '')}).`,
    '',
  );
  return lines.join('\n');
}

export function renderEnvExample(doc: EnvSchemaDocument): string {
  const lines: string[] = [
    '# --- trading-mock-platform: пример env ---',
    '# СГЕНЕРИРОВАНО из src/env.ts командой `pnpm env:docs` — НЕ редактировать руками.',
    '',
  ];
  for (const v of doc.variables) {
    lines.push(`# ${v.description}`);
    if (v.secret) {
      lines.push(`# ${SECRET_NOTE}`);
      lines.push(`${v.name}=`);
    } else if (v.default !== null) {
      lines.push(`${v.name}=${v.default}`);
    } else if (v.required) {
      lines.push(`${v.name}=`);
    } else {
      lines.push(`# ${v.name}=`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const doc = envSchemaDocument();
  writeFileSync(resolve(repoRoot, 'ENV.md'), renderEnvMd(doc));
  writeFileSync(resolve(repoRoot, '.env.example'), renderEnvExample(doc));
  console.log('env-docs: ENV.md и .env.example перегенерированы из src/env.ts');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
