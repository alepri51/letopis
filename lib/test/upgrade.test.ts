/**
 * Обновление схемы (доработки после 1.2.0, этап 1). Схему ставит прежний пакет — 1.1.0 (dev-зависимость `letopis-11`)
 * или 1.0.1 (`letopis-1`), данные в неё пишет прежний движок, затем up() текущей версии:
 * - 1.1.0 → текущая: ревизия движка та же (6), поэтому up() идёт обычным повторным накатом, без upgrade;
 * - 1.0.1 → текущая: ревизия 5 — up() без upgrade отказывает, up({ upgrade: true }) применяет миграцию 0006.
 * После обновления версии прежнего движка и их хэши на месте, verify({ data: true }) чист, каталог схемы совпадает с
 * чистой установкой текущей версии, у классов есть строки-замки семейств, строки вида LOCK чужих аккаунтов сняты,
 * приложение и проектор работают по данным прежнего движка, а повторный up() не меняет ни каталог, ни данные.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureDatabase, adminSql, appSql, ensureAppRole, appDsn, ident, schemaFor, ADMIN_DSN, type Sql } from './_harness.js';
import { up, SYSTEM_ID, type UpResult } from '../src/up.js';
import type { SignalMode } from '../src/signals.js';
import { connect, type ProjectorChange, type ProjectorOut, type WatchEvent } from '../src/index.js';

/** Что тест берёт у прежнего пакета. */
interface OldLib { up(opts: Record<string, unknown>): Promise<unknown> }

const BASE = schemaFor(import.meta.filename);
let sql: Sql;
let app: Sql | undefined;

before(async () => {
  await ensureDatabase();
  sql = adminSql();
});

after(async () => {
  await app?.end({ timeout: 5 });
  for (const s of ['110', '101', 'ref110', 'ref101']) await sql.unsafe(`drop schema if exists ${ident(`${BASE}_${s}`)} cascade`);
  await sql.end({ timeout: 5 });
});

/** Предупреждения connect() текущей версии на схеме S — кроме «RLS не действует» администраторского подключения. */
async function connectWarns(S: string): Promise<string[]> {
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => warns.push(String(m));
  try {
    const db = await connect({ dsn: ADMIN_DSN, schema: S, allowBypassRls: true, listen: false, max: 1 });
    await db.close();
  } finally {
    console.warn = warn;
  }
  return warns.filter((w) => !/RLS не действует/.test(w));
}

/** Пул прикладной роли: роль letopis_app создаёт установщик, поэтому — после установки прежним пакетом. */
async function appPool(): Promise<Sql> {
  await ensureAppRole(sql);
  return (app ??= appSql(4));
}

const SHELF = { name: 'Shelf', kind: 'hub', key: ['code'], history: { all: '1 day', daily: 'forever' },
  fields: { properties: { code: { type: 'string' }, title: { type: 'string' } }, required: ['code'] } };
const BOOK = { name: 'Book', kind: 'hub', fields: { properties: { title: { type: 'string' }, n: { type: 'integer' } }, required: ['title'] },
  ends: { Shelf: { class: 'Shelf', required: true, onDelete: 'cascade' } } };
const BOOK_COUNT = { name: 'BookCount', kind: 'hub', key: ['k'], derivedBy: 'bookcount', history: false,
  fields: { properties: { k: { type: 'string' }, n: { type: 'integer' } }, required: ['k'] } };

interface OldData {
  tenant: string;
  token: string;
  shelves: string[];
  books: string[];
  /** Книги, удалённые прежним движком: первая — со стёртой историей, две другие — каскадом. */
  gone: string[];
  /** Креденшал пользователя вида LOCK, заведённый прежним движком. */
  lockCred: string;
}

/**
 * Данные прежнего движка: арендатор с правилом «можно всё», класс с политикой хранения и класс с концом, правки,
 * перенос на другую полку, удаление, каскад, purge, обрезка истории и креденшал вида LOCK.
 */
