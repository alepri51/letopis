/**
 * Воспроизведение ARTICLE.md: все примеры/ответы/тайминги статьи сняты этим скриптом: восстанавливает датасет 1.11M строк
 * (генератор как в bench/dimensions.bench.mjs), поверх — демо-сущности статьи.
 * Каждый вызов API: реальный ответ + реальное время (ms) + дельта строк БД.
 */
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';
import {
  connect, cursorOf, gte, between, ilike, like, starts, ends,
  has, hasAny, hasAll, exists, isNull, not, or, ne, gt, lt, lte, inList,
} from '../src/index.js';

const DSN = 'postgres://postgres:test@localhost:15432/clockz';
const S = 'article';
const SYS = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const J = (x) => console.log(JSON.stringify(x, null, 2));
const H = (t) => console.log(`\n\n########## ${t} ##########`);

// ---- таймер: ответ + мс ----
async function T(label, p) {
  const t0 = performance.now();
  const res = await p;
  const ms = (performance.now() - t0).toFixed(1);
  console.log(`\n>>> ${label}   [${ms} ms]`);
  return res;
}

// ---------------- восстановление большой БД (генератор dimensions.bench) ----------------
const bu = (code, n) => `0000000${code}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DAY = 24 * 3600e3;
const BASE = Date.now() - 370 * DAY;
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ORGS = 20, FOLDERS = 100, STAFF = 300, SERVICES = 400, CUSTOMERS = 30000,
  SCHEDULES = 240, SLOTS = 80000, BOOKINGS = 250000, SKILLS = 1000;

function makeRows() {
  const rnd = mulberry32(42);
  const t = () => new Date(BASE + rnd() * 360 * DAY);
  const iso = (d) => d.toISOString();
  const rows = [];
  const push = (id, cls, data, links, when) => rows.push([id, cls, data, links, iso(when)]);
  for (let i = 0; i < ORGS; i++) push(bu(1, i), 'Org', { name: `Орг ${i}` }, {}, t());
  for (let i = 0; i < FOLDERS; i++) {
    const links = { Org: bu(1, i % ORGS) };
    if (i % 2 === 1) links.Folder = bu(2, i - 1);
    push(bu(2, i), 'Folder', { name: `Папка ${i}` }, links, t());
  }
  for (let i = 0; i < STAFF; i++)
    push(bu(3, i), 'Staff', { name: `Мастер ${i}`, roles: ['master'] }, { Org: bu(1, i % ORGS) }, t());
  for (let i = 0; i < SERVICES; i++) {
    const base = t();
    for (let v = 0; v < 3; v++)
      push(bu(4, i), 'Service', { name: `Услуга ${i}`, duration: 30 + (i % 4) * 15, price: { RUB: 1000 + i + v * 100 }, active: true },
        { Org: bu(1, i % ORGS), Folder: bu(2, i % FOLDERS) }, new Date(+base + v * DAY));
  }
  for (let i = 0; i < CUSTOMERS; i++)
    push(bu(5, i), 'Customer', { name: `Клиент ${i}`, contact: `+7-900-${String(i).padStart(7, '0')}` }, { Org: bu(1, i % ORGS) }, t());
  for (let i = 0; i < SCHEDULES; i++)
    push(bu(6, i), 'Schedule', { start: iso(new Date(BASE)), end: iso(new Date(BASE + 360 * DAY)) }, { Org: bu(1, i % ORGS) }, t());
  for (let i = 0; i < SLOTS; i++) {
    const s = t();
    push(bu(7, i), 'Slot', { start: iso(s), end: iso(new Date(+s + 3600e3)) }, { Schedule: bu(6, i % SCHEDULES) }, s);
  }
  const statuses = ['confirmed', 'confirmed', 'confirmed', 'completed', 'cancelled'];
  for (let i = 0; i < BOOKINGS; i++) {
    const t1 = t();
    const t2 = new Date(+t1 + (1 + rnd() * 5) * DAY);
    const links = { Customer: bu(5, i % CUSTOMERS) };
    push(bu(8, i), 'Booking', { status: 'created', total: { RUB: 1000 + (i % 50) * 100 } }, links, t1);
    push(bu(8, i), 'Booking', { status: statuses[i % 5], total: { RUB: 1000 + (i % 50) * 100 } }, links, t2);
    push(bu(9, i), 'busy', { kind: 'booking' }, { Staff: bu(3, i % STAFF), Slot: bu(7, i % SLOTS), Booking: bu(8, i) }, t2);
    push(bu(10, i), 'item', { qty: 1, price: { RUB: 1000 + (i % 50) * 100 } }, { Booking: bu(8, i), Service: bu(4, i % SERVICES) }, t2);
  }
  for (let i = 0; i < SKILLS; i++)
    push(bu(11, i), 'skill', {}, { Staff: bu(3, i % STAFF), Service: bu(4, i % SERVICES) }, t());
  return rows;
}

async function bulk(sql, rows) {
  const CHUNK = 5000;
  await sql.unsafe('BEGIN');
  try {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      for (const [id, cls, data, links, updated] of part) {
        const o = params.length;
        values.push(`('entity',$${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5}::timestamptz,'${SYS}','${SYS}')`);
        params.push(id, cls, data, links, updated);
      }
      await sql.unsafe(
        `INSERT INTO "${S}"."Entity" (partition, id, class, data, links, updated, account, owner) VALUES ${values.join(',')}`,
        params);
      if ((i / CHUNK) % 40 === 0) process.stdout.write(`  seeded ${i + part.length}/${rows.length}\r`);
    }
    await sql.unsafe('COMMIT');
  } catch (e) { await sql.unsafe('ROLLBACK'); throw e; }
}

console.log('restore big DB…');
const admin = postgres(DSN, { max: 1, onnotice: () => {} });
await admin.unsafe(`DROP SCHEMA IF EXISTS "${S}" CASCADE`);
await admin.end();
execFileSync('node', ['C:/projects/AI_AGENTS/clockz.pro/db/apply.mjs', `--dsn=${DSN}`, `--schema=${S}`], { stdio: 'ignore' });
const seeder = postgres(DSN, { max: 1, onnotice: () => {} });
const t0 = performance.now();
const rows = makeRows();
await bulk(seeder, rows);
await seeder.unsafe(`ANALYZE "${S}"."Entity"`);
console.log(`big DB: ${rows.length} rows in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
await seeder.end();

