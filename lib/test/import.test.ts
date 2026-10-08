/**
 * import — импорт из letopis 0.21 (план, этап 7, п. 1–2; тест-план §7.9 №7.1–7.5, 7.9, 7.10). Источник —
 * фикстура test/fixtures/v021.sql: дамп обычных таблиц настоящей 0.21 (генератор gen-v021.mjs), накатанный
 * в схему той же базы; приёмник — свежая установка 1.0 на каждый сценарий.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ensureDatabase, adminSql, ADMIN_DSN, ident, type Sql } from './_harness.js';
import { install, SYSTEM_ID } from '../src/up.js';
import { import021, type ImportOptions, type ImportReport } from '../src/import.js';
import { connect } from '../src/index.js';
import { v5Id } from '../src/uuid.js';
import { verifyHash } from '../src/auth.js';
import { main as cli } from '../src/cli.js';

const SRC = 'v1.t_import_src';
const DST = 'v2.t_import';
const S = ident(DST);
const F = ident(SRC);
let sql: Sql;
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'aaaaaaaa-0000-4000-8000-000000000002';
const ANNA = 'aaaaaaaa-0000-4000-8000-000000000003';
const acc = (old: string) => v5Id(SYSTEM_ID, 'Account', [old]);

/** Источник 0.21 из фикстуры (patch — правка таблиц для варианта сценария). */
async function source(patch?: string): Promise<void> {
  await sql.unsafe(`drop schema if exists ${F} cascade`);
  await sql.unsafe((await readFile(new URL('./fixtures/v021.sql', import.meta.url), 'utf8')).replaceAll('<SCHEMA>', SRC));
  if (patch) await sql.unsafe(patch.replaceAll('$F', F));
}

/** Свежая установка 1.0. */
async function target(): Promise<void> {
  await sql.unsafe(`drop schema if exists ${S} cascade`);
  await install(sql, { schema: DST, allowReset: true });
}

const run = (o: Partial<ImportOptions> = {}): Promise<ImportReport> =>
  import021({ from: ADMIN_DSN, fromSchema: SRC, dsn: ADMIN_DSN, schema: DST, tenant: 'Импорт', quiet: true, ...o });

/** Число объектов, версий и живых строк по классам фикстуры (как в базе 0.21). */
const EXPECTED: Record<string, [number, number, number]> = {
  Org: [3, 3, 3], Folder: [3, 3, 3], Service: [5, 7, 5], Product: [1, 1, 1], Complex: [1, 1, 1], Customer: [2, 4, 1],
  Location: [1, 1, 1], Schedule: [1, 1, 1], Staff: [1, 1, 1], address: [1, 1, 1], booking: [1, 2, 1], compo: [2, 2, 2],
  content: [1, 1, 1], price: [1, 1, 1], skill: [1, 1, 1],
};

before(async () => {
  await ensureDatabase();
  sql = adminSql();
});

after(async () => {
  await sql.unsafe(`drop schema if exists ${F} cascade`);
  await sql.unsafe(`drop schema if exists ${S} cascade`);
  await sql.end({ timeout: 5 });
});

test('7.1 нарушение ключа в данных 0.21: импорт останавливается до записи и называет строки', async () => {
  await source();
  await target();
  await assert.rejects(run(), (e: Error & { code?: string; detail?: { rows: { class: string; id: string; code: string }[] } }) => {
    assert.equal(e.code, 'duplicate');
    assert.match(e.message, /--keyless Service/);
    assert.ok(e.detail!.rows.some((r) => r.class === 'Service' && r.code === 'duplicate'));
    return true;
  });
  const [{ n }] = await sql.unsafe(`select count(*)::int as n from ${S}.entity where class = 'Class' and data->>'name' = 'Org'`);
  assert.equal(n, 0, 'классы не созданы: проверки — до первой записи');
});

