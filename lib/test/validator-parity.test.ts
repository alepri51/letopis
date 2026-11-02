/**
 * validator-parity — валидатор на TypeScript отвечает так же, как проверка в базе (план, этап 2, п. 11;
 * тест-план §7.4 №2.10, дифференциальные тесты §7.12): официальный набор JSON-Schema-Test-Suite
 * и 10 000 случайных документов по описаниям демо-классов, в том числе с ключами на $ во вложенных
 * объектах. Сравниваются пути и ключевые слова нарушений. `pattern` валидатор на TypeScript не исполняет
 * (ревью: шаблон арендатора с катастрофическим перебором вешал процесс) — нарушения `pattern` даёт только база.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { ensureDatabase, adminSql, schemaFor, ident, type Sql } from './_harness.js';
import { install } from '../src/up.js';
import { compileValidator, applyDefaults } from '../src/validate.js';
import type { JsonSchema } from '../src/jsonschema.js';
import type { Issue } from '../src/errors.js';

let sql: Sql;
const schema = schemaFor(import.meta.filename);
const S = ident(schema);

before(async () => {
  await ensureDatabase();
  sql = adminSql();
  await sql.unsafe(`drop schema if exists ${S} cascade`);
  await install(sql, { schema });
});

after(async () => {
  await sql.unsafe(`drop schema if exists ${S} cascade`);
  await sql?.end({ timeout: 5 });
});

const norm = (issues: Issue[]) => issues.map((i) => `${JSON.stringify(i.path)}|${i.keyword}`).sort();
/** Нарушения базы без `pattern`: его проверяет только база (ревью, ReDoS); dbPattern — сколько их отброшено. */
let dbPattern = 0;
function normDb(issues: Issue[]): string[] {
  const rest = issues.filter((i) => i.keyword !== 'pattern');
  dbPattern += issues.length - rest.length;
  return norm(rest);
}

/** Нарушения из базы для набора документов одним запросом. */
async function dbIssues(js: unknown, docs: unknown[]): Promise<Issue[][]> {
  const rows = await sql.unsafe(`select d.i, ${S}.validate_data(c.rules, c.validator, c.vars, d.doc) as bad
    from ${S}.compile_validator($1::text::jsonb) c, jsonb_array_elements($2::text::jsonb) with ordinality as d(doc, i) order by d.i`,
    [JSON.stringify(js), JSON.stringify(docs)]);
  return rows.map((r) => r.bad as Issue[]);
}

interface SuiteGroup { description: string; schema: unknown; tests: { description: string; data: unknown; valid: boolean }[] }

