/**
 * scenario-salon — сквозной сценарий салона красоты (план, этап 6; тест-план §7.8 №6.13): перенос
 * 21 акта 0.21 `lib/test/salon.test.ts` на API 1.0 и демо-домен booking с матрицей покрытия
 * публичного API (CHAIN_METHODS, DB_METHODS, BATCH_METHODS — последний тест файла).
 *
 * Открытие салона → каталог и мастера → расписание → записи клиентов (гонки, переносы, отмены) →
 * отчёты → подписка → приватность → вход и сессии → права → изоляция арендаторов → охранники.
 * Каждый акт в шапке перечисляет методы API, которые он задевает.
 *
 * Отличия 1.0, учтённые при переносе (по смыслу, а не дословно):
 * - id окна и записи — v5 от ключа (Staff, start_datetime) в арендаторе: db.idOf вместо формулы 0.21;
 *   время ключевого поля — ISO с миллисекундами и Z;
 * - предмет записи — полиморфный конец Item (в 0.21 — союз концов Service | Product | Complex);
 * - create занятого ключа — ошибка exists, замена — upsert; count() считает сущности, пути — paths();
 * - строки принадлежат арендатору сессии (System-fallback и enforceAccount 0.21 сняты: изоляция всегда);
 * - фасады db.accounts, credentials, resources, rules сняты: аккаунты — помощники _access.ts и системный
 *   класс Account, креды — db.auth, права — системные классы Resource и rule цепочками, решения —
 *   db.acl.check(endpoint) / checkData(class, op) от имени сессии;
 * - сессии в базе (Redis не нужен): db.auth.sessionFor, refresh, revoke, revokeAll;
 * - up() не подключает: возвращает { created, revision, serviceKey } — Акт 2 проверяет повторный накат
 *   на своей схеме v2.t_scenario_salon_up;
 * - watch — асинхронный итератор по курсору: db.watch({ from: 'now', classes }), sub.close().
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn, ADMIN_DSN, ident } from './_harness.js';
import { account, member, session, sqlAs, sysadmin, type Acc } from './_access.js';
import {
  connect, up, cursorOf, totpCode, ValidationError, Registry, DDL_REVISION,
  CHAIN_METHODS, DB_METHODS,
  ne, gt, gte, lt, lte, between, inList, like, ilike, starts, ends, exists, isNull, not, or,
  type Db, type Row, type WatchEvent, type QueryEvent,
} from '../src/index.js';
import { BATCH_METHODS } from '../src/types.js';

let e: Engine;
let t: Tenant;
let db: Db;
let svc: Db;   // сервис установки: вход, креды, сессии (права auth.*)
let adb: Db;   // системный администратор: maintain, purgeAccount
const dbs: Db[] = [];
/** Именованный склад сущностей сцены (общий между актами). */
const S: Record<string, Row> = {};
const A: Record<string, Acc> = {};

/** Час 1 августа 2026 по Москве (UTC+3) — в UTC с миллисекундами и Z, как требует ключевое поле. */
const iso = (h: number) => `2026-08-01T${String(h - 3).padStart(2, '0')}:00:00.000Z`;
/** id записи известен до создания: v5 от ключа (мастер, старт) в арендаторе. */
const bookingId = (staff: Row, start: string) => db.idOf('booking', { Staff: staff.id, start_datetime: start });
/** Сумма варианта цены в рублях (data.amounts — record RUB | USD | EUR | AED). */
const rub = (r: Row) => (r.data.amounts as Record<string, number>).RUB;

/** Момент timestamptz (строкой из базы: «2026-08-01 07:00:00.123+00» или ISO) в мс. */
const msOf = (v: string) => Date.parse(v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));

/** Ошибка letopis с кодом c. */
const code = (c: string) => (err: { code?: string }) => {
  assert.equal(err.code, c, String((err as Error).message));
  return true;
};
/** Отказ — синхронный (при построении цепочки) или асинхронный (при запросе) — с кодом c. */
const fails = (fn: () => unknown, c: string) => assert.rejects(async () => fn(), code(c));

const open = async (o: { token?: string; apiKey?: string; max?: number; onQuery?: (q: QueryEvent) => void; slowMs?: number }) => {
  const d = await connect({ dsn: appDsn(), schema: e.schema, max: 2, ...o });
  dbs.push(d);
  return d;
};
/** Чей токен: аккаунт сессии или null (сессия погашена). */
const whose = async (token: string): Promise<string | null> => {
  const [r] = await sqlAs(e, token)(`select account from ${e.S}.ctx()`);
  return (r?.account as string | null) ?? null;
};
/** Следующие n событий подписки (не дольше ms). */
async function take(it: AsyncIterator<WatchEvent>, n: number, ms = 10_000): Promise<WatchEvent[]> {
  const out: WatchEvent[] = [];
  const until = Date.now() + ms;
  while (out.length < n) {
    const left = until - Date.now();
    const r = await Promise.race([it.next(), new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), Math.max(left, 1)))]);
    if (r === 'timeout') throw new Error(`take: за ${ms} мс получено ${out.length} из ${n}`);
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

before(async () => {
  e = await engine(import.meta.filename, { seeds: ['booking'] });
  t = await e.tenant('Локоны');
  db = await open({ token: t.token, max: 6 });
  svc = await open({ apiKey: e.serviceKey });
  adb = await open({ token: (await sysadmin(e)).token });
});

after(async () => {
  for (const d of dbs) await d.close().catch(() => {});
  await e?.close();
});

