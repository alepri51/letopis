/**
 * Воспроизводитель статьи SALON.md: снимает ЖИВЫЕ ответы всех API по тест-плану
 * (21 акт) на полигоне v1.salondemo (~1M строк). Чтения/агрегации — на полигоне
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
// v5-классы (Service/Complex/Slot/skill/shift/compo/busy) id не принимают — их считает Schema.
// Формула открыта → id демо-сущностей знаем заранее (для уборки и проверок):
const v5 = (cls, ...parts) => uuidv5(`${S}:entity:${cls}:${parts.join(':')}`);
const орг = dm(10), ольгаId = dm(11), иринаId = dm(12), распId = dm(70);
const свцId = (name) => v5('Service', орг, name);
const слотId = (h) => v5('Slot', распId, `2026-08-01T${String(h).padStart(2, '0')}:00:00+03:00`);
const комплексId = v5('Complex', орг, 'Образ');
const demoV5 = [
  свцId('Стрижка'), свцId('Укладка'), свцId('Борода'), свцId('Хит сезона'), свцId('Спец'),
  комплексId,
  v5('compo', комплексId, свцId('Стрижка')), v5('compo', комплексId, свцId('Укладка')),
  v5('skill', ольгаId, свцId('Стрижка')), v5('skill', ольгаId, свцId('Укладка')), v5('skill', ольгаId, комплексId),
  v5('skill', иринаId, свцId('Стрижка')), v5('skill', иринаId, свцId('Борода')),
  ...[10, 11, 12, 13, 14, 15, 16, 17].map(слотId),
  v5('shift', распId, ольгаId), v5('shift', распId, иринаId),
  v5('busy', слотId(17), иринаId), v5('busy', слотId(10), ольгаId),
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

const b = db.batch('setup');
b.Организация(org).Сотрудник().create({ id: dm(11), name: 'Ольга', roles: ['owner', 'master'] });
b.Организация(org).Сотрудник().create({ id: dm(12), name: 'Ирина', roles: ['master'] });
console.log('batch.size() →', b.size());
const setup = await T('batch.run()  (multi-VALUES склейка)', b.run());
J(shorts(setup.map((g) => g[0])));
const [ольга, ирина] = [setup[0][0], setup[1][0]];

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 2. up(): вход одной функцией на живой БД');
const dbUp = await T("up({schema:'salondemo', version:1})", up({ dsn: DSN, schema: 'salondemo', version: 1, quiet: true }));
console.log('орг в схеме →', await dbUp.Организация().count());
await dbUp.close();

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 3. Каталог: папки-дерево, услуги, комплекс + состав слотом');
const [корень] = await db.Организация(org).Папка().create({ id: dm(20), name: 'Каталог' }).rows();
const [волосы] = await db.Организация(org).Папка(корень).Папка().create({ id: dm(21), name: 'Волосы' }).rows();
const [стрижка] = await T('услуга в папке (Org→Папка→Услуга)',
  db.Организация(org).Папка(волосы).Услуга().create({ name: 'Стрижка', duration: 60, price: { RUB: 1500 } }).rows());
J(short(стрижка));
console.log('id услуги посчитала Schema: uuidv5(Org, name) →', стрижка.id === свцId('Стрижка'));
const [укладка] = await db.Организация(org).Папка(волосы).Услуга().create({ name: 'Укладка', duration: 30, price: { RUB: 900 } }).rows();
const [борода] = await db.Организация(org).Услуга().create({ name: 'Борода', duration: 30, price: { RUB: 800 }, description: 'моделирование' }).rows();
const [набор] = await db.Организация(org).Комплекс().create({ name: 'Образ', duration: 90, discount: 10 }).rows();
await T('состав слотом: Комплекс(k).состав().create().Услуга.set(u)',
  db.Комплекс(набор).состав().create({ qty: 1 }).Услуга.set(стрижка).rows());
await db.Комплекс(набор).состав().create({ qty: 1 }).Услуга.set(укладка).rows();
const состав = await T('чтение состава: Комплекс→состав→Услуга', db.Комплекс(набор).состав().Услуга().rows());
J(состав.map((r) => r.data.name));
const ветка = await T('deep(): вся ветка папок', db.Организация(org).Папка(корень).Папка().deep().rows());
J(ветка.map((f) => f.data.name));

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 4. Навыки мастеров: слоты, союз-конец, pivot-проверка умения');
await db.Сотрудник(ольга).навык().create().Услуга.set(стрижка).rows();
await db.Сотрудник(ольга).навык().create().Услуга.set(укладка).rows();
await db.Сотрудник(ольга).навык().create().Комплекс.set(набор).rows();
await db.Сотрудник(ирина).навык().create().Услуга.set(стрижка).rows();
await db.Сотрудник(ирина).навык().create().Услуга.set(борода).rows();
const уменияО = await T('умения Ольги: Сотрудник→навык→Услуга', db.Сотрудник(ольга).навык().Услуга().rows());
J(уменияО.map((r) => r.data.name));
console.log('Ольга умеет комплексов →', await db.Сотрудник(ольга).навык().Комплекс().count());
const умеет = await T('умеет ли Ирина бороду: навык→Услуга(борода)',
  db.Сотрудник(ирина).навык().Услуга(борода).count());
console.log('  →', умеет, '(1 = умеет)');
console.log('умеет ли Ирина укладку →', await db.Сотрудник(ирина).навык().Услуга(укладка).count());

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 5. Расписание: окна батчем, ростер сменами, off-окно');
const [расп] = await db.Организация(org).Расписание().create({ id: dm(70), start: '2026-08-01T10:00:00+03:00', end: '2026-08-01T18:00:00+03:00' }).rows();
const wb = db.batch('окна');
const iso = (h) => `2026-08-01T${String(h).padStart(2, '0')}:00:00+03:00`;
for (let h = 10; h < 18; h++) wb.Расписание(расп).Окно().create({ start: iso(h), end: iso(h + 1) });
const окна = (await T('8 окон дня батчем', wb.run())).map((g) => g[0]);
console.log('создано окон →', окна.length, '| id окна = uuidv5(Schedule, start) →', окна[0].id === слотId(10));
const w = (h) => окна[h - 10];
await db.Расписание(расп).смена().create().Сотрудник.set(ольга).rows();
await db.Расписание(расп).смена().create().Сотрудник.set(ирина).rows();
const ростер = await T('ростер дня: Расписание→смена→Сотрудник', db.Расписание(расп).смена().Сотрудник().rows());
J(ростер.map((r) => r.data.name));
await db.Сотрудник(ирина).занятость().create({ kind: 'off', reason: 'учёба' }).Окно.set(w(17)).rows();

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 6. Бронь №1: транзакция + lock, позиция+занятость слотами');
const [аня] = await db.Организация(org).Клиент().create({ id: dm(110), name: 'Аня', contact: '+7 911 001' }).rows();
const зАни = await T('транзакция брони (begin/lock/commit)', (async () => {
  const tr = await db.begin();
  try {
    await tr.lock('busy', ольга.id, w(10).id);
    const [зап] = await tr.Клиент(аня).Запись().create({ id: dm(120), status: 'created', source: 'online', total: { RUB: 1500 } }).rows();
    await tr.Запись(зап).позиция().create({ id: dm(130), qty: 1, price: { RUB: 1500 } }).Услуга.set(стрижка).Сотрудник.set(ольга).rows();
    await tr.Сотрудник(ольга).занятость().create({ kind: 'booking' }).Окно.set(w(10)).Запись.set(зап).rows(); // id = v5(окно, мастер)
    await tr.commit();
    return зап;
  } catch (e) { await tr.rollback(); throw e; }
})());
J(short(зАни));
const [поз1] = await db.Запись(зАни).позиция().rows();
console.log('позиция брони links →', JSON.stringify(поз1.links));

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 8. Комбо-запись: две услуги у двух мастеров (мульти-мастер)');
const [зКомбо] = await db.Клиент(аня).Запись().create({ id: dm(121), status: 'created', total: { RUB: 2300 } }).rows();
await db.Запись(зКомбо).позиция().create({ id: dm(131), qty: 1, price: { RUB: 1500 } }).Услуга.set(стрижка).Сотрудник.set(ольга).rows();
await db.Запись(зКомбо).позиция().create({ id: dm(132), qty: 1, price: { RUB: 800 } }).Услуга.set(борода).Сотрудник.set(ирина).rows();
console.log('позиций в комбо-записи →', await db.Запись(зКомбо).позиция().count());
const мастераКомбо = await T('кто занят: Запись→позиция→Сотрудник', db.Запись(зКомбо).позиция().Сотрудник().rows());
J(мастераКомбо.map((r) => r.data.name));

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 9. Перевес мастера (pivot+слот), союз-замена, снятие');
const перевес = await T('pivot-перевес: позиции Ольги в комбо → Ирине (update + слот)',
  db.Запись(зКомбо).позиция().Сотрудник(ольга).позиция().update().Сотрудник.set(ирина).rows());
J(shorts(перевес));
console.log('версий позиции →', (await db.позиция(перевес[0].id).versions()).length);
const [зам] = await T('союз-замена: предмет Стрижка → Комплекс (конец один)',
  db.позиция(поз1.id).update().Комплекс.set(набор).rows());
console.log('links после замены →', JSON.stringify(зам.links), '(Service снят)');
await db.позиция(поз1.id).update().Услуга.set(стрижка).rows(); // вернуть
const [снято] = await T('снятие optional-конца: занятость.Запись.unset()',
  db.занятость(v5('busy', слотId(10), ольгаId)).update({ kind: 'hold' }).Запись.unset().rows());
console.log('links после снятия →', JSON.stringify(снято.links));

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 10. Отмена: превью каскада delete, затем tombstone');
const превью = await T('delete() без confirm — ПРЕВЬЮ (БД не тронута)', db.Запись(зКомбо).delete().rows());
J(превью.map((r) => ({ class: r.class, $deleted: r.$deleted })));
const удалено = await T('delete({confirm:true}) — каскадный tombstone', db.Запись(зКомбо).delete({ confirm: true }).rows());
console.log('удалено строк →', удалено.length, '| запись жива? →', await db.Запись(зКомбо).count());

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 11. entity(): узел-переменная и старт с Row');
const [позАни] = await db.Запись(зАни).позиция().rows();
const услугаПоз = await T('db.entity(row).Услуга()', db.entity(позАни).Услуга().first());
console.log('  →', услугаПоз?.data.name);

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 12. 18 операторов фильтра — НА ПОЛИГОНЕ (1M строк)');
const cS = (f) => db.Услуга(f).count();
console.log('ne(60):', await T('ne', cS({ duration: ne(60) })));
console.log('gt(45):', await cS({ duration: gt(45) }), '| gte(45):', await cS({ duration: gte(45) }));
console.log('lt(45):', await cS({ duration: lt(45) }), '| lte(45):', await cS({ duration: lte(45) }));
console.log('between(30,45):', await cS({ duration: between(30, 45) }));
console.log('inList([Стрижка0,Укладка0]):', await cS({ name: inList(['Стрижка 0', 'Укладка 2']) }));
console.log('like(Массаж%):', await cS({ name: like('Массаж%') }));
console.log('ilike(МАССАЖ 7):', await cS({ name: ilike('массаж 7') }));
console.log('starts(Спа):', await cS({ name: starts('Спа') }), '| ends(0):', await cS({ name: ends('0') }));
console.log('has(owner) у Staff:', await db.Сотрудник({ roles: has('owner') }).count());
console.log('hasAny([owner,administrator]):', await db.Сотрудник({ roles: hasAny(['owner', 'administrator']) }).count());
console.log('hasAll([owner,master]):', await db.Сотрудник({ roles: hasAll(['owner', 'master']) }).count());
console.log('exists(description):', await cS({ description: exists() }), '| isNull:', await cS({ description: isNull() }));
console.log('not(ilike(стриж%)):', await cS({ name: not(ilike('стриж%')) }));
console.log('or(Стрижка0 | duration<40):', await db.Услуга(or({ name: 'Стрижка 0' }, { duration: lt(40) })).count());

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 13. Аналитика на полигоне: агрегации, keyset, sort');
console.log('услуг всего (уникальных) →', await T('count() услуг', db.Услуга().count()));
console.log('sum(price.RUB) всех услуг →', await T('sum', db.Услуга().sum('data.price.RUB')));
console.log('avg(duration) →', (await db.Услуга().avg('data.duration'))?.toFixed(1));
console.log('min/max(duration) →', await db.Услуга().min('data.duration'), '/', await db.Услуга().max('data.duration'));
const byDur = await T('countBy(duration)', db.Услуга().countBy('data.duration'));
J(byDur);
const бронейВсего = await T('count() Записей (пути)', db.Запись().count());
console.log('  →', бронейВсего);
const p1 = await T('keyset стр.1: sort(price).limit(3)', db.Услуга().sort('data.price.RUB').limit(3).rows());
J(p1.map((r) => ({ name: r.data.name, RUB: r.data.price.RUB })));
const cur = cursorOf(p1[p1.length - 1], 'data.price.RUB');
const p2 = await T('keyset стр.2: after(cursor)', db.Услуга().sort('data.price.RUB').after(cur).limit(3).rows());
J(p2.map((r) => ({ name: r.data.name, RUB: r.data.price.RUB })));

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 14. История: asOf + versions (машина времени по цене)');
const было = new Date().toISOString();
await new Promise((r) => setTimeout(r, 10));
await db.Услуга(борода).update({ price: { RUB: 1000 } }).rows();
console.log('цена сейчас →', (await db.Услуга(борода).first()).data.price.RUB);
console.log('цена asOf(до) →', (await db.Услуга(борода).asOf(было).first()).data.price.RUB);
const версии = await T('versions() Бороды', db.Услуга(борода).versions());
J(версии.map((v) => ({ RUB: v.data.price.RUB, updated: v.updated.slice(0, 19) })));

// ────────────────────────────────────────────────────────────────────────────
H('АКТ 16. GDPR: anonymize (история цела)');
const [клиентГ] = await db.Организация(org).Клиент().create({ id: dm(111), name: 'Пётр Удаляев', contact: 'secret@mail' }).rows();
const [аноним] = await T('anonymize([name,contact])', db.Клиент(клиентГ.id).anonymize(['name', 'contact']).rows());
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
await db.resources.set({ alias: 'booking:READ', category: 'READ', pattern: { class: 'Booking' } });
await db.rules.set({ account: 'salonStaff:ACCOUNT', resource: 'salon.book:API', permission: 'allow', weight: 50 });
await db.rules.set({ account: 'salonStaff:ACCOUNT', resource: 'booking:READ', permission: 'allow', weight: 50 });
console.log('acl.check(endpoint) →', JSON.stringify(await T('acl.check', db.acl.check(acc.id, 'salon.book'))));
console.log('acl.checkData(Booking,READ) →', (await db.acl.checkData(acc.id, 'Booking', 'READ')).allow);
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
await g('create невалидной услуги', () => db.Организация(org).Услуга().create({ name: 'X', duration: -1, price: { RUB: 1 } }).rows());
gs('путь Запись→Сотрудник', () => db.Запись(зАни).Сотрудник());
gs('LINK→LINK позиция→навык', () => db.позиция().навык());
gs('create с фильтром', () => db.Услуга({ name: 'X' }).create({}));
gs('снесённый set()', () => db.Услуга().set({ name: 'X' }));
gs('слот без операции', () => db.занятость('x').Запись.set('x'));
gs('слот .delete() → .unset()', () => db.занятость('x').update().Запись.delete());
gs('слот не-конец Запись.Сотрудник', () => db.Запись(зАни).update().Сотрудник.set('x'));
gs('слот без владельца', () => db.Сотрудник.set('x'));
gs('снесённый .link()', () => db.Услуга().link('X', 'y'));
gs('execute() → run()', () => db.Услуга().execute());

console.log('\n\n✓ демо-прогон завершён');
await db.close();
redis.disconnect();