async function writeOld(S: string): Promise<OldData> {
  const Q = ident(S);
  const pool = await appPool();
  const tenant = randomUUID();
  await sql.begin(async (tx) => {
    await tx.unsafe('set local role letopis_owner');
    await tx.unsafe(`select ${Q}.sys_create($1::uuid, 'Account', $2::uuid, '{}', $3::jsonb)`, [tenant, SYSTEM_ID, { name: 'old', enabled: true } as never]);
    await tx.unsafe(`select ${Q}.sys_grant_all($1::uuid)`, [tenant]);
  });
  // свежий интерактивный вход: auth_link требует недавнего входа
  const [{ tok }] = await sql.unsafe(`select ${Q}.new_session($1::uuid, interval '1 day', $2::jsonb) as tok`,
    [tenant, { login_at: new Date().toISOString(), methods: ['PASSWORD'] } as never]);
  const token = tok as string;
  const as = (text: string, params: unknown[] = []) => pool.begin(async (tx) => {
    await tx`select set_config('letopis.token', ${token}, true)`;
    return tx.unsafe(text, params as never[]);
  });
  for (const c of [SHELF, BOOK]) await as(`insert into ${Q}.entity (class, data) values ('Class', $1::jsonb)`, [c]);
  const shelves: string[] = [];
  for (const code of ['a', 'b', 'c']) {
    const [r] = await as(`insert into ${Q}.entity (class, data) values ('Shelf', $1::jsonb) returning id`, [{ code, title: `полка ${code}` }]);
    shelves.push(r.id as string);
  }
  const books: string[] = [];
  for (let i = 0; i < 6; i++) {
    const [r] = await as(`insert into ${Q}.entity (class, data, links) values ('Book', $1::jsonb, $2::jsonb) returning id`,
      [{ title: `книга ${i}`, n: 0 }, { Shelf: shelves[i % 3] }]);
    books.push(r.id as string);
  }
  for (const id of books) await as(`update ${Q}.entity set data = data || '{"n": 1}' where id = $1`, [id]);
  await as(`update ${Q}.entity set data = data || '{"n": 2}', links = $2::jsonb where id = $1`, [books[0], { Shelf: shelves[1] }]);
  await as(`delete from ${Q}.entity where id = $1`, [books[1]]);
  await as(`delete from ${Q}.entity where id = $1`, [shelves[2]]); // каскад: книги 2 и 5
  await as(`select ${Q}.purge($1::uuid, true)`, [books[1]]);
  await as(`select ${Q}.trim_history(array[$1::uuid], null, now())`, [books[3]]);
  // вид LOCK у креденшала пользователя прежние версии допускали (auth_kind_ok); накат 1.2 такие строки снимает
  const [{ id: lockCred }] = await as(`select ${Q}.auth_link($1::uuid, 'LOCK', $2, '{}'::jsonb, false) as id`,
    [tenant, `${S}:family:${tenant}:Book`]);
  return { tenant, token, shelves, books, gone: [books[1], books[2], books[5]], lockCred: lockCred as string };
}

interface Versions {
  /** Версии журнала всех арендаторов: «id rev op hash». */
  log: string[];
  /** Арендатор каждой версии журнала. */
  tenants: Map<string, string>;
  /** Строки арендатора теста: «id rev hash». */
  ent: string[];
}

async function versions(S: string, tenant: string): Promise<Versions> {
  const Q = ident(S);
  const log = await sql.unsafe(`select id::text, rev, op, tenant::text, encode(hash, 'hex') as h from ${Q}.log order by id, rev, seq`);
  const ent = await sql.unsafe(`select id::text, rev, encode(hash, 'hex') as h from ${Q}.entity where tenant = $1 order by id`, [tenant]);
  const key = (r: Record<string, unknown>) => `${r.id} ${r.rev} ${r.op} ${r.h}`;
  return {
    log: log.map(key),
    tenants: new Map(log.map((r) => [key(r), r.tenant as string])),
    ent: ent.map((r) => `${r.id} ${r.rev} ${r.h}`),
  };
}

/**
 * Каталог схемы строками без её имени: функции (аргументы с умолчаниями, результат, вид, security definer,
 * изменчивость, настройки, владелец, права, текст), отношения (вид, владелец, права, RLS, параметры), колонки по
 * порядку (тип, not null, генерируемое выражение, умолчание, права), индексы, ограничения, триггеры с режимом,
 * политики, типы, комментарий и права схемы. Права — отсортированными элементами: порядок выдачи не важен.
 */
