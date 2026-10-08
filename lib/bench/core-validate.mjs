/**
 * Замер 3 точки А (план, §6, §2.6): цена проверки данных jsonpath на строку — для плоского описания
 * из пяти полей, для вложенного глубины 4 и для модели, где регулярных выражений больше 32
 * (PostgreSQL держит в памяти процесса 32 скомпилированных выражения). Отдельно — цена разбора
 * выражения, чтобы подтвердить пользу колонки validator.
 * Запуск: cd lib && npx tsx bench/core-validate.mjs
 */
import { setup, save, n, round, timed } from './_core.mjs';

const MODELS = {
  flat5: {
    schema: { type: 'object', additionalProperties: false, required: ['a', 'b'], properties: {
      a: { type: 'string' }, b: { type: 'integer', minimum: 0 }, c: { type: 'boolean' },
      d: { type: 'string', enum: ['x', 'y', 'z'] }, e: { type: 'number', maximum: 1e6 } } },
    data: { a: 'строка', b: 5, c: true, d: 'y', e: 12.5 },
  },
  nested4: {
    schema: { type: 'object', additionalProperties: false, properties: { l1: { type: 'object', additionalProperties: false, properties: {
      l2: { type: 'object', additionalProperties: false, properties: { l3: { type: 'object', additionalProperties: false, properties: {
        l4: { type: 'object', additionalProperties: false, required: ['v'], properties: { v: { type: 'string' }, n: { type: 'integer', minimum: 0 } } },
        flag: { type: 'boolean' } } }, mode: { type: 'string', enum: ['a', 'b'] } } }, title: { type: 'string', maxLength: 100 } } } } },
    data: { l1: { title: 'заголовок', l2: { mode: 'a', l3: { flag: false, l4: { v: 'лист', n: 3 } } } } },
  },
  regex40: (() => {
    const properties = {};
    const data = {};
    for (let i = 0; i < 40; i++) {
      properties[`f${i}`] = { type: 'string', pattern: `^p${i}-[0-9]+$` };
      data[`f${i}`] = `p${i}-${i * 7}`;
    }
    return { schema: { type: 'object', additionalProperties: false, properties }, data };
  })(),
};

const env = await setup('validate', { classes: [] });
try {
  const N = n(100000);
  const results = {};
  // данные — строками таблицы: выражение зависит от строки, и планировщик не вычислит его один раз
  const D = `${env.S}.bench_d`;
  for (const [name, m] of Object.entries(MODELS)) {
    await env.sql.unsafe(`drop table if exists ${D}`);
    await env.sql.unsafe(`create table ${D} as select $1::jsonb as d from generate_series(1, $2::int)`, [m.data, N]);
    const baseline = (await timed(() => env.sql.unsafe(`select count(jsonb_typeof(d)) from ${D}`))).ms;
    await env.sql.unsafe(`drop table if exists ${env.S}.bench_v`);
    await env.sql.unsafe(`create table ${env.S}.bench_v as select c.* from ${env.S}.compile_validator($1::jsonb) c`, [m.schema]);
    const [{ ok }] = await env.sql.unsafe(`select ${env.S}.validate_data(rules, validator, vars, $1::jsonb) = '[]' as ok from ${env.S}.bench_v`, [m.data]);
    if (!ok) throw new Error(`данные модели ${name} не проходят проверку`);
    const full = (await timed(() => env.sql.unsafe(`select count(*) from ${D} t, ${env.S}.bench_v v
      where ${env.S}.validate_data(v.rules, v.validator, v.vars, t.d) = '[]'`))).ms;
    const match = (await timed(() => env.sql.unsafe(`select count(*) from ${D} t, ${env.S}.bench_v v
      where jsonb_path_match(t.d, v.validator, v.vars, true) is true`))).ms;
    // разбор выражения на каждую строку: текст выражения отличается пробелом в зависимости от строки
    const parse = (await timed(() => env.sql.unsafe(`select count(*) from ${D} t, ${env.S}.bench_v v
      where jsonb_path_match(t.d, (v.validator::text || repeat(' ', (t.ctid::text::point)[1]::int % 2))::jsonpath, v.vars, true) is true`))).ms;
    const [{ len }] = await env.sql.unsafe(`select length(validator::text) as len from ${env.S}.bench_v`);
    results[name] = {
      validatorChars: len,
      baselineMs: round(baseline),
      validateDataUs: round(((full - baseline) * 1000) / N, 2),
      pathMatchUs: round(((match - baseline) * 1000) / N, 2),
      pathMatchWithParseUs: round(((parse - baseline) * 1000) / N, 2),
    };
    console.log(name, JSON.stringify(results[name]));
  }
  await save('core-validate', { measure: 3, rows: N, results });
} finally {
  await env.close();
}
