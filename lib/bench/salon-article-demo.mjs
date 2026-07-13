/**
 * Воспроизводитель статьи SALON.md: снимает ЖИВЫЕ ответы всех API по тест-плану
 * (акты) на полигоне v1.salondemo (~1M строк). Чтения/агрегации — на полигоне
 * (реальные числа и тайминги), мутации — на демо-сущностях (id 9xx, вне генератора).
 * Идемпотентен: демо-сущности пере-создаются, полигон не трогается.
 *
 *   node bench/salon-seed.mjs        # сначала засеять (если ещё нет)
 *   node bench/salon-article-demo.mjs
 */
import Redis from 'ioredis';
import postgres from 'postgres';
import {
  connect, up, cursorOf, totpCode,
  ne, gt, gte, lt, lte, between, inList, like, ilike, starts, ends,
  has, hasAny, hasAll, exists, isNull, not, or,
} from '../src/index.js';
import { uuidv5 } from '../src/uuid.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const REDIS = process.env.ENTITY_REDIS ?? 'redis://localhost:16379';
const S = 'v1.salondemo';
const dm = (n) => `00000900-0000-4000-8000-${String(n).padStart(12, '0')}`; // демо-id v7-классов (вне генератора)
// v5-классы (Service/Product/Complex/окно/запись/навык/состав/содержимое/адрес) id не принимают —
// их считает Schema. Формула открыта → id демо-сущностей знаем заранее (для уборки и проверок):
const v5 = (cls, ...parts) => uuidv5(`${S}:entity:${cls}:${parts.join(':')}`);
const орг = dm(10), ольгаId = dm(11), иринаId = dm(12), залId = dm(15), распId = dm(70);
const iso = (h) => `2026-08-01T${String(h).padStart(2, '0')}:00:00+03:00`;
const свцId = (name) => v5('Service', орг, name);
const товарId = v5('Product', орг, 'Шампунь (демо)');
const комплексId = v5('Complex', орг, 'Образ');
const сменаId = (staff) => v5('slot', staff, iso(10));       // окно-смена 10:00–18:00
const бронId = (staff, h) => v5('booking', staff, iso(h));   // запись: v5(мастер, старт) — унаследовано от окна
const demoV5 = [
  свцId('Стрижка'), свцId('Укладка'), свцId('Борода'), свцId('Хит сезона'), свцId('Спец'),
  товарId, комплексId,
  v5('compo', комплексId, свцId('Стрижка')), v5('compo', комплексId, свцId('Укладка')), v5('compo', комплексId, товарId),
  v5('content', dm(21), свцId('Стрижка')), v5('content', dm(21), свцId('Укладка')), v5('content', dm(20), комплексId),
  v5('skill', ольгаId, свцId('Стрижка')), v5('skill', ольгаId, свцId('Укладка')),
  v5('skill', иринаId, свцId('Стрижка')), v5('skill', иринаId, свцId('Борода')),
  v5('address', ольгаId, залId), v5('address', иринаId, залId),
  сменаId(ольгаId), сменаId(иринаId),
  ...[10, 11, 12, 15].map((h) => бронId(ольгаId, h)), бронId(иринаId, 12),
  // варианты цены демо-каталога (v5(элемент, note))
  v5('price', свцId('Стрижка'), 'базовая'), v5('price', свцId('Стрижка'), 'с дизайном'),
  v5('price', свцId('Укладка'), 'базовая'), v5('price', свцId('Борода'), 'базовая'),
  v5('price', товарId, 'базовая'), v5('price', комплексId, 'базовая'),
];

const H = (t) => console.log(`\n\n########## ${t} ##########`);
const J = (x) => console.log(JSON.stringify(x, (_k, v) => (v === undefined ? undefined : v), 1));
async function T(label, p) {
  const t0 = performance.now();
  const res = await p;
  const ms = (performance.now() - t0).toFixed(1);
  console.log(`\n>>> ${label}   [${ms} ms]`);
  return res;
}
/** короткий вид Row: id-хвост + class + data + links */
const short = (r) => r && ({ id: '…' + r.id.slice(-4), class: r.class, data: r.data, links: r.links, ...(r.tags?.length ? { tags: r.tags } : {}), ...(r.$deleted ? { $deleted: true } : {}) });
const shorts = (rows) => rows.map(short);

