/**
 * Сквозной тест ВСЕХ публичных методов API (чек-лист из 15 групп).
 * Одна PG-схема booking, общий сид в before; каждая группа — свой test().
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect, cursorOf,
  ne, gt, gte, lt, lte, between, inList, like, ilike, starts, ends,
  has, hasAny, hasAll, exists, isNull, not, or,
} from '../src/index.js';
import type { QueryEvent, Row } from '../src/types.js';
import type { EntityDb } from '../src/chain.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const SYS = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';

let db: EntityDb;
const S: Record<string, Row> = {}; // общий сид

before(async () => {
  db = await connect({ dsn: DSN, schema: 'v1.booking', max: 4 });
  await db.sql.unsafe('TRUNCATE "v1.booking"."Entity"');

  const [org] = await db.Организация().set({ name: 'API-салон', phone: '+7-900-000-00-00' }).rows();
  const [vasya] = await db.Организация(org).Сотрудник().set({ name: 'Вася', roles: ['owner', 'master'] }).rows();
  const [petya] = await db.Организация(org).Сотрудник().set({ name: 'Петя' }).rows();
  const [root] = await db.Организация(org).Папка().set({ name: 'Каталог' }).rows();
  const [nails] = await db.Организация(org).Папка(root).Папка().set({ name: 'Ногти' }).rows();
  const [spa] = await db.Организация(org).Папка(nails).Папка().set({ name: 'Спа' }).rows();
  const [manik] = await db.Организация(org).Папка(nails).Услуга().set({ name: 'Маникюр', duration: 60, price: { RUB: 2000 } }).rows();
  const [strizh] = await db.Организация(org).Услуга().set({ name: 'Стрижка', duration: 30, price: { RUB: 1500 }, description: 'классика' }).rows();
  const [cli] = await db.Организация(org).Клиент().set({ name: 'Анна', contact: '+7-911-111-11-11' }).rows();
  const [sched] = await db.Организация(org).Расписание().set({ start: '2026-07-01T00:00:00Z', end: '2026-07-31T23:59:59Z' }).rows();
  const [slot1] = await db.Расписание(sched).Окно().set({ start: '2026-07-15T10:00:00Z', end: '2026-07-15T11:00:00Z' }).rows();
  const [slot2] = await db.Расписание(sched).Окно().set({ start: '2026-07-15T11:00:00Z', end: '2026-07-15T12:00:00Z' }).rows();
  const [booking] = await db.Клиент(cli).Запись().set({ status: 'confirmed', total: { RUB: 2000 } }).rows();
  const [skill] = await db.Сотрудник(vasya).навык().set({}).Услуга.set(manik).rows();
  const [shift] = await db.Расписание(sched).смена().set({}).Сотрудник.set(vasya).rows();
  const [busy] = await db.Сотрудник(vasya).занятость().set({ kind: 'booking' }).Окно.set(slot1).Запись.set(booking).rows();
  const [item] = await db.Запись(booking).позиция().set({ qty: 1, price: { RUB: 2000 } }).Услуга.set(manik).rows();

  Object.assign(S, { org, vasya, petya, root, nails, spa, manik, strizh, cli, sched, slot1, slot2, booking, skill, shift, busy, item });
});
after(async () => db.close());

// ---------------------------------------------------------------------------

test('✔ connect: schema/partition/account/owner/max, System-fallback, неизвестный класс', async () => {
  // System-fallback: без account в connect строки получают System-аккаунт
  assert.equal(S.org.account, SYS);
  assert.equal(S.org.owner, SYS);

  // account/owner из connect
  const acc = await db.accounts.set({ categories: ['Client'] });
  const scoped = await connect({ dsn: DSN, schema: 'v1.booking', account: acc.id, owner: acc.id, max: 2 });
  const [mine] = await scoped.Организация().set({ name: 'Своя орга' }).rows();
  assert.equal(mine.account, acc.id);
  assert.equal(mine.owner, acc.id);
  await scoped.close();
  await db.Организация(mine.id).delete({ confirm: true }).rows();

  // partition: классов для чужой партиции нет → понятная ошибка
  await assert.rejects(connect({ dsn: DSN, schema: 'v1.booking', partition: 'нет-такой' }), /no classes for partition/);

  // неизвестный класс — ошибка со списком известных (id·alias)
  assert.throws(() => (db as unknown as Record<string, () => void>).Чебурашка(), /unknown class "Чебурашка".*Staff·Сотрудник/);
});

test('✔ формы Filter: без аргумента, {}, id, Row, массив id, объект полей', async () => {
  const services = await db.Услуга().rows();          // без аргумента — все
  assert.equal(services.length, 2);
  assert.equal(await db.Услуга({}).count(), 2);        // {} в чтении — тоже все

  const byId = await db.Услуга(S.manik.id).first();    // id-строка
  assert.equal(byId?.data.name, 'Маникюр');
  const byRow = await db.Услуга(S.manik).first();      // Row-объект → его id
  assert.equal(byRow?.id, S.manik.id);

  const byIds = await db.Услуга([S.manik.id, S.strizh.id]).rows();  // массив id
  assert.equal(byIds.length, 2);
  assert.equal(await db.Услуга([]).count(), 0);        // пустой массив — пусто

  // объект полей: скаляр (eq), ключ id, record-путь, скаляр+оператор вместе
  assert.equal(await db.Услуга({ name: 'Маникюр' }).count(), 1);
  assert.equal(await db.Услуга({ id: S.manik.id, name: 'Маникюр' }).count(), 1);
  assert.equal(await db.Услуга({ price: { RUB: 2000 } }).count(), 1);
  assert.equal(await db.Услуга({ name: 'Маникюр', duration: gte(60) }).count(), 1);
});

test('✔ 18 операторов фильтра', async () => {
  const c = (f: Parameters<typeof db.Услуга>[0]) => db.Услуга(f).count();
  assert.equal(await c({ name: ne('Маникюр') }), 1);                       // ne
  assert.equal(await c({ duration: gt(30) }), 1);                          // gt
  assert.equal(await c({ duration: gte(30) }), 2);                         // gte
  assert.equal(await c({ duration: lt(60) }), 1);                          // lt
  assert.equal(await c({ duration: lte(30) }), 1);                         // lte
  assert.equal(await c({ duration: between(25, 45) }), 1);                 // between
  assert.equal(await c({ name: inList(['Маникюр', 'Стрижка']) }), 2);      // inList
  assert.equal(await c({ name: inList([]) }), 0);                          // inList пустой → FALSE
  assert.equal(await c({ name: like('Ма%') }), 1);                         // like
  assert.equal(await c({ name: ilike('мАнИкюр') }), 1);                    // ilike
  assert.equal(await c({ name: starts('Стри') }), 1);                      // starts
  assert.equal(await c({ name: ends('жка') }), 1);                         // ends
  const s = (f: Parameters<typeof db.Сотрудник>[0]) => db.Сотрудник(f).count();
  assert.equal(await s({ roles: has('owner') }), 1);                       // has
  assert.equal(await s({ roles: hasAny(['owner', 'admin']) }), 1);         // hasAny
  assert.equal(await s({ roles: hasAll(['owner', 'master']) }), 1);        // hasAll
  assert.equal(await c({ description: exists() }), 1);                     // exists(true)
  assert.equal(await c({ description: exists(false) }), 1);                // exists(false)
  assert.equal(await c({ description: isNull() }), 1);                     // isNull (нет поля)
  assert.equal(await c({ name: not(ilike('ма%')) }), 1);                   // not(op)
  assert.equal(await c({ name: not('Маникюр') }), 1);                      // not(скаляр) = ne
  assert.equal(await db.Услуга(or({ name: 'Маникюр' }, { duration: lt(40) })).count(), 2); // or
});

test('✔ модификаторы: limit/offset/sort/asOf/after/alias/tags/account/owner/deep', async () => {
  // sort по data-полю + limit/offset
  const asc = await db.Услуга().sort('data.duration').rows();
  assert.deepEqual(asc.map((r) => r.data.duration), [30, 60]);
  const desc = await db.Услуга().sort('data.duration', 'desc').rows();
  assert.deepEqual(desc.map((r) => r.data.duration), [60, 30]);
  assert.equal((await db.Услуга().sort('updated').limit(1).rows()).length, 1);
  assert.equal((await db.Услуга().sort('updated').offset(1).rows()).length, 1);

  // asOf: до правки цена старая; count тоже видит asOf
  const t0 = S.manik.updated;
  await db.Услуга(S.manik.id).set({ price: { RUB: 2500 } }).rows();
  const old = await db.Услуга(S.manik.id).asOf(t0).first();
  assert.equal((old?.data.price as { RUB: number }).RUB, 2000);
  const [orgNew] = await db.Организация().set({ name: 'Позже' }).rows();
  assert.equal(await db.Организация().asOf(t0).count(), 1);
  await db.Организация(orgNew.id).delete({ confirm: true }).rows();

  // after + cursorOf: keyset-страницы по updated и по data-полю; без sort — ошибка
  const page1 = await db.Услуга().sort('updated').limit(1).rows();
  const page2 = await db.Услуга().sort('updated').after(cursorOf(page1[0])).rows();
  assert.equal(page2.length, 1);
  assert.notEqual(page2[0].id, page1[0].id);
  const byDur = await db.Услуга().sort('data.duration').limit(1).rows();
  const next = await db.Услуга().sort('data.duration').after(cursorOf(byDur[0], 'data.duration')).rows();
  assert.deepEqual([byDur[0].data.duration, next[0]?.data.duration], [30, 60]);
  await assert.rejects(db.Услуга().after({ v: 1, id: 'x' }).rows(), /requires .sort/);

  // alias: ключ шага в путях
  const paths = await db.Организация(S.org).alias('салон').Услуга(S.manik.id).alias('услуга').run();
  assert.deepEqual(Object.keys(paths[0]).sort(), ['салон', 'услуга']);

  // tags: значение при записи, фильтр строкой/массивом/hasAny при чтении
  const [tagged] = await db.Организация(S.org).Клиент().tags(['vip', 'net']).set({ name: 'Тэгги' }).rows();
  assert.deepEqual(tagged.tags, ['vip', 'net']);
  assert.equal(await db.Клиент().tags('vip').count(), 1);
  assert.equal(await db.Клиент().tags(['vip', 'net']).count(), 1);
  assert.equal(await db.Клиент().tags(hasAny(['vip', 'нет'])).count(), 1);
  await db.Клиент(tagged.id).delete({ confirm: true }).rows();

  // account/owner как фильтры колонок
  assert.equal(await db.Услуга().account(SYS).count(), 2);
  assert.equal(await db.Услуга().owner({ id: SYS }).count(), 2);
  assert.equal(await db.Услуга().account('00000000-0000-4000-8000-00000000dead').count(), 0);

  // sort по вложенному record-пути + keyset-курсор по нему (каст по типу листа)
  const поЦене = await db.Услуга().sort('data.price.RUB', 'desc').rows();
  assert.deepEqual(поЦене.map((r) => (r.data.price as { RUB: number }).RUB), [2500, 1500]);
  const дороже = await db.Услуга().sort('data.price.RUB').after(cursorOf(поЦене[1], 'data.price.RUB')).rows();
  assert.deepEqual(дороже.map((r) => (r.data.price as { RUB: number }).RUB), [2500]);

  // deep: default и max, ошибка на не-self
  const all = await db.Папка(S.root.id).Папка().deep().rows();
  assert.deepEqual(all.map((r) => [r.data.name, r.$depth]).sort(), [['Ногти', 1], ['Спа', 2]]);
  assert.equal((await db.Папка(S.root.id).Папка().deep(1).rows()).length, 1);
  await assert.rejects(db.Организация(S.org).Папка().deep().rows(), /self hop/);
});

test('✔ терминалы: run/rows/first/ids/count/versions/sum/avg/min/max/countBy', async () => {
  // run: узлы всех шагов; дубликат имени шага → _2
  const paths = await db.Папка(S.root.id).Папка().run();
  assert.deepEqual(Object.keys(paths[0]).sort(), ['Папка', 'Папка_2']);
  assert.equal(paths[0].Папка.id, S.root.id);

  assert.equal((await db.Сотрудник().rows()).length, 2);
  assert.equal((await db.Сотрудник({ name: 'Вася' }).first())?.id, S.vasya.id);
  assert.equal(await db.Сотрудник({ name: 'Нет такого' }).first(), null);
  assert.deepEqual((await db.Сотрудник().ids()).sort(), [S.vasya.id, S.petya.id].sort());
  assert.equal(await db.Сотрудник().count(), 2);

  // versions: вся история + $deleted у tombstone
  const [tmp] = await db.Организация(S.org).Клиент().set({ name: 'Версионный' }).rows();
  await db.Клиент(tmp.id).set({ language: 'en' }).rows();
  await db.Клиент(tmp.id).delete({ confirm: true }).rows();
  const hist = await db.Клиент(tmp.id).versions();
  assert.equal(hist.length, 3);
  assert.equal(hist.at(-1)?.$deleted, true);
  assert.equal(hist[0].$deleted, undefined);

  // агрегации + null/{} на пустом множестве
  assert.equal(await db.Услуга().sum('data.duration'), 90);
  assert.equal(await db.Услуга().avg('data.duration'), 45);
  assert.equal(await db.Услуга().min('data.duration'), 30);          // number-поле → number (не строка)
  assert.equal(await db.Услуга().max('data.duration'), 60);
  assert.equal(await db.Услуга().min('data.price.RUB'), 1500);       // record-лист number → number
  assert.equal(await db.Услуга().max('data.price.RUB'), 2500);
  assert.deepEqual(await db.Услуга().countBy('data.name'), { Маникюр: 1, Стрижка: 1 });
  assert.equal(await db.Услуга({ name: 'Пусто' }).sum('data.duration'), null);
  assert.deepEqual(await db.Услуга({ name: 'Пусто' }).countBy('data.name'), {});
});

test('✔ обходы: HUB→LINK, LINK→HUB (+необъявленный ключ), HUB→HUB fwd/rev, self, ошибки', async () => {
  // HUB→LINK (reverse containment)
  assert.equal((await db.Сотрудник(S.vasya.id).навык().rows())[0].id, S.skill.id);
  // LINK→HUB forward по объявленному концу
  assert.equal((await db.Сотрудник(S.vasya.id).навык().Услуга().rows())[0].id, S.manik.id);
  // LINK→HUB по НЕобъявленному ключу: у занятости конец 'Booking' не в Schema.links, но лежит в links строки
  assert.equal((await db.занятость({ kind: 'booking' }).Запись().rows())[0].id, S.booking.id);
  // HUB→HUB forward (Услуга.links ⊃ Org) и reverse (Организация → Услуги)
  assert.equal((await db.Услуга(S.manik.id).Организация().rows())[0].id, S.org.id);
  assert.equal(await db.Организация(S.org.id).Услуга().count(), 2);
  // self-hop = дети
  assert.deepEqual((await db.Папка(S.nails.id).Папка().rows()).map((r) => r.data.name), ['Спа']);
  // нет пути / LINK→LINK — ошибка синхронно при построении цепочки (0.15.0)
  assert.throws(() => db.Услуга(S.manik.id).Клиент(), /no path/);
  assert.throws(() => db.Сотрудник(S.vasya.id).навык().занятость(), /LINK → LINK/);
});

test('✔ set: INSERT/UPSERT/UPDATE, deep-merge, связи путь+слоты, повторный терминал, валидация, LINK-концы', async () => {
  // чистый INSERT: Класс() без аргумента
  const [ins] = await db.Организация(S.org).Клиент().set({ name: 'Новый' }).rows();
  assert.ok(ins.id);
  assert.equal(ins.links.Org, S.org.id);

  // upsert по фильтр-id (нет → создать) и по data.id
  const idA = '00000000-0000-4000-8000-0000000000aa';
  const [upA] = await db.Организация(S.org).Клиент(idA).set({ name: 'По фильтр-id' }).rows();
  assert.equal(upA.id, idA);
  const [upA2] = await db.Клиент(idA).set({ language: 'en' }).rows();          // есть → новая версия
  assert.deepEqual([upA2.data.name, upA2.data.language], ['По фильтр-id', 'en']);
  const idB = '00000000-0000-4000-8000-0000000000bb';
  const [upB] = await db.Организация(S.org).Клиент().set({ id: idB, name: 'По data.id' }).rows();
  assert.equal(upB.id, idB);

  // UPDATE по объект-фильтру: deep-merge меняет ТОЛЬКО указанные листья record-поля
  await db.Услуга(S.manik.id).set({ price: { USD: 25 } }).rows();
  const merged = await db.Услуга(S.manik.id).first();
  assert.deepEqual(merged?.data.price, { RUB: 2500, USD: 25 });         // RUB остался (2500 из группы модификаторов)

  // UPDATE {} — все в контексте; [] без совпадений на непустом фильтре
  const off = await db.Организация(S.org).Услуга({}).set({ active: false }).rows();
  assert.equal(off.length, 2);
  assert.ok(off.every((r) => r.data.active === false));
  assert.deepEqual(await db.Услуга({ name: 'Нет такой' }).set({ active: true }).rows(), []);

  // 2 формы связей: владелец из пути + конец слотом / без пути — все концы слотами (.Класс.set())
  const [viaCtx] = await db.Сотрудник(S.petya).навык().set({}).Услуга.set(S.strizh).rows();
  assert.deepEqual([viaCtx.links.Staff, viaCtx.links.Service], [S.petya.id, S.strizh.id]);
  const [viaLink] = await db.занятость().set({ kind: 'off' }).Сотрудник.set(S.petya).Окно.set(S.slot2).rows();
  assert.deepEqual([viaLink.links.Staff, viaLink.links.Slot], [S.petya.id, S.slot2.id]);

  // цепочка переиспользуема: каждый терминал исполняет план ЗАНОВО (INSERT-форма — новая
  // сущность на каждый вызов); модификатор шага сразу после set() — ошибка
  const sc = db.Организация(S.org).Клиент().set({ name: 'Кешик' });
  const r1 = await sc.rows();
  const r2 = await sc.rows();
  assert.notEqual(r1[0].id, r2[0].id);
  assert.equal(await db.Клиент({ name: 'Кешик' }).count(), 2);
  assert.throws(() => sc.alias('x'), /step modifier after set/);

  // строгая валидация: неверный тип и лишнее поле; abstract-класс — ошибки на терминале
  await assert.rejects(db.Организация(S.org).Услуга().set({ name: 'Х', duration: 'час' as never }).rows(), /validation failed/);
  await assert.rejects(db.Организация(S.org).Услуга().set({ name: 'Х', duration: 5, лишнее: 1 }).rows(), /validation failed/);
  await assert.rejects(db.Сущность().set({}).rows(), /abstract/);

  // LINK-концы v2: обязательный и союз
  await assert.rejects(db.Сотрудник(S.vasya).занятость().set({ kind: 'off' }).rows(), /requires end "Slot"/);
  await assert.rejects(db.Сотрудник(S.vasya).навык().set({}).rows(), /requires end "Service\|Complex"/);

  // прибираем
  for (const r of [ins, upA, upB]) await db.Клиент(r.id).delete({ confirm: true }).rows();
  await db.Клиент({ name: 'Кешик' }).delete({ confirm: true }).rows();
  await db.занятость({ kind: 'off' }).delete({ confirm: true }).rows();
  await db.Сотрудник(S.petya.id).навык().delete({ confirm: true }).rows();
  await db.Организация(S.org).Услуга({}).set({ active: true }).rows();
});

test('✔ delete: по id/фильтру/контексту, $deleted, каскад, повторный, воскрешение', async () => {
  const [c1] = await db.Организация(S.org).Клиент().set({ name: 'Удаляемый' }).rows();
  const [b1] = await db.Клиент(c1).Запись().set({ status: 'created' }).rows();

  // по id (confirm: true — реальное удаление): цели + каскад (Запись ссылается на Клиента) — все с $deleted
  const gone = await db.Клиент(c1.id).delete({ confirm: true }).rows();
  assert.deepEqual(gone.map((r) => r.class).sort(), ['Booking', 'Customer']);
  assert.ok(gone.every((r) => r.$deleted === true));
  assert.equal(await db.Запись(b1.id).count(), 0);              // каскад реально затомбстоунил

  // повторный — no-op
  assert.deepEqual(await db.Клиент(c1.id).delete({ confirm: true }).rows(), []);

  // воскрешение set-ом по id
  const [alive] = await db.Организация(S.org).Клиент(c1.id).set({ name: 'Воскрес' }).rows();
  assert.equal(alive.id, c1.id);
  assert.equal(await db.Клиент(c1.id).count(), 1);

  // по фильтру и в контексте (границы контекста уважаются)
  const [c2] = await db.Организация(S.org).Клиент().set({ name: 'Фильтровый' }).rows();
  assert.equal((await db.Клиент({ name: 'Фильтровый' }).delete({ confirm: true }).rows()).length, 1);
  const delInCtx = await db.Организация(S.org).Клиент({ name: 'Воскрес' }).delete({ confirm: true }).rows();
  assert.equal(delInCtx.length, 1);
  void c2;
});

test('✔ anonymize: string-поля затёрты, тег, история цела, не-string — ошибка', async () => {
  const [p] = await db.Организация(S.org).Клиент().set({ name: 'Персона', language: 'ru' }).rows();
  const [anon] = await db.Клиент(p.id).anonymize(['name']).rows();
  assert.equal(anon.data.name, '[erased]');
  assert.equal(anon.data.language, 'ru');                        // не тронуто
  assert.ok(anon.tags.includes('anonymized'));
  const hist = await db.Клиент(p.id).versions();
  assert.equal(hist.length, 2);
  assert.equal(hist[0].data.name, 'Персона');                    // история священна
  await assert.rejects(db.Клиент(p.id).anonymize(['active' as never]).rows(), /string fields only/);
  await db.Клиент(p.id).delete({ confirm: true }).rows();
});

test('✔ tx: begin/commit/rollback (обе формы), повторный no-op, lock', async () => {
  // commit через db.commit(tr)
  const tr1 = await db.begin();
  const [a] = await tr1.Организация(S.org).Клиент().set({ name: 'В-транзакции' }).rows();
  assert.equal(await db.Клиент(a.id).count(), 0);                // снаружи не видно до commit
  await db.commit(tr1);
  assert.equal(await db.Клиент(a.id).count(), 1);

  // rollback через tr.rollback(); повторный rollback/commit — no-op
  const tr2 = await db.begin();
  await tr2.Клиент(a.id).set({ name: 'Откачусь' }).rows();
  await tr2.rollback();
  await tr2.rollback();
  await tr2.commit();
  assert.equal((await db.Клиент(a.id).first())?.data.name, 'В-транзакции');

  // lock: вне транзакции — ошибка; в транзакции держит соперника до commit
  await assert.rejects(db.lock('ключ'), /only inside/);
  const holder = await db.begin();
  await holder.lock('slot', 42);
  const rival = await db.begin();
  let acquired = false;
  const wait = rival.lock('slot', 42).then(() => (acquired = true));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(acquired, false);                                 // лок держится
  await holder.commit();
  await wait;
  assert.equal(acquired, true);                                  // освободился после commit
  await rival.rollback();
  await db.Клиент(a.id).delete({ confirm: true }).rows();
});

test('✔ batch: копление/size/discard, multi-VALUES, атомарный откат, контекст-связи', async () => {
  // события запросов покажут склейку multi-VALUES
  const events: QueryEvent[] = [];
  const hooked = await connect({ dsn: DSN, schema: 'v1.booking', onQuery: (e) => events.push(e) });

  // чистые INSERT (один шаг, без контекста и data.id) склеиваются в один multi-VALUES
  const b = hooked.batch('пачка');
  const q1 = b.Клиент().set({ name: 'Б1' });                              // план встал в очередь, вернулась цепочка
  b.Клиент().set({ name: 'Б2' });
  b.Клиент().set({ name: 'Б3' });
  assert.throws(() => q1.rows(), /plan is queued in the batch/);          // терминал в батче — только b.run()
  assert.equal(b.size(), 3);

  events.length = 0;
  const res = await b.run();
  assert.equal(res.length, 3);
  assert.ok(res.every((r) => String(r[0].data.name).startsWith('Б')));
  assert.equal(b.size(), 0);
  const inserts = events.filter((e) => e.mode === 'insert');
  assert.equal(inserts.length, 1);                                        // один INSERT…VALUES ×3
  assert.equal(inserts[0].rows, 3);

  // discard: очередь очищается без исполнения
  const d = hooked.batch('мусор');
  d.Организация(S.org).Клиент().set({ name: 'НеБудет' });
  assert.equal(d.size(), 1);
  d.discard();
  assert.equal(d.size(), 0);
  assert.equal(await hooked.Клиент({ name: 'НеБудет' }).count(), 0);

  // атомарность: невалидная операция в конце откатывает ВСЮ пачку
  const bad = hooked.batch('сломанная');
  bad.Организация(S.org).Клиент().set({ name: 'НеЗапишется' });
  bad.Организация(S.org).Услуга().set({ name: 'Х', duration: 'плохо' as never });
  await assert.rejects(bad.run(), /validation failed/);
  assert.equal(await hooked.Клиент({ name: 'НеЗапишется' }).count(), 0);

  // связи контекст-шагами работают и в батче
  const b2 = hooked.batch('связи');
  b2.Сотрудник(S.petya).навык().set({}).Услуга.set(S.strizh);
  const [linked] = (await b2.run())[0];
  assert.deepEqual([linked.links.Staff, linked.links.Service], [S.petya.id, S.strizh.id]);

  await hooked.Клиент({ name: starts('Б') }).delete({ confirm: true }).rows();
  await hooked.Сотрудник(S.petya.id).навык().delete({ confirm: true }).rows();
  await hooked.close();
});

test('✔ tables: accounts/credentials/resources/rules — весь CRUD + FK', async () => {
  // accounts: insert → get → find → update → RESTRICT → delete
  const acc = await db.accounts.set({ categories: ['Client'], data: { название: 'ООО Тест' } });
  assert.equal((await db.accounts.get(acc.id))?.id, acc.id);
  assert.ok((await db.accounts.find({ category: 'Client' })).some((a) => a.id === acc.id));
  const upd = await db.accounts.set({ id: acc.id, enabled: false });
  assert.equal(upd.enabled, false);
  assert.ok((await db.accounts.find({ enabled: false })).some((a) => a.id === acc.id));
  await assert.rejects(db.accounts.delete(SYS), /entity_account_fk|violates foreign key/); // на System есть Entity

  // credentials: set → find → soft-delete → withDeleted → воскрешение upsert-ом
  const cred = await db.credentials.set({ account: acc.id, category: 'phone', identifier: '+7-900', confirmed: false });
  assert.equal((await db.credentials.find({ account: acc.id, confirmed: false }))[0].id, cred.id);
  assert.equal(await db.credentials.delete(cred.id), true);
  assert.equal((await db.credentials.find({ account: acc.id })).length, 0);
  assert.equal((await db.credentials.find({ account: acc.id, withDeleted: true })).length, 1);
  const revived = await db.credentials.set({ account: acc.id, category: 'phone', identifier: '+7-900' });
  assert.equal(revived.id, cred.id);
  assert.equal(revived.deleted, null);

  // resources + rules: upsert, FK-ошибка, каскад при удалении ресурса
  await db.resources.set({ alias: 'api.test', category: 'test', pattern: { path: '/t' } });
  assert.equal((await db.resources.get('api.test'))?.category, 'test');
  assert.ok((await db.resources.find({ category: 'test' })).length >= 1);
  const accRes = await db.resources.set({ alias: 'acc.test', category: 'test' });
  await db.rules.set({ account: accRes.alias, resource: 'api.test', permission: 'read', weight: 10 });
  const again = await db.rules.set({ account: accRes.alias, resource: 'api.test', permission: 'write' }); // upsert по PK
  assert.equal(again.permission, 'write');
  assert.equal((await db.rules.find({ account: accRes.alias, permission: 'write' })).length, 1);
  await assert.rejects(db.rules.set({ account: accRes.alias, resource: 'нет.такого', permission: 'x' }), /violates foreign key/);
  await db.resources.delete('api.test');                          // Rule снесётся каскадом
  assert.equal((await db.rules.find({ account: accRes.alias })).length, 0);
  assert.equal(await db.rules.delete(accRes.alias, 'api.test'), false);
  await db.resources.delete(accRes.alias);
  await db.accounts.delete(acc.id);                                // Credential уйдёт FK-каскадом
  assert.equal(await db.accounts.get(acc.id), null);
});

test('✔ watch: все классы и фильтр-класс, insert/tombstone, stop', async () => {
  const all: string[] = [];
  const only: { deleted: boolean }[] = [];
  const stopAll = await db.watch((e) => all.push(e.class));
  const stopCli = await db.watch('Клиент', (e) => only.push({ deleted: e.deleted }));

  const [w] = await db.Организация(S.org).Клиент().set({ name: 'Наблюдаемый' }).rows();
  await db.Организация(S.org).Услуга(S.strizh.id).set({ description: 'обновка' }).rows();
  await db.Клиент(w.id).delete({ confirm: true }).rows();
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(all.includes('Customer') && all.includes('Service'));  // watch(cb) видит все классы
  assert.equal(only.length, 2);                                    // фильтр-класс: insert + tombstone
  assert.deepEqual(only.map((e) => e.deleted), [false, true]);

  await stopCli();
  const n = only.length;
  const [w2] = await db.Организация(S.org).Клиент().set({ name: 'После stop' }).rows();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(only.length, n);                                    // после stop — тишина
  await stopAll();
  await db.Клиент(w2.id).delete({ confirm: true }).rows();
});

test('✔ enforceAccount: чужое невидимо, чтение и запись пришпилены', async () => {
  const tenant = await db.accounts.set({ categories: ['Client'] });
  const iso = await connect({ dsn: DSN, schema: 'v1.booking', account: tenant.id, enforceAccount: true });

  const [own] = await iso.Организация().set({ name: 'Только моя' }).rows();
  assert.equal(own.account, tenant.id);
  assert.equal(await iso.Организация().count(), 1);                // System-орга невидима
  assert.equal((await iso.Организация().first())?.id, own.id);
  await assert.rejects(iso.Организация().account(SYS).rows(), /pinned to account/);       // чтение чужого
  await assert.rejects(iso.Организация().account(SYS).set({ name: 'Чужая' }).rows(), /pinned to account/); // запись чужим
  await iso.Организация(own.id).delete({ confirm: true }).rows();
  await iso.close();
  // аккаунт с Entity-историей физически НЕудаляем (FK RESTRICT) — tombstone-строки остаются навсегда
  await assert.rejects(db.accounts.delete(tenant.id), /violates foreign key/);
});

test('✔ onQuery/slowMs: события чтения и записи с mode/classes/ms/rows', async () => {
  const events: QueryEvent[] = [];
  const hooked = await connect({ dsn: DSN, schema: 'v1.booking', slowMs: 10_000, onQuery: (e) => events.push(e) });
  await hooked.Услуга().навык().count();
  const [tmp] = await hooked.Организация(S.org).Клиент().set({ name: 'Хукнутый' }).rows();
  await hooked.Клиент(tmp.id).delete({ confirm: true }).rows();
  await hooked.close();

  const count = events.find((e) => e.mode === 'count');
  assert.deepEqual(count?.classes, ['Service', 'skill']);
  assert.ok(events.some((e) => e.mode === 'insert' && e.classes.includes('Customer')));
  assert.ok(events.some((e) => e.mode === 'delete'));
  assert.ok(events.every((e) => e.ms >= 0 && e.rows >= 0 && e.slow === false));
});
