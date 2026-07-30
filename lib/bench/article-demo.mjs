/**
 * Сквозной прогон публичного API (S1–S27) на ЕДИНОМ полигоне v1.salondemo
 * (booking-модель 0.18, ~982k строк; генератор bench/salon-seed.mjs).
 * Каждый вызов: реальный ответ + реальное время (ms) + дельта строк БД.
 * Тот же полигон обслуживает демо-прогон по тест-плану (bench/salon-article-demo.mjs)
 * и полный API Reference (bench/api-reference-demo.mjs).
 *
 * Модель: окно (slot) — LINK Мастер×Локация×Расписание, интервал доступности
 * (смена, позитивная модель); запись (booking) — LINK-наследник окна с предметом
 * (союз Услуга|Товар|Комплекс) и опциональным Клиентом; id окна/записи =
 * v5(Мастер, старт) — двойная бронь мертва самим id. НЕ ПЕРЕСЕВАЕТ полигон: только
 * читает его, мутирует лишь свои демо-сущности (префикс 00000902), идемпотентен.
 */
import postgres from 'postgres';
import {
  connect, cursorOf, uuidv5, gte, between, ilike, like, starts, ends,
  has, hasAny, hasAll, exists, isNull, not, or, ne, gt, lt, lte, inList,
} from '../src/index.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const S = 'v1.salondemo';
const SYS = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
// свои демо-сущности — префикс 00000902 (не пересекается с salon-article 00000900 и api-reference 00000000-09xx)
const u = (n) => `00000902-0000-4000-8000-${String(n).padStart(12, '0')}`;
// v5-классы (Услуга/Товар/Комплекс, окно/запись/навык…) id не принимают — считает Schema; формула открыта:
const v5 = (cls, ...parts) => uuidv5(`${S}:entity:${cls}:${parts.join(':')}`);
const bid = (staffId, start) => v5('booking', staffId, start); // id записи = v5(Мастер, старт)
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

// ---------------- уборка прошлого прогона: ТОЛЬКО свой префикс 00000902 + свои v5 + свой аккаунт ----------------
// Полигон (System-аккаунт, id генератора salon-seed) не трогаем — только читаем.
// v5-каталог демо (услуги/товар/комплекс): их прайсы/состав/содержимое ссылаются на эти концы.
const ownCat = [
  v5('Service', u(1), 'Стрижка'), v5('Service', u(1), 'Королевское бритьё'),
  v5('Product', u(1), 'Воск для бороды'), v5('Complex', u(1), 'Свадебный образ'),
];
console.log('уборка прошлого прогона (префикс 00000902)…');
const admin = postgres(DSN, { max: 1, onnotice: () => {} });
await admin.unsafe(`DELETE FROM "${S}"."Rule" WHERE resource = 'api.booking'`);      // словарь S24
await admin.unsafe(`DELETE FROM "${S}"."Resource" WHERE alias = 'api.booking'`);
const мусор = (await admin.unsafe(`SELECT id FROM "${S}"."Account" WHERE data->>'название' = 'ИП Анна'`)).map((r) => r.id);
await admin.unsafe('BEGIN');
await admin.unsafe(`SET LOCAL session_replication_role = replica`); // обойти append-only tombstone — физически стереть демо
await admin.unsafe(
  `DELETE FROM "${S}"."Entity" WHERE id::text LIKE '00000902-%'
     OR account = ANY($1) OR owner = ANY($1)
     OR links->>'Org' LIKE '00000902-%' OR links->>'Staff' LIKE '00000902-%'
     OR links->>'Location' LIKE '00000902-%' OR links->>'Schedule' LIKE '00000902-%'
     OR links->>'Folder' LIKE '00000902-%' OR links->>'Customer' LIKE '00000902-%'
     OR links->>'Service' = ANY($2) OR links->>'Product' = ANY($2) OR links->>'Complex' = ANY($2)
     OR id::text = ANY($2)`,
  [мусор, ownCat]);
await admin.unsafe('COMMIT');
// Account — с ЖИВЫМИ триггерами (replica отключил бы FK CASCADE на Credential → creds-сироты)
await admin.unsafe(`DELETE FROM "${S}"."Account" WHERE id = ANY($1)`, [мусор]);
await admin.end();

const db = await connect({ enforceAccount: false, dsn: DSN, schema: S });

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
const [org] = await T(`db.Организация().create({id:…0001, name:'BarberPro', phone}).rows()`,
  db.Организация().create({ id: u(1), name: 'BarberPro', phone: '+7 900 000-00-00' }).rows());