const db = await connect({ dsn: DSN, schema: S });
const redis = new Redis(REDIS);

// демо-уборка: снести прошлый прогон. Демо-сущности — по id-префиксу '00000900',
// плюс всё на не-System аккаунтах (арендатор Акта 20); полигон (System, id генератора) цел.
const admin = postgres(DSN, { max: 1, onnotice: () => {} });
// Entity: под replica (обойти append-only tombstone-триггер — физически стереть демо-строки).
// v7-демо — по id-префиксу '00000900'; v5-демо — по вычисленным id (формула открыта).
await admin.unsafe(`SET session_replication_role = replica`);
await admin.unsafe(
  `DELETE FROM "${S}"."Entity" WHERE id LIKE '00000900-%' OR id = ANY($1)
    OR account NOT IN (SELECT id FROM "${S}"."Account" WHERE 'System' = ANY(categories))`,
  [demoV5],
);
await admin.unsafe(`SET session_replication_role = origin`);
// Account/Credential: в ОБЫЧНОМ режиме — иначе FK CASCADE на Credential не сработает
// (replica отключает и FK-триггеры) и останутся creds-сироты → дубль credential_identity_udx
await admin.unsafe(`DELETE FROM "${S}"."Account" WHERE 'System' <> ALL(categories)`);
await admin.end();

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 1. Открытие салона: connect, создание HUB, батч');
const [org] = await T('db.Организация().create(...).rows()',
  db.Организация().create({ id: dm(10), name: 'Салон «Пример»', phone: '+7 495 0000000', timezone: 'Europe/Moscow' }).rows());
J(short(org));

const [зал] = await db.Организация(org).Локация().create({ id: dm(15), address: 'Тверская, 7', coordinates: { lat: 55.76, lng: 37.61 } }).rows();
console.log('локация →', зал.data.address);

const b = db.batch('setup');
b.Организация(org).Мастер().create({ id: dm(11), name: 'Ольга', phone: '+7 900 222', specialization: 'парикмахер' });
b.Организация(org).Мастер().create({ id: dm(12), name: 'Ирина', phone: '+7 900 333', specialization: 'барбер' });
console.log('batch.size() →', b.size());
const setup = await T('batch.run()', b.run());
J(shorts(setup.map((g) => g[0])));
const [ольга, ирина] = [setup[0][0], setup[1][0]];
// адрес: мастер ↔ локация (id = v5(Staff, Location))
await db.Мастер(ольга).адрес().create({ default: true }).Локация.set(зал).rows();
await db.Мастер(ирина).адрес().create({ default: true }).Локация.set(зал).rows();

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 2. up(): вход одной функцией на живой БД');
const dbUp = await T("up({schema:'salondemo', version:1})", up({ dsn: DSN, schema: 'salondemo', version: 1, quiet: true }));
console.log('орг в схеме →', await dbUp.Организация().count());
await dbUp.close();

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 3. Каталог: папки-дерево, услуги/товар, комплекс + состав, содержимое папок');
const [корень] = await db.Организация(org).Папка().create({ id: dm(20), name: 'Каталог' }).rows();
const [волосы] = await db.Организация(org).Папка(корень).Папка().create({ id: dm(21), name: 'Волосы' }).rows();
const [стрижка] = await T('услуга: id считает Schema — v5(Org, name)',
  db.Организация(org).Услуга().create({ name: 'Стрижка', duration: 60 }).rows());
J(short(стрижка));
console.log('id услуги посчитала Schema: uuidv5(Org, name) →', стрижка.id === свцId('Стрижка'));
const [укладка] = await db.Организация(org).Услуга().create({ name: 'Укладка', duration: 30 }).rows();
const [борода] = await db.Организация(org).Услуга().create({ name: 'Борода', duration: 30, description: 'моделирование' }).rows();
const [шампунь] = await db.Организация(org).Товар().create({ name: 'Шампунь (демо)', sku: 'SH-D1' }).rows();
const [набор] = await db.Организация(org).Комплекс().create({ name: 'Образ', duration: 90, cost: 2200 }).rows();
// цена — отдельный LINK «цена» (варианты по пожеланиям + мультивалюта); note не задан → «базовая»
const [цСтрижка] = await T('цена услуги: Услуга(s).цена().create({amounts}) — note дефолт «базовая»',
  db.Услуга(стрижка).цена().create({ amounts: { RUB: 1500, USD: 18 } }).rows());