// ===========================================================================
// АКТ 1. Открытие салона: подключение, реестр, описание модели, создание, батч
// покрывает: connect, schema, token, tenant, registry, idOf, sql, transaction,
//            Класс().create, rows, batch: Класс, size, run, discard
// ===========================================================================
test('Акт 1. Открытие: организация, локация, мастера — создание цепочками и батч', async () => {
  assert.equal(db.schema, e.schema);
  assert.equal(db.token, t.token);
  assert.equal(db.tenant, t.id, 'арендатор сессии');
  assert.ok(db.registry instanceof Registry);
  assert.equal(db.registry.resolve('Организация').name, 'Org');
  assert.ok(db.registry.has('содержимое'));
  assert.ok(db.registry.all().length >= 18);
  const booking = db.registry.resolve('booking');
  assert.deepEqual([booking.kind, booking.ancestors[1]], ['link', 'slot'], 'описание модели: связь booking — потомок slot');

  [S.org] = await db.Организация().create({ name: 'Салон «Локоны»', phone: '+7 900 111', timezone: 'Europe/Moscow' }).rows();
  assert.equal(S.org.data.name, 'Салон «Локоны»');
  assert.equal(S.org.data.active, true, 'умолчание описания класса');
  // в 1.0 нет System-fallback: строка принадлежит арендатору сессии, владелец — актор
  assert.equal(S.org.tenant, t.id);
  assert.equal(S.org.owner, t.id);
  const [{ mine }] = await db.sql`select current_setting('letopis.token', true) = ${t.token} as mine`;
  assert.equal(mine, true, 'db.sql — под сессией подключения');
  const [raw] = await db.transaction((q) => q.unsafe(`select tenant from ${e.S}.entity where id = $1`, [S.org.id]));
  assert.equal(raw.tenant, t.id, 'db.transaction — тот же контекст и RLS');

  [S.зал] = await db.Организация(S.org).Локация().create({ address: 'Тверская, 7', coordinates: { lat: 55.76, lng: 37.61 } }).rows();

  // батч: два мастера одним заходом (планы в очереди, одна транзакция)
  const b = db.batch('setup');
  b.Организация(S.org).Мастер().create({ name: 'Ольга', phone: '+7 900 222', specialization: 'парикмахер' });
  b.Организация(S.org).Мастер().create({ name: 'Ирина', phone: '+7 900 333', specialization: 'барбер' });
  assert.equal(b.size(), 2);
  const res = await b.run();
  assert.equal(res.length, 2);
  assert.equal(b.size(), 0, 'очередь дренирована');
  [[S.ольга], [S.ирина]] = res;
  assert.equal(S.ольга.links.Org, S.org.id);

  // discard: план в очереди — и выброшен
  const b2 = db.batch('scratch');
  b2.Организация(S.org).Клиент().create({ name: 'Черновик', phone: '+7 000 000' });
  assert.equal(b2.size(), 1);
  b2.discard();
  assert.equal(b2.size(), 0);
  assert.deepEqual(await b2.run(), []);
  assert.equal(await db.Клиент().count(), 0);
});

// ===========================================================================
// АКТ 2. up(): повторный накат на живой схеме идемпотентен
// покрывает: up (created, revision, serviceKey), connect({ apiKey })
// ===========================================================================
test('Акт 2. up(): свежая установка, затем повторный накат на живой схеме — данные целы, ключ не выдаётся', async () => {
  const UP = 'v2.t_scenario_salon_up';
  await e.sql.unsafe(`drop schema if exists ${ident(UP)} cascade`);
  try {
    const r1 = await up({ dsn: ADMIN_DSN, schema: UP, quiet: true, seeds: ['booking'] });
    assert.equal(r1.created, true);
    assert.equal(r1.revision, DDL_REVISION);
    assert.match(r1.serviceKey ?? '', /^lts_/);
    const count = async () => (await e.sql.unsafe(`select count(*)::int as n from ${ident(UP)}.entity`))[0].n as number;
    const n1 = await count();

    const r2 = await up({ dsn: ADMIN_DSN, schema: UP, quiet: true, seeds: ['booking'] });
    assert.equal(r2.created, false, 'схема живая — не ставится заново');
    assert.equal(r2.serviceKey, null, 'ключ сервиса выдаётся один раз');
    assert.equal(r2.revision, DDL_REVISION);
    assert.equal(await count(), n1, 'строки целы');

    // ключ первой установки по-прежнему открывает сессию сервиса; демо-классы видны
    const s = await connect({ dsn: appDsn(), schema: UP, apiKey: r1.serviceKey!, max: 1 });
    try {
      assert.ok(s.registry.has('Организация'));
    } finally {
      await s.close();
    }
  } finally {
    await e.sql.unsafe(`drop schema if exists ${ident(UP)} cascade`);
  }
});

// ===========================================================================
// АКТ 3. Каталог: папки-дерево, услуги и товар, комплекс и состав, наполнение папок
// покрывает: create, слот .Роль.set, deep, rows, count, навигация по концам и ролям
// ===========================================================================
test('Акт 3. Каталог: папки-дерево, услуги, комплекс и состав, наполнение папок', async () => {
  const { org } = S;
  [S.корень] = await db.Организация(org).Папка().create({ name: 'Каталог' }).rows();
  // Папка → Папка: обратный шаг по роли Parent; организация — слотом
  [S.волосы] = await db.Папка(S.корень).Папка().create({ name: 'Волосы' }).Организация.set(org).rows();
  assert.equal(S.волосы.links.Parent, S.корень.id);
  [S.мужское] = await db.Папка(S.волосы).Папка().create({ name: 'Мужское' }).Организация.set(org).rows();

  [S.стрижка] = await db.Организация(org).Услуга().create({ name: 'Стрижка', duration: 60 }).rows();
  [S.укладка] = await db.Организация(org).Услуга().create({ name: 'Укладка', duration: 30 }).rows();
  [S.борода] = await db.Организация(org).Услуга().create({ name: 'Борода', duration: 30, description: 'моделирование' }).rows();
  [S.шампунь] = await db.Организация(org).Товар().create({ name: 'Шампунь', sku: 'SH-01' }).rows();
  assert.equal(S.шампунь.data.unit, 'шт');

  // цена — связь «цена» (вариант «базовая», мультивалюта amounts); конец Item берётся из пути
  await db.Услуга(S.стрижка).цена().create({ amounts: { RUB: 1500 } }).rows();
  await db.Услуга(S.укладка).цена().create({ amounts: { RUB: 900 } }).rows();
  [S.ценаБорода] = await db.Услуга(S.борода).цена().create({ amounts: { RUB: 800 } }).rows();
  assert.equal(S.ценаБорода.data.note, 'базовая');

  // комплекс и его состав (связь «состав» = [Комплекс, Part: Услуга | Товар]) — часть слотом
  [S.набор] = await db.Организация(org).Комплекс().create({ name: 'Образ', duration: 90, cost: 2200 }).rows();
  await db.Комплекс(S.набор).состав().create({ quantity: 1, order: 1 }).Услуга.set(S.стрижка).rows();
  await db.Комплекс(S.набор).состав().create({ quantity: 1, order: 2 }).Услуга.set(S.укладка).rows();
  const [вСоставе] = await db.Комплекс(S.набор).состав().create({ quantity: 1, order: 3 }).Товар.set(S.шампунь).rows();
  assert.equal(вСоставе.links.Part, S.шампунь.id, 'слот по имени класса нашёл единственную роль');

  // наполнение папки: связь «содержимое» = [Папка, Item: элемент каталога]
  await db.Папка(S.волосы).содержимое().create({ order: 1 }).Услуга.set(S.стрижка).rows();
  await db.Папка(S.волосы).содержимое().create({ order: 2 }).Услуга.set(S.укладка).rows();
  await db.Папка(S.корень).содержимое().create({ order: 1 }).Комплекс.set(S.набор).rows();

  // deep: вся ветка папок от корня с глубиной
  const ветка = await db.Папка(S.корень).Папка().deep().rows();
  assert.deepEqual(ветка.map((f) => [f.data.name, f.$depth]).sort(), [['Волосы', 1], ['Мужское', 2]]);
  assert.deepEqual((await db.Папка(S.мужское).Parent().Parent().rows()).map((r) => r.data.name), ['Каталог']);

  // состав комплекса: Комплекс → состав → Услуга (и Товар отдельно)
  const услугиНабора = await db.Комплекс(S.набор).состав().Услуга().rows();
  assert.deepEqual(услугиНабора.map((r) => r.data.name).sort(), ['Стрижка', 'Укладка']);
  assert.equal(await db.Комплекс(S.набор).состав().Товар().count(), 1);
  const вПапке = await db.Папка(S.волосы).содержимое().Услуга().rows();
  assert.deepEqual(вПапке.map((r) => r.data.name).sort(), ['Стрижка', 'Укладка']);
});