J(org);
await dumpNew('S1');

H('S2 INSERT с контекстом');
const [вася] = await T(`db.Организация(org).Мастер().create({id:…0011, name:'Вася', phone, specialization:'барбер'}).rows()`,
  db.Организация(org).Мастер().create({ id: u(11), name: 'Вася', phone: '+7 901 000-00-11', specialization: 'барбер' }).rows());
J(вася);
const [олег] = await db.Организация(org).Мастер().create({ id: u(12), name: 'Олег', phone: '+7 901 000-00-12' }).rows();
await dumpNew('S2');

H('S3 каталог/клиент/календарь');
// Услуга/Товар/Комплекс — v5-классы: id считает схема (Org+name), явный id запрещён
const [стрижка] = await T(`Услуга Стрижка (цена — отдельным LINK)`, db.Организация(org).Услуга().create({ name: 'Стрижка', duration: 60, description: 'классика' }).rows());
const [бритьё] = await db.Организация(org).Услуга().create({ name: 'Королевское бритьё', duration: 30 }).rows();
const [воск] = await db.Организация(org).Товар().create({ name: 'Воск для бороды', sku: 'WAX-01' }).rows();
const [набор] = await db.Организация(org).Комплекс().create({ name: 'Свадебный образ', cost: 2000, duration: 90 }).rows();
// цена — отдельный LINK «цена» (варианты по note + мультивалюта amounts); note не задан → «базовая», id = v5(элемент, note)
const [цСтрижка] = await T(`цена услуги: Услуга(s).цена().create({ amounts }) — note дефолт «базовая»`,
  db.Услуга(стрижка).цена().create({ amounts: { RUB: 1500 } }).rows());
J({ id: цСтрижка.id, 'id = v5(услуга, note=базовая)': цСтрижка.id === v5('price', стрижка.id, 'базовая'), data: цСтрижка.data, links: цСтрижка.links });
await db.Услуга(стрижка).цена().create({ note: 'с дизайном', amounts: { RUB: 2000 } }).rows(); // второй вариант
await db.Услуга(бритьё).цена().create({ amounts: { RUB: 800 } }).rows();
await db.Товар(воск).цена().create({ amounts: { RUB: 600 } }).rows();
await db.Комплекс(набор).цена().create({ amounts: { RUB: 2500 } }).rows();
// состав комплекса: LINK «состав» = [Комплекс, Услуга|Товар] — предмет слотом
await db.Комплекс(набор).состав().create({ order: 1 }).Услуга.set(стрижка).rows();
await db.Комплекс(набор).состав().create({ order: 2 }).Услуга.set(бритьё).rows();
await db.Комплекс(набор).состав().create({ order: 3, quantity: 2 }).Товар.set(воск).rows();
const [анна] = await db.Организация(org).Клиент().create({ id: u(31), name: 'Анна', phone: '+7 911 111-11-11' }).rows();
const [зал] = await db.Организация(org).Локация().create({ id: u(21), address: 'Невский, 5', coordinates: { lat: 59.93, lng: 30.36 } }).rows();
const [расп] = await db.Организация(org).Расписание().create({ id: u(41), name: 'Июль-26', year: 2026, month: 7 }).rows();
// окно-смена: Мастер×Локация×Расписание + интервал; id = v5(мастер, старт)
const [смена] = await T(`db.Мастер(вася).окно().create({start,end}).Локация.set(зал).Расписание.set(расп).rows()`,
  db.Мастер(вася).окно().create({ start_datetime: '2026-07-15T10:00:00+03:00', end_datetime: '2026-07-15T20:00:00+03:00' })
    .Локация.set(зал).Расписание.set(расп).rows());
J({ id: смена.id, class: смена.class, 'id из формулы': смена.id === v5('slot', вася.id, '2026-07-15T10:00:00+03:00'), links: смена.links });
// адрес мастера: LINK «адрес» = [Мастер, Локация]
await db.Мастер(вася).адрес().create({ default: true }).Локация.set(зал).rows();
const [root] = await db.Организация(org).Папка().create({ id: u(71), name: 'Каталог' }).rows();
const [муж] = await db.Организация(org).Папка(root).Папка().create({ id: u(72), name: 'Мужской зал' }).rows();
await db.Организация(org).Папка(муж).Папка().create({ id: u(73), name: 'Борода и усы' }).rows();
// наполнение папки: LINK «содержимое» = [Папка, Услуга|Товар|Комплекс]
await db.Папка(муж).содержимое().create({ order: 1 }).Услуга.set(стрижка).rows();
await db.Папка(муж).содержимое().create({ order: 2 }).Комплекс.set(набор).rows();
await dumpNew('S3');