const db = await connect({ dsn: DSN, schema: S });

H('МИР: что лежит в БД');
const классы = await db.sql.unsafe(
  `SELECT class, count(*)::int AS rows, count(DISTINCT id)::int AS entities FROM "${S}"."Entity" GROUP BY class ORDER BY 2 DESC`);
console.log(JSON.stringify(классы));
const [{ n: всего }] = await db.sql.unsafe(`SELECT count(*)::int AS n FROM "${S}"."Entity"`);
console.log('всего строк:', всего);

let mark = (await db.sql.unsafe(`SELECT now()::text AS t`))[0].t;
async function dumpNew(label) {
  const rs = await db.sql.unsafe(
    `SELECT id, class, data, links, tags, updated, deleted FROM "${S}"."Entity" WHERE updated > $1 ORDER BY updated`, [mark]);
  console.log(`--- БД (${label}): новые строки ---`);
  for (const r of rs) console.log(JSON.stringify(r));
  if (rs.length) mark = rs[rs.length - 1].updated;
}

H('S1 INSERT организация');
const [org] = await T(`db.Организация().set({id:…0001, name:'BarberPro', phone})`,
  db.Организация().set({ id: u(1), name: 'BarberPro', phone: '+7 900 000-00-00' }));
J(org);
await dumpNew('S1');

H('S2 INSERT с контекстом');
const [вася] = await T(`db.Организация(org).Сотрудник().set({id:…0011, name:'Вася', roles:['owner','master']})`,
  db.Организация(org).Сотрудник().set({ id: u(11), name: 'Вася', roles: ['owner', 'master'] }));
J(вася);
const [олег] = await db.Организация(org).Сотрудник().set({ id: u(12), name: 'Олег' });
await dumpNew('S2');