J(short(цСтрижка));
console.log('id цены = v5(услуга, note=базовая) →', цСтрижка.id === v5('price', стрижка.id, 'базовая'));
await db.Услуга(стрижка).цена().create({ note: 'с дизайном', amounts: { RUB: 2000 } }).rows(); // второй вариант
await db.Услуга(укладка).цена().create({ amounts: { RUB: 900 } }).rows();
await db.Услуга(борода).цена().create({ amounts: { RUB: 800 } }).rows();
await db.Товар(шампунь).цена().create({ amounts: { RUB: 700 } }).rows();
await db.Комплекс(набор).цена().create({ amounts: { RUB: 2500 } }).rows();
const варС = await T('варианты цены услуги: Услуга(s).цена().rows()', db.Услуга(стрижка).цена().rows());
J(варС.map((r) => ({ note: r.data.note, amounts: r.data.amounts })));
await T('состав слотом: Комплекс(k).состав().create().Услуга.set(u)',
  db.Комплекс(набор).состав().create({ quantity: 1, order: 1 }).Услуга.set(стрижка).rows());
await db.Комплекс(набор).состав().create({ quantity: 1, order: 2 }).Услуга.set(укладка).rows();
await db.Комплекс(набор).состав().create({ quantity: 1, order: 3 }).Товар.set(шампунь).rows();
const состав = await T('чтение состава: Комплекс→состав→Услуга', db.Комплекс(набор).состав().Услуга().rows());
J(состав.map((r) => r.data.name));
// наполнение папок: LINK содержимое (union Услуга|Товар|Комплекс)
await db.Папка(волосы).содержимое().create({ order: 1 }).Услуга.set(стрижка).rows();
await db.Папка(волосы).содержимое().create({ order: 2 }).Услуга.set(укладка).rows();
await db.Папка(корень).содержимое().create({ order: 1 }).Комплекс.set(набор).rows();
const вПапке = await T('содержимое папки: Папка→содержимое→Услуга', db.Папка(волосы).содержимое().Услуга().rows());
J(вПапке.map((r) => r.data.name));
const ветка = await T('deep(): вся ветка папок', db.Организация(org).Папка(корень).Папка().deep().rows());
J(ветка.map((f) => f.data.name));

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 4. Навыки мастеров: слоты, pivot-проверка, умение комплекса по составу');
await db.Мастер(ольга).навык().create({ level: 'expert' }).Услуга.set(стрижка).rows();
await db.Мастер(ольга).навык().create().Услуга.set(укладка).rows();
await db.Мастер(ирина).навык().create().Услуга.set(стрижка).rows();
await db.Мастер(ирина).навык().create({ level: 'advanced' }).Услуга.set(борода).rows();
const уменияО = await T('умения Ольги: Мастер→навык→Услуга', db.Мастер(ольга).навык().Услуга().rows());
J(уменияО.map((r) => r.data.name));
const умеет = await T('умеет ли Ирина бороду: навык→Услуга(борода)',
  db.Мастер(ирина).навык().Услуга(борода).count());
console.log('  →', умеет, '(1 = умеет)');
console.log('умеет ли Ирина укладку →', await db.Мастер(ирина).навык().Услуга(укладка).count());
// умение комплекса ВЫЧИСЛИМО: покрывает ли мастер все услуги состава
const услугиСостава = await db.Комплекс(набор).состав().Услуга().ids();
console.log('Ольга покрывает состав «Образа» →',
  (await db.Мастер(ольга).навык().Услуга(услугиСостава).count()) === услугиСостава.length);
