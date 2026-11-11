// Цена прав (решение 3 точки А, замер на этапе 5): контекст, матрица прав со счётом и короткие запросы под RLS
// с настоящими правилами — жилец-owner квартиры (правила createTenant: owner — READ, WRITE, DELETE, API и ROLE с весом
// 100 000, консьерж «можно всё» с весом 1 000 000) и ещё 40 правил
// с условиями на строку по меткам. Время на вызов: внутри одной транзакции и операцией библиотеки
// (каждая операция — своя транзакция с set_config).
// Запуск: cd lib && npx tsx bench/acl-cost.mjs
import { setup } from './_core.mjs';

const N = Number(process.env.N ?? 500);
const env = await setup('acl_cost');
const { sql, app, S, asOwner, tenant, token } = env;

const [{ org }] = await env.as((tx) => tx.unsafe(`insert into ${S}.entity (class, data) values ('Org', '{"name": "Салон"}') returning id as org`));
for (let i = 0; i < 200; i++) {
  await env.as((tx) => tx.unsafe(`insert into ${S}.entity (class, data, links) values ('Master', $1::jsonb, $2::jsonb)`,
    [{ name: `Мастер ${i}`, level: i % 10 }, { Org: org }]));
}
const [m] = await env.as((tx) => tx.unsafe(`select id from ${S}.entity where class = 'Master' limit 1`));

const extra = async () => asOwner(async (tx) => {
  for (let i = 0; i < 20; i++) {
    const [{ id: g }] = await tx.unsafe(`select ${S}.sys_resource($1, $2, 'ACCOUNT', $3::jsonb) as id`, [tenant, `g${i}:ACCOUNT`, { roles: `{r${i}}` }]);
    for (const op of ['READ', 'WRITE']) {
      const [{ id: o }] = await tx.unsafe(`select ${S}.sys_resource($1, $2, $3, $4::jsonb) as id`,
        [tenant, `o${i}:${op}`, op, { class: i % 2 ? 'Master' : 'Shift', owner: '$actor' }]);
      await tx.unsafe(`select ${S}.sys_rule($1, $2, $3, 'allow', $4)`, [tenant, g, o, 20 + i]);
    }
  }
});

async function timeIt(label, text, params = [], perTx = false) {
  const run = async () => {
    if (perTx) {
      for (let i = 0; i < N; i++) {
        await app.begin(async (tx) => {
          await tx`select set_config('letopis.token', ${token}, true)`;
          await tx.unsafe(text, params);
        });
      }
    } else {
      await app.begin(async (tx) => {
        await tx`select set_config('letopis.token', ${token}, true)`;
        for (let i = 0; i < N; i++) await tx.unsafe(text, params);
      });
    }
  };
  await run();
  const t0 = process.hrtime.bigint();
  await run();
  const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
  console.log(`${label.padEnd(62)} ${us.toFixed(0).padStart(6)} мкс`);
}

// На стороне сервера: цикл в одном DO-блоке от роли приложения — без круга по сети.
let pass = null; // eslint-disable-line prefer-const
async function server(label, stmt, params = []) {
  const body = stmt.replace(/\$1/g, params.length ? `'${params[0]}'::uuid` : '$1');
  const [r] = await app.begin(async (tx) => {
    await tx`select set_config('letopis.token', ${token}, true)`;
    if (pass) await tx`select set_config('letopis.acl', ${pass}, true)`;
    await tx.unsafe(`do $$ declare t0 timestamptz := clock_timestamp(); i int; begin
      for i in 1..${N} loop perform * from (${body}) q; end loop;
      perform set_config('bench.us', (extract(epoch from clock_timestamp() - t0) * 1e6 / ${N})::text, true);
    end $$`);
    return tx.unsafe(`select current_setting('bench.us') as us`);
  });
  console.log(`${('[сервер' + (pass ? ', пропуск' : '') + '] ' + label).padEnd(62)} ${Number(r.us).toFixed(1).padStart(6)} мкс`);
}

async function series(title) {
  console.log(`\n${title}`);
  await timeIt('select 1 (база отсчёта)', 'select 1');
  await timeIt('ctx()', `select * from ${S}.ctx()`);
  await timeIt('acl_plan(READ)', `select ${S}.acl_plan('READ')`);
  await timeIt('строка по id под RLS', `select * from ${S}.entity where id = $1`, [m.id]);
  await timeIt('count Master (200 строк) под RLS', `select count(*) from ${S}.entity where class = 'Master'`);
  await timeIt('операция: транзакция + set_config + строка по id', `select * from ${S}.entity where id = $1`, [m.id], true);
  await server('select 1', 'select 1');
  await server('ctx()', `select * from ${S}.ctx()`);
  await server('acl_plan(READ)', `select ${S}.acl_plan('READ')`);
  await server('строка по id под RLS', `select * from ${S}.entity where id = $1`, [m.id]);
  await server('count Master (200 строк) под RLS', `select count(*) from ${S}.entity where class = 'Master'`);
}

console.log(`letopis — цена прав, N=${N}`);
await series('правила createTenant: owner (READ, WRITE, DELETE, API, ROLE) и консьерж «можно всё» + правила System');
await extra();
await series('плюс 40 правил с условием owner = $actor по 20 меткам');
({ 0: { t: pass } } = await env.as((tx) => tx.unsafe(`select ${S}.acl_token() as t`)));
await series('то же с подписанным пропуском прав letopis.acl');
const own = await sql.begin(async (tx) => {
  await tx.unsafe('set local role letopis_owner');
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) await tx.unsafe(`select * from ${S}.entity where id = $1`, [m.id]);
  return Number(process.hrtime.bigint() - t0) / 1000 / N;
});
console.log(`\n${'строка по id от владельца (без RLS)'.padEnd(62)} ${own.toFixed(0).padStart(6)} мкс`);
await env.close();