// ===========================================================================
// АКТ 4. Навыки мастеров: слоты, проверка умения, умение комплекса по составу
// покрывает: create + слот, ids, count, фильтр списком id
// ===========================================================================
test('Акт 4. Навыки мастеров: слоты, проверка умения, комплекс вычислим по составу', async () => {
  const { ольга, ирина, стрижка, укладка, борода, набор } = S;
  await db.Мастер(ольга).навык().create({ level: 'expert' }).Услуга.set(стрижка).rows();
  const [навыкО] = await db.Мастер(ольга).навык().create().Услуга.set(укладка).rows();
  assert.equal(навыкО.data.level, 'intermediate', 'умолчание уровня');
  await db.Мастер(ирина).навык().create().Услуга.set(стрижка).rows();
  await db.Мастер(ирина).навык().create({ level: 'advanced' }).Услуга.set(борода).rows();

  const уменияО = await db.Мастер(ольга).навык().Услуга().rows();
  assert.deepEqual(уменияО.map((r) => r.data.name).sort(), ['Стрижка', 'Укладка']);

  // «умеет ли Ирина бороду»: навык, дофильтр по предмету, возврат к навыку
  assert.equal(await db.Мастер(ирина).навык().Услуга(борода).навык().count(), 1);
  assert.equal(await db.Мастер(ирина).навык().Услуга(укладка).навык().count(), 0);

  // умение комплекса вычислимо: Ольга покрывает все услуги состава «Образа», Ирина — нет
  const услугиСостава = await db.Комплекс(набор).состав().Услуга().ids();
  assert.equal(await db.Мастер(ольга).навык().Услуга(услугиСостава).count(), услугиСостава.length);
  assert.ok(await db.Мастер(ирина).навык().Услуга(услугиСостава).count() < услугиСостава.length);

  // повтор навыка — ключ (Staff, Service) занят: exists; замена — upsert
  await fails(() => db.Мастер(ольга).навык().create({ level: 'basic' }).Услуга.set(стрижка).rows(), 'exists');
  const [заменён] = await db.Мастер(ольга).навык().upsert({ level: 'expert' }).Услуга.set(укладка).rows();
  assert.equal(заменён.$upsert, 'updated');
  assert.equal(заменён.id, навыкО.id, 'тот же id от ключа');
});

// ===========================================================================
// АКТ 5. Расписание: окна мастеров батчем (позитивная доступность)
// покрывает: batch + слоты, sort, limit, exact, between, idOf
// ===========================================================================
test('Акт 5. Расписание: месяц и окна мастеров батчем; выходной час — отсутствие окна', async () => {
  const { org, зал, ольга, ирина } = S;
  [S.расп] = await db.Организация(org).Расписание().create({ name: 'Август-26', year: 2026, month: 8 }).rows();

  const b = db.batch('окна');
  for (let h = 10; h < 18; h++) {
    b.Мастер(ольга).окно().create({ start_datetime: iso(h), end_datetime: iso(h + 1) }).Локация.set(зал).Расписание.set(S.расп);
  }
  for (let h = 10; h < 17; h++) { // Ирина в 17:00 не работает — окна просто нет
    b.Мастер(ирина).окно().create({ start_datetime: iso(h), end_datetime: iso(h + 1) }).Локация.set(зал).Расписание.set(S.расп);
  }
  const созданы = await b.run();
  assert.equal(созданы.length, 15);
  assert.ok(созданы.every(([r]) => r.class === 'slot' && r.links.Schedule === S.расп.id));
  assert.equal(созданы[0][0].id, db.idOf('slot', { Staff: ольга.id, start_datetime: iso(10) }), 'id от ключа — и в батче');

  const поВремени = await db.Расписание(S.расп).окно().exact().sort('data.start_datetime').rows();
  assert.equal(поВремени.length, 15);
  assert.equal(поВремени[0].data.start_datetime, iso(10));
  assert.equal((await db.Расписание(S.расп).окно().exact().limit(3).rows()).length, 3);

  const ростер = await db.Расписание(S.расп).окно().exact().Мастер().rows();
  assert.deepEqual(ростер.map((r) => r.data.name).sort(), ['Ирина', 'Ольга'], 'ростер без повторов');
  assert.equal(await db.Мастер(ирина).окно({ start_datetime: between(iso(17), iso(17)) }).exact().count(), 0);
  assert.equal(await db.Мастер(ольга).окно({ start_datetime: between(iso(17), iso(17)) }).exact().count(), 1);
});

// ===========================================================================
// АКТ 6. Первая бронь — транзакция и advisory-lock
// покрывает: begin, lock, forUpdate, first, create + слоты, commit, rollback
// ===========================================================================
test('Акт 6. Бронь №1: Аня → Ольга, стрижка 10:00 (транзакция и lock)', async () => {
  const { org, зал, расп, ольга, стрижка } = S;
  [S.аня] = await db.Организация(org).Клиент().create({ name: 'Аня', phone: '+7 911 001' }).rows();
  const bid = bookingId(ольга, iso(10));

  const tr = await db.begin();
  try {
    await tr.lock('booking', ольга.id, iso(10));
    assert.equal((await tr.Мастер(ольга).forUpdate().first())?.id, ольга.id, 'строка мастера заблокирована');
    assert.equal(await tr.запись(bid).first(), null, 'время свободно');
    const [з] = await tr.Мастер(ольга).запись()
      .create({ start_datetime: iso(10), end_datetime: iso(11) })
      .Локация.set(зал).Расписание.set(расп).Услуга.set(стрижка).Клиент.set(S.аня).rows();
    assert.equal(з.id, bid, 'id совпал с вычисленным заранее');
    await tr.commit();
  } catch (err) {
    await tr.rollback();
    throw err;
  }
  S.зАни = (await db.запись(bid).first())!;
  assert.deepEqual(S.зАни.links, { Staff: ольга.id, Location: зал.id, Schedule: расп.id, Item: стрижка.id, Customer: S.аня.id });
  // forUpdate вне транзакции — отказ
  await fails(() => db.Мастер(ольга).forUpdate().first(), 'tx_required');
});

