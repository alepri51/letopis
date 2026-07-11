/**
 * Прогон ВСЕХ методов публичного API для README §11 (API Reference):
 * каждый вызов — реальный ответ + реальное время с живого article-полигона (1.11M строк).
 * БАЗУ НЕ ПЕРЕСОЗДАЁТ (в отличие от article-demo.mjs): мутации только на своих id
 * u(9xx), своих аккаунтах и ресурсах apiref.* (словарь ACL убирается в конце).
 */
import postgres from 'postgres';
import {
  connect, cursorOf, totpCode, ValidationError,
  ne, gt, gte, lt, lte, between, inList, like, ilike, starts, ends,
  has, hasAny, hasAll, exists, isNull, not, or,
} from '../src/index.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const REDIS = process.env.ENTITY_REDIS ?? 'redis://localhost:16379';
const S = 'v1.article';
const SYS = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bu = (code, n) => `0000000${code}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const J = (x) => console.log(JSON.stringify(x, null, 2));
const H = (t) => console.log(`\n\n########## ${t} ##########`);
const h = (t) => console.log(`\n----- ${t} -----`);

async function T(label, p) {
  const t0 = performance.now();
  const res = await p;
  console.log(`\n>>> ${label}   [${(performance.now() - t0).toFixed(1)} ms]`);
  return res;
}
async function TE(label, fn) {
  const t0 = performance.now();
  try { await fn(); console.log(`\n>>> ${label}   !!! НЕ УПАЛО (ожидалась ошибка)`); return null; }
  catch (e) {
    console.log(`\n>>> ${label}   [${(performance.now() - t0).toFixed(1)} ms]`);
    console.log(`Error: ${e.message.split('\n')[0]}`);
    return e;
  }
}
function TS(label, fn) {
  const t0 = performance.now();
  const res = fn();
  console.log(`\n>>> ${label}   [${((performance.now() - t0) * 1000).toFixed(0)} µs]`);
  return res;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (r) => ({ id: r.id, class: r.class, data: r.data, links: r.links, tags: r.tags, updated: r.updated, ...(r.$deleted ? { $deleted: r.$deleted } : {}), ...(r.$depth ? { $depth: r.$depth } : {}) });

// ---------- подготовка: чистим следы прошлого прогона ----------
const pre = postgres(DSN, { max: 1, onnotice: () => {} });
await pre.unsafe(`DELETE FROM "${S}"."Rule" WHERE resource LIKE 'apiref.%'`);
await pre.unsafe(`DELETE FROM "${S}"."Resource" WHERE alias LIKE 'apiref.%'`);
// свои сущности/аккаунты прошлого прогона — под нож БЕЗ триггеров (без tombstone), чтобы ответы были воспроизводимы
const мусор = (await pre.unsafe(`SELECT id FROM "${S}"."Account" WHERE data->>'название' = 'ИП Ромашка'`)).map((r) => r.id);
await pre.unsafe('BEGIN');
await pre.unsafe(`SET LOCAL session_replication_role = replica`);
await pre.unsafe(`DELETE FROM "${S}"."Entity" WHERE account = ANY($1) OR owner = ANY($1)
  OR id::text LIKE '00000000-0000-4000-8000-0000000009%' OR class = 'VipBooking'
  OR links @> '{"Staff": "${u(911)}"}' OR links @> '{"Service": "${u(921)}"}' OR links @> '{"Booking": "${u(961)}"}'
  OR data->>'name' = 'Пилигрим'`, [мусор]);
await pre.unsafe(`DELETE FROM "${S}"."Schema" WHERE id = 'VipBooking'`);
await pre.unsafe('COMMIT');
// Account — с ЖИВЫМИ триггерами (replica отключил бы FK CASCADE на Credential)
await pre.unsafe(`DELETE FROM "${S}"."Account" WHERE id = ANY($1)`, [мусор]);
await pre.end();
{ // сессии прошлого прогона в Redis
  const { default: Redis } = await import('ioredis');
  const r = new Redis(REDIS);
  const старые = await r.keys('sess:*');
  if (старые.length) await r.del(...старые);
  r.disconnect();
}

H('R0 connect / onQuery / close');
const t0c = performance.now();
const события = [];
const db = await connect({ dsn: DSN, schema: S, onQuery: (e) => события.push(e) });
console.log(`>>> connect({ dsn, schema: 'v1.article', onQuery })   [${(performance.now() - t0c).toFixed(1)} ms]`);
await db.Услуга(u(21)).first();
console.log('первое событие onQuery:', JSON.stringify({ ...события[0], ms: +события[0].ms.toFixed(1) }));

const t0s = performance.now();
const dbSlow = await connect({ dsn: DSN, schema: S, slowMs: 200, onQuery: (e) => { if (e.slow) console.log('SLOW:', JSON.stringify({ ...e, ms: +e.ms.toFixed(1) })); } });
console.log(`>>> connect({ …, slowMs: 200 })   [${(performance.now() - t0s).toFixed(1)} ms]`);
await dbSlow.Запись().count(); // 250k путей — заведомо дольше 200 ms
const t0e = performance.now();
await dbSlow.close();
console.log(`>>> db.close()   [${(performance.now() - t0e).toFixed(1)} ms]`);

H('R1 старт цепочки и терминалы чтения');
const пути = await T(`db.Сотрудник({ name: 'Вася' }).навык().Услуга().run()`,
  db.Сотрудник({ name: 'Вася' }).навык().Услуга().run());
J(пути.map((p) => Object.fromEntries(Object.entries(p).map(([k, r]) => [k, short(r)]))));
const услуги = await T(`db.Услуга().rows()`, db.Услуга().rows());
console.log(`length = ${услуги.length}; [0] =`, JSON.stringify(short(услуги[0])));
const олег = await T(`db.Сотрудник({ name: 'Олег' }).first()`, db.Сотрудник({ name: 'Олег' }).first());
J(short(олег));
console.log('несуществующий →', await T(`db.Сотрудник({ name: 'Гэндальф' }).first()`, db.Сотрудник({ name: 'Гэндальф' }).first()));
const ids = await T(`db.Сотрудник().ids()`, db.Сотрудник().ids());
console.log(`length = ${ids.length}; первые 3:`, JSON.stringify(ids.slice(0, 3)));
const cnt = await T(`db.Организация('${u(1).slice(-4)}').Сотрудник().count()`, db.Организация(u(1)).Сотрудник().count());
console.log('=', cnt);
// count считает ПУТИ, rows — уникальные сущности
const cntПути = await T(`db.навык().Услуга().count() — число ПУТЕЙ`, db.навык().Услуга().count());
const rowsУник = await T(`db.навык().Услуга().rows() — уникальные сущности`, db.навык().Услуга().rows());
console.log(`count() = ${cntПути}, rows().length = ${rowsУник.length}`);
// формы Filter
console.log('по id-строке →', (await T(`db.Услуга('${u(21).slice(-4)}').first()`, db.Услуга(u(21)).first())).data.name);
console.log('по списку id →', (await T(`db.Услуга([id1, id2]).rows()`, db.Услуга([u(21), u(22)]).rows())).map((r) => r.data.name));
console.log('по Row-объекту →', (await T(`db.Организация(org).first()`, db.Организация({ id: u(1) }).first())).data.name);

H('R2 операторы (18)');
const c = async (label, p) => { const r = await T(label, p); console.log('   =', JSON.stringify(r)); };
await c(`db.Услуга({ name: ne('Стрижка') }).count()`, db.Услуга({ name: ne('Стрижка') }).count());
await c(`db.Услуга({ duration: gt(60) }).count()`, db.Услуга({ duration: gt(60) }).count());
await c(`db.Услуга({ duration: gte(60) }).count()`, db.Услуга({ duration: gte(60) }).count());
await c(`db.Услуга({ duration: lt(45) }).count()`, db.Услуга({ duration: lt(45) }).count());
await c(`db.Услуга({ duration: lte(45) }).count()`, db.Услуга({ duration: lte(45) }).count());
await c(`db.Услуга({ duration: between(40, 65) }).count()`, db.Услуга({ duration: between(40, 65) }).count());
await c(`db.Услуга({ name: inList(['Стрижка', 'Услуга 7']) }).count()`, db.Услуга({ name: inList(['Стрижка', 'Услуга 7']) }).count());
await c(`db.Услуга({ name: like('Стри%') }).count()`, db.Услуга({ name: like('Стри%') }).count());
await c(`db.Услуга({ name: ilike('%королевское%') }).count()`, db.Услуга({ name: ilike('%королевское%') }).count());
await c(`db.Услуга({ name: starts('Услуга 39') }).count()`, db.Услуга({ name: starts('Услуга 39') }).count());
await c(`db.Услуга({ name: ends('бритьё') }).count()`, db.Услуга({ name: ends('бритьё') }).count());
await c(`db.Сотрудник({ roles: has('owner') }).count()`, db.Сотрудник({ roles: has('owner') }).count());
await c(`db.Сотрудник({ roles: hasAny(['owner', 'admin']) }).count()`, db.Сотрудник({ roles: hasAny(['owner', 'admin']) }).count());
await c(`db.Сотрудник({ roles: hasAll(['owner', 'master']) }).count()`, db.Сотрудник({ roles: hasAll(['owner', 'master']) }).count());
await c(`db.Услуга({ description: exists() }).count()`, db.Услуга({ description: exists() }).count());
await c(`db.Услуга({ description: exists(false) }).count()`, db.Услуга({ description: exists(false) }).count());
await c(`db.Услуга({ description: isNull() }).count()`, db.Услуга({ description: isNull() }).count());
await c(`db.Услуга({ name: not(starts('Услуга')) }).count()`, db.Услуга({ name: not(starts('Услуга')) }).count());
await c(`db.Услуга({ name: not('Стрижка') }).count()`, db.Услуга({ name: not('Стрижка') }).count());
await c(`db.Услуга(or({ name: 'Стрижка' }, { duration: lt(45) })).count()`, db.Услуга(or({ name: 'Стрижка' }, { duration: lt(45) })).count());
await c(`db.Услуга({ price: { RUB: gte(1300) } }).count() — record-путь`, db.Услуга({ price: { RUB: gte(1300) } }).count());
await c(`db.Организация({ settings: { booking: { deposit: { amount: gte(900) } } } }).count() — глубина 4`,
  db.Организация({ settings: { booking: { deposit: { amount: gte(900) } } } }).count());

H('R3 limit / offset / sort');
const топ3 = await T(`db.Услуга().sort('data.price.RUB', 'desc').limit(3).rows()`, db.Услуга().sort('data.price.RUB', 'desc').limit(3).rows());
J(топ3.map((r) => ({ name: r.data.name, RUB: r.data.price.RUB })));
const стр2off = await T(`db.Услуга().sort('data.price.RUB', 'desc').limit(3).offset(3).rows()`, db.Услуга().sort('data.price.RUB', 'desc').limit(3).offset(3).rows());
J(стр2off.map((r) => ({ name: r.data.name, RUB: r.data.price.RUB })));
const поВремени = await T(`db.Запись().sort('updated', 'desc').limit(2).rows() — 250k сущностей`, db.Запись().sort('updated', 'desc').limit(2).rows());
J(поВремени.map((r) => ({ id: r.id, status: r.data.status, updated: r.updated })));
const asc = await T(`db.Услуга().sort('data.duration').limit(2).rows() — asc по умолчанию`, db.Услуга().sort('data.duration').limit(2).rows());
J(asc.map((r) => ({ name: r.data.name, duration: r.data.duration })));

H('R4 asOf / versions');
const истор = await T(`db.Услуга('${u(21).slice(-4)}').versions()`, db.Услуга(u(21)).versions());
J(истор.map((r) => ({ updated: r.updated, price: r.data.price, $deleted: r.$deleted })));
const тогда = await T(`db.Услуга('${u(21).slice(-4)}').asOf(t1).first()`, db.Услуга(u(21)).asOf(истор[0].updated).first());
console.log('цена ТОГДА =', JSON.stringify(тогда.data.price), '; сейчас =', JSON.stringify((await db.Услуга(u(21)).first()).data.price));
const историяСТомбстоуном = await T(`db.Запись('${u(61).slice(-4)}').versions() — с tombstone в середине`, db.Запись(u(61)).versions());
J(историяСТомбстоуном.map((r) => ({ status: r.data.status, updated: r.updated, $deleted: r.$deleted })));

H('R5 keyset: cursorOf + after');
const p1 = await T(`страница 1: db.Запись().sort('updated', 'desc').limit(3).rows()`, db.Запись().sort('updated', 'desc').limit(3).rows());
J(p1.map((r) => ({ id: r.id, updated: r.updated })));
const кур = TS(`cursorOf(p1.at(-1))`, () => cursorOf(p1.at(-1)));
J(кур);
const p2 = await T(`страница 2: .after(cursor).limit(3).rows()`, db.Запись().sort('updated', 'desc').after(кур).limit(3).rows());
J(p2.map((r) => ({ id: r.id, updated: r.updated })));
console.log('пересечение страниц:', p1.filter((a) => p2.some((b) => b.id === a.id)).length);
const курДата = TS(`cursorOf(row, 'data.price.RUB')`, () => cursorOf(топ3.at(-1), 'data.price.RUB'));
J(курДата);
const p2Данные = await T(`.sort('data.price.RUB', 'desc').after(cursor).limit(3).rows()`, db.Услуга().sort('data.price.RUB', 'desc').after(курДата).limit(3).rows());
J(p2Данные.map((r) => ({ name: r.data.name, RUB: r.data.price.RUB })));
await TE(`.after() без .sort() — ошибка`, () => db.Запись().after(кур).rows());

H('R6 deep');
const дерево = await T(`db.Папка('${u(71).slice(-4)}').Папка().deep().rows()`, db.Папка(u(71)).Папка().deep().rows());
J(дерево.map((r) => ({ name: r.data.name, $depth: r.$depth })));
const дерево1 = await T(`db.Папка('${u(71).slice(-4)}').Папка().deep(1).rows() — только прямые дети`, db.Папка(u(71)).Папка().deep(1).rows());
J(дерево1.map((r) => ({ name: r.data.name, $depth: r.$depth })));

H('R7 агрегации');
await c(`db.Запись().countBy('data.status')`, db.Запись().countBy('data.status'));
await c(`db.Запись({ status: 'completed' }).sum('data.total.RUB')`, db.Запись({ status: 'completed' }).sum('data.total.RUB'));
await c(`db.Услуга().avg('data.duration')`, db.Услуга().avg('data.duration'));
await c(`db.Услуга().min('data.price.RUB')`, db.Услуга().min('data.price.RUB'));
await c(`db.Услуга().max('data.price.RUB')`, db.Услуга().max('data.price.RUB'));
await c(`db.Организация({}).sum('data.settings.booking.deposit.amount') — лист глубины 4`,
  db.Организация({}).sum('data.settings.booking.deposit.amount'));
await c(`db.Услуга({ name: 'НетТакой' }).sum('data.duration') — пусто → null`, db.Услуга({ name: 'НетТакой' }).sum('data.duration'));

H('R8 alias / tags / account / owner');
const путиАлиас = await T(`db.Организация(org).alias('салон').Сотрудник({ name: 'Вася' }).alias('мастер').run()`,
  db.Организация(u(1)).alias('салон').Сотрудник({ name: 'Вася' }).alias('мастер').run());
console.log('ключи пути:', JSON.stringify(Object.keys(путиАлиас[0])));
await c(`db.Клиент().tags('vip').count()`, db.Клиент().tags('vip').count());
await c(`db.Клиент().tags(hasAny(['vip', 'telegram'])).count()`, db.Клиент().tags(hasAny(['vip', 'telegram'])).count());
await c(`db.Организация().account('${SYS.slice(0, 8)}…').count() — фильтр колонки account`, db.Организация().account(SYS).count());
await c(`db.Организация().owner(SYS).count()`, db.Организация().owner(SYS).count());

H('R9 set: все формы записи');
h('R9.1 INSERT без id');
const [фреш] = await T(`db.Организация().set({ name: 'Пилигрим' }).rows()`, db.Организация().set({ name: 'Пилигрим' }).rows());
J(short(фреш));
await db.Организация(фреш.id).delete({ confirm: true }).rows(); // мусор не копим
h('R9.2 INSERT с явным id (идемпотентный сид)');
const [орг9] = await T(`db.Организация().set({ id: '…0901', name: 'Демо-салон §11' }).rows()`,
  db.Организация().set({ id: u(901), name: 'Демо-салон §11' }).rows());
J({ id: орг9.id, data: орг9.data });
h('R9.3 INSERT с контекст-связями');
const [мастер9] = await T(`db.Организация('…0901').Сотрудник().set({ id: '…0911', name: 'Мия', roles: ['master'] }).rows()`,
  db.Организация(u(901)).Сотрудник().set({ id: u(911), name: 'Мия', roles: ['master'] }).rows());
J({ id: мастер9.id, data: мастер9.data, links: мастер9.links });
h('R9.4 UPSERT по id: deep-merge');
const [усл9] = await db.Организация(u(901)).Услуга().set({ id: u(921), name: 'Массаж головы', duration: 30, price: { RUB: 1200 }, description: 'релакс' }).rows();
console.log('v1:', JSON.stringify(усл9.data));
const [усл9v2] = await T(`db.Услуга('…0921').set({ price: { RUB: 1400, USD: 15 } }).rows()`,
  db.Услуга(u(921)).set({ price: { RUB: 1400, USD: 15 } }).rows());
console.log('v2 (merge листьев, duration/description целы):', JSON.stringify(усл9v2.data));
h('R9.5 UPDATE по фильтру в контексте');
const [клиент9] = await db.Организация(u(901)).Клиент().set({ id: u(931), name: 'Злата', contact: '+7 999 000-99-11' }).rows();
await db.Клиент(клиент9).Запись().set({ id: u(962), status: 'created', total: { RUB: 1400 } }).rows();
await db.Клиент(клиент9).Запись().set({ id: u(963), status: 'created', total: { RUB: 2800 } }).rows();
const подтв = await T(`db.Клиент('…0931').Запись({ status: 'created' }).set({ status: 'confirmed' }).rows()`,
  db.Клиент(клиент9).Запись({ status: 'created' }).set({ status: 'confirmed' }).rows());
J(подтв.map((r) => ({ id: r.id, status: r.data.status })));
h('R9.6 UPDATE всех в контексте: Класс({})');
const всеЗаписи = await T(`db.Клиент('…0931').Запись({}).set({ status: 'completed' }).rows()`,
  db.Клиент(клиент9).Запись({}).set({ status: 'completed' }).rows());
J(всеЗаписи.map((r) => ({ id: r.id, status: r.data.status })));
h('R9.7 .link(): значение связи без участия в фильтре целей');
const [навык9] = await T(`db.навык().link('Сотрудник', мастер9).link('Услуга', усл9v2).set({}).rows() — ОДИН INSERT`,
  db.навык().link('Сотрудник', мастер9).link('Услуга', усл9v2).set({}).rows());
J({ id: навык9.id, class: навык9.class, links: навык9.links });
h('R9.8 ошибки записи');
const ve = await TE(`db.Услуга().set({ name: 'X', чепуха: 1 }).rows() — ValidationError на терминале`, () => db.Услуга().set({ name: 'X', чепуха: 1 }).rows());
if (ve instanceof ValidationError) J({ 'instanceof ValidationError': true, issues: ve.issues });
await TE(`модификатор сразу после операции`, async () => db.Услуга(u(921)).set({ duration: 30 }).link('Сотрудник', мастер9));
await TE(`контекст-шаг без фильтра`, () => db.Организация().Сотрудник().set({ name: 'Y' }).rows());
await TE(`db.НетТакогоКласса().rows()`, () => db.НетТакогоКласса().rows());

H('R10 delete: каскад');
// своя мини-пирамида: Запись → busy + item
const [окно9] = await db.Расписание().set({ id: u(941), start: '2026-08-01T09:00:00Z', end: '2026-08-01T21:00:00Z' })
  .Окно().set({ id: u(951), start: '2026-08-01T10:00:00Z', end: '2026-08-01T11:00:00Z' }).rows(); // два сегмента, одна транзакция
const [зп] = await db.Клиент(клиент9).Запись().set({ id: u(961), status: 'created', total: { RUB: 500 } }).rows();
await db.Сотрудник(мастер9).Окно(окно9).Запись(зп).занятость(`busy-${u(961).slice(-4)}`).set({ kind: 'booking' }).rows();
await db.Запись(зп).позиция().link('Услуга', усл9v2).set({ qty: 1, price: { RUB: 500 } }).rows();
const превью = await T(`db.Запись('…0961').delete().rows() — ПРЕВЬЮ: кандидаты, БД не тронута`, db.Запись(u(961)).delete().rows());
J(превью.map((r) => ({ id: r.id, class: r.class, живой: !r.$deleted })));
console.log('после превью запись жива:', (await db.Запись(u(961)).first()) !== null);
const удалено = await T(`db.Запись('…0961').delete({ confirm: true }).rows() — сервер найдёт зависимых`, db.Запись(u(961)).delete({ confirm: true }).rows());
J(удалено.map((r) => ({ id: r.id, class: r.class, $deleted: r.$deleted })));
console.log('повторный delete →', JSON.stringify(await T(`db.Запись('…0961').delete({ confirm: true }).rows() повторно`, db.Запись(u(961)).delete({ confirm: true }).rows())));
h('R10.2 воскрешение: set по тому же id');
const [жив] = await T(`db.Клиент('…0931').Запись('…0961').set({ status: 'created', total: { RUB: 500 } }).rows()`,
  db.Клиент(клиент9).Запись(u(961)).set({ status: 'created', total: { RUB: 500 } }).rows());
J({ id: жив.id, status: жив.data.status });

H('R11 anonymize');
const анон = await T(`db.Клиент('…0931').anonymize(['name', 'contact']).rows()`, db.Клиент(u(931)).anonymize(['name', 'contact']).rows());
J(анон.map((r) => ({ data: r.data, tags: r.tags })));
console.log('история цела:', JSON.stringify((await db.Клиент(u(931)).versions()).map((r) => r.data.name)));

H('R12 транзакции');
h('R12.1 begin → set → commit');
const tr = await T(`db.begin()`, db.begin());
await T(`tr.Услуга('…0922').set({ name: 'Укладка', duration: 15, price: { RUB: 700 } }).rows()`,
  tr.Организация(u(901)).Услуга().set({ id: u(922), name: 'Укладка', duration: 15, price: { RUB: 700 } }).rows());
await T(`tr.commit()`, tr.commit());
console.log('после commit виднa:', (await db.Услуга(u(922)).first()).data.name);
h('R12.2 rollback');
const tr2 = await db.begin();
await tr2.Услуга(u(922)).set({ price: { RUB: 9900 } }).rows();
console.log('внутри tx цена =', (await tr2.Услуга(u(922)).first()).data.price.RUB);
await T(`tr.rollback()`, tr2.rollback());
console.log('после rollback цена =', (await db.Услуга(u(922)).first()).data.price.RUB);
h('R12.3 db.commit(tr) — эквивалентная форма');
const tr3 = await db.begin();
await tr3.Услуга(u(922)).set({ description: 'быстрая' }).rows();
await T(`db.commit(tr3)`, db.commit(tr3));
console.log('description =', (await db.Услуга(u(922)).first()).data.description);
h('R12.4 lock: гонка двойной брони');
const busy9 = `busy-${u(911).slice(-4)}-${u(951).slice(-4)}`;
const trA = await db.begin();
const trB = await db.begin();
await T(`trA.lock('busy', staffId, slotId)`, trA.lock('busy', u(911), u(951)));
const гонкаB = (async () => {
  await trB.lock('busy', u(911), u(951)); // ВИСИТ до конца trA
  const занято = await trB.занятость(busy9).first();
  if (занято) { await trB.rollback(); return 'ОТКАЗ: окно уже занято'; }
  await trB.Сотрудник(u(911)).Окно(окно9).занятость(busy9).set({ kind: 'booking' }).rows();
  await trB.commit(); return 'бронь моя';
})();
console.log('trA перечитка под локом:', await trA.занятость(busy9).first());
await trA.Сотрудник(u(911)).Окно(окно9).занятость(busy9).set({ kind: 'booking' }).rows();
await trA.commit();
console.log('trA: бронь моя; trB:', await гонкаB);
h('R12.5 deadlock: жертва получает подсказку');
const dl1 = await db.begin();
const dl2 = await db.begin();
await dl1.lock('ресурс-A');
await dl2.lock('ресурс-B');
const [r1, r2] = await Promise.allSettled([dl1.lock('ресурс-B'), dl2.lock('ресурс-A')]);
const жертва = [r1, r2].find((r) => r.status === 'rejected');
console.log('одна из транзакций упала:\nError:', жертва.reason.message.split('\n')[0]);
await dl1.rollback().catch(() => {});
await dl2.rollback().catch(() => {});
h('R12.6 ошибки транзакций');
await TE(`db.lock('x') вне транзакции`, () => db.lock('x'));
await TE(`db.commit() без транзакции`, () => db.commit());

H('R13 batch');
const b = db.batch('слоты-августа');
TS(`db.batch('слоты-августа')`, () => b);
const i1 = b.Окно().set({ id: u(952), start: '2026-08-01T11:00:00Z', end: '2026-08-01T12:00:00Z' });
const i2 = b.Окно().set({ id: u(953), start: '2026-08-01T12:00:00Z', end: '2026-08-01T13:00:00Z' });
const i3 = b.Окно().set({ id: u(954), start: '2026-08-01T13:00:00Z', end: '2026-08-01T14:00:00Z' });
void i1; void i2; void i3;
console.log('size() =', TS(`b.size()`, () => b.size()));
const резБатч = await T(`b.run() — 3 чистых INSERT одного класса склеены в один multi-VALUES`, b.run());
J(резБатч.map((rr) => rr.map((r) => ({ id: r.id, start: r.data.start }))));
console.log('size() после run =', b.size());
const b2 = db.batch('отмена');
b2.Окно().set({ id: u(955), start: '2026-08-01T14:00:00Z', end: '2026-08-01T15:00:00Z' });
TS(`b2.discard()`, () => b2.discard());
console.log('size() после discard =', b2.size(), '; окно НЕ создано:', await db.Окно(u(955)).first());

H('R14 watch');
h('R14.1 один класс + все классы');
const пойманные = [];
const всеСоб = [];
const stop1 = await T(`db.watch('Клиент', cb)`, db.watch('Клиент', (e) => пойманные.push(e)));
const stop2 = await T(`db.watch(cb) — все классы`, db.watch((e) => всеСоб.push(e)));
await db.Организация(u(901)).Клиент().set({ id: u(932), name: 'Пётр §11' }).rows();
await db.Клиент(u(932)).set({ name: 'Пётр Второй' }).rows();
await db.Клиент(u(932)).delete({ confirm: true }).rows();
await sleep(400);
console.log(`watch('Клиент') поймал:`);
J(пойманные);
console.log(`watch(cb) поймал ${всеСоб.length} событий (все классы), классы:`, JSON.stringify([...new Set(всеСоб.map((e) => e.class))]));
await stop1(); await stop2();
h('R14.2 reconnect: обрыв LISTEN + onReconnect');
let реконнект = 0;
const событияПослеОбрыва = [];
const stop3 = await db.watch('Клиент', (e) => событияПослеОбрыва.push(e), { onReconnect: () => { реконнект++; } });
const admin2 = postgres(DSN, { max: 1, onnotice: () => {} });
await admin2.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND query ILIKE 'listen %'`);
await admin2.end();
const t0r = performance.now();
while (реконнект === 0 && performance.now() - t0r < 10000) await sleep(100);
console.log(`onReconnect сработал через ${((performance.now() - t0r) / 1000).toFixed(1)} s после обрыва (пора дочитать пропущенное)`);
await db.Клиент(u(932)).set({ name: 'Пётр после обрыва' }).rows(); // воскрешение переживёт: id тот же
await sleep(400);
console.log('событие после reconnect:', JSON.stringify(событияПослеОбрыва.at(-1)));
await stop3();

H('R15 registry / db.sql');
const def = TS(`db.registry.resolve('Запись')`, () => db.registry.resolve('Запись'));
J({ id: def.id, alias: def.alias, category: def.category, ancestors: def.ancestors, links: def.links, abstract: def.abstract });
console.log(`db.registry.has('Booking') =`, db.registry.has('Booking'), `; has('Дракон') =`, db.registry.has('Дракон'));
console.log(`db.registry.find('Дракон') =`, db.registry.find('Дракон'));
console.log(`db.registry.all.length =`, db.registry.all.length);
try { db.registry.resolve('Дракон'); } catch (e) { console.log('resolve(неизвестный) → Error:', e.message.split('\n')[0].slice(0, 120) + '…'); }
const сырое = await T(`db.sql.unsafe('SELECT count(*) FROM "v1.article"."Entity"') — голый postgres.js`,
  db.sql.unsafe(`SELECT count(*)::int AS n FROM "${S}"."Entity"`));
console.log('=', JSON.stringify(сырое[0]));

H('R16 таблицы accounts / credentials / resources / rules');
h('R16.1 accounts');
const acc = await T(`db.accounts.set({ categories: ['Client'], data: { название: 'ИП Ромашка' } })`,
  db.accounts.set({ categories: ['Client'], data: { название: 'ИП Ромашка' } }));
J(acc);
const got = await T(`db.accounts.get(acc.id)`, db.accounts.get(acc.id));
console.log('get →', got.id === acc.id ? 'тот же аккаунт' : '???');
const найдено = await T(`db.accounts.find({ category: 'Client', enabled: true })`, db.accounts.find({ category: 'Client', enabled: true }));
console.log('find →', найдено.length, 'аккаунтов');
const обновлён = await T(`db.accounts.set({ id: acc.id, avatar: 'https://…/i.png' })`, db.accounts.set({ id: acc.id, avatar: 'https://cdn.example/i.png' }));
console.log('avatar =', обновлён.avatar, '; updated растёт:', обновлён.updated > acc.updated);
const времAcc = await db.accounts.set({ categories: ['Temp'] });
console.log('delete(пустого) →', await T(`db.accounts.delete(id)`, db.accounts.delete(времAcc.id)));
await TE(`db.accounts.delete(SYS) — RESTRICT: у аккаунта история Entity`, () => db.accounts.delete(SYS));
h('R16.2 credentials');
const кред = await T(`db.credentials.set({ account, category: 'phone', identifier: '+7 921 555-77-99' })`,
  db.credentials.set({ account: acc.id, category: 'phone', identifier: '+7 921 555-77-99' }));
J(кред);
const креды = await T(`db.credentials.find({ account: acc.id })`, db.credentials.find({ account: acc.id }));
console.log('find →', креды.length, 'живых');
console.log('delete →', await T(`db.credentials.delete(кред.id)`, db.credentials.delete(кред.id)));
console.log('после delete find →', (await db.credentials.find({ account: acc.id })).length,
  '; withDeleted →', (await db.credentials.find({ account: acc.id, withDeleted: true })).length);
const воскрес = await T(`db.credentials.set(тот же identifier) — воскрешение`,
  db.credentials.set({ account: acc.id, category: 'phone', identifier: '+7 921 555-77-99' }));
console.log('deleted =', воскрес.deleted, '; тот же id =', воскрес.id === кред.id);
h('R16.3 resources / rules');
const рес = await T(`db.resources.set({ alias: 'apiref.demo:API', category: 'API', pattern: { endpoint: 'demo.*' } })`,
  db.resources.set({ alias: 'apiref.demo:API', category: 'API', pattern: { endpoint: 'demo.*' } }));
J(рес);
console.log('get →', JSON.stringify(await T(`db.resources.get('apiref.demo:API')`, db.resources.get('apiref.demo:API'))));
console.log('find(API) →', (await T(`db.resources.find({ category: 'API' })`, db.resources.find({ category: 'API' }))).length, 'ресурсов');
const прав = await T(`db.rules.set({ account: 'apiref.demo:API', resource: 'apiref.demo:API', permission: 'allow', weight: 90 })`,
  db.rules.set({ account: 'apiref.demo:API', resource: 'apiref.demo:API', permission: 'allow', weight: 90 }));
J(прав);
console.log('rules.find →', (await T(`db.rules.find({ resource: 'apiref.demo:API' })`, db.rules.find({ resource: 'apiref.demo:API' }))).length);
console.log('rules.delete →', await T(`db.rules.delete('apiref.demo:API', 'apiref.demo:API')`, db.rules.delete('apiref.demo:API', 'apiref.demo:API')));
console.log('resources.delete →', await T(`db.resources.delete('apiref.demo:API')`, db.resources.delete('apiref.demo:API')));

H('R17 db.auth');
h('R17.1 пароль');
await T(`db.auth.setPassword({ account: acc, identifier: 'romashka@salon.io', password: 'лето-2026!' })`,
  db.auth.setPassword({ account: acc, identifier: 'romashka@salon.io', password: 'лето-2026!' }));
const вход = await T(`db.auth.verifyPassword({ identifier: 'romashka@salon.io', password: 'лето-2026!' })`,
  db.auth.verifyPassword({ identifier: 'romashka@salon.io', password: 'лето-2026!' }));
J({ account: { id: вход.account.id, categories: вход.account.categories, enabled: вход.account.enabled }, credential: { category: вход.credential.category, identifier: вход.credential.identifier } });
console.log('неверный пароль →', await T(`verifyPassword(неверный)`, db.auth.verifyPassword({ identifier: 'romashka@salon.io', password: 'зима' })));
console.log('незнакомый identifier →', await T(`verifyPassword(незнакомый) — dummy-verify, время то же`, db.auth.verifyPassword({ identifier: 'ghost@nowhere.io', password: 'x' })));
const хэш = (await db.credentials.find({ account: acc.id, category: 'PASSWORD' }))[0].meta.password;
console.log('в БД вместо пароля:', String(хэш).slice(0, 44) + '…');
h('R17.2 ворота confirmed / enabled');
await db.auth.setPassword({ account: acc, identifier: 'noconfirm@salon.io', password: 'пароль-77', category: 'EMAIL', confirmed: false });
console.log('confirmed:false →', await T(`verifyPassword(неподтверждённый кред)`, db.auth.verifyPassword({ identifier: 'noconfirm@salon.io', password: 'пароль-77', category: 'EMAIL' })));
const мягко = await T(`verifyPassword(…, requireConfirmed: false)`, db.auth.verifyPassword({ identifier: 'noconfirm@salon.io', password: 'пароль-77', category: 'EMAIL', requireConfirmed: false }));
console.log('requireConfirmed:false →', мягко ? '{ account, credential }' : null);
await db.accounts.set({ id: acc.id, enabled: false });
console.log('аккаунт disabled →', await T(`verifyPassword при enabled=false`, db.auth.verifyPassword({ identifier: 'romashka@salon.io', password: 'лето-2026!' })));
await db.accounts.set({ id: acc.id, enabled: true });
h('R17.3 api-ключ');
const апи = await T(`db.auth.issueApiKey({ account: acc, name: 'касса-1' })`, db.auth.issueApiKey({ account: acc, name: 'касса-1' }));
console.log('key =', апи.key);
console.log('в БД: identifier =', апи.credential.identifier.slice(0, 16) + '… (sha256), meta =', JSON.stringify(апи.credential.meta));
const поКлючу = await T(`db.auth.verifyApiKey(key)`, db.auth.verifyApiKey(апи.key));
console.log('=', поКлючу ? `{ account: ${поКлючу.account.id.slice(0, 8)}…, credential }` : null);
await db.credentials.delete(апи.credential.id);
console.log('после credentials.delete →', await T(`verifyApiKey(отозванный)`, db.auth.verifyApiKey(апи.key)));
h('R17.4 ключ-секрет');
const пара = await T(`db.auth.issueKeySecret({ account: acc, name: 'интеграция-1С' })`, db.auth.issueKeySecret({ account: acc, name: 'интеграция-1С' }));
console.log('key =', пара.key, '; secret =', пара.secret.slice(0, 12) + '… (48 hex, показан один раз)');
console.log('verify →', (await T(`db.auth.verifyKeySecret(key, secret)`, db.auth.verifyKeySecret(пара.key, пара.secret))) ? '{ account, credential }' : null);
console.log('неверный secret →', await T(`verifyKeySecret(key, 'мимо')`, db.auth.verifyKeySecret(пара.key, 'f'.repeat(48))));
h('R17.5 TOTP');
const тотп = await T(`db.auth.enrollTotp({ account: acc, issuer: 'clockz', label: 'romashka@salon.io' })`,
  db.auth.enrollTotp({ account: acc, issuer: 'clockz', label: 'romashka@salon.io' }));
console.log('secret =', тотп.secret);
console.log('uri =', тотп.uri);
console.log('totpEnabled ДО первой проверки →', await db.auth.totpEnabled(acc));
const код = TS(`totpCode(secret) — хелпер, код «как в приложении»`, () => totpCode(тотп.secret));
console.log('код =', код);
console.log('verifyTotp →', await T(`db.auth.verifyTotp({ account: acc, code })`, db.auth.verifyTotp({ account: acc, code: код })));
console.log('replay того же кода →', await T(`verifyTotp(тот же code)`, db.auth.verifyTotp({ account: acc, code: код })));
console.log('totpEnabled ПОСЛЕ →', await T(`db.auth.totpEnabled(acc)`, db.auth.totpEnabled(acc)));
const кодПрошлогоШага = TS(`totpCode(secret, Date.now() - 30_000) — прошлый шаг, окно ±1`, () => totpCode(тотп.secret, Date.now() - 30_000));
console.log('код прошлого шага =', кодПрошлогоШага, '; уже принят как lastStep → отбит:', await db.auth.verifyTotp({ account: acc, code: кодПрошлогоШага }));
h('R17.6 одноразовый код (OTP)');
const otp = await T(`db.auth.issueOtp({ account: acc, identifier: 'romashka@salon.io', ttlSec: 600 })`,
  db.auth.issueOtp({ account: acc, identifier: 'romashka@salon.io', ttlSec: 600 }));
console.log('code =', otp.code, '; в БД:', JSON.stringify({ identifier: otp.credential.identifier, meta: { code: otp.credential.meta.code.slice(0, 12) + '…', expires: otp.credential.meta.expires, attempts: otp.credential.meta.attempts } }));
console.log('неверный код →', await T(`verifyOtp(неверный)`, db.auth.verifyOtp({ identifier: 'romashka@salon.io', code: '000000' })));
const отпОк = await T(`db.auth.verifyOtp({ identifier, code }) — верный`, db.auth.verifyOtp({ identifier: 'romashka@salon.io', code: otp.code }));
console.log('=', отпОк ? '{ account, credential }' : null);
console.log('повторно (код сожжён) →', await T(`verifyOtp(тот же code)`, db.auth.verifyOtp({ identifier: 'romashka@salon.io', code: otp.code })));
const otp2 = await db.auth.issueOtp({ account: acc, identifier: 'romashka@salon.io', ttlSec: 1 });
await sleep(1300);
console.log('истёкший TTL 1 s →', await T(`verifyOtp(протухший)`, db.auth.verifyOtp({ identifier: 'romashka@salon.io', code: otp2.code })));
h('R17.7 внешняя identity: link / lookup');
const тг = await T(`db.auth.link({ account: acc, category: 'TELEGRAM', identifier: '777000111', meta: { username: 'romashka' } })`,
  db.auth.link({ account: acc, category: 'TELEGRAM', identifier: '777000111', meta: { username: 'romashka' } }));
J({ category: тг.category, identifier: тг.identifier, meta: тг.meta, confirmed: тг.confirmed });
const найден = await T(`db.auth.lookup({ category: 'TELEGRAM', identifier: '777000111' })`,
  db.auth.lookup({ category: 'TELEGRAM', identifier: '777000111' }));
console.log('=', найден ? `{ account: ${найден.account.id.slice(0, 8)}…, credential }` : null);
await TE(`db.auth.link(identifier занят ДРУГИМ аккаунтом) — credential_identity_udx`,
  () => db.auth.link({ account: acc, category: 'TELEGRAM', identifier: '1635246915' }));

H('R18 сессии (Redis)');
const { default: Redis } = await import('ioredis');
const redis = new Redis(REDIS);
const sess = TS(`db.auth.sessions(new Redis('redis://localhost:16379'))`, () => db.auth.sessions(redis));
const token = await T(`sess.start(acc, { ttlSec: 3600, meta: { device: 'iphone' } })`, sess.start(acc, { ttlSec: 3600, meta: { device: 'iphone' } }));
console.log('token =', token);
const провер = await T(`sess.check(token)`, sess.check(token));
J(провер);
console.log('ключи в Redis:', JSON.stringify((await redis.keys('sess:*')).map((k) => k.slice(0, 24) + '…')));
console.log('revoke →', await T(`sess.revoke(token)`, sess.revoke(token)));
console.log('повторный revoke →', await T(`sess.revoke(token) ещё раз`, sess.revoke(token)));
const т1 = await sess.start(acc, { meta: { device: 'ipad' } });
const т2 = await sess.start(acc, { meta: { device: 'macbook' } });
void т1; void т2;
console.log('revokeAll →', await T(`sess.revokeAll(acc) — гасит обе`, sess.revokeAll(acc)));
const короткий = await sess.start(acc, { ttlSec: 1 });
await sleep(1300);
console.log('истёкшая (ttl 1 s) →', await T(`sess.check(протухший token)`, sess.check(короткий)));
h('R18.2 кейс: полный вход — пароль → сессия → запрос → выход');
const визит = await T(`verifyPassword`, db.auth.verifyPassword({ identifier: 'romashka@salon.io', password: 'лето-2026!' }));
const токенВхода = await T(`sess.start(визит.account, { ttlSec: 86400 })`, sess.start(визит.account, { ttlSec: 86400, meta: { ip: '10.0.0.7' } }));
const кто = await T(`sess.check из middleware`, sess.check(токенВхода));
console.log('запрос от:', кто.account.slice(0, 8) + '…, meta:', JSON.stringify(кто.meta));
console.log('logout →', await T(`sess.revoke`, sess.revoke(токенВхода)));

H('R19 ACL');
h('R19.1 словарь: группа, эндпоинты, данные (apiref.*)');
await db.resources.set({ alias: 'apiref.client:ACCOUNT', category: 'ACCOUNT', pattern: { categories: '{Client}' } });
await db.resources.set({ alias: 'apiref.api.booking:API', category: 'API', pattern: { endpoint: 'v2.booking.*' } });
await db.resources.set({ alias: 'apiref.booking.own:READ', category: 'READ', pattern: { class: 'Booking', owner: '$account' } });
await db.resources.set({ alias: 'apiref.booking.own:WRITE', category: 'WRITE', pattern: { class: 'Booking', owner: '$account' } });
await db.resources.set({ alias: 'apiref.booking.own:DELETE', category: 'DELETE', pattern: { class: 'Booking', owner: '$account' } });
await db.resources.set({ alias: 'apiref.service:READ', category: 'READ', pattern: { class: 'Service' } });
for (const рс of ['apiref.api.booking:API', 'apiref.booking.own:READ', 'apiref.booking.own:WRITE', 'apiref.booking.own:DELETE', 'apiref.service:READ'])
  await db.rules.set({ account: 'apiref.client:ACCOUNT', resource: рс, permission: 'allow', weight: 60 });
console.log('словарь: 6 ресурсов + 5 правил «Client → allow»');
h('R19.2 db.acl.check — эндпоинты');
const реш1 = await T(`db.acl.check(acc, 'v2.booking.create')`, db.acl.check(acc, 'v2.booking.create'));
J(реш1);
const реш2 = await T(`db.acl.check(acc, 'v2.admin.stats')`, db.acl.check(acc, 'v2.admin.stats'));
J(реш2);
h('R19.3 db.acl.checkData — операции над классами');
const реш3 = await T(`db.acl.checkData(acc, 'Booking', 'READ')`, db.acl.checkData(acc, 'Booking', 'READ'));
J(реш3);
const реш4 = await T(`db.acl.checkData(acc, 'Service', 'READ') — безусловный`, db.acl.checkData(acc, 'Service', 'READ'));
J(реш4);
const реш5 = await T(`db.acl.checkData(acc, 'Org', 'READ') — правил нет`, db.acl.checkData(acc, 'Org', 'READ'));
J(реш5);
h('R19.4 lineage: право на предка действует на потомков');
await db.sql.unsafe(`INSERT INTO "${S}"."Schema" (partition, id, alias, category, ancestor, attributes, meta, "order")
  SELECT partition, 'VipBooking', 'VIP-запись', category, 'Booking', attributes, meta, 950 FROM "${S}"."Schema" WHERE id = 'Booking'`);
const dbV = await connect({ dsn: DSN, schema: S }); // реестр классов читается на connect — новому классу нужен новый connect
const реш6 = await T(`db.acl.checkData(acc, 'VipBooking', 'READ') — класса нет в словаре, право дал предок Booking`,
  dbV.acl.checkData(acc, 'VipBooking', 'READ'));
J(реш6);
await dbV.close();
TS(`db.acl.reload() — сброс кэша Resource/Rule`, () => db.acl.reload());
h('R19.5 enforceAcl: предикат в SQL цепочек');
// свои записи: 3 с owner=acc среди 250k чужих
for (let i = 0; i < 3; i++)
  await db.Клиент(u(931)).Запись().owner(acc.id).set({ id: u(965 + i), status: 'created', total: { RUB: 1000 + i * 500 } }).rows();
const t0acl = performance.now();
const uc = await connect({ dsn: DSN, schema: S, account: acc.id, enforceAcl: true });
console.log(`>>> connect({ …, account: acc.id, enforceAcl: true })   [${(performance.now() - t0acl).toFixed(1)} ms] — правила фиксируются здесь`);
const мои = await T(`uc.Запись().rows() — предикат owner=$account в WHERE заранее`, uc.Запись().rows());
J(мои.map((r) => ({ id: r.id, status: r.data.status, owner: r.owner === acc.id ? '$account' : r.owner })));
console.log('count =', await T(`uc.Запись().count() — честный по суженному множеству`, uc.Запись().count()));
console.log('безусловный класс: uc.Услуга().count() =', await T(`uc.Услуга().count()`, uc.Услуга().count()));
await TE(`uc.Организация().rows() — deny-by-default`, () => uc.Организация().rows());
const [своя] = await T(`uc.Запись().set({ status: 'created', total: { RUB: 300 } }).rows() — owner пришпилен правилом`,
  uc.Запись().set({ status: 'created', total: { RUB: 300 } }).rows());
console.log('owner === acc.id:', своя.owner === acc.id);
await TE(`uc.Запись().owner(SYS).set({…}).rows() — конфликт с пришпиленным`, () => uc.Запись().owner(SYS).set({ status: 'created', total: { RUB: 1 } }).rows());
const чужая = bu(8, 0);
console.log('upsert чужого id → ', JSON.stringify(await T(`uc.Запись('${чужая.slice(-4)}').set({ status: 'hacked' }).rows() — НЕ перехватывает`, uc.Запись(чужая).set({ status: 'hacked' }).rows())));
console.log('чужая жива, status =', (await db.Запись(чужая).first()).data.status);
const снесено = await T(`uc.Запись('…0965').delete({ confirm: true }).rows() — DELETE своей разрешён`, uc.Запись(u(965)).delete({ confirm: true }).rows());
console.log('=', JSON.stringify(снесено.map((r) => ({ id: r.id, $deleted: r.$deleted }))));
h('R19.6 watch под enforceAcl');
const aclСобытия = [];
const stopAcl = await uc.watch((e) => aclСобытия.push(e));
await db.Услуга(u(922)).set({ price: { RUB: 750 } }).rows();        // Service: безусловный allow → видно
await db.Клиент(u(931)).Запись().owner(acc.id).set({ id: u(968), status: 'created', total: { RUB: 1 } }).rows(); // Booking: предикатный → скрыто
await sleep(400);
console.log('uc.watch поймал классы:', JSON.stringify(aclСобытия.map((e) => e.class)), '— Booking скрыт (предикат не проверить по payload)');
await stopAcl();
await uc.close();

H('R20 enforceAccount');
const isoT0 = performance.now();
const iso = await connect({ dsn: DSN, schema: S, account: acc.id, enforceAccount: true });
console.log(`>>> connect({ …, account: acc.id, enforceAccount: true })   [${(performance.now() - isoT0).toFixed(1)} ms]`);
const [свояОрг] = await T(`iso.Организация().set({ name: 'Салон Ромашки' }).rows() — account пришпилен`, iso.Организация().set({ id: u(902), name: 'Салон Ромашки' }).rows());
console.log('своя.account === acc.id:', свояОрг.account === acc.id);
console.log('видимых орг:', await T(`iso.Организация().count() — чужие арендаторы невидимы`, iso.Организация().count()));
await TE(`iso.Организация().account(SYS).rows() — чтение чужого арендатора`, () => iso.Организация().account(SYS).rows());
await iso.close();

H('R22 план-цепочка: несколько операций, fan-out, откат');
const план1 = await T(`db.Клиент('…0931').set({ language: 'en' }).Запись().set({ id: '…0964', status: 'created', total: { RUB: 990 } }).rows()`,
  db.Клиент(u(931)).set({ language: 'en' }).Запись().set({ id: u(964), status: 'created', total: { RUB: 990 } }).rows());
J(план1.map((r) => ({ id: r.id, class: r.class, links: r.links, status: r.data.status })));
const двойной = await T(`db.Запись('…0964').set({ status: 'confirmed' }).set({ status: 'completed' }).rows() — self-set: две версии`,
  db.Запись(u(964)).set({ status: 'confirmed' }).set({ status: 'completed' }).rows());
console.log('=', JSON.stringify(двойной.map((r) => r.data.status)), '; versions:',
  JSON.stringify((await db.Запись(u(964)).versions()).map((r) => r.data.status)));
const хвостCnt = await T(`db.Клиент('…0931').set({ language: 'ru' }).Запись().count() — хвост-чтение`,
  db.Клиент(u(931)).set({ language: 'ru' }).Запись().count());
console.log('=', хвостCnt);
await TE(`откат: валидный set + невалидный set — весь план назад`,
  () => db.Клиент(u(931)).set({ name: 'Не запишется' }).Запись().set({ чепуха: 1 }).rows());
console.log('имя после отката =', (await db.Клиент(u(931)).first()).data.name);
const эталон = await T(`db.Клиент('…0931').set({ active: true }).Запись().delete({ confirm: true }).rows() — fan-out: снести записи каждого`,
  db.Клиент(u(931)).set({ active: true }).Запись().delete({ confirm: true }).rows());
console.log('снесено записей:', эталон.length, JSON.stringify(эталон.map((r) => ({ id: r.id.slice(-4), dead: r.$deleted }))));

H('R21 уборка словаря ACL');
for (const рс of ['apiref.api.booking:API', 'apiref.booking.own:READ', 'apiref.booking.own:WRITE', 'apiref.booking.own:DELETE', 'apiref.service:READ'])
  await db.rules.delete('apiref.client:ACCOUNT', рс);
for (const al of ['apiref.client:ACCOUNT', 'apiref.api.booking:API', 'apiref.booking.own:READ', 'apiref.booking.own:WRITE', 'apiref.booking.own:DELETE', 'apiref.service:READ'])
  await db.resources.delete(al);
await db.sql.unsafe(`DELETE FROM "${S}"."Schema" WHERE id = 'VipBooking'`);
console.log('ресурсы/правила apiref.* удалены, VipBooking удалён; осталось ресурсов:',
  (await db.resources.find()).length);
redis.disconnect();
await db.close();
console.log('\nDONE');