H('S4 идемпотентный create: та же (услуга, note) → версия цены, record-merge amounts, versions');
const [цv2] = await T(`db.Услуга(стрижка).цена().create({ amounts: { RUB: 1800, USD: 18 } }).rows() — та же (услуга, note=базовая)`,
  db.Услуга(стрижка).цена().create({ amounts: { RUB: 1800, USD: 18 } }).rows());
J({ id: цv2.id === цСтрижка.id ? 'тот же (v5 из услуга+note)' : 'ДРУГОЙ?!', 'amounts (record-merge: RUB обновлён, USD добавлен)': цv2.data.amounts, updated: цv2.updated });
await dumpNew('S4');
const истор = await T(`db.цена(цСтрижка.id).versions()`, db.цена(цСтрижка.id).versions());
J(истор.map((r) => ({ updated: r.updated, amounts: r.data.amounts, $deleted: r.$deleted })));

H('S5 связи: владелец из пути, концы слотами');
const [навык] = await T(`db.Мастер(вася).навык().create({level:'expert'}).Услуга.set(стрижка).rows() — 1 INSERT`,
  db.Мастер(вася).навык().create({ level: 'expert' }).Услуга.set(стрижка).rows());
J({ id: навык.id, class: навык.class, data: навык.data, links: навык.links });
await db.Мастер(вася).навык().create().Услуга.set(бритьё).rows();
// запись — LINK-наследник окна: интервал свой, концы Staff/Location/Schedule/союз/Customer
const T10 = '2026-07-15T10:00:00+03:00';
const [запись] = await T(`db.Клиент(анна).запись().create({start,end}).Мастер.set(вася).Локация.set(зал).Расписание.set(расп).Услуга.set(стрижка).rows() — 1 INSERT`,
  db.Клиент(анна).запись().create({ start_datetime: T10, end_datetime: '2026-07-15T11:00:00+03:00' })
    .Мастер.set(вася).Локация.set(зал).Расписание.set(расп).Услуга.set(стрижка).rows());
J({ id: запись.id, class: запись.class, 'id из формулы v5(Мастер, старт)': запись.id === bid(вася.id, T10), data: запись.data, links: запись.links });
await dumpNew('S5');

H('S6 UPDATE по фильтру В КОНТЕКСТЕ клиента (дата-момент — between)');
const подтв = await T(`db.Клиент(анна).запись({start_datetime: between(T10, T10)}).update({notes:'подтверждена по телефону'}).rows()`,
  db.Клиент(анна).запись({ start_datetime: between(T10, T10) }).update({ notes: 'подтверждена по телефону' }).rows());
J(подтв.map((r) => ({ id: r.id, notes: r.data.notes, updated: r.updated })));

H('S7 run() пути');
const пути = await T(`db.Мастер({name:'Вася'}).навык().Услуга().run()`,
  db.Мастер({ name: 'Вася' }).навык().Услуга().run());
J(пути);

H('S8 rows/first/ids/count на большом классе');
const услуги = await T(`db.Услуга().rows() — весь класс`, db.Услуга().rows());
console.log('rows().length =', услуги.length, '; первые 2:', JSON.stringify(услуги.slice(0, 2).map((r) => ({ id: r.id, name: r.data.name }))));
const первый = await T(`db.Мастер({name:'Олег'}).first()`, db.Мастер({ name: 'Олег' }).first());
J({ id: первый.id, name: первый.data.name });
const ids = await T(`db.Мастер().ids()`, db.Мастер().ids());
console.log('ids().length =', ids.length);
const cnt = await T(`db.Организация(org).Мастер().count()`, db.Организация(org).Мастер().count());
console.log('count =', cnt);