async function catalog(S: string): Promise<string[]> {
  const acl = (col: string) => `coalesce((select string_agg(x::text, ',' order by x::text) from unnest(${col}) x), '')`;
  const rows = await sql.unsafe(`
    with n as (select oid from pg_namespace where nspname = $1)
    select 'fn ' || p.proname || '(' || pg_get_function_arguments(p.oid) || ') -> ' || coalesce(pg_get_function_result(p.oid), '')
           || ' kind=' || p.prokind::text || ' secdef=' || p.prosecdef || ' vol=' || p.provolatile::text || ' strict=' || p.proisstrict
           || ' cfg=' || coalesce(array_to_string(p.proconfig, ';'), '') || ' owner=' || pg_get_userbyid(p.proowner)
           || ' acl=' || ${acl('p.proacl')} || ' src=' || md5(replace(coalesce(p.prosrc, ''), $1, '@S@')) as x
    from pg_proc p join n on p.pronamespace = n.oid
    union all
    select 'rel ' || c.relname || ' kind=' || c.relkind::text || ' owner=' || pg_get_userbyid(c.relowner) || ' acl=' || ${acl('c.relacl')}
           || ' rls=' || c.relrowsecurity || '/' || c.relforcerowsecurity || ' opts=' || coalesce(array_to_string(c.reloptions, ';'), '')
    from pg_class c join n on c.relnamespace = n.oid
    union all
    select 'col ' || c.relname || ' #' || row_number() over (partition by c.oid order by a.attnum) || ' ' || a.attname || ' '
           || format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull || ' gen=' || a.attgenerated::text
           || ' ident=' || a.attidentity::text || ' def=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ' acl=' || ${acl('a.attacl')}
    from pg_class c join n on c.relnamespace = n.oid
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
    where c.relkind in ('r', 'p', 'v', 'm', 'c')
    union all
    select 'idx ' || pg_get_indexdef(i.indexrelid) from pg_index i join pg_class c on c.oid = i.indexrelid join n on c.relnamespace = n.oid
    union all
    select 'con ' || k.conrelid::regclass::text || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid)
    from pg_constraint k join n on k.connamespace = n.oid
    union all
    select 'trg ' || pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join n on c.relnamespace = n.oid where not t.tgisinternal
    union all
    select 'pol ' || c.relname || ' ' || pl.polname || ' cmd=' || pl.polcmd::text || ' permissive=' || pl.polpermissive
           || ' roles=' || coalesce((select string_agg(r::regrole::text, ',' order by r::regrole::text) from unnest(pl.polroles) r), '')
           || ' using=' || coalesce(pg_get_expr(pl.polqual, pl.polrelid), '') || ' check=' || coalesce(pg_get_expr(pl.polwithcheck, pl.polrelid), '')
    from pg_policy pl join pg_class c on c.oid = pl.polrelid join n on c.relnamespace = n.oid
    union all
    select 'type ' || t.typname || ' ' || t.typtype::text from pg_type t join n on t.typnamespace = n.oid where t.typrelid = 0 and t.typelem = 0
    union all
    select 'schema ' || coalesce(obj_description(ns.oid, 'pg_namespace'), '') || ' owner=' || pg_get_userbyid(ns.nspowner) || ' acl=' || ${acl('ns.nspacl')}
    from pg_namespace ns join n on ns.oid = n.oid`, [S]);
  return rows.map((r) => (r.x as string).split(S).join('@S@')).sort();
}

/** Строки-замки 1.2: строки семейства и шлюза у каждого класса, строка maintain; вид LOCK у чужих аккаунтов снят. */
async function checkLocks(S: string, o: OldData): Promise<void> {
  const Q = ident(S);
  const [r] = await sql.unsafe(`select
      (select count(*)::int from ${Q}.secret s where s.kind = 'LOCK' and s.account <> $1::uuid and s.deleted_at is null) as foreign_live,
      (select s.deleted_at is not null from ${Q}.secret s where s.id = $2::uuid) as cred_gone,
      (select coalesce(array_agg(c.data->>'name' order by c.data->>'name'), '{}') from ${Q}.entity c
       where c.class = 'Class'
         and (select count(*) from ${Q}.secret s where s.kind = 'LOCK' and s.account = $1::uuid and s.deleted_at is null
                and s.id in (${Q}.lock_id(${Q}.family_name(c.tenant, c.data)),
                             ${Q}.lock_id(${Q}.family_name(c.tenant, c.data) || ':gate'))) <> 2) as missing,
      exists (select 1 from ${Q}.secret s where s.kind = 'LOCK' and s.deleted_at is null and s.id = ${Q}.lock_id($3)) as maintain`,
  [SYSTEM_ID, o.lockCred, `${S}:maintain`]);
  assert.equal(r.foreign_live, 0, 'живых строк вида LOCK у чужих аккаунтов нет');
  assert.equal(r.cred_gone, true, 'креденшал пользователя вида LOCK помечен удалённым');
  assert.deepEqual(r.missing, [], 'у каждого класса — строка семейства и строка шлюза');
  assert.equal(r.maintain, true, 'строка-замок maintain');
}