// ===========================================================================
// АКТ 7. Гонка двойной брони — две транзакции на пару (мастер, старт)
// покрывает: begin, lock, rollback, commit(tr), exists
// ===========================================================================
test('Акт 7. Гонка: Боря и Вера одновременно на Ольгу 11:00 — ровно один успех', async () => {
  const { org, зал, расп, ольга, стрижка } = S;
  [S.боря] = await db.Организация(org).Клиент().create({ name: 'Боря', phone: '+7 911 002' }).rows();
  [S.вера] = await db.Организация(org).Клиент().create({ name: 'Вера', phone: '+7 911 003' }).rows();
  const bid = bookingId(ольга, iso(11));

  const попытка = async (клиент: Row, label: string): Promise<string | null> => {
    const tr = await db.begin();
    try {
      await tr.lock('booking', ольга.id, iso(11));
      if (await tr.запись(bid).first()) {
        await db.rollback(tr);
        return null;
      }
      await tr.Мастер(ольга).запись()
        .create({ start_datetime: iso(11), end_datetime: iso(12) })
        .Локация.set(зал).Расписание.set(расп).Услуга.set(стрижка).Клиент.set(клиент).rows();
      await db.commit(tr);
      return label;
    } catch (err) {
      await tr.rollback();
      if ((err as { code?: string }).code === 'exists') return null; // конкурент успел
      throw err;
    }
  };
  const итог = await Promise.all([попытка(S.боря, 'боря'), попытка(S.вера, 'вера')]);
  assert.equal(итог.filter(Boolean).length, 1, 'ровно один');
  assert.equal(await db.запись(bid).count(), 1);
  // повтор занятой пары без проверки — exists (в 0.21 create делал новую версию)
  await fails(() => db.Мастер(ольга).запись()
    .create({ start_datetime: iso(11), end_datetime: iso(12) })
    .Локация.set(зал).Расписание.set(расп).Услуга.set(стрижка).rows(), 'exists');
});

// ===========================================================================
// АКТ 8. «4 руки»: две записи в один час у двух мастеров (клиентка одна)
// покрывает: create + слоты, count, count({ paths })
// ===========================================================================
test('Акт 8. Параллель: Аня в 12:00 — стрижка у Ольги и борода у Ирины', async () => {
  const { зал, расп, ольга, ирина, стрижка, борода, аня } = S;
  const мк = (мастер: Row, услуга: Row) =>
    db.Мастер(мастер).запись()
      .create({ start_datetime: iso(12), end_datetime: iso(13) })
      .Локация.set(зал).Расписание.set(расп).Услуга.set(услуга).Клиент.set(аня).rows();
  await мк(ольга, стрижка);
  await мк(ирина, борода);

  const в12 = { start_datetime: iso(12) };
  assert.equal(await db.Клиент(аня).запись(в12).count(), 2);
  const занятыеВ12 = await db.запись(в12).Мастер().rows();
  assert.deepEqual(занятыеВ12.map((r) => r.data.name).sort(), ['Ирина', 'Ольга']);
  // сущностей-мастеров две, путей «клиент → запись → мастер» тоже два
  assert.equal(await db.Клиент(аня).запись(в12).Мастер().count({ paths: true }), 2);
  S.зОльга12 = (await db.запись(bookingId(ольга, iso(12))).first())!;
});

// ===========================================================================
// АКТ 9. Операции дня: замена предмета, снятие клиента, перенос = пересоздание
// покрывает: update + слот .set/.unset, versions, delete({ confirm }) в транзакции
// ===========================================================================
test('Акт 9. Изменения броней: замена предмета, снятие клиента, перенос времени', async () => {
  const { зАни, набор, стрижка, шампунь, аня, зал, расп, ольга } = S;

  // предмет записи — один полиморфный конец Item: Стрижка → Комплекс «Образ» → Товар → Стрижка
  const [зам] = await db.запись(зАни.id).update().Комплекс.set(набор).rows();
  assert.equal(зам.links.Item, набор.id);
  assert.equal((await db.запись(зАни.id).Item().first())!.class, 'Complex');
  const [зам2] = await db.запись(зАни.id).update().Товар.set(шампунь).rows();
  assert.equal(зам2.links.Item, шампунь.id);
  await db.запись(зАни.id).update().Услуга.set(стрижка).rows();

  // снятие необязательного конца: ручная бронь — клиент отвязан, имя в notes
  const [снято] = await db.запись(зАни.id).update({ notes: 'бронь по телефону: Аня' }).Клиент.unset().rows();
  assert.ok(!('Customer' in снято.links));
  // обязательный конец снять нельзя
  await fails(() => db.запись(зАни.id).update().Локация.unset().rows(), 'invalid_query');
  await db.запись(зАни.id).update().Клиент.set(аня).rows();

  // версий записи: создание и пять правок
  assert.equal((await db.запись(зАни.id).versions()).length, 6);

  // перенос: id держит (мастер, старт) — смена времени есть пересоздание в транзакции
  const tr = await db.begin();
  try {
    await tr.запись(bookingId(ольга, iso(10))).delete({ confirm: true }).rows();
    await tr.Мастер(ольга).запись()
      .create({ start_datetime: iso(15), end_datetime: iso(16) })
      .Локация.set(зал).Расписание.set(расп).Услуга.set(стрижка).Клиент.set(аня).rows();
    await tr.commit();
  } catch (err) {
    await tr.rollback();
    throw err;
  }
  assert.equal(await db.запись(bookingId(ольга, iso(10))).count(), 0, '10:00 свободно');
  assert.equal(await db.запись(bookingId(ольга, iso(15))).count(), 1, '15:00 занято');
  S.зАни15 = (await db.запись(bookingId(ольга, iso(15))).first())!;
});

// ===========================================================================
// АКТ 10. Отмена записи — превью, надгробие, ошибочная отмена восстановлена
// покрывает: delete() превью и confirm, withDeleted, restore
// ===========================================================================
test('Акт 10. Отмена записи Ольги 12:00: превью, надгробие, восстановление ошибочной отмены', async () => {
  const { зОльга12, ольга } = S;
  const превью = await db.запись(зОльга12.id).delete().rows();
  assert.deepEqual(превью.map((r) => [r.class, r.$action]), [['booking', 'delete']]);
  assert.ok(превью.every((r) => r.$deleted === undefined), 'база не тронута');
  assert.ok(await db.запись(зОльга12.id).first());

  const удалено = await db.запись(зОльга12.id).delete({ confirm: true }).rows();
  assert.ok(удалено.length === 1 && удалено.every((r) => r.$deleted === true));
  assert.equal(await db.запись(зОльга12.id).count(), 0);
  assert.equal(await db.запись(bookingId(ольга, iso(12))).count(), 0, 'нет записи — мастер свободен');
  const [надгробие] = await db.запись(зОльга12.id).withDeleted().rows();
  assert.equal(надгробие.$deleted, true, 'удалённая видна с withDeleted()');

  // администратор отменил не ту запись — восстановление той же сущности новой версией
  const [вернули] = await db.запись(зОльга12.id).restore().rows();
  assert.equal(вернули.id, зОльга12.id);
  assert.equal(await db.запись(зОльга12.id).count(), 1);
  await fails(() => db.запись(зОльга12.id).restore().rows(), 'not_deleted');
  // а теперь — настоящая отмена
  await db.запись(зОльга12.id).delete({ confirm: true }).rows();
  const история = await db.запись(зОльга12.id).withDeleted().versions();
  assert.deepEqual(история.map((v) => v.$deleted === true), [false, true, false, true]);
});