console.log('Ирина покрывает →',
  (await db.Мастер(ирина).навык().Услуга(услугиСостава).count()) === услугиСостава.length);

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 5. Расписание: месяц + смены мастеров (окна) батчем — позитивная доступность');
const [расп] = await db.Организация(org).Расписание().create({ id: dm(70), name: 'Август-26', year: 2026, month: 8 }).rows();
const wb = db.batch('смены');
wb.Мастер(ольга).окно().create({ start_datetime: iso(10), end_datetime: iso(18) }).Локация.set(зал).Расписание.set(расп);
wb.Мастер(ирина).окно().create({ start_datetime: iso(10), end_datetime: iso(17) }).Локация.set(зал).Расписание.set(расп); // Ирина до 17:00
const смены = (await T('2 смены батчем', wb.run())).map((g) => g[0]);
console.log('создано смен →', смены.length, '| id окна = uuidv5(Мастер, старт) →', смены[0].id === сменаId(ольгаId));
const ростер = await T('ростер: Расписание→окно→Мастер', db.Расписание(расп).окно().Мастер().rows());
J([...new Set(ростер.map((r) => r.data.name))]);

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 6. Бронь №1: транзакция + lock; запись = наследник окна, id = v5(мастер, старт)');
const [аня] = await db.Организация(org).Клиент().tags(['vip']).create({ id: dm(110), name: 'Аня', phone: '+7 911 001' }).rows();
const зАни = await T('транзакция брони (begin/lock/commit)', (async () => {
  const tr = await db.begin();
  try {
    await tr.lock('booking', ольга.id, iso(10));
    const занято = await tr.запись(бронId(ольгаId, 10)).first();   // id знаем ДО создания
    if (занято) throw new Error('время занято');
    const [зап] = await tr.Мастер(ольга).запись()
      .create({ start_datetime: iso(10), end_datetime: iso(11) })
      .Локация.set(зал).Расписание.set(расп).Услуга.set(стрижка).Клиент.set(аня).rows();
    await tr.commit();
    return зап;
  } catch (e) { await tr.rollback(); throw e; }
})());
J(short(зАни));
console.log('id записи = v5(мастер, старт) →', зАни.id === бронId(ольгаId, 10), '(двойная бронь мертва самим id)');
// повторный create той же пары — версия, не дубль
const [повтор] = await db.Мастер(ольга).запись()
  .create({ start_datetime: iso(10), end_datetime: iso(11), notes: 'подтверждена по телефону' })
  .Локация.set(зал).Расписание.set(расп).Услуга.set(стрижка).Клиент.set(аня).rows();
console.log('повторный create → тот же id:', повтор.id === зАни.id, '| версий:', (await db.запись(зАни.id).versions()).length);

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 8. «4 руки»: два мастера в один час — две записи одной клиентки');
await db.Мастер(ольга).запись().create({ start_datetime: iso(12), end_datetime: iso(13) })
  .Локация.set(зал).Расписание.set(расп).Услуга.set(укладка).Клиент.set(аня).rows();
await db.Мастер(ирина).запись().create({ start_datetime: iso(12), end_datetime: iso(13) })
  .Локация.set(зал).Расписание.set(расп).Услуга.set(борода).Клиент.set(аня).rows();
const в12 = { start_datetime: between(iso(12), iso(12)) };
console.log('записей Ани в 12:00 →', await db.Клиент(аня).запись(в12).count());
const мастера12 = await T('кто занят в 12:00: запись→Мастер', db.запись(в12).Мастер().rows());
J([...new Set(мастера12.map((r) => r.data.name))]);

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 9. Операции: союз-замена предмета, unset клиента, перенос = пересоздание');
const [зам] = await T('союз-замена: предмет Услуга → Комплекс (конец один)',
  db.запись(бронId(ольгаId, 12)).update().Комплекс.set(набор).rows());
console.log('links после замены →', JSON.stringify(зам.links), '(Service снят)');
await db.запись(бронId(ольгаId, 12)).update().Услуга.set(укладка).rows(); // вернуть
const [безКлиента] = await T('ручная бронь: Клиент.unset() + имя в notes',
  db.запись(бронId(ольгаId, 12)).update({ notes: 'бронь по телефону: Аня' }).Клиент.unset().rows());