H('S9 операторы: вызов → ответ (полигон salon-seed: ~603 услуги / ~360 мастеров; has* — на tags)');
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
// в data новой модели массивов нет — has/hasAny/hasAll живут на КОЛОНКЕ tags (среди 40k+ клиентов)
await c(`Клиент().tags(has('vip')).count()`, db.Клиент().tags(has('vip')).count());
await c(`Клиент().tags(hasAny(['vip','telegram'])).count()`, db.Клиент().tags(hasAny(['vip', 'telegram'])).count());
await c(`Клиент().tags(hasAll(['vip','telegram'])).count()`, db.Клиент().tags(hasAll(['vip', 'telegram'])).count());
await c(`Услуга({description: exists()}).count()`, db.Услуга({ description: exists() }).count());
await c(`Услуга({description: exists(false)}).count()`, db.Услуга({ description: exists(false) }).count());
await c(`Услуга({description: isNull()}).count()`, db.Услуга({ description: isNull() }).count());
await c(`Услуга({name: not(starts('Услуга'))}).count()`, db.Услуга({ name: not(starts('Услуга')) }).count());
await c(`цена({amounts:{RUB:gte(1300)}}).Услуга().count() — фильтр по цене через класс цена`, db.цена({ amounts: { RUB: gte(1300) } }).Услуга().count());
await c(`Организация({settings:{booking:{deposit:{amount: gte(700)}}}}).count() — глубина 4`,
  db.Организация({ settings: { booking: { deposit: { amount: gte(700) } } } }).count());
await c(`Услуга(or({name:'Стрижка'},{duration:lt(45)})).count()`, db.Услуга(or({ name: 'Стрижка' }, { duration: lt(45) })).count());

H('S10 модификаторы sort/limit/offset');
const топ = await T(`db.цена().sort('data.amounts.RUB','desc').limit(3).rows()`,
  db.цена().sort('data.amounts.RUB', 'desc').limit(3).rows());
J(топ.map((r) => ({ note: r.data.note, RUB: r.data.amounts.RUB })));
const свежие = await T(`db.запись().sort('updated','desc').limit(2).rows() — 250k записей`,
  db.запись().sort('updated', 'desc').limit(2).rows());
J(свежие.map((r) => ({ id: r.id, notes: r.data.notes, updated: r.updated })));

H('S11 alias');
const пути2 = await T(`…alias('салон')…alias('мастер').run()`,
  db.Организация(org).alias('салон').Мастер({ name: 'Вася' }).alias('мастер').run());
console.log('ключи пути:', Object.keys(пути2[0]));

H('S12 tags');
const [vip] = await T(`db.Организация(org).Клиент().tags(['vip','telegram']).create({id:…0032, name:'Пётр'}).rows()`,
  db.Организация(org).Клиент().tags(['vip', 'telegram']).create({ id: u(32), name: 'Пётр', phone: '+7 921 000-00-32' }).rows());
J({ id: vip.id, tags: vip.tags });
await c(`Клиент().tags('vip').count() — среди 40k+ клиентов полигона`, db.Клиент().tags('vip').count());
await dumpNew('S12');

H('S13 deep');
const дерево = await T(`db.Папка('…0071').Папка().deep().rows()`, db.Папка(u(71)).Папка().deep().rows());
J(дерево.map((r) => ({ name: r.data.name, $depth: r.$depth })));

H('S14 asOf');
const тогда = await T(`db.цена(цСтрижка.id).asOf(t1).first()`, db.цена(цСтрижка.id).asOf(истор[0].updated).first());
J({ amounts: тогда.data.amounts });
const сейчас = await db.цена(цСтрижка.id).first();
J({ amounts: сейчас.data.amounts });

H('S15 keyset на 250k записей');
const стр1 = await T(`страница 1: запись().sort('updated','desc').limit(3).rows()`,
  db.запись().sort('updated', 'desc').limit(3).rows());
const курсор = cursorOf(стр1.at(-1));
J(курсор);
const стр2 = await T(`страница 2: .after(cursor).limit(3)`,
  db.запись().sort('updated', 'desc').after(курсор).limit(3).rows());
console.log('пересечение страниц:', стр1.filter((a) => стр2.some((b) => b.id === a.id)).length);

H('S16 агрегации на 250k+');
await c(`запись().countBy('data.notes')`, db.запись().countBy('data.notes'));
await c(`запись({notes:'no-show'}).count()`, db.запись({ notes: 'no-show' }).count());
await c(`цена().sum('data.amounts.RUB') — record-лист`, db.цена().sum('data.amounts.RUB'));
await c(`Услуга().avg('data.duration')`, db.Услуга().avg('data.duration'));
await c(`цена().min('data.amounts.RUB')`, db.цена().min('data.amounts.RUB'));
await c(`цена().max('data.amounts.RUB')`, db.цена().max('data.amounts.RUB'));