test('7.2–7.5 импорт с --keyless: счётчики по классам, verify, самоссылка, повтор без дублей, id классов без ключа', async () => {
  await source();
  await target();
  const r = await run({ keyless: ['Service'] });
  // 7.2 счётчики сущностей и версий по классам равны фикстуре; verify чист; отчёт называет класс без ключа
  for (const [cls, [objects, versions, live]] of Object.entries(EXPECTED)) {
    assert.deepEqual(r.source[cls], { objects, versions, live }, `0.21: ${cls}`);
    assert.deepEqual(r.target[cls], { objects, versions, live }, `1.0: ${cls}`);
  }
  assert.equal(r.verify.ok, true);
  assert.deepEqual(r.classes.keyless, ['Service']);
  assert.deepEqual(r.classes.omitted.sort(), ['Entity', 'link']);
  assert.ok(r.classes.created.includes('Folder') && r.classes.created.includes('booking'));
  const v = await sql.unsafe(`select ${S}.verify(true) as v`);
  assert.equal(v[0].v.ok, true, JSON.stringify(v[0].v.issues));

  // описание: союз всех потомков Element — полиморфный конец Element; часть потомков — союз
  const desc = async (name: string) => (await sql.unsafe(`select data from ${S}.entity where class = 'Class' and data->>'name' = $1`, [name]))[0].data;
  assert.deepEqual((await desc('booking')).ends.Element, { class: 'Element', required: true, onDelete: 'cascade' });
  assert.deepEqual((await desc('compo')).ends.Service_Product.class, ['Service', 'Product']);
  assert.deepEqual((await desc('compo')).key, ['Complex', 'Service_Product']);
  assert.deepEqual((await desc('Element')).key, ['Org', 'name']);
  assert.deepEqual((await desc('Service')).key, []);
  assert.equal((await desc('Org')).fields.properties.settings.anyOf[0].additionalProperties, false, 'strict-объект');
  assert.deepEqual((await desc('Element')).fields.properties.description, { type: ['string', 'null'] }, 'optional пропускает null');

  // 7.3 самоссылка: дерево папок загружено, ссылки — на новые id
  const folders = await sql.unsafe(`select id, data->>'name' as name, links from ${S}.entity where class = 'Folder' order by data->>'name'`);
  const byName = Object.fromEntries(folders.map((f) => [f.name, f]));
  assert.equal(byName['Мужской зал'].links.Folder, byName['Каталог'].id);
  assert.equal(byName['Борода'].links.Folder, byName['Мужской зал'].id);

  // 7.5 класс без ключа: новый id — v5 от старого в пространстве арендатора; ссылки — на новые id
  const src = await sql.unsafe(`select distinct id, account::text as account, data->>'name' as name from ${F}."Entity" where class = 'Service'`);
  const live = await sql.unsafe(`select id, tenant::text as tenant, data->>'name' as name from ${S}.entity where class = 'Service'`);
  for (const s of src) {
    const id = v5Id(acc(s.account), 'Service', [s.id]);
    if (s.name !== 'Окрашивание' || live.some((l) => l.id === id)) assert.ok(live.some((l) => l.id === id), `услуга ${s.name}`);
  }
  const [skill] = await sql.unsafe(`select links from ${S}.entity where class = 'skill'`);
  const [cutOld] = await sql.unsafe(`select id from ${F}."Entity" where class = 'Service' and data->>'name' = 'Стрижка' and account = $1`, [A]);
  assert.equal(skill.links.Service, v5Id(acc(A), 'Service', [cutOld.id]));

  // история: надгробие и воскрешение; теги; владелец; данные System — в арендаторе «Импорт»
  const dye = await sql.unsafe(`select l.op from ${S}.log l join ${S}.entity e on e.id = l.id where e.data->>'name' = 'Окрашивание' order by l.rev`);
  assert.deepEqual(dye.map((x) => x.op), ['create', 'delete', 'create']);
  const [vip] = await sql.unsafe(`select tags from ${S}.entity where class = 'Customer' and data->>'name' = 'Пётр'`);
  assert.deepEqual(vip.tags, ['vip']);
  const [bk] = await sql.unsafe(`select owner::text as owner, data->>'notes' as notes, rev from ${S}.entity where class = 'booking'`);
  assert.deepEqual([bk.owner, bk.notes, bk.rev], [acc(ANNA), 'подтверждена', 2]);
  const [sysOrg] = await sql.unsafe(`select tenant::text as tenant from ${S}.entity where class = 'Org' and data->>'name' = 'Системная организация'`);
  assert.equal(sysOrg.tenant, v5Id(SYSTEM_ID, 'Account', ['tenant:Импорт']));
  const [{ agents }] = await sql.unsafe(`select array_agg(distinct agent) as agents from ${S}.log where tenant = $1::uuid`, [acc(A)]);
  assert.deepEqual(agents, ['letopis import']);

  // креды: хэши как есть — вход настоящим паролем и ключом; OTP не переносится; совпадение без учёта регистра — в отчёте
  assert.deepEqual([r.credentials.imported, r.credentials.otp, r.credentials.conflicts.length], [5, 1, 1]);
  const [pw] = await sql.unsafe(`select convert_from(material, 'UTF8') as h from ${S}.secret where kind = 'PASSWORD' and account = $1::uuid`, [acc(ANNA)]);
  assert.equal(await verifyHash('пароль-Ани-1', pw.h), true);
  assert.equal(await verifyHash('неверный', pw.h), false);
  // ключ API Ани: вход открывает её сессию (login_apikey сверяет sha256 ключа)
  const anna = await connect({ dsn: ADMIN_DSN, schema: DST, apiKey: 'lts_0123456789abcdef0123456789abcdef0123456789abcdef', allowBypassRls: true, listen: false, max: 1 });
  await anna.close();
  await assert.rejects(connect({ dsn: ADMIN_DSN, schema: DST, apiKey: 'lts_ffff456789abcdef0123456789abcdef0123456789abcdef', allowBypassRls: true, listen: false, max: 1 }),
    (e: Error & { code?: string }) => e.code === 'no_session');
  // права: ресурс на строки (account → tenant) и правило
  const [res] = await sql.unsafe(`select data from ${S}.entity where class = 'Resource' and data->>'alias' = 'own-bookings:READ'`);
  assert.deepEqual(res.data.pattern, { class: 'booking', owner: '$account' });
  assert.ok(r.rules.loaded >= 1);

  // 7.4 повторный импорт: ничего не записано, все объекты пропущены
  const r2 = await run({ keyless: ['Service'] });
  assert.equal(r2.objects.loaded, 0);
  assert.equal(r2.objects.skipped, Object.values(EXPECTED).reduce((n, [o]) => n + o, 0));
  assert.equal(r2.classes.created.length, 0);
  assert.equal(r2.accounts.loaded, 0);
  assert.equal(r2.credentials.imported, 0);
  for (const [cls, [objects, versions, live]] of Object.entries(EXPECTED)) assert.deepEqual(r2.target[cls], { objects, versions, live }, `повтор: ${cls}`);
});