// ===========================================================================
// АКТ 11. entity() — старт с готового Row и узел-переменная
// покрывает: db.entity, chain.entity, paths
// ===========================================================================
test('Акт 11. entity(): старт от Row и узел-переменная в пути', async () => {
  const { зАни15, стрижка, аня } = S;
  const услугаЗаписи = await db.entity(зАни15).Услуга().first();
  assert.equal(услугаЗаписи?.id, стрижка.id);

  // та же переменная — тот же узел: записи Ани на стрижку и их мастера
  const зап = db.запись();
  const пути = await db.Клиент(аня).entity(зап).Услуга(стрижка).entity(зап).Мастер().paths();
  assert.ok(пути.length >= 1);
  assert.ok(пути.every((p) => p.Мастер && p.Клиент.id === аня.id));
});

// ===========================================================================
// АКТ 12. Отчёты — операторы фильтра на каталоге
// покрывает: ne gt gte lt lte between inList like ilike starts ends exists isNull not or
// ===========================================================================
test('Акт 12. Отчёты: операторы фильтра на каталоге', async () => {
  const c = (f: Parameters<typeof db.Услуга>[0]) => db.Услуга(f).count();
  assert.equal(await c({ duration: ne(60) }), 2);
  assert.equal(await c({ duration: gt(30) }), 1);
  assert.equal(await c({ duration: gte(30) }), 3);
  assert.equal(await c({ duration: lt(60) }), 2);
  assert.equal(await c({ duration: lte(30) }), 2);
  assert.equal(await c({ duration: between(25, 35) }), 2);
  assert.equal(await c({ name: inList(['Стрижка', 'Борода']) }), 2);
  assert.equal(await c({ name: like('Стр%') }), 1);
  assert.equal(await c({ name: ilike('бОрОдА') }), 1);
  assert.equal(await c({ name: starts('Укл') }), 1);
  assert.equal(await c({ name: ends('дка') }), 1);
  assert.equal(await c({ description: exists() }), 1);
  assert.equal(await c({ description: isNull() }), 2);
  assert.equal(await c({ name: not(ilike('стр%')) }), 2);
  assert.equal(await db.Услуга(or({ name: 'Стрижка' }, { duration: lt(40) })).count(), 3);
  // фильтр по листу record amounts.RUB через связь «цена»: услуги дороже 1000
  assert.equal(await db.цена({ amounts: { RUB: gte(1000) } }).Услуга().count(), 1);
});

// ===========================================================================
// АКТ 13. Аналитика — агрегации, keyset-пагинация, alias, tags, кэш, reclass и rekey
// покрывает: sum avg min max countBy sort offset after cursorOf ids alias paths tags(create и фильтр)
//            cache (цепочка и db.cache), rekey, reclass
// ===========================================================================
test('Акт 13. Аналитика: агрегации, keyset, alias, tags, кэш; товар-хит переименован и переведён', async () => {
  assert.equal(await db.цена().sum('data.amounts.RUB'), 1500 + 900 + 800);
  assert.ok(Math.abs((await db.цена().avg('data.amounts.RUB'))! - 1066.67) < 1);
  assert.equal(await db.Услуга().min('data.duration'), 30);
  assert.equal(await db.Услуга().max('data.duration'), 60);
  const byDur = await db.Услуга().countBy('data.duration');
  assert.equal(byDur['30'], 2);
  assert.equal(byDur['60'], 1);

  // keyset-пагинация: страница 1 → курсор → страница 2
  const p1 = await db.Услуга().sort('data.duration').limit(2).rows();
  assert.equal(p1.length, 2);
  const cur = cursorOf(p1[p1.length - 1], 'data.duration');
  const p2 = await db.Услуга().sort('data.duration').after(cur).rows();
  assert.equal(p2.length, 1);
  assert.ok(!p2.some((r) => p1.find((x) => x.id === r.id)), 'без пересечений');
  assert.equal((await db.Услуга().sort('data.duration').offset(1).ids()).length, 2);

  // alias: переименование ключа шага в путях
  const пути = await db.Мастер(S.ольга).alias('Исполнитель').навык().Услуга().paths();
  assert.equal(пути.length, 2);
  assert.ok(пути.every((p) => p.Исполнитель.data.name === 'Ольга'));

  // кэш результатов: повтор — попадание, правка класса — сброс
  db.cache.clear();
  const до = db.cache.stats();
  assert.equal(до.enabled, true);
  assert.equal((await db.Услуга().cache().rows()).length, 3);
  assert.equal((await db.Услуга().cache().rows()).length, 3);
  assert.ok(db.cache.stats().hits > до.hits, 'второй запрос — из кэша');

  // tags: значение при создании и поиск по тегу
  const [хит] = await db.Организация(S.org).Услуга().tags(['топ']).create({ name: 'Хит сезона', duration: 45 }).rows();
  const поТегу = await db.Услуга().tags('топ').rows();
  assert.deepEqual(поТегу.map((r) => r.id), [хит.id]);
  assert.equal((await db.Услуга().cache().rows()).length, 4, 'своя запись сбросила кэш класса');

  // ключ услуги — (Org, name): переименование — rekey (новый id), затем перевод в товары — reclass
  const [переим] = await db.Услуга(хит.id).rekey({ name: 'Хит года' }).rows();
  assert.notEqual(переим.id, хит.id);
  assert.equal(переим.moved, хит.id);
  assert.equal(await db.Услуга(хит.id).count(), 0);
  const [товар] = await db.Услуга(переим.id).reclass('Product', { name: 'Хит года', sku: 'HIT-1' }).rows();
  assert.equal(товар.class, 'Product');
  assert.equal(await db.Услуга().tags('топ').count(), 0);
  await db.Товар(товар.id).delete({ confirm: true }).rows();
});

// ===========================================================================
// АКТ 14. История — asOf, versions
// покрывает: asOf, versions
// ===========================================================================
test('Акт 14. История: asOf и versions по изменению цены', async () => {
  const { ценаБорода } = S;
  const тогдаМомент = (await db.цена(ценаБорода.id).first())!.at;
  await db.цена(ценаБорода.id).update({ amounts: { RUB: 1000 } }).rows(); // подорожание (record сливается точечно)

  assert.equal(rub((await db.цена(ценаБорода.id).first())!), 1000);
  assert.equal(rub((await db.цена(ценаБорода.id).asOf(тогдаМомент).first())!), 800);
  const версии = await db.цена(ценаБорода.id).versions();
  assert.deepEqual(версии.map(rub), [800, 1000]);
});

