/**
 * zod-output — снимок вывода z.toJSONSchema() по видам полей демо-домена (план, этап 0, п. 10; тест 0.6).
 * Эталон лежит в test/fixtures/zod-output.json. Если новая версия Zod выводит иначе, тест падает:
 * нормализатор моделей (этап 2) опирается на этот вывод.
 * Обновить эталон: UPDATE_SNAPSHOT=1 npm test -- test/zod-output.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { z } from 'zod';

const FIXTURE = new URL('./fixtures/zod-output.json', import.meta.url);

/** Виды полей демо-домена, включая то, что в 0.21 выражено языком fastest-validator. */
function kinds(): Record<string, z.ZodType> {
  return {
    // строгий вложенный объект глубины 4 с умолчаниями (Org.settings)
    nestedStrictDefaults: z.strictObject({
      booking: z.strictObject({
        window: z.strictObject({
          limits: z.strictObject({ maxPerDay: z.number().int().min(1).default(8), allowOverlap: z.boolean().default(false) }),
        }),
      }),
    }),
    // record с ключом-перечислением (price.amounts)
    recordEnumKey: z.record(z.enum(['RUB', 'USD', 'EUR']), z.number().int().min(0)),
    // перечисление с умолчанием
    enumDefault: z.enum(['draft', 'active', 'archived']).default('draft'),
    // числовые диапазоны
    intRange: z.number().int().min(0).max(9007199254740991),
    floatRange: z.number().min(0).max(100),
    // даты и время с миллисекундами для ключевых полей
    date: z.iso.date(),
    datetimeMs: z.iso.datetime({ precision: 3 }),
    uuid: z.uuid(),
    email: z.email(),
    // строка с шаблоном и длиной
    pattern: z.string().regex(/^[0-9]{3}-[0-9]{2}$/).min(6).max(6),
    // необязательное поле и массив без повторов
    optionalArray: z.strictObject({ tags: z.array(z.string()).optional() }),
    // пометки .meta()
    withMeta: z.string().meta({ title: 'Телефон', widget: 'phone' }),
  };
}

function snapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(kinds())) {
    out[name] = z.toJSONSchema(schema, { io: 'input' });
  }
  return out;
}

test('0.6: вывод z.toJSONSchema() совпадает с эталоном', async () => {
  const actual = snapshot();
  if (process.env.UPDATE_SNAPSHOT || !existsSync(FIXTURE)) {
    await mkdir(new URL('./fixtures/', import.meta.url), { recursive: true });
    await writeFile(FIXTURE, JSON.stringify(actual, null, 2) + '\n');
  }
  const expected = JSON.parse(await readFile(FIXTURE, 'utf8'));
  assert.deepEqual(actual, expected);
});