async function verifyOk(S: string, msg: string): Promise<void> {
  const adm = await connect({ dsn: ADMIN_DSN, schema: S, allowBypassRls: true, listen: false, cache: false, max: 1 });
  try {
    const v = await adm.verify({ data: true });
    assert.equal(v.ok, true, `${msg}: ${JSON.stringify(v.issues)}`);
  } finally {
    await adm.close();
  }
}

/** Следующее событие подписки (не дольше ms). */
async function nextEvent(sub: { next(): Promise<IteratorResult<WatchEvent>> }, ms = 10_000): Promise<WatchEvent> {
  let timer: NodeJS.Timeout | undefined;
  const r = await Promise.race([sub.next(), new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), ms); })]);
  clearTimeout(timer);
  if (r === 'timeout' || r.done) throw new Error(`подписка: события нет за ${ms} мс`);
  return r.value;
}

/** Число книг арендатора по изменениям журнала: прошлая версия вычитается, новая прибавляется. */
async function countBooks(changes: ProjectorChange[], out: ProjectorOut): Promise<void> {
  for (const c of changes) {
    if (c.op === 'purge' || c.op === 'trim' || c.op === 'reset') continue;
    const d = (c.row.$deleted ? 0 : 1) - (c.before ? 1 : 0);
    if (d) out.inc('BookCount', { k: 'all' }, { n: d }, { tenant: c.tenant });
  }
}

/** Работа текущей версии по данным прежнего движка: чтение, подписка, запись, purge, обрезка, maintain, проектор. */
async function workAfter(S: string, o: OldData): Promise<void> {
  const Q = ident(S);
  const db = await connect({ dsn: appDsn(), schema: S, token: o.token, listen: false, cache: false, max: 2 });
  const adm = await connect({ dsn: ADMIN_DSN, schema: S, allowBypassRls: true, listen: false, cache: false, max: 2 });
  try {
    const live = o.books.filter((id) => !o.gone.includes(id));
    assert.deepEqual((await db.Book().rows()).map((r) => r.id).sort(), [...live].sort(), 'книги прежнего движка читаются цепочкой');

    const sub = db.watch({ from: 'now', classes: ['Book'], pollMs: 20 });
    try {
      await sub.ready();
      const [fresh] = await db.Shelf(o.shelves[0]).Book().create({ title: 'новая', n: 0 }).rows();
      const ev = await nextEvent(sub);
      assert.equal(ev.id, fresh.id, 'подписка получает запись после ready()');
    } finally {
      await sub.close();
    }

    // правка и удаление строк прежнего движка продолжают их цепочки версий; purge его надгробия; обрезка; maintain
    await db.Book(live[0]).update({ n: 10 }).rows();
    await db.Book(live[1]).delete({ confirm: true }).rows();
    await db.Book(o.gone[1]).purge({ confirm: true }).rows();
    assert.ok((await db.trimHistory('Book', new Date())) >= 1, 'обрезка истории книг');
    await adm.maintain();

    // проектор по журналу прежнего движка: первый запуск строит проекцию, затем хвост и перестройка
    await sql.begin(async (tx) => {
      await tx`select set_config('letopis.token', ${o.token}, true)`;
      await tx.unsafe(`insert into ${Q}.entity (class, data) values ('Class', $1::jsonb)`, [BOOK_COUNT as never]);
    });
    const count = async () =>
      Number((await sql.unsafe(`select data->>'n' as n from ${Q}.entity where class = 'BookCount' and tenant = $1`, [o.tenant]))[0]?.n ?? 0);
    const p = adm.projector('bookcount', { from: ['Book'], into: ['BookCount'], version: 1, withBefore: true, handle: countBooks });
    try {
      await p.run({ once: true });
      const n = (await db.Book().rows()).length;
      assert.equal(await count(), n, 'первый запуск проектора считает книги прежнего движка');
      await db.Shelf(o.shelves[1]).Book().create({ title: 'ещё одна', n: 0 }).rows();
      await p.run({ once: true });
      assert.equal(await count(), n + 1, 'хвост журнала');
      await p.rebuild();
      assert.equal(await count(), n + 1, 'перестройка');
    } finally {
      await p.close();
    }
  } finally {
    await adm.close();
    await db.close();
  }
}