// ===========================================================================
// АКТ 15. Подписка — watch по курсору (все классы и один класс), продолжение с курсора
// покрывает: watch, flushSignals, refresh
// ===========================================================================
test('Акт 15. Подписка: watch ловит новые версии; поток продолжается с курсора', async () => {
  await db.refresh();
  const [{ ts }] = await db.sql`select clock_timestamp()::text as ts`;
  const подписка = msOf(ts as string);
  const всё = db.watch({ from: 'now' });
  const клиенты = db.watch({ from: 'now', classes: ['Клиент'] });
  let продолжение: ReturnType<Db['watch']> | null = null;
  try {
    // момент «now» подписка берёт первым запросом к базе: записи — после него
    await всё.ready();
    await клиенты.ready();
    const [гость] = await db.Организация(S.org).Клиент().create({ name: 'Гость', phone: '+7 911 004' }).rows();
    const [салон] = await db.Организация(S.org.id).update({ address: 'Тверская, 7' }).rows();
    await db.flushSignals();

    // 'now' — изменения после подписки: зафиксированное до неё не приходит (снимок момента подписки)
    const общие = await take(всё, 2);
    assert.deepEqual(общие.map((x) => [x.id, x.class, x.op]), [[гость.id, 'Customer', 'create'], [салон.id, 'Org', 'update']],
      'ровно свои события по порядку фиксации');
    assert.ok(общие.every((x) => msOf(x.at) >= подписка));
    const кл = await take(клиенты, 1);
    assert.ok(кл.every((x) => x.class === 'Customer'), 'фильтр по классу');
    const ev = кл.at(-1)!;
    assert.equal(ev.row.data.name, 'Гость');
    assert.equal(ev.op, 'create');

    // продолжение с курсора события: только то, что после него
    продолжение = db.watch({ from: ev.cursor, classes: ['Клиент'] });
    const [второй] = await db.Организация(S.org).Клиент().create({ name: 'Второй гость', phone: '+7 911 005' }).rows();
    await db.flushSignals();
    const [ev2] = await take(продолжение, 1);
    assert.equal(ev2.id, второй.id);
  } finally {
    всё.close();
    клиенты.close();
    продолжение?.close();
  }
});

// ===========================================================================
// АКТ 16. Приватность — anonymize (история цела) и purge (право на забвение)
// покрывает: anonymize, purge (превью и confirm)
// ===========================================================================
test('Акт 16. GDPR: anonymize клиента, история сохранена; удалённый клиент стёрт целиком', async () => {
  const { org } = S;
  const [клиент] = await db.Организация(org).Клиент().create({ name: 'Пётр Удаляев', phone: '+7 917 005' }).rows();
  const [аноним] = await db.Клиент(клиент.id).anonymize(['name', 'phone']).rows();
  assert.equal(аноним.data.name, '[erased]');
  assert.equal(аноним.data.phone, '[erased]');
  assert.ok(аноним.tags.includes('anonymized'));
  const версии = await db.Клиент(клиент.id).versions();
  assert.equal(версии[0].data.name, 'Пётр Удаляев', 'первая версия хранит настоящее имя');

  // право на забвение: клиент удалён, затем история стёрта
  const [ушла] = await db.Организация(org).Клиент().create({ name: 'Мария Забвенная', phone: '+7 917 006' }).rows();
  await fails(() => db.Клиент(ушла.id).purge({ confirm: true }).rows(), 'not_deleted');
  await db.Клиент(ушла.id).delete({ confirm: true }).rows();
  const [превью] = await db.Клиент(ушла.id).purge().rows();
  assert.equal(превью.$versions, 2);
  const [стёрто] = await db.Клиент(ушла.id).purge({ confirm: true }).rows();
  assert.equal(стёрто.$purged, true);
  assert.deepEqual(await db.Клиент(ушла.id).withDeleted().versions(), []);
});

// ===========================================================================
// АКТ 17. Вход — db.auth: пароль, ключ API, ключ и секрет, TOTP, OTP, внешняя identity
// покрывает: auth.setPassword verifyPassword issueApiKey verifyApiKey issueKeySecret verifyKeySecret
//            enrollTotp verifyTotp totpEnabled issueOtp verifyOtp link lookup credentials
//            revokeCredential setFlags tenants switch
// ===========================================================================
test('Акт 17. Вход: все способы аутентификации мастера', async () => {
  // аккаунт мастера — системный класс Account (фасада db.accounts в 1.0 нет); член салона с ролью staff
  A.ольга = await account(e, 'Ольга', { categories: ['Staff'] });
  await member(e, A.ольга.id, t.id, ['staff']);
  const [acc] = await adb.Account(A.ольга.id).rows();
  assert.deepEqual(acc.data.categories, ['Staff']);
  const id = A.ольга.id;

  // пароль
  await svc.auth.setPassword({ account: id, identifier: 'olga@salon.ru', password: 'Secr3t!', confirmed: true });
  assert.equal((await svc.auth.verifyPassword({ identifier: 'olga@salon.ru', password: 'Secr3t!' }))?.account, id);
  assert.equal(await svc.auth.verifyPassword({ identifier: 'olga@salon.ru', password: 'wrong' }), null);

  // ключ API (в базе — только хэш)
  const { key } = await svc.auth.issueApiKey({ account: id, name: 'касса' });
  assert.equal((await svc.auth.verifyApiKey(key))?.account, id);
  assert.equal(await svc.auth.verifyApiKey('lts_deadbeef'), null);

  // ключ и секрет
  const ks = await svc.auth.issueKeySecret({ account: id });
  assert.equal((await svc.auth.verifyKeySecret(ks.key, ks.secret))?.account, id);

  // TOTP: регистрация → код → проверка включает фактор
  const totp = await svc.auth.enrollTotp({ account: id, issuer: 'Локоны' });
  assert.equal(await svc.auth.totpEnabled(id), false, 'до подтверждения');
  assert.equal(await svc.auth.verifyTotp({ account: id, code: totpCode(totp.secret) }), true);
  assert.equal(await svc.auth.totpEnabled(id), true);

  // одноразовый код: успех гасит его
  const otp = await svc.auth.issueOtp({ account: id, identifier: '+7 900 111' });
  assert.equal((await svc.auth.verifyOtp({ identifier: '+7 900 111', code: otp.code }))?.account, id);
  assert.equal(await svc.auth.verifyOtp({ identifier: '+7 900 111', code: otp.code }), null, 'погашен');

  // внешняя identity: связка и вход (Telegram)
  await svc.auth.link({ account: id, kind: 'TELEGRAM', identifier: '777000999', confirmed: true });
  assert.equal((await svc.auth.lookup({ kind: 'TELEGRAM', identifier: '777000999' }))?.account, id);

  // креды аккаунта без секретов; отзыв ключа; выключение связки
  const creds = await svc.auth.credentials(id);
  assert.deepEqual([...new Set(creds.map((c) => c.kind))].sort(), ['APIKEY', 'KEYSECRET', 'PASSWORD', 'TELEGRAM', 'TOTP']);
  const apiCred = creds.find((c) => c.kind === 'APIKEY')!;
  assert.equal(await svc.auth.revokeCredential(apiCred.id), true);
  assert.equal(await svc.auth.verifyApiKey(key), null, 'ключ отозван');
  const tg = creds.find((c) => c.kind === 'TELEGRAM')!;
  assert.equal(await svc.auth.setFlags(tg.id, { enabled: false }), true);
  assert.equal(await svc.auth.lookup({ kind: 'TELEGRAM', identifier: '777000999' }), null, 'связка выключена');

  // вход паролем: собственный арендатор и салон по членству; переключение в салон
  const вход = (await svc.auth.verifyPassword({ identifier: 'olga@salon.ru', password: 'Secr3t!' }))!;
  const olga = await open({ token: вход.token });
  assert.equal(olga.tenant, id, 'по умолчанию — собственный арендатор');
  const доступные = await olga.auth.tenants();
  assert.ok(доступные.some((x) => x.tenant === t.id && x.roles.includes('staff')));
  await olga.auth.switch(t.id);
  assert.equal(olga.tenant, t.id);
  assert.equal(await olga.Мастер().count(), 2, 'в салоне видны его мастера');
});

