#!/usr/bin/env node
/**
 * Генератор фикстуры 0.21 для теста импорта (план, этап 7, п. 2): небольшая база настоящей letopis 0.21
 * (dev-зависимость letopis-0, контейнер letopis-timescale, порт 15432), выгруженная дампом обычных
 * таблиц без TimescaleDB — test/fixtures/v021.sql. CI файл только читает; генератор нужен, чтобы
 * пересобрать фикстуру:
 *
 *   cd lib && node test/fixtures/gen-v021.mjs        (LETOPIS_021_DSN — другая база 0.21)
 *
 * Состав: арендаторы «Салон А» и «Салон Б», пользователь Аня (владелец записи, креды всех видов),
 * данные аккаунта System; дерево папок (самоссылка), услуги, товар, комплекс и состав (союзы),
 * мастер, локация, расписание, клиенты, навык, запись в двух версиях, удалённый клиент (надгробие),
 * услуга, удалённая и созданная заново, теги; ресурсы и правила сида 0.21 плюс правило на строки;
 * намеренное нарушение ключа — вторая услуга «Стрижка» Салона Б, вставленная сырым SQL со своим id.
 */
import { writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { up } from 'letopis-0';
import { hashPassword, base32Encode } from '../../src/auth.ts';

const DSN = process.env.LETOPIS_021_DSN ?? 'postgres://postgres:test@localhost:15432/letopis';
const SCHEMA = 'v1.fixture_import';
const SYSTEM = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'aaaaaaaa-0000-4000-8000-000000000002';
const ANNA = 'aaaaaaaa-0000-4000-8000-000000000003';
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const adm = postgres(DSN, { max: 1, onnotice: () => {} });
await adm.unsafe(`drop schema if exists "${SCHEMA}" cascade`);
const db = await up({ schema: 'fixture_import', version: 1, dsn: DSN, quiet: true });
const S = `"${SCHEMA}"`;
try {
  // аккаунты: два арендатора и пользователь
  await adm.unsafe(`insert into ${S}."Account" (id, categories, data) values
    ('${A}', '{User}', '{"name": "Салон А"}'), ('${B}', '{User}', '{"name": "Салон Б"}'), ('${ANNA}', '{User}', '{"name": "Аня"}')`);
  // креды: пароль, ключ API, пара ключ-секрет, TOTP, одноразовый код, внешняя identity; совпадение без учёта регистра
  const totp = base32Encode(Buffer.from('12345678901234567890'));
  await adm.unsafe(`insert into ${S}."Credential" (account, category, identifier, meta, confirmed) values
    ($1, 'PASSWORD', 'anna@salon.ru', $2, true),
    ($1, 'APIKEY', $3, $4, true),
    ($5, 'KEYSECRET', 'k-salon-b-0001', $6, true),
    ($1, 'TOTP', $1, $7, true),
    ($1, 'OTP', 'anna@salon.ru', $8, true),
    ($1, 'TELEGRAM', 'tg-100500', '{"username": "anna"}', true),
    ($9, 'PASSWORD', 'Anna@Salon.ru', $10, false)`,
  [ANNA, { password: await hashPassword('пароль-Ани-1') }, sha('lts_0123456789abcdef0123456789abcdef0123456789abcdef'),
    { name: 'касса', prefix: 'lts_01234567' }, B, { name: 'склад', secret: sha('секрет-Б') }, { secret: totp, lastStep: 0 },
    { code: sha('123456'), expires: new Date(Date.now() + 3600e3).toISOString(), attempts: 0 }, A, { password: await hashPassword('другой') }]);
  // права: ресурс на строки и правило (сид 0.21 уже положил 16 ресурсов и 12 правил)
  await adm.unsafe(`insert into ${S}."Resource" (alias, category, pattern, meta) values
    ('own-bookings:READ', 'READ', '{"class": "booking", "owner": "$account"}', '{"description": "свои записи"}')`);
  await adm.unsafe(`insert into ${S}."Rule" (account, resource, permission, weight, meta, enabled) values
    ('authenticated:ACCOUNT', 'own-bookings:READ', 'allow', 50, '{"description": "клиент видит свои записи"}', true)`);

  const a = await db.as(A);
  const [org] = await a.Организация().create({ name: 'Салон А', settings: { booking: { deposit: { amount: 500 } } } }).rows();
  const [root] = await a.Организация(org).Папка().create({ name: 'Каталог' }).rows();
  const [hall] = await a.Папка(root).Папка().create({ name: 'Мужской зал' }).Организация.set(org).rows();
  await a.Папка(hall).Папка().create({ name: 'Борода' }).Организация.set(org).rows();
  const [cut] = await a.Организация(org).Услуга().create({ name: 'Стрижка', duration: 60 }).rows();
  const [shave] = await a.Организация(org).Услуга().create({ name: 'Бритьё', duration: 30, description: null }).rows();
  const [wax] = await a.Организация(org).Товар().create({ name: 'Воск', sku: 'W-1' }).rows();
  const [combo] = await a.Организация(org).Комплекс().create({ name: 'Стрижка и бритьё', cost: 2000, duration: 90 }).rows();
  await a.Комплекс(combo).состав().create({ quantity: 1 }).Услуга.set(cut).rows();
  await a.Комплекс(combo).состав().create({ quantity: 1 }).Товар.set(wax).rows();
  await a.Папка(hall).содержимое().create({ order: 1 }).Услуга.set(shave).rows();
  await a.Услуга(cut).цена().create({ amounts: { RUB: 1500 } }).rows();
  const [loc] = await a.Организация(org).Локация().create({ address: 'Тверская, 1' }).rows();
  const [sch] = await a.Организация(org).Расписание().create({ name: 'Октябрь', year: 2026, month: 10 }).rows();
  const [vasya] = await a.Организация(org).Мастер().create({ name: 'Вася', phone: '+7 900 000-00-01' }).rows();
  await a.Мастер(vasya).навык().create({ level: 'expert' }).Услуга.set(cut).rows();
  await a.Мастер(vasya).адрес().create({ default: true }).Локация.set(loc).rows();
  const [vip] = await a.Организация(org).Клиент().create({ name: 'Пётр', phone: '+7 900 000-00-02' }).rows();
  await adm.unsafe(`update ${S}."Entity" set tags = '{vip}' where id = $1`, [vip.id]);
  const [gone] = await a.Организация(org).Клиент().create({ name: 'Ушедший', phone: '+7 900 000-00-03' }).rows();
  const start = '2026-10-07T10:00:00.000Z';
  const ao = await db.as(A, { owner: ANNA });
  const [bk] = await ao.Мастер(vasya).запись().create({ start_datetime: start, end_datetime: '2026-10-07T11:00:00.000Z' })
    .Локация.set(loc).Расписание.set(sch).Услуга.set(cut).Клиент.set(vip).rows();
  await a.запись(bk).update({ notes: 'подтверждена' }).rows();
  await a.Клиент(gone).delete({ confirm: true }).rows();
  // услуга удалена и создана заново с тем же ключом: история продолжается
  const [dye] = await a.Организация(org).Услуга().create({ name: 'Окрашивание', duration: 120 }).rows();
  await a.Услуга(dye).delete({ confirm: true }).rows();
  await a.Организация(org).Услуга().create({ name: 'Окрашивание', duration: 90 }).rows();

  // Салон Б: организация и услуга; затем нарушение ключа сырым SQL — вторая «Стрижка» со своим id
  const b = await db.as(B);
  const [orgB] = await b.Организация().create({ name: 'Салон Б' }).rows();
  const [cutB] = await b.Организация(orgB).Услуга().create({ name: 'Стрижка', duration: 45 }).rows();
  await adm.unsafe(`insert into ${S}."Entity" (partition, id, class, data, account, owner, links, tags)
    select partition, $1, class, data || '{"duration": 50}', account, owner, links, tags from ${S}."Entity" where id = $2`, [randomUUID(), cutB.id]);

  // данные аккаунта System
  const sys = await db.as(SYSTEM);
  await sys.Организация().create({ name: 'Системная организация' }).rows();

  // дамп: обычные таблицы без TimescaleDB, триггеров и внешних ключей; схема — маркер <SCHEMA>
  const tables = {
    Schema: `partition text, id text, alias text, category text, ancestor text, attributes jsonb, links jsonb, meta jsonb, "order" int, ancestors text[], descendants text[]`,
    Entity: `partition text, id text, class text, data jsonb, updated timestamptz, account uuid, tags text[], owner uuid, links jsonb, deleted timestamptz`,
    Account: `id uuid, categories varchar[], data jsonb, meta jsonb, avatar varchar(255), enabled boolean, created timestamptz, updated timestamptz`,
    Credential: `id uuid, account uuid, category varchar(255), identifier varchar(255), meta jsonb, confirmed boolean, created timestamptz, updated timestamptz, deleted timestamptz`,
    Resource: `alias varchar(255), category varchar(255), pattern jsonb, meta jsonb`,
    Rule: `account varchar(255), resource varchar(255), permission varchar(255), weight integer, meta jsonb, enabled boolean`,
  };
  const order = { Schema: 'cardinality(ancestors), id', Entity: 'class, id, updated', Account: 'id', Credential: 'created, id', Resource: 'alias', Rule: 'account, resource' };
  let out = `-- Фикстура letopis 0.21 для теста импорта (этап 7, п. 2): дамп обычных таблиц схемы ${SCHEMA}.\n`
    + `-- Сгенерирован lib/test/fixtures/gen-v021.mjs; маркер <SCHEMA> — имя схемы при накате.\n`
    + `create schema if not exists "<SCHEMA>";\n`;
  for (const [t, cols] of Object.entries(tables)) {
    const [{ j }] = await adm.unsafe(`select coalesce(json_agg(x order by ${order[t]}), '[]') as j from (select * from ${S}."${t}") x`);
    out += `create table "<SCHEMA>"."${t}" (${cols});\n`;
    out += `insert into "<SCHEMA>"."${t}" select * from json_populate_recordset(null::"<SCHEMA>"."${t}", $j$${JSON.stringify(j)}$j$);\n`;
  }
  await writeFile(new URL('./v021.sql', import.meta.url), out);
  const [{ n }] = await adm.unsafe(`select count(*)::int as n from ${S}."Entity"`);
  console.log(`фикстура: ${n} версий Entity → test/fixtures/v021.sql`);
} finally {
  await db.close();
  await adm.unsafe(`drop schema if exists "${SCHEMA}" cascade`);
  await adm.end();
}