H('S3 каталог/клиент/календарь');
const [стрижка] = await T(`Услуга Стрижка`, db.Организация(org).Услуга().set({ id: u(21), name: 'Стрижка', duration: 60, price: { RUB: 1500 }, description: 'классика' }));
const [бритьё] = await db.Организация(org).Услуга().set({ id: u(22), name: 'Королевское бритьё', duration: 30, price: { RUB: 800 } });
const [анна] = await db.Организация(org).Клиент().set({ id: u(31), name: 'Анна', contact: '+7 911 111-11-11' });
const [расп] = await db.Организация(org).Расписание().set({ id: u(41), start: '2026-07-15T09:00:00Z', end: '2026-07-15T21:00:00Z' });
const [окно1] = await db.Расписание(расп).Окно().set({ id: u(51), start: '2026-07-15T10:00:00Z', end: '2026-07-15T11:00:00Z' });
const [окно2] = await db.Расписание(расп).Окно().set({ id: u(52), start: '2026-07-15T11:00:00Z', end: '2026-07-15T12:00:00Z' });
const [root] = await db.Организация(org).Папка().set({ id: u(71), name: 'Каталог' });
const [муж] = await db.Организация(org).Папка(root).Папка().set({ id: u(72), name: 'Мужской зал' });
await db.Организация(org).Папка(муж).Папка().set({ id: u(73), name: 'Борода и усы' });
await dumpNew('S3');
void бритьё;

H('S4 UPSERT по id: вторая версия, deep-merge');
const [v2] = await T(`db.Услуга('…0021').set({price:{RUB:1800, USD:20}})`,
  db.Услуга(u(21)).set({ price: { RUB: 1800, USD: 20 } }));
J({ data: v2.data, updated: v2.updated });
await dumpNew('S4');
const истор = await T(`db.Услуга('…0021').versions()`, db.Услуга(u(21)).versions());
J(истор.map((r) => ({ updated: r.updated, price: r.data.price, $deleted: r.$deleted })));

H('S5 связи: z-форма, запись, занятость, позиция');
const z = db.навык().set({});
z.Сотрудник(вася); z.Услуга(стрижка);
const [навык] = await T(`z-форма навык (1 INSERT)`, z);
J({ id: навык.id, class: навык.class, links: навык.links });
await db.Расписание(расп).Сотрудник(вася).смена().set({});
const [запись] = await T(`db.Клиент(анна).Запись().set({id:…0061, status:'created', total:{RUB:1800}})`,
  db.Клиент(анна).Запись().set({ id: u(61), status: 'created', total: { RUB: 1800 } }));
const [бронь] = await T(`db.Сотрудник(вася).Окно(окно1).Запись(запись).занятость('busy-0011-0051').set({kind:'booking'})`,
  db.Сотрудник(вася).Окно(окно1).Запись(запись).занятость('busy-0011-0051').set({ kind: 'booking' }));
J(бронь);
const [позиция] = await db.Запись(запись).позиция().set({ qty: 1, price: { RUB: 1800 } }).Услуга(стрижка).Сотрудник(вася);
J({ id: позиция.id, class: позиция.class, data: позиция.data, links: позиция.links });
await dumpNew('S5');

H('S6 UPDATE по фильтру В КОНТЕКСТЕ клиента');
const подтв = await T(`db.Клиент(анна).Запись({status:'created'}).set({status:'confirmed'})`,
  db.Клиент(анна).Запись({ status: 'created' }).set({ status: 'confirmed' }));
J(подтв.map((r) => ({ id: r.id, status: r.data.status, updated: r.updated })));

H('S7 execute() пути');
const пути = await T(`db.Сотрудник({name:'Вася'}).навык().Услуга().execute()`,
  db.Сотрудник({ name: 'Вася' }).навык().Услуга().execute());
J(пути);

H('S8 rows/first/ids/count на большом классе');
const услуги = await T(`db.Услуга().rows() — весь класс`, db.Услуга().rows());
console.log('rows().length =', услуги.length, '; первые 2:', JSON.stringify(услуги.slice(0, 2).map((r) => ({ id: r.id, name: r.data.name }))));
const первый = await T(`db.Сотрудник({name:'Олег'}).first()`, db.Сотрудник({ name: 'Олег' }).first());
J({ id: первый.id, name: первый.data.name });
const ids = await T(`db.Сотрудник().ids()`, db.Сотрудник().ids());
console.log('ids().length =', ids.length);
const cnt = await T(`db.Организация(org).Сотрудник().count()`, db.Организация(org).Сотрудник().count());
console.log('count =', cnt);