H('S17 delete: превью и каскад (клиент → его записи)');
const T11 = '2026-07-15T11:00:00+03:00';
const [гость] = await db.Организация(org).Клиент().create({ id: u(34), name: 'Каскадный Гость', phone: '+7 931 000-00-34' }).rows();
await db.Мастер(олег).запись().create({ start_datetime: T11, end_datetime: '2026-07-15T12:00:00+03:00' })
  .Локация.set(зал).Расписание.set(расп).Услуга.set(бритьё).Клиент.set(гость).rows();
const превью = await T(`db.Клиент('…0034').delete().rows() — ПРЕВЬЮ, БД не тронута`, db.Клиент(u(34)).delete().rows());
J(превью.map((r) => ({ id: r.id, class: r.class, живой: !r.$deleted })));
console.log('после превью клиент жив:', (await db.Клиент(u(34)).first()) !== null);
const удалено = await T(`db.Клиент('…0034').delete({ confirm: true }).rows() — сервер найдёт зависимых`, db.Клиент(u(34)).delete({ confirm: true }).rows());
J(удалено.map((r) => ({ id: r.id, class: r.class, $deleted: r.$deleted })));
await dumpNew('S17');
console.log('запись Олега на 11:00 умерла каскадом:', await db.запись(bid(олег.id, T11)).first() === null);
console.log('повторный delete →', JSON.stringify(await db.Клиент(u(34)).delete({ confirm: true }).rows()));

H('S18 воскрешение v5-id: та же пара (мастер, старт) после tombstone');
const [жив] = await T(`db.Мастер(олег).запись().create({тот же старт, notes:'walk-in: Надя'})… — id совпал, история цела`,
  db.Мастер(олег).запись().create({ start_datetime: T11, end_datetime: '2026-07-15T12:00:00+03:00', notes: 'walk-in: Надя' })
    .Локация.set(зал).Расписание.set(расп).Услуга.set(бритьё).rows());
J({ id: жив.id, 'тот же id': жив.id === bid(олег.id, T11), notes: жив.data.notes, links: жив.links });
J((await db.запись(жив.id).versions()).map((r) => ({ notes: r.data.notes, updated: r.updated, $deleted: r.$deleted })));

H('S19 anonymize');
const [анон] = await T(`db.Клиент('…0031').anonymize(['name','phone']).rows()`,
  db.Клиент(u(31)).anonymize(['name', 'phone']).rows());
J({ data: анон.data, tags: анон.tags });
await dumpNew('S19');
J((await db.Клиент(u(31)).versions()).map((r) => ({ name: r.data.name, phone: r.data.phone })));

H('S20 tx: гонка двойной брони');
// id записи детерминирован схемой — известен ДО создания (формула открыта)
const T12 = '2026-07-15T12:00:00+03:00';
const bid12 = bid(вася.id, T12);
const tr1 = await db.begin();
const tr2 = await db.begin();
await tr1.lock('booking', вася.id, T12);
const гонка2 = (async () => {
  await tr2.lock('booking', вася.id, T12);
  const занято = await tr2.запись(bid12).first();
  if (занято) { await tr2.rollback(); return 'ОТКАЗ: время уже занято'; }
  await tr2.Мастер(вася).запись().create({ start_datetime: T12, end_datetime: '2026-07-15T12:30:00+03:00' })
    .Локация.set(зал).Расписание.set(расп).Услуга.set(бритьё).rows();
  await tr2.commit(); return 'бронь моя';
})();
console.log('tr1 видит запись?', await tr1.запись(bid12).first());
await tr1.Мастер(вася).запись().create({ start_datetime: T12, end_datetime: '2026-07-15T12:30:00+03:00' })
  .Локация.set(зал).Расписание.set(расп).Услуга.set(бритьё).rows();
await tr1.commit();
console.log('tr1: бронь моя; tr2:', await гонка2);

H('S21 batch');
const события = [];
const db2 = await connect({ enforceAccount: false, dsn: DSN, schema: S, onQuery: (e) => события.push(e) });
const [распАвг] = await db2.Организация(org).Расписание().create({ id: u(43), name: 'Август-26', year: 2026, month: 8 }).rows();
const b = db2.batch('смены-августа');
b.Мастер(вася).окно().create({ start_datetime: '2026-08-01T10:00:00+03:00', end_datetime: '2026-08-01T18:00:00+03:00' }).Локация.set(зал).Расписание.set(распАвг);
b.Мастер(вася).окно().create({ start_datetime: '2026-08-02T10:00:00+03:00', end_datetime: '2026-08-02T18:00:00+03:00' }).Локация.set(зал).Расписание.set(распАвг);
console.log('size():', b.size());
const резБатч = await T(`batch.run() — одна транзакция`, b.run());
J(резБатч.map((rr) => rr.map((r) => ({ id: r.id, start: r.data.start_datetime, links: r.links }))));