console.log('links после снятия →', JSON.stringify(безКлиента.links));
await db.запись(бронId(ольгаId, 12)).update().Клиент.set(аня).rows(); // вернуть
// перенос: id жёстко держит (мастер, старт) ⇒ смена времени = пересоздание в транзакции
await T('перенос 10:00 → 15:00 (delete + create одной транзакцией)', (async () => {
  const tr = await db.begin();
  try {
    await tr.запись(бронId(ольгаId, 10)).delete({ confirm: true }).rows();
    await tr.Мастер(ольга).запись()
      .create({ start_datetime: iso(15), end_datetime: iso(16) })
      .Локация.set(зал).Расписание.set(расп).Услуга.set(стрижка).Клиент.set(аня).rows();
    await tr.commit();
  } catch (e) { await tr.rollback(); throw e; }
})());
console.log('10:00 свободно →', (await db.запись(бронId(ольгаId, 10)).count()) === 0,
  '| 15:00 занято →', (await db.запись(бронId(ольгаId, 15)).count()) === 1);

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 10. Отмена: превью delete, затем tombstone (история цела)');
const превью = await T('delete() без confirm — ПРЕВЬЮ (БД не тронута)', db.запись(бронId(иринаId, 12)).delete().rows());
J(превью.map((r) => ({ class: r.class, $deleted: r.$deleted })));
const удалено = await T('delete({confirm:true}) — tombstone', db.запись(бронId(иринаId, 12)).delete({ confirm: true }).rows());
console.log('удалено строк →', удалено.length, '| запись жива? →', await db.запись(бронId(иринаId, 12)).count());
console.log('история жива (versions с tombstone) →', (await db.запись(бронId(иринаId, 12)).versions()).length);

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 11. entity(): узел-переменная и старт с Row');
const текАни = await db.запись(бронId(ольгаId, 15)).first();
const услугаЗаписи = await T('db.entity(row).Услуга()', db.entity(текАни).Услуга().first());
console.log('  →', услугаЗаписи?.data.name);

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 12. Операторы фильтра — НА ПОЛИГОНЕ (~1M строк)');
const cS = (f) => db.Услуга(f).count();
console.log('ne(60):', await T('ne', cS({ duration: ne(60) })));
console.log('gt(45):', await cS({ duration: gt(45) }), '| gte(45):', await cS({ duration: gte(45) }));
console.log('lt(45):', await cS({ duration: lt(45) }), '| lte(45):', await cS({ duration: lte(45) }));
console.log('between(30,45):', await cS({ duration: between(30, 45) }));
console.log('inList([Стрижка0,Укладка2]):', await cS({ name: inList(['Стрижка 0', 'Укладка 2']) }));
console.log('like(Массаж%):', await cS({ name: like('Массаж%') }));
console.log('ilike(МАССАЖ 7):', await cS({ name: ilike('массаж 7') }));
console.log('starts(Спа):', await cS({ name: starts('Спа') }), '| ends(0):', await cS({ name: ends('0') }));
console.log('вложенный фильтр (coordinates.lat ≥ 55.5):', await T('nested gte', db.Локация({ coordinates: { lat: gte(55.5) } }).count()));
console.log('услуг с ценой ≥ 2000 RUB (через класс цена):', await T('nested amounts', db.цена({ amounts: { RUB: gte(2000) } }).Услуга().count()));
// has/hasAny/hasAll: массивов в data новой схемы нет — операторы живут на колонке tags
console.log('tags has(vip):', await db.Клиент().tags(has('vip')).count());
console.log('tags hasAny([vip,net]):', await db.Клиент().tags(hasAny(['vip', 'net'])).count());
console.log('tags hasAll([vip]):', await db.Клиент().tags(hasAll(['vip'])).count());
console.log('exists(description):', await cS({ description: exists() }), '| isNull:', await cS({ description: isNull() }));
console.log('not(ilike(стриж%)):', await cS({ name: not(ilike('стриж%')) }));
console.log('or(Стрижка0 | duration<40):', await db.Услуга(or({ name: 'Стрижка 0' }, { duration: lt(40) })).count());

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 13. Аналитика на полигоне: агрегации, keyset, sort');
console.log('услуг всего (уникальных) →', await T('count() услуг', db.Услуга().count()));
console.log('sum(amounts.RUB) всех цен →', await T('sum', db.цена().sum('data.amounts.RUB')));
console.log('avg(duration) →', (await db.Услуга().avg('data.duration'))?.toFixed(1));
console.log('min/max(duration) →', await db.Услуга().min('data.duration'), '/', await db.Услуга().max('data.duration'));
const byDur = await T('countBy(duration)', db.Услуга().countBy('data.duration'));
J(byDur);
const бронейВсего = await T('count() записей', db.запись().count());
console.log('  →', бронейВсего);
const p1 = await T('keyset стр.1: цена sort(amounts.RUB).limit(3)', db.цена().sort('data.amounts.RUB').limit(3).rows());
J(p1.map((r) => ({ note: r.data.note, RUB: r.data.amounts.RUB })));
const cur = cursorOf(p1[p1.length - 1], 'data.amounts.RUB');
const p2 = await T('keyset стр.2: after(cursor)', db.цена().sort('data.amounts.RUB').after(cur).limit(3).rows());
J(p2.map((r) => ({ note: r.data.note, RUB: r.data.amounts.RUB })));

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 14. История: asOf + versions (машина времени по цене — вариант цены Бороды)');
const [цБорода] = await db.Услуга(борода).цена().rows();  // вариант «базовая» Бороды (800 из Акта 3)
const было = new Date().toISOString();
await new Promise((r) => setTimeout(r, 30));
await db.цена(цБорода.id).update({ amounts: { RUB: 1000 } }).rows();  // подорожание (record-merge)
console.log('цена сейчас →', (await db.цена(цБорода.id).first()).data.amounts.RUB);
console.log('цена asOf(до) →', (await db.цена(цБорода.id).asOf(было).first()).data.amounts.RUB);
const версии = await T('versions() цены Бороды', db.цена(цБорода.id).versions());
J(версии.map((v) => ({ RUB: v.data.amounts.RUB, updated: v.updated.slice(0, 19) })));

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 16. GDPR: anonymize (история цела)');
const [клиентГ] = await db.Организация(org).Клиент().create({ id: dm(111), name: 'Пётр Удаляев', phone: '+7 917 005' }).rows();
const [аноним] = await T('anonymize([name,phone])', db.Клиент(клиентГ.id).anonymize(['name', 'phone']).rows());
J(short(аноним));
console.log('первая версия хранит имя →', (await db.Клиент(клиентГ.id).versions())[0].data.name);

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 17. Вход: пароль/api-key/key-secret/TOTP/OTP/identity');
const acc = await db.accounts.set({ categories: ['Staff'], data: { name: 'Ольга (демо)' } });
await db.auth.setPassword({ account: acc.id, identifier: 'olga@salon.ru', password: 'Secr3t!' });
console.log('verifyPassword(верный) →', !!(await T('verifyPassword', db.auth.verifyPassword({ identifier: 'olga@salon.ru', password: 'Secr3t!' }))));
console.log('verifyPassword(неверный) →', await db.auth.verifyPassword({ identifier: 'olga@salon.ru', password: 'x' }));
const { key } = await db.auth.issueApiKey({ account: acc.id, name: 'касса' });
console.log('api-key выдан →', key.slice(0, 12) + '…  verify →', !!(await db.auth.verifyApiKey(key)));
const ks = await db.auth.issueKeySecret({ account: acc.id });
console.log('key-secret verify →', !!(await db.auth.verifyKeySecret(ks.key, ks.secret)));
const totp = await db.auth.enrollTotp({ account: acc.id, issuer: 'Пример' });
console.log('TOTP enrolled, enabled(до) →', await db.auth.totpEnabled(acc.id), '| verify(code) →', await db.auth.verifyTotp({ account: acc.id, code: totpCode(totp.secret) }), '| enabled(после) →', await db.auth.totpEnabled(acc.id));
const otp = await db.auth.issueOtp({ account: acc.id, identifier: '+7 900 111' });
console.log('OTP verify →', !!(await db.auth.verifyOtp({ identifier: '+7 900 111', code: otp.code })), '| повторно →', await db.auth.verifyOtp({ identifier: '+7 900 111', code: otp.code }));
await db.auth.link({ account: acc.id, category: 'TELEGRAM', identifier: '900900900' });
console.log('lookup(TELEGRAM) →', (await db.auth.lookup({ category: 'TELEGRAM', identifier: '900900900' }))?.account.id.slice(-4));

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 18. Сессии в Redis');
const sessions = db.auth.sessions(redis);
const token = await T('sessions.start', sessions.start(acc.id, { ttlSec: 3600, meta: { ip: '10.0.0.1' } }));
console.log('token →', token.slice(0, 12) + '…');
console.log('check →', JSON.stringify(await sessions.check(token)));
console.log('revoke →', await sessions.revoke(token), '| check после →', await sessions.check(token));
await sessions.start(acc.id); await sessions.start(acc.id);
console.log('revokeAll →', await sessions.revokeAll(acc.id));

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 19. ACL: ресурс-субъект, объект, правило, check/checkData');
await db.resources.set({ alias: 'salonStaff:ACCOUNT', category: 'ACCOUNT', pattern: { categories: '{Staff}' } });
await db.resources.set({ alias: 'salon.book:API', category: 'API', pattern: { endpoint: 'salon.book' } });
await db.resources.set({ alias: 'booking:READ', category: 'READ', pattern: { class: 'booking' } });
await db.rules.set({ account: 'salonStaff:ACCOUNT', resource: 'salon.book:API', permission: 'allow', weight: 50 });
await db.rules.set({ account: 'salonStaff:ACCOUNT', resource: 'booking:READ', permission: 'allow', weight: 50 });
console.log('acl.check(endpoint) →', JSON.stringify(await T('acl.check', db.acl.check(acc.id, 'salon.book'))));
console.log('acl.checkData(booking,READ) →', (await db.acl.checkData(acc.id, 'booking', 'READ')).allow);
await db.rules.delete('salonStaff:ACCOUNT', 'salon.book:API');
await db.resources.delete('salon.book:API'); await db.resources.delete('salonStaff:ACCOUNT'); await db.resources.delete('booking:READ');

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 20. Изоляция арендатора + наблюдаемость');
const tenant = await db.accounts.set({ categories: ['Client'] });
const isoDb = await connect({ dsn: DSN, schema: S, account: tenant.id, owner: tenant.id, enforceAccount: true });
const [своя] = await isoDb.Организация().create({ name: 'Частная' }).rows();
console.log('своя орг account==tenant →', своя.account === tenant.id, '| видит орг →', await isoDb.Организация().count(), '(только свою)');
await isoDb.close();
const события = [];
const obs = await connect({ dsn: DSN, schema: S, onQuery: (e) => события.push(e), slowMs: 0 });
await obs.Услуга().count();
await obs.close();
console.log('onQuery событие →', JSON.stringify(события[0]));

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 21. Гарды: валидация, пути, слоты, снесённый .link');
const g = async (label, fn) => { try { await fn(); console.log(label, '→ НЕ упало!'); } catch (e) { console.log(label, '→', e.message.split('\n')[0].slice(0, 70)); } };
const gs = (label, fn) => { try { fn(); console.log(label, '→ НЕ упало!'); } catch (e) { console.log(label, '→', e.message.slice(0, 70)); } };
await g('create невалидной услуги', () => db.Организация(org).Услуга().create({ name: 'X', duration: -1 }).rows());
await g('запись без предмета (union-конец)', () => db.Мастер(ольга).запись().create({ start_datetime: iso(16), end_datetime: iso(17) }).Локация.set(зал).Расписание.set(расп).rows());
await g('навык без услуги (v5 needs end)', () => db.Мастер(ольга).навык().create().rows());
await g('явный id у v5-класса', () => db.Услуга('11111111-1111-4111-8111-111111111111').create({ name: 'Y' }).rows());
gs('путь Локация→Клиент (no path)', () => db.Локация(зал).Клиент());
gs('LINK→LINK запись→навык', () => db.запись().навык());
gs('create с фильтром', () => db.Услуга({ name: 'X' }).create({}));
gs('снесённый set()', () => db.Услуга().set({ name: 'X' }));
gs('слот без операции', () => db.запись('x').Клиент.set('x'));
gs('слот .delete() → .unset()', () => db.запись('x').update().Клиент.delete());
gs('слот не-конец: запись.Папка', () => db.запись(бронId(ольгаId, 15)).update().Папка.set('x'));
gs('слот без владельца', () => db.Мастер.set('x'));
gs('снесённый .link()', () => db.Услуга().link('X', 'y'));
gs('execute() → run()', () => db.Услуга().execute());

console.log('\n\n✓ демо-прогон завершён');
await db.close();
redis.disconnect();