H('S9 операторы: вызов → ответ (402 услуги / 302 мастера)');
const c = async (label, p) => { const r = await T(label, p); console.log('   =', JSON.stringify(r)); };
await c(`Услуга({duration: gte(60)}).count()`, db.Услуга({ duration: gte(60) }).count());
await c(`Услуга({duration: gt(60)}).count()`, db.Услуга({ duration: gt(60) }).count());
await c(`Услуга({duration: lt(45)}).count()`, db.Услуга({ duration: lt(45) }).count());
await c(`Услуга({duration: lte(45)}).count()`, db.Услуга({ duration: lte(45) }).count());
await c(`Услуга({name: ne('Стрижка')}).count()`, db.Услуга({ name: ne('Стрижка') }).count());
await c(`Услуга({duration: between(40,65)}).count()`, db.Услуга({ duration: between(40, 65) }).count());
await c(`Услуга({name: inList(['Стрижка','Услуга 7'])}).count()`, db.Услуга({ name: inList(['Стрижка', 'Услуга 7']) }).count());
await c(`Услуга({name: like('Стри%')}).count()`, db.Услуга({ name: like('Стри%') }).count());
await c(`Услуга({name: ilike('%королевское%')}).count()`, db.Услуга({ name: ilike('%королевское%') }).count());
await c(`Услуга({name: starts('Услуга 39')}).count()`, db.Услуга({ name: starts('Услуга 39') }).count());
await c(`Услуга({name: ends('бритьё')}).count()`, db.Услуга({ name: ends('бритьё') }).count());
await c(`Сотрудник({roles: has('owner')}).count()`, db.Сотрудник({ roles: has('owner') }).count());
await c(`Сотрудник({roles: hasAny(['owner','admin'])}).count()`, db.Сотрудник({ roles: hasAny(['owner', 'admin']) }).count());
await c(`Сотрудник({roles: hasAll(['owner','master'])}).count()`, db.Сотрудник({ roles: hasAll(['owner', 'master']) }).count());
await c(`Услуга({description: exists()}).count()`, db.Услуга({ description: exists() }).count());
await c(`Услуга({description: exists(false)}).count()`, db.Услуга({ description: exists(false) }).count());
await c(`Услуга({description: isNull()}).count()`, db.Услуга({ description: isNull() }).count());
await c(`Услуга({name: not(starts('Услуга'))}).count()`, db.Услуга({ name: not(starts('Услуга')) }).count());
await c(`Услуга({price: {RUB: gte(1300)}}).count()`, db.Услуга({ price: { RUB: gte(1300) } }).count());
await c(`Услуга(or({name:'Стрижка'},{duration:lt(45)})).count()`, db.Услуга(or({ name: 'Стрижка' }, { duration: lt(45) })).count());

H('S10 модификаторы sort/limit/offset');
const топ = await T(`db.Услуга().sort('data.price.RUB','desc').limit(3).rows()`,
  db.Услуга().sort('data.price.RUB', 'desc').limit(3).rows());
J(топ.map((r) => ({ name: r.data.name, RUB: r.data.price.RUB })));
const свежие = await T(`db.Запись().sort('updated','desc').limit(2).rows() — 250k записей`,
  db.Запись().sort('updated', 'desc').limit(2).rows());
J(свежие.map((r) => ({ id: r.id, status: r.data.status, updated: r.updated })));

H('S11 alias');
const пути2 = await T(`…alias('салон')…alias('мастер').execute()`,
  db.Организация(org).alias('салон').Сотрудник({ name: 'Вася' }).alias('мастер').execute());
console.log('ключи пути:', Object.keys(пути2[0]));

H('S12 tags');
const [vip] = await T(`db.Организация(org).Клиент().tags(['vip','telegram']).set({id:…0032, name:'Пётр'})`,
  db.Организация(org).Клиент().tags(['vip', 'telegram']).set({ id: u(32), name: 'Пётр' }));
J({ id: vip.id, tags: vip.tags });
await c(`Клиент().tags('vip').count() — среди 30 002 клиентов`, db.Клиент().tags('vip').count());
await dumpNew('S12');

H('S13 deep');
const дерево = await T(`db.Папка('…0071').Папка().deep().rows()`, db.Папка(u(71)).Папка().deep().rows());
J(дерево.map((r) => ({ name: r.data.name, $depth: r.$depth })));