async function scenario(o: { old: OldLib; S: string; ref: string; signals?: SignalMode; upgrade: boolean }): Promise<void> {
  const opts = { dsn: ADMIN_DSN, quiet: true, ...(o.signals ? { signals: o.signals } : {}) };
  await o.old.up({ ...opts, schema: o.S, fresh: true, seeds: ['booking'] });
  const data = await writeOld(o.S);
  // connect() текущей версии на схеме прежней: при той же ревизии предупреждает штамп движка, при отставшей — ревизия
  assert.match((await connectWarns(o.S)).join('\n'), o.upgrade ? /ревизии 5, библиотека ждёт/ : /поставила версия до 1\.4\.0/);
  const before = await versions(o.S, data.tenant);
  assert.ok(before.log.length > 20 && before.ent.length > 5, 'прежний движок записал данные');
  // эталон — чистая установка текущей версии с теми же сидами и режимом сигналов; сверка обязана различать схему до наката
  await up({ ...opts, schema: o.ref, fresh: true, seeds: ['booking'] });
  const ref = await catalog(o.ref);
  assert.ok(ref.length > 300, 'каталог эталона прочитан');
  assert.notDeepEqual(await catalog(o.S), ref, 'сверка каталога различает схему прежней версии');

  let r: UpResult;
  if (o.upgrade) {
    await assert.rejects(up({ dsn: ADMIN_DSN, schema: o.S, quiet: true }), /upgrade: true/);
    r = await up({ dsn: ADMIN_DSN, schema: o.S, quiet: true, upgrade: true });
    assert.equal(r.upgraded, true);
    assert.deepEqual(r.migrations, ['0006-changed-paths.sql']);
  } else {
    r = await up({ dsn: ADMIN_DSN, schema: o.S, quiet: true });
    assert.equal(r.upgraded, false);
    assert.deepEqual(r.migrations, []);
  }
  assert.equal(r.serviceKey, null, 'ключ сервиса прежней установки сохранён, новый не выдан');
  assert.equal(r.signals, o.signals ?? 'class', 'режим сигналов сохранён');
  assert.deepEqual(await connectWarns(o.S), [], 'после наката connect() не предупреждает');

  const after1 = await versions(o.S, data.tenant);
  const kept = new Set(after1.log);
  assert.deepEqual(before.log.filter((v) => !kept.has(v)), [], 'версии журнала прежнего движка на месте, хэши те же');
  const was = new Set(before.log);
  assert.deepEqual(after1.log.filter((v) => !was.has(v) && after1.tenants.get(v) !== SYSTEM_ID), [],
    'новые версии журнала после наката — только у System');
  assert.deepEqual(after1.ent, before.ent, 'строки арендатора накат не меняет');
  await verifyOk(o.S, 'после обновления');

  const cat = await catalog(o.S);
  const inCat = new Set(cat);
  const inRef = new Set(ref);
  assert.deepEqual({ extra: cat.filter((x) => !inRef.has(x)), missing: ref.filter((x) => !inCat.has(x)) }, { extra: [], missing: [] },
    'каталог обновлённой схемы совпадает с чистой установкой текущей версии');

  await checkLocks(o.S, data);
  await workAfter(o.S, data);
  await verifyOk(o.S, 'после работы текущей версии');

  const cat1 = await catalog(o.S);
  const v1 = await versions(o.S, data.tenant);
  const r2 = await up({ dsn: ADMIN_DSN, schema: o.S, quiet: true });
  assert.equal(r2.upgraded, false);
  assert.deepEqual(await catalog(o.S), cat1, 'повторный up(): каталог прежний');
  const v2 = await versions(o.S, data.tenant);
  assert.deepEqual({ log: v2.log, ent: v2.ent }, { log: v1.log, ent: v1.ent }, 'повторный up(): данные прежние');
}

test('№1 обновление 1.1.0 → текущая: повторный накат без upgrade', async () => {
  const old = (await import('letopis-11')) as unknown as OldLib;
  await scenario({ old, S: `${BASE}_110`, ref: `${BASE}_ref110`, signals: 'tenant', upgrade: false });
});

test('№2 обновление 1.0.1 → текущая: up({ upgrade: true }) с миграцией 0006', async () => {
  const old = (await import('letopis-1')) as unknown as OldLib;
  await scenario({ old, S: `${BASE}_101`, ref: `${BASE}_ref101`, upgrade: true });
});