test('2.10: официальный набор — валидатор и база дают одни нарушения', async () => {
  const dir = new URL('./vectors/json-schema-test-suite/', import.meta.url);
  let compared = 0;
  const diffs: string[] = [];
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.json'))) {
    for (const g of JSON.parse(await readFile(new URL(f, dir), 'utf8')) as SuiteGroup[]) {
      const js = typeof g.schema === 'object' && g.schema ? { ...(g.schema as object) } as JsonSchema : g.schema;
      if (typeof js === 'object' && js) delete (js as JsonSchema).$schema;
      let db: Issue[][];
      try {
        db = await dbIssues(js, g.tests.map((c) => c.data));
      } catch {
        continue; // описание, которое база не компилирует (вне подмножества или NUL) — пропускается и там
      }
      const v = compileValidator(js as JsonSchema);
      g.tests.forEach((c, i) => {
        compared++;
        const a = norm(v(c.data));
        const b = normDb(db[i]);
        if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${f}: ${g.description} / ${c.description}: ts=${a} db=${b}`);
      });
    }
  }
  if (diffs.length) console.log(diffs.join('\n'));
  assert.deepEqual(diffs, []);
  assert.ok(compared >= 300, `сравнено ${compared}`);
  assert.ok(dbPattern > 0, 'нарушения pattern в наборе есть — их даёт база');
});

/** Детерминированный генератор случайных чисел (mulberry32) — повторяемый прогон. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODELS: { name: string; schema: JsonSchema; base: Record<string, unknown> }[] = [
  { name: 'Org', schema: { type: 'object', additionalProperties: false, required: ['name'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 20 }, timezone: { type: 'string', default: 'Europe/Moscow' },
      settings: { type: 'object', additionalProperties: false, properties: { booking: { type: 'object', additionalProperties: false, properties: {
        window: { type: 'object', additionalProperties: false, required: ['limits'], properties: { limits: { type: 'object', additionalProperties: false, properties: {
          maxPerDay: { type: 'integer', minimum: 1, maximum: 100, default: 8 }, allowOverlap: { type: 'boolean', default: false } } } } } } } } } } },
    base: { name: 'Acme', settings: { booking: { window: { limits: { maxPerDay: 5 } } } } } },
  { name: 'price', schema: { type: 'object', additionalProperties: false, properties: {
      amounts: { type: 'object', propertyNames: { type: 'string', enum: ['RUB', 'USD', 'AED'] }, additionalProperties: { type: 'integer', minimum: 0 } },
      note: { type: ['string', 'null'] }, kind: { type: 'string', enum: ['base', 'promo'] } } },
    base: { amounts: { RUB: 1500, AED: 60 }, note: null, kind: 'base' } },
  { name: 'slot', schema: { type: 'object', additionalProperties: false, required: ['start'], properties: {
      start: { type: 'string', format: 'date-time' }, day: { type: 'string', format: 'date' }, ref: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' }, code: { type: 'string', pattern: '^\\d{3}-\\w+$' }, cost: { type: 'number', multipleOf: 0.01, exclusiveMinimum: 0 } } },
    base: { start: '2026-10-07T10:00:00.000Z', day: '2026-10-07', ref: '0f8fad5b-d9cb-469f-a165-70867728950e', email: 'a@b.ru', code: '123-ab', cost: 19.99 } },
  { name: 'complex', schema: { type: 'object', additionalProperties: false, properties: {
      tags: { type: 'array', items: { type: 'string', maxLength: 5 }, uniqueItems: true, minItems: 1, maxItems: 4 },
      mode: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', enum: ['none'] }] },
      pick: { oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'number', minimum: 10 }] },
      opts: { type: 'object', minProperties: 1, maxProperties: 3 }, fixed: { const: { a: [1, 2] } } } },
    base: { tags: ['a', 'b'], mode: 3, pick: 'x', opts: { k: 1 }, fixed: { a: [1, 2] } } },
  { name: 'free', schema: { type: 'object', additionalProperties: false, properties: {
      meta: { type: 'object', properties: { $ref: { type: 'string' }, $inc: { type: 'integer' } } }, list: { type: 'array', items: { type: 'object', required: ['$key'] } } } },
    base: { meta: { $ref: 'r', $inc: 1 }, list: [{ $key: 1 }] } },
];

function randomValue(r: () => number, depth = 0): unknown {
  const k = Math.floor(r() * (depth > 2 ? 6 : 8));
  switch (k) {
    case 0: return null;
    case 1: return r() < 0.5;
    case 2: return Math.floor(r() * 200) - 50;
    case 3: return Math.round(r() * 10000) / 100;
    case 4: return ['', 'x', 'Acme', 'none', 'RUB', '2026-02-30', '2026-10-07T10:00:00Z', '2026-10-07', '123-ab', 'a@b.ru', 'ёжик', '0f8fad5b-d9cb-469f-a165-70867728950e', '$ref'][Math.floor(r() * 13)];
    case 5: return 'длинная строка с пробелами';
    case 6: return Array.from({ length: Math.floor(r() * 4) }, () => randomValue(r, depth + 1));
    default: return Object.fromEntries(Array.from({ length: Math.floor(r() * 3) }, (_, i) => [['a', 'k', '$key', 'RUB', 'name'][Math.floor(r() * 5)] + (i ? i : ''), randomValue(r, depth + 1)]));
  }
}

/** Мутация документа: замена значения по случайному пути, удаление или добавление ключа. */
function mutate(doc: unknown, r: () => number): unknown {
  const copy = structuredClone(doc) as Record<string, unknown>;
  const steps = 1 + Math.floor(r() * 3);
  for (let s = 0; s < steps; s++) {
    let node: Record<string, unknown> = copy;
    for (let d = 0; d < 4; d++) {
      const ks = Object.keys(node);
      if (!ks.length) break;
      const k = ks[Math.floor(r() * ks.length)];
      const v = node[k];
      if (typeof v === 'object' && v !== null && r() < 0.6) { node = v as Record<string, unknown>; continue; }
      const op = r();
      if (op < 0.6) node[k] = randomValue(r);
      else if (op < 0.8) delete node[k];
      else node[`extra${Math.floor(r() * 3)}`] = randomValue(r);
      break;
    }
  }
  return copy;
}

test('2.10: 10 000 случайных документов по описаниям демо-классов', async () => {
  const r = rng(20261008);
  const diffs: string[] = [];
  let invalid = 0;
  for (const m of MODELS) {
    const v = compileValidator(m.schema);
    // через JSON, как в настоящей работе: удаление элемента массива не оставляет «дыр»
    const docs = Array.from({ length: 2000 }, (_, i) => JSON.parse(JSON.stringify(i === 0 ? m.base : mutate(m.base, r))));
    const db = await dbIssues(m.schema, docs);
    docs.forEach((d, i) => {
      const a = norm(v(d));
      const b = normDb(db[i]);
      if (db[i].length) invalid++;
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${m.name} #${i} ${JSON.stringify(d)}: ts=${a} db=${b}`);
    });
  }
  if (diffs.length) console.log(diffs.slice(0, 30).join('\n'));
  assert.deepEqual(diffs.slice(0, 30), []);
  assert.ok(invalid > 3000, `среди случайных документов должны быть отклонённые: ${invalid}`);
});

test('умолчания в TypeScript — как apply_defaults в базе', async () => {
  const m = MODELS[0];
  for (const doc of [{ name: 'x' }, { name: 'x', settings: { booking: { window: { limits: {} } } } }, { name: 'x', settings: {} }]) {
    const [row] = await sql.unsafe(`select ${S}.apply_defaults($1::text::jsonb, $2::text::jsonb) as d`, [JSON.stringify(m.schema), JSON.stringify(doc)]);
    assert.deepEqual(applyDefaults(m.schema, doc), row.d);
  }
});