H('S14 asOf');
const тогда = await T(`db.Услуга('…0021').asOf(t1).first()`, db.Услуга(u(21)).asOf(истор[0].updated).first());
J({ price: тогда.data.price });
const сейчас = await db.Услуга(u(21)).first();
J({ price: сейчас.data.price });

H('S15 keyset на 250k записей');
const стр1 = await T(`страница 1: Запись().sort('updated','desc').limit(3).rows()`,
  db.Запись().sort('updated', 'desc').limit(3).rows());
const курсор = cursorOf(стр1.at(-1));
J(курсор);
const стр2 = await T(`страница 2: .after(cursor).limit(3)`,
  db.Запись().sort('updated', 'desc').after(курсор).limit(3).rows());
console.log('пересечение страниц:', стр1.filter((a) => стр2.some((b) => b.id === a.id)).length);

H('S16 агрегации на 250k+');
await c(`Запись().countBy('data.status')`, db.Запись().countBy('data.status'));
await c(`Запись({status:'completed'}).sum('data.total.RUB')`, db.Запись({ status: 'completed' }).sum('data.total.RUB'));
await c(`Услуга().avg('data.duration')`, db.Услуга().avg('data.duration'));
await c(`Услуга().min('data.price.RUB')`, db.Услуга().min('data.price.RUB'));
await c(`Услуга().max('data.price.RUB')`, db.Услуга().max('data.price.RUB'));

H('S17 delete: каскад');
const удалено = await T(`db.Запись('…0061').delete()`, db.Запись(u(61)).delete());
J(удалено.map((r) => ({ id: r.id, class: r.class, $deleted: r.$deleted })));
await dumpNew('S17');
J((await db.Запись(u(61)).versions()).map((r) => ({ status: r.data.status, updated: r.updated, $deleted: r.$deleted })));
console.log('повторный delete →', JSON.stringify(await db.Запись(u(61)).delete()));

H('S18 воскрешение');
const [жив] = await T(`db.Клиент(анна).Запись('…0061').set({status:'created', total:{RUB:1800}})`,
  db.Клиент(анна).Запись(u(61)).set({ status: 'created', total: { RUB: 1800 } }));
J({ id: жив.id, status: жив.data.status });

H('S19 anonymize');
const [анон] = await T(`db.Клиент('…0031').anonymize(['name','contact'])`,
  db.Клиент(u(31)).anonymize(['name', 'contact']));
J({ data: анон.data, tags: анон.tags });
await dumpNew('S19');
J((await db.Клиент(u(31)).versions()).map((r) => ({ name: r.data.name, contact: r.data.contact })));

H('S20 tx: гонка двойной брони');
const busyId = 'busy-0011-0052';
const tr1 = await db.begin();
const tr2 = await db.begin();
await tr1.lock('busy', вася.id, окно2.id);
const гонка2 = (async () => {
  await tr2.lock('busy', вася.id, окно2.id);
  const занято = await tr2.занятость(busyId).first();
  if (занято) { await tr2.rollback(); return 'ОТКАЗ: окно уже занято'; }
  await tr2.Сотрудник(вася).Окно(окно2).занятость(busyId).set({ kind: 'booking' });
  await tr2.commit(); return 'бронь моя';
})();
console.log('tr1 видит занятость?', await tr1.занятость(busyId).first());
await tr1.Сотрудник(вася).Окно(окно2).занятость(busyId).set({ kind: 'booking' });
await tr1.commit();
console.log('tr1: бронь моя; tr2:', await гонка2);

H('S21 batch');
const события = [];
const db2 = await connect({ dsn: DSN, schema: S, onQuery: (e) => события.push(e) });
const b = db2.batch('окна');
b.Окно().set({ id: u(53), start: '2026-07-15T12:00:00Z', end: '2026-07-15T13:00:00Z' });
b.Окно().set({ id: u(54), start: '2026-07-15T13:00:00Z', end: '2026-07-15T14:00:00Z' });
console.log('size():', b.size());
const резБатч = await T(`batch.execute() — одна транзакция`, b.execute());
J(резБатч.map((rr) => rr.map((r) => ({ id: r.id, start: r.data.start }))));

H('S22 onQuery события');
J(события.slice(-2).map((e) => ({ ...e, ms: +e.ms.toFixed(1) })));
await db2.close();