// ===========================================================================
// АКТ 18. Сессии в базе — выпуск, продление, выход, выход везде; удаление аккаунта
// покрывает: auth.sessionFor refresh revoke revokeAll purgeAccount
// ===========================================================================
test('Акт 18. Сессии: выпуск сервисом, продление, выход, выход везде; удаление уволенного', async () => {
  const id = A.ольга.id;
  const tok = await svc.auth.sessionFor(id, { ttl: 3600 });
  assert.equal(await whose(tok), id);
  const u = await open({ token: tok, max: 1 });
  // новый срок — от сейчас, но не дольше срока выдачи (meta.ttl = 3600 с): продление не делает сессию вечной
  const срок = msOf(await u.auth.refresh({ ttl: 7200 })) - Date.now();
  assert.ok(срок > 3500_000 && срок <= 3600_000 + 5_000, `срок через ${срок} мс`);
  assert.equal(await u.auth.revoke(), true);
  assert.equal(await whose(tok), null, 'выход');

  // выход везде: две сессии гаснут разом
  const s1 = await svc.auth.sessionFor(id);
  const s2 = await svc.auth.sessionFor(id);
  assert.ok(await svc.auth.revokeAll(id) >= 2);
  assert.equal(await whose(s1), null);
  assert.equal(await whose(s2), null);

  // уволенная сотрудница: аккаунт удаляет системный администратор — сессии гаснут, креды удаляются
  const уволена = await account(e, 'Уволенная', { categories: ['Staff'] });
  await svc.auth.setPassword({ account: уволена.id, identifier: 'fired@salon.ru', password: 'Bye-2026', confirmed: true });
  const r = await adb.auth.purgeAccount(уволена.id);
  assert.equal(r.account, уволена.id);
  assert.equal(await whose(уволена.token), null);
  assert.equal(await svc.auth.verifyPassword({ identifier: 'fired@salon.ru', password: 'Bye-2026' }), null);
});

// ===========================================================================
// АКТ 19. Права — ресурсы и правила системными классами, решения db.acl
// покрывает: Resource/rule цепочками (create, слоты Group/Object, delete), acl.check, acl.checkData
// ===========================================================================
test('Акт 19. ACL: ресурс-группа, ресурс-эндпоинт, правило; check и checkData от имени сессии', async () => {
  // мастер салона с категорией SalonStaff и кассир без неё — члены арендатора
  A.зоя = await account(e, 'Зоя', { categories: ['SalonStaff'] });
  const кассир = await account(e, 'Кассир');
  for (const a of [A.зоя, кассир]) {
    await member(e, a.id, t.id, ['staff']);
    a.token = await session(e, a.id, { tenant: t.id });
  }
  const зоя = await open({ token: A.зоя.token });
  const касса = await open({ token: кассир.token });
  assert.equal((await зоя.acl.check('salon.book.read')).allow, false, 'правил на эндпоинт нет — запрет');

  // ресурс-ГРУППА (маска категорий) и ресурс-ОБЪЕКТ (эндпоинт) — системный класс Resource в арендаторе
  const [группа] = await db.Resource().create({ alias: 'salonStaff:ACCOUNT', category: 'ACCOUNT', pattern: { categories: '{SalonStaff}' } }).rows();
  const [эндпоинт] = await db.Resource().create({ alias: 'salon.book.read:API', category: 'API', pattern: { endpoint: 'salon.book.*' } }).rows();
  assert.ok((await db.Resource({ category: 'API' }).ids()).includes(эндпоинт.id));
  await fails(() => db.Resource().create({ alias: 'salon.book.read:API', category: 'API' }).rows(), 'exists');
  // правило: группа → объект
  const [правило] = await db.rule().create({ permission: 'allow', weight: 50 }).Group.set(группа).Object.set(эндпоинт).rows();
  assert.equal((await db.Resource(эндпоинт.id).rule().ids()).length, 1);

  const d = await зоя.acl.check('salon.book.read');
  assert.equal(d.allow, true);
  assert.equal(d.rule?.weight, 50);
  assert.equal((await касса.acl.check('salon.book.read')).allow, false, 'категории SalonStaff нет — правило не про кассира');
  // данные класса: тестовому арендатору выдано «аутентифицированным можно всё»
  assert.equal((await зоя.acl.checkData('booking', 'READ')).allow, true);

  // уборка: правило, затем ресурсы — права пересчитываются базой сами (reload снят)
  await db.rule(правило.id).delete({ confirm: true }).rows();
  assert.equal((await зоя.acl.check('salon.book.read')).allow, false);
  await db.Resource([эндпоинт.id, группа.id]).delete({ confirm: true }).rows();
  assert.equal(await db.Resource([эндпоинт.id, группа.id]).count(), 0);
});