test('7.9 висячая ссылка 0.21: живая запись ссылается на удалённого клиента — импорт останавливается с target_not_found', async () => {
  await source(`update $F."Entity" e set links = jsonb_set(e.links, '{Customer}', to_jsonb(g.id))
    from (select id from $F."Entity" where class = 'Customer' and deleted is not null) g
    where e.class = 'booking' and e.updated = (select max(updated) from $F."Entity" where class = 'booking')`);
  await target();
  await assert.rejects(run({ keyless: ['Service'] }), (e: Error & { code?: string; detail?: { rows: { class: string; code: string }[] } }) => {
    assert.equal(e.code, 'target_not_found');
    assert.ok(e.detail!.rows.some((x) => x.class === 'booking' && x.code === 'target_not_found'), JSON.stringify(e.detail));
    return true;
  });
});

test('7.10 директивы fastest-validator: $$strict во вложенном объекте → additionalProperties: false; поле $note — в отчёте', async () => {
  await source(`insert into $F."Schema" (partition, id, alias, category, ancestor, attributes, links, meta, "order", ancestors, descendants)
      values ('entity', 'Note', 'Заметка', 'HUB', 'Entity',
        '{"text": "string", "$note": "string|optional", "box": {"type": "object", "props": {"$$strict": true, "a": "string"}}}',
        '[]', '{}', 0, '{Note,Entity}', '{Note}');
    insert into $F."Entity" (partition, id, class, data, updated, account, tags, owner, links)
      values ('entity', '01a11d17-0000-7000-8000-00000000f001', 'Note', '{"text": "т", "$note": "служебное", "box": {"a": "x"}}',
        now(), '${A}', '{}', '${A}', '{}')`);
  await target();
  const r = await run({ keyless: ['Service'] });
  assert.ok(r.notes.some((n) => n.class === 'Note' && n.field === '$note'), JSON.stringify(r.notes));
  assert.equal(r.droppedFields['Note.$note'], 1);
  const [d] = await sql.unsafe(`select data from ${S}.entity where class = 'Class' and data->>'name' = 'Note'`);
  assert.equal(d.data.fields.properties.box.additionalProperties, false);
  assert.equal(d.data.fields.properties.$note, undefined);
  const [n] = await sql.unsafe(`select data from ${S}.entity where class = 'Note'`);
  assert.deepEqual(n.data, { text: 'т', box: { a: 'x' } });
  void B;
});

test('повтор с update: изменившийся в 0.21 объект получает новую версию, остальные не тронуты', async () => {
  await source();
  await target();
  await run({ keyless: ['Service'] });
  // в 0.21 появилась новая версия клиента
  await sql.unsafe(`insert into ${F}."Entity" (partition, id, class, data, updated, account, tags, owner, links)
    select partition, id, class, data || '{"phone": "+7 900 999-99-99"}', updated + interval '1 day', account, tags, owner, links
    from ${F}."Entity" where class = 'Customer' and data->>'name' = 'Пётр' order by updated desc limit 1`);
  const plain = await run({ keyless: ['Service'] });
  assert.equal(plain.objects.updated, 0, 'без update существующие объекты пропускаются');
  const r = await run({ keyless: ['Service'], update: true });
  assert.equal(r.objects.updated, 1);
  const [p] = await sql.unsafe(`select rev, data->>'phone' as phone, tags from ${S}.entity where class = 'Customer' and data->>'name' = 'Пётр'`);
  assert.deepEqual([p.rev, p.phone, p.tags], [3, '+7 900 999-99-99', ['vip']]);
  assert.equal(r.verify.ok, true);
});

test('CLI letopis import: нарушение ключа — ошибка с перечнем строк; с --keyless — код 0 и отчёт', async () => {
  await source();
  await target();
  const base = ['import', '--from', ADMIN_DSN, '--from-schema', SRC, '--dsn', ADMIN_DSN, '--schema', DST, '--tenant', 'Импорт'];
  await assert.rejects(cli(base), (e: Error & { code?: string }) => e.code === 'duplicate');
  const log = console.log;
  const out: string[] = [];
  console.log = (m: string) => out.push(String(m));
  let code: number;
  try {
    code = await cli([...base, '--keyless', 'Service']);
  } finally {
    console.log = log;
  }
  assert.equal(code, 0);
  const r = JSON.parse(out.find((x) => x.startsWith('{'))!) as ImportReport;
  assert.equal(r.verify.ok, true);
  assert.deepEqual(r.classes.keyless, ['Service']);
});