H('S23 watch');
const пойманные = [];
const stop = await db.watch('Клиент', (e) => пойманные.push(e));
await db.Организация(org).Клиент().set({ id: u(33), name: 'Наблюдаемый' });
await db.Клиент(u(33)).delete();
await new Promise((r) => setTimeout(r, 400));
await stop();
J(пойманные);

H('S24 tables');
const acc = await T(`db.accounts.set({categories:['Client'], data:{название:'ИП Анна'}})`,
  db.accounts.set({ categories: ['Client'], data: { название: 'ИП Анна' } }));
J(acc);
const cred = await db.credentials.set({ account: acc.id, category: 'phone', identifier: '+7 911 111-11-11' });
J(cred);
await db.resources.set({ alias: 'api.booking', category: 'API', pattern: { endpoint: 'booking.*' } });
J(await db.rules.set({ account: 'api.booking', resource: 'api.booking', permission: 'allow', weight: 90 }));
void cred;

H('S25 enforceAccount');
const iso = await connect({ dsn: DSN, schema: S, account: acc.id, enforceAccount: true });
const [своя] = await iso.Организация().set({ id: u(2), name: 'Салон Анны' });
console.log('своя.account ===', своя.account);
const isoCnt = await T(`iso.Организация().count() среди 21 орги`, iso.Организация().count());
console.log('count =', isoCnt);
try { await iso.Организация().account(SYS).rows(); } catch (e) { console.log('чтение чужого →', e.message); }
await iso.close();

H('S26 db.auth: вход по кредам + сессии (Redis)');
await T(`db.auth.setPassword({account: acc, identifier: 'anna@salon.io', …})`,
  db.auth.setPassword({ account: acc, identifier: 'anna@salon.io', password: 'весна-2026' }));
J(await T(`db.auth.verifyPassword(верный)`, db.auth.verifyPassword({ identifier: 'anna@salon.io', password: 'весна-2026' })));
console.log('неверный →', await T(`db.auth.verifyPassword(неверный)`, db.auth.verifyPassword({ identifier: 'anna@salon.io', password: 'зима' })));
console.log('незнакомый →', await T(`db.auth.verifyPassword(незнакомый identifier)`, db.auth.verifyPassword({ identifier: 'кто@это.io', password: 'x' })));
const апиключ = await T(`db.auth.issueApiKey({account: acc, name: 'касса-1'})`, db.auth.issueApiKey({ account: acc, name: 'касса-1' }));
J(апиключ);
J(await T(`db.auth.verifyApiKey(key)`, db.auth.verifyApiKey(апиключ.key)));
const пара = await T(`db.auth.issueKeySecret({account: acc, name: 'интеграция-1С'})`, db.auth.issueKeySecret({ account: acc, name: 'интеграция-1С' }));
J(пара);
J(await T(`db.auth.verifyKeySecret(key, secret)`, db.auth.verifyKeySecret(пара.key, пара.secret)));
await T(`db.auth.link({category: 'TELEGRAM', identifier: '1635246915'})`,
  db.auth.link({ account: acc, category: 'TELEGRAM', identifier: '1635246915', meta: { username: 'roboteza' } }));
J(await T(`db.auth.lookup({category: 'TELEGRAM', …})`, db.auth.lookup({ category: 'TELEGRAM', identifier: '1635246915' })));
try {
  const { default: Redis } = await import('ioredis'); // devDep; без Redis сцена пропускается
  const redis = new Redis(process.env.ENTITY_REDIS ?? 'redis://localhost:16379');
  const sess = db.auth.sessions(redis);
  const token = await T(`sessions.start(acc, {ttlSec: 3600, meta: {device: 'iphone-анны'}})`, sess.start(acc, { ttlSec: 3600, meta: { device: 'iphone-анны' } }));
  console.log('token =', token);
  J(await T(`sessions.check(token)`, sess.check(token)));
  console.log('revoke →', await T(`sessions.revoke(token)`, sess.revoke(token)));
  console.log('повторный revoke →', await T(`sessions.revoke(token) ещё раз`, sess.revoke(token)));
  redis.disconnect();
} catch (e) { console.log('Redis недоступен, сессии пропущены:', e.message); }

await db.close();
console.log('\nDONE');