// ===========================================================================
// АКТ 20. Изоляция арендаторов и наблюдаемость — RLS всегда, as(), owner, onQuery/slowMs
// покрывает: as, owner (фильтр), tags-значение в create, connect({ onQuery, slowMs })
// ===========================================================================
test('Акт 20. Аренда и наблюдаемость: изоляция арендаторов, владелец новых строк, onQuery/slowMs', async () => {
  // другой арендатор: свои строки видит, чужие — нет (enforceAccount снят: изоляция всегда)
  const u = await e.tenant('Частный мастер');
  const чужой = await open({ token: u.token });
  const [своя] = await чужой.Организация().create({ name: 'Частная' }).rows();
  assert.equal(своя.tenant, u.id);
  assert.equal(await чужой.Организация().count(), 1, 'только своя');
  assert.equal(await чужой.Организация(S.org.id).count(), 0, 'салон невидим');
  assert.equal(await db.Организация(своя.id).first(), null, 'и наоборот');
  // тот же ключ (Org, name) в другом арендаторе — другой id: пространство v5 — арендатор
  const [чужаяУслуга] = await чужой.Организация(своя).Услуга().create({ name: 'Стрижка', duration: 40 }).rows();
  assert.notEqual(чужаяУслуга.id, S.стрижка.id);

  // владелец новых строк — сотрудница: db.as(null, { owner }); теги — значением при создании
  const отЗои = await db.as(null, { owner: A.зоя.id });
  const [спец] = await отЗои.Организация(S.org).Услуга().tags(['акция', 'сезон']).create({ name: 'Спец', duration: 20 }).rows();
  assert.equal(спец.owner, A.зоя.id);
  assert.deepEqual([...спец.tags].sort(), ['акция', 'сезон']);
  assert.deepEqual(await db.Услуга().owner(A.зоя.id).ids(), [спец.id]);
  await db.Услуга(спец.id).delete({ confirm: true }).rows();

  // onQuery/slowMs — событие на каждый запрос цепочки
  const события: QueryEvent[] = [];
  const obs = await open({ token: t.token, onQuery: (q) => события.push(q), slowMs: 0 });
  assert.equal(await obs.Услуга().count(), 3);
  assert.equal(события.length, 1);
  assert.equal(события[0].mode, 'count');
  assert.ok(события[0].classes.includes('Service'));
  assert.equal(события[0].slow, события[0].ms > 0, 'slowMs: 0 — медленный всякий запрос дольше 0 мс');
});

// ===========================================================================
// АКТ 21. Охранники и ошибки — валидация, пути, глаголы, слоты, служебные отказы
// покрывает: ValidationError, set/unset/add/remove вне слота, commit/rollback/lock вне транзакции, load, verify,
//            maintain, rekeyClass
// ===========================================================================
test('Акт 21. Охранники: валидация, пути, слоты, служебные права', async () => {
  // строгая валидация данных
  await assert.rejects(db.Организация(S.org).Услуга().create({ name: 'Плохая', duration: -1 }).rows(), ValidationError);
  await assert.rejects(db.Организация(S.org).Услуга().create({ name: 'Лишнее', duration: 10, xx: 1 }).rows(), ValidationError);

  // невалидные пути — при построении цепочки
  await fails(() => db.Локация(S.зал).Клиент(), 'no_path');
  await fails(() => db.Нечто(), 'invalid_class');

  // методы слота вне слота; add/remove — только у концов-множеств (в booking их нет)
  await fails(() => (db.Услуга() as unknown as { set: (d: object) => void }).set({}), 'invalid_query');
  await fails(() => (db.Услуга() as unknown as { unset: () => void }).unset(), 'invalid_query');
  await fails(() => db.запись(S.зАни15.id).update().Клиент.add(S.аня).rows(), 'invalid_query');
  await fails(() => db.запись(S.зАни15.id).update().Клиент.remove(S.аня).rows(), 'invalid_query');
  await fails(() => db.запись(S.зАни15.id).update().Папка.set(S.волосы).rows(), 'invalid_query');

  // цепочка не thenable: await без терминала запроса не шлёт
  assert.equal((db.Услуга() as unknown as { then?: unknown }).then, undefined);

  // транзакционные методы вне db.begin()
  await fails(() => db.commit(), 'tx_required');
  await fails(() => db.rollback(), 'tx_required');
  await fails(() => db.lock('x'), 'tx_required');

  // служебные операции: загрузчик — только администраторское подключение; maintain — системный администратор
  await fails(() => db.load([]), 'admin_required');
  await fails(() => db.maintain(), 'acl_denied');
  // ключ меняют только у собственных классов арендатора; Service — системный класс демо-домена
  await fails(() => db.rekeyClass('Услуга', ['name']), 'invalid_class');
  const m = await adb.maintain();
  assert.equal(m.skipped, false);
});

// ===========================================================================
// МАТРИЦА ПОКРЫТИЯ API 1.0 → акт
// ===========================================================================
/** Живые методы цепочки и свойства db, которые задевает сценарий, — акт. */
const COVERED: Record<string, string> = {
  // цепочка
  entity: 'А11', paths: 'А11 А13', rows: 'везде', first: 'А6', ids: 'А4 А13', count: 'А3 А8', limit: 'А5', offset: 'А13',
  sort: 'А5 А13', asOf: 'А14', withDeleted: 'А10 А16', deep: 'А3', exact: 'А5', sum: 'А13', avg: 'А13', min: 'А13',
  max: 'А13', countBy: 'А13', after: 'А13', versions: 'А9 А10 А14', create: 'везде', update: 'А9 А14', upsert: 'А4',
  set: 'А3 А9 (слот), А21 (вне слота)', unset: 'А9 (слот), А21', add: 'А21 (охранник одиночного конца)',
  remove: 'А21 (охранник одиночного конца)', delete: 'А9 А10 А19', anonymize: 'А16', reclass: 'А13', restore: 'А10',
  purge: 'А16', alias: 'А13', tags: 'А13 А20', owner: 'А20', forUpdate: 'А6', cache: 'А13', rekey: 'А13',
  // db
  as: 'А20', begin: 'А6 А7 А9', commit: 'А6 А7 А21', rollback: 'А7 А21', lock: 'А6 А7 А21', batch: 'А1 А5',
  watch: 'А15', close: 'везде', registry: 'А1', sql: 'А1', load: 'А21 (admin_required)',
  maintain: 'А21', auth: 'А17 А18', acl: 'А19', idOf: 'А5 А6',
  refresh: 'А15', transaction: 'А1', flushSignals: 'А15', schema: 'А1', token: 'А1', tenant: 'А1 А17',
  rekeyClass: 'А21 (invalid_class: системный класс арендатору не перекодировать)',
  // батч
  run: 'А1', discard: 'А1', size: 'А1',
};
/** Имена, которых сценарий осознанно не касается как методов, — с причиной. */
const NOT_TOUCHED: Record<string, string> = {
  then: 'не метод: цепочка нарочно не thenable (А21 проверяет, что then === undefined)',
};

test('Матрица покрытия: каждый метод цепочки, свойство db и батча — в акте или исключение с причиной', async () => {
  const all = [...new Set<string>([...CHAIN_METHODS, ...DB_METHODS, ...BATCH_METHODS])];
  const lists = { COVERED, NOT_TOUCHED };
  for (const name of all) {
    const where = Object.entries(lists).filter(([, l]) => name in l).map(([k]) => k);
    assert.equal(where.length, 1, `${name}: должен быть ровно в одном списке, найден в [${where.join(', ')}]`);
  }
  for (const l of Object.values(lists)) for (const name of Object.keys(l)) assert.ok(all.includes(name), `${name}: нет в API 1.0`);

  // покрытое действительно вызывается в тексте актов (до матрицы), а не только объявлено
  const src = readFileSync(import.meta.filename, 'utf8');
  const acts = src.slice(0, src.indexOf('// МАТРИЦА ПОКРЫТИЯ API 1.0'));
  for (const name of Object.keys(COVERED)) {
    assert.match(acts, new RegExp(`[.\\[{'] ?${name}\\b`), `${name}: не встречается в актах`);
  }
});
