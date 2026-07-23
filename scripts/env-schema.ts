/**
 * env-schema — `npm run env:schema`: печатает документ env-schema.1 в stdout.
 * JSON, 2 пробела, variables отсортированы по name, завершающий перевод строки.
 * Файл env-schema.json НЕ коммитится (второй источник правды = собственный дрейф);
 * агрегатор env-registry в control-center захватывает stdout этой команды.
 */
import { envSchemaDocument } from '../src/env.js';

process.stdout.write(`${JSON.stringify(envSchemaDocument(), null, 2)}\n`);