H('S22 onQuery события');
J(события.slice(-2).map((e) => ({ ...e, ms: +e.ms.toFixed(1) })));
await db2.close();

H('S23 watch');
const пойманные = [];
const stop = await db.watch('Клиент', (e) => пойманные.push(e));
await db.Организация(org).Клиент().create({ id: u(33), name: 'Наблюдаемый', phone: '+7 941 000-00-33' }).rows();
await db.Клиент(u(33)).delete({ confirm: true }).rows();
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
const iso = await (await connect({ dsn: DSN, schema: S, enforceAccount: true })).as(acc.id);
const [своя] = await iso.Организация().create({ id: u(2), name: 'Салон Анны' }).rows();
console.log('своя.account ===', своя.account);
const isoCnt = await T(`iso.Организация().count() — видит только своего арендатора`, iso.Организация().count());
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
const { totpCode } = await import('../src/index.js');
const тотп = await T(`db.auth.enrollTotp({account: acc, issuer: 'clockz'})`,
  db.auth.enrollTotp({ account: acc, issuer: 'clockz', label: 'anna@salon.io' }));
J({ secret: тотп.secret, uri: тотп.uri });
const тотпКод = totpCode(тотп.secret);
console.log('код authenticator-а =', тотпКод);
console.log('verifyTotp →', await T(`db.auth.verifyTotp({account, code})`, db.auth.verifyTotp({ account: acc, code: тотпКод })));
console.log('replay →', await T(`db.auth.verifyTotp тот же код`, db.auth.verifyTotp({ account: acc, code: тотпКод })));
const otp = await T(`db.auth.issueOtp({account, identifier: 'anna@salon.io'})`,
  db.auth.issueOtp({ account: acc, identifier: 'anna@salon.io', ttlSec: 600 }));
J(otp);
J(await T(`db.auth.verifyOtp — верный код`, db.auth.verifyOtp({ identifier: 'anna@salon.io', code: otp.code })));
console.log('повторно (сожжён) →', await T(`db.auth.verifyOtp тот же код`, db.auth.verifyOtp({ identifier: 'anna@salon.io', code: otp.code })));
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

H('S27 план-цепочка: несколько операций, один терминал, одна транзакция');
const T16 = '2026-07-15T16:00:00+03:00';
const bid16 = bid(вася.id, T16);
const плановые = await T(`db.Клиент(анна).update({preferred_contact:'messenger'}).запись().create({start,end}).Мастер.set(вася)….rows()`,
  db.Клиент(анна).update({ preferred_contact: 'messenger' }).запись()
    .create({ start_datetime: T16, end_datetime: '2026-07-15T16:30:00+03:00' })
    .Мастер.set(вася).Локация.set(зал).Расписание.set(расп).Услуга.set(бритьё).rows());
J(плановые.map((r) => ({ id: r.id, class: r.class, links: r.links, data: r.data })));
const двойной = await T(`db.запись(bid16).update({notes:'подтверждена'}).update({notes:'выполнена'}).rows() — две версии подряд`,
  db.запись(bid16).update({ notes: 'подтверждена' }).update({ notes: 'выполнена' }).rows());
J(двойной.map((r) => ({ notes: r.data.notes })));
J((await db.запись(bid16).versions()).map((r) => r.data.notes));
const хвост = await T(`db.Клиент(анна).update({preferred_contact:'phone'}).запись().count() — хвост-чтение в той же транзакции`,
  db.Клиент(анна).update({ preferred_contact: 'phone' }).запись().count());
console.log('=', хвост);
try {
  await db.Клиент(анна).update({ name: 'Откат-нет' }).запись()
    .create({ start_datetime: T16, end_datetime: T16, чепуха: 1 })
    .Мастер.set(вася).Локация.set(зал).Расписание.set(расп).Услуга.set(бритьё).rows();
} catch (e) { console.log('невалидный сегмент → ошибка:', e.message.slice(0, 80)); }
console.log('первый сегмент откатился, имя =', (await db.Клиент(анна).first()).data.name);
await T(`db.запись(bid16).delete({ confirm: true }).rows() — уборка сцены`, db.запись(bid16).delete({ confirm: true }).rows());

await db.close();
console.log('\nDONE');
