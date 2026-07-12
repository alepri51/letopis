/**
 * ТЕСТ-ПЛАН «САЛОН»: имитация работы салона красоты, покрывающая ВСЕ публичные API letopis.
 *
 * Сквозной сценарий: открытие салона → каталог и мастера → расписание → записи клиентов
 * (гонки, переносы, отмены) → отчёты → realtime → приватность → вход/доступ → администрирование.
 * Каждый акт (test) в шапке перечисляет покрываемые API-точки [#N] из матрицы (см. конец файла).
 *
 * Схема — v1.salon (booking-домен), изолирована: гоняется независимо от прочих файлов.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import Redis from 'ioredis';
import {
  connect, up, cursorOf, totpCode, ValidationError, Registry,
  ne, gt, gte, lt, lte, between, inList, like, ilike, starts, ends,
  has, hasAny, hasAll, exists, isNull, not, or,
} from '../src/index.js';
import { uuidv5 } from '../src/uuid.js';
import type { EntityDb, EntityTx, Row } from '../src/chain.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const REDIS = process.env.ENTITY_REDIS ?? 'redis://localhost:16379';
const SCHEMA = 'v1.salon';
const here = dirname(fileURLToPath(import.meta.url));

/** Именованный склад сущностей сцены (общий между актами). */
const S: Record<string, Row> = {};
let db: EntityDb;
let redis: Redis;

// детерминированные окна дня: 10:00…18:00, часовые
const iso = (h: number) => `2026-08-01T${String(h).padStart(2, '0')}:00:00+03:00`;
/** Schema: занятость id = uuidv5(Slot, Staff) — формула открыта, id знаем ДО создания. */
const busyId = (staff: Row, slot: Row) => uuidv5(`${SCHEMA}:entity:busy:${slot.id}:${staff.id}`);

before(async () => {
  const admin = postgres(DSN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.end();
  execFileSync('node', [join(here, '../../db/apply.mjs'), `--dsn=${DSN}`, '--schema=salon', '--version=1'], { stdio: 'ignore' });
  db = await connect({ dsn: DSN, schema: SCHEMA });
  redis = new Redis(REDIS);
});
after(async () => {
  await db.close();
  redis.disconnect();
});

// ===========================================================================
// АКТ 1. Открытие салона — connect-опции, System-fallback, создание HUB, батч
// покрывает: [1 connect][30 db.Класс][53 create][21 registry][22 sql]
//            [117-126 ConnectOpts][78-81 batch][17 db.batch]
// ===========================================================================
test('Акт 1. Открытие: организация, филиалы, владелец — HUB-создание и батч', async () => {
  // connect уже открыт в before (schema/partition/dsn/max — ConnectOpts [117-122])
  assert.ok(db.registry instanceof Registry);                       // [21][6-10 Registry]
  assert.equal(db.registry.resolve('Организация').id, 'Org');       // [8]
  assert.ok(db.registry.has('позиция'));                            // [9]
  assert.ok(db.registry.all.length >= 15);                          // [10]

  const [org] = await db.Организация().create({ name: 'Салон «Локоны»', phone: '+7 900 111', timezone: 'Europe/Moscow' }).rows(); // [30][53]
  assert.equal(org.data.name, 'Салон «Локоны»');

  // System-fallback: без account в connect строки получают System-аккаунт
  const sysRows = await db.sql.unsafe(`SELECT id FROM "${SCHEMA}"."Account" WHERE 'System' = ANY(categories) LIMIT 1`); // [22]
  assert.equal(org.account, (sysRows as unknown as { id: string }[])[0].id);

  // батч: два мастера-заготовки одним заходом (multi-VALUES склейка чистых INSERT)
  const b = db.batch('setup');                                      // [17]
  b.Организация(org).Сотрудник().create({ name: 'Ольга', roles: ['owner', 'master'] }); // [81]
  b.Организация(org).Сотрудник().create({ name: 'Ирина', roles: ['master'] });
  assert.equal(b.size(), 2);                                        // [80]
  const res = await b.run();                                        // [78]
  assert.equal(res.length, 2);
  assert.equal(b.size(), 0);                                        // очередь дренирована

  Object.assign(S, { org, ольга: res[0][0], ирина: res[1][0] });

  // discard: план в очередь — и выброшен
  const b2 = db.batch('scratch');
  b2.Организация(org).Клиент().create({ name: 'Черновик' });
  assert.equal(b2.size(), 1);
  b2.discard();                                                     // [79]
  assert.equal(b2.size(), 0);
});

// ===========================================================================
// АКТ 2. up() — вторая точка входа (идемпотентна на живом postgres)
// покрывает: [2 up][127-137 UpOpts]
// ===========================================================================
test('Акт 2. up(): вход одной функцией на уже живой БД (docker пропускается)', async () => {
  const dbUp = await up({ dsn: DSN, schema: 'salon', version: 1, quiet: true }); // [2][127-129][136]
  assert.equal(await dbUp.Организация({ name: 'Салон «Локоны»' }).count(), 1);    // та же схема v1.salon
  await dbUp.close();
});

// ===========================================================================
// АКТ 3. Каталог — папки (deep-иерархия), услуги, комплексы, состав комплекса
// покрывает: [30][53][42 deep][32 rows][58 навигация][56 слот .set]
// ===========================================================================
test('Акт 3. Каталог: папки-дерево, услуги, комплекс + состав через слот', async () => {
  const { org } = S;
  const [корень] = await db.Организация(org).Папка().create({ name: 'Каталог' }).rows();
  const [волосы] = await db.Организация(org).Папка(корень).Папка().create({ name: 'Волосы' }).rows(); // Папка→Папка (self)

  const [стрижка] = await db.Организация(org).Папка(волосы).Услуга().create({ name: 'Стрижка', duration: 60, price: { RUB: 1500 } }).rows();
  const [укладка] = await db.Организация(org).Папка(волосы).Услуга().create({ name: 'Укладка', duration: 30, price: { RUB: 900 } }).rows();
  const [борода] = await db.Организация(org).Услуга().create({ name: 'Борода', duration: 30, price: { RUB: 800 }, description: 'моделирование' }).rows();

  // комплекс + его состав (LINK «состав» = [Комплекс, Услуга]) — предмет слотом
  const [набор] = await db.Организация(org).Комплекс().create({ name: 'Образ', duration: 90, discount: 10 }).rows();
  await db.Комплекс(набор).состав().create({ qty: 1 }).Услуга.set(стрижка).rows();  // [56 слот]
  await db.Комплекс(набор).состав().create({ qty: 1 }).Услуга.set(укладка).rows();

  // deep: вся ветка папок от корня
  const ветка = await db.Организация(org).Папка(корень).Папка().deep().rows();    // [42]
  assert.ok(ветка.some((f) => f.data.name === 'Волосы'));

  // состав комплекса читается: Комплекс→состав→Услуга
  const состав = await db.Комплекс(набор).состав().Услуга().rows();               // [58]
  assert.deepEqual(состав.map((r) => r.data.name).sort(), ['Стрижка', 'Укладка']);

  Object.assign(S, { корень, волосы, стрижка, укладка, борода, набор });
});

// ===========================================================================
// АКТ 4. Мастера и навыки — слоты (союз Услуга|Комплекс), pivot-фильтр умений
// покрывает: [56][58 чтение навык][52 pivot/entity через повтор]
// ===========================================================================
test('Акт 4. Навыки мастеров: слоты, союз-конец, проверка умения через pivot', async () => {
  const { ольга, ирина, стрижка, укладка, борода, набор } = S;
  // навык [Сотрудник, Услуга|Комплекс] — владелец из пути, предмет слотом
  await db.Сотрудник(ольга).навык().create().Услуга.set(стрижка).rows();
  await db.Сотрудник(ольга).навык().create().Услуга.set(укладка).rows();
  await db.Сотрудник(ольга).навык().create().Комплекс.set(набор).rows();          // союз: предмет-Комплекс
  await db.Сотрудник(ирина).навык().create().Услуга.set(стрижка).rows();
  await db.Сотрудник(ирина).навык().create().Услуга.set(борода).rows();

  // умения Ольги
  const уменияО = await db.Сотрудник(ольга).навык().Услуга().rows();
  assert.deepEqual(уменияО.map((r) => r.data.name).sort(), ['Стрижка', 'Укладка']);
  assert.equal(await db.Сотрудник(ольга).навык().Комплекс().count(), 1);

  // «умеет ли Ирина бороду» — pivot: навык, дофильтр по предмету, возврат
  const умеет = await db.Сотрудник(ирина).навык().Услуга(борода).навык().count();  // [52 pivot]
  assert.equal(умеет, 1);
  const неУмеет = await db.Сотрудник(ирина).навык().Услуга(укладка).навык().count();
  assert.equal(неУмеет, 0);
});

// ===========================================================================
// АКТ 5. Расписание и ростер — окна батчем, смены (слот), off-исключение
// покрывает: [53][81][56 слот][39 sort][37 limit]
// ===========================================================================
test('Акт 5. Расписание: окна дня батчем, ростер сменами, выходное окно off', async () => {
  const { org, ольга, ирина } = S;
  const [расп] = await db.Организация(org).Расписание().create({ start: iso(10), end: iso(18) }).rows();

  const b = db.batch('окна');
  for (let h = 10; h < 18; h++) b.Расписание(расп).Окно().create({ start: iso(h), end: iso(h + 1) });
  const созданы = await b.run();
  assert.equal(созданы.length, 8);

  // sort работает; окна берём из результата батча по порядку (timestamptz нормализуется —
  // сравнение ISO-строк ненадёжно, а порядок вставки сохранён)
  assert.equal((await db.Расписание(расп).Окно().sort('data.start').rows()).length, 8); // [39]
  const w = (h: number) => созданы[h - 10][0];

  // ростер: обе мастерицы работают в расписании (смена = [Расписание, Сотрудник])
  await db.Расписание(расп).смена().create().Сотрудник.set(ольга).rows();
  await db.Расписание(расп).смена().create().Сотрудник.set(ирина).rows();
  const ростер = await db.Расписание(расп).смена().Сотрудник().rows();
  assert.deepEqual(ростер.map((r) => r.data.name).sort(), ['Ирина', 'Ольга']);

  // Ирина не работает в 17:00 — off-занятость (владелец Сотрудник, окно слотом)
  await db.Сотрудник(ирина).занятость().create({ kind: 'off', reason: 'учёба' }).Окно.set(w(17)).rows(); // id считает схема (v5)

  Object.assign(S, { расп, окна10: w(10), окна11: w(11), окна12: w(12), окна17: w(17) });
});

// ===========================================================================
// АКТ 6. Клиенты и первая бронь — транзакция + advisory-lock, позиция+занятость
// покрывает: [11 begin][14 tr.commit][16 tr.lock][53][56][33 first]
// ===========================================================================
test('Акт 6. Бронь №1: Аня → Ольга, стрижка 10:00 (транзакция + lock)', async () => {
  const { org, ольга, стрижка, окна10 } = S;
  const [аня] = await db.Организация(org).Клиент().create({ name: 'Аня', contact: '+7 911 001' }).rows();

  const tr: EntityTx = await db.begin();                            // [11]
  try {
    await tr.lock('busy', ольга.id, окна10.id);                     // [16]
    assert.equal(await tr.занятость(busyId(ольга, окна10)).first(), null); // [33] окно свободно
    const [зап] = await tr.Клиент(аня).Запись().create({ status: 'created', source: 'online', total: { RUB: 1500 } }).rows();
    // позиция: владелец Запись из пути, предмет+исполнитель слотами
    await tr.Запись(зап).позиция().create({ qty: 1, price: { RUB: 1500 } }).Услуга.set(стрижка).Сотрудник.set(ольга).rows();
    // занятость: владелец Сотрудник, окно+запись слотами
    await tr.Сотрудник(ольга).занятость().create({ kind: 'booking' }).Окно.set(окна10).Запись.set(зап).rows(); // id = v5(окно, мастер)
    await tr.commit();                                             // [14]
    S.зАни = зап;
    S.аня = аня;
  } catch (e) {
    await tr.rollback();
    throw e;
  }
  assert.equal(await db.занятость(busyId(ольга, окна10)).count(), 1);
});

// ===========================================================================
// АКТ 7. Гонка двойной брони — две транзакции на одну пару (мастер, окно)
// покрывает: [11][15 tr.rollback][16 lock][54 delete в откате не нужен]
// ===========================================================================
test('Акт 7. Гонка: Боря и Вера одновременно на Ольгу 11:00 → ровно один успех', async () => {
  const { org, ольга, стрижка, окна11 } = S;
  const [боря] = await db.Организация(org).Клиент().create({ name: 'Боря' }).rows();
  const [вера] = await db.Организация(org).Клиент().create({ name: 'Вера' }).rows();

  const попытка = async (клиент: Row, label: string): Promise<string | null> => {
    const tr = await db.begin();
    try {
      await tr.lock('busy', ольга.id, окна11.id);
      if (await tr.занятость(busyId(ольга, окна11)).first()) { await tr.rollback(); return null; } // [15]
      const [зап] = await tr.Клиент(клиент).Запись().create({ status: 'created', total: { RUB: 1500 } }).rows();
      await tr.Запись(зап).позиция().create({ qty: 1 }).Услуга.set(стрижка).Сотрудник.set(ольга).rows();
      await tr.Сотрудник(ольга).занятость().create({ kind: 'booking' }).Окно.set(окна11).Запись.set(зап).rows();
      await tr.commit();
      return label;
    } catch (e) {
      await tr.rollback();
      if ((e as { code?: string }).code === '23505') return null; // конкурент успел
      throw e;
    }
  };
  const итог = await Promise.all([попытка(боря, 'боря'), попытка(вера, 'вера')]);
  assert.equal(итог.filter(Boolean).length, 1);                    // ровно один
  assert.equal(await db.занятость(busyId(ольга, окна11)).count(), 1);
});

// ===========================================================================
// АКТ 8. «4 руки»: одна запись — две услуги у двух мастеров (мульти-мастер)
// покрывает: [53][56][32][35 count]
// ===========================================================================
test('Акт 8. Комбо-запись: Аня — стрижка у Ольги + борода у Ирины, 12:00', async () => {
  const { ольга, ирина, стрижка, борода, окна12, аня } = S;
  const [зап] = await db.Клиент(аня).Запись().create({ status: 'created', total: { RUB: 2300 } }).rows();
  await db.Запись(зап).позиция().create({ qty: 1, price: { RUB: 1500 } }).Услуга.set(стрижка).Сотрудник.set(ольга).rows();
  await db.Запись(зап).позиция().create({ qty: 1, price: { RUB: 800 } }).Услуга.set(борода).Сотрудник.set(ирина).rows();
  await db.Сотрудник(ольга).занятость().create({ kind: 'booking' }).Окно.set(окна12).Запись.set(зап).rows();
  await db.Сотрудник(ирина).занятость().create({ kind: 'booking' }).Окно.set(окна12).Запись.set(зап).rows();

  assert.equal(await db.Запись(зап).позиция().count(), 2);
  // оба мастера заняты в 12:00 (Окно→занятость→Сотрудник)
  const занятыеВ12 = await db.Окно(окна12).занятость({ kind: 'booking' }).Сотрудник().rows();
  assert.deepEqual(занятыеВ12.map((r) => r.data.name).sort(), ['Ирина', 'Ольга']);
  S.зКомбо = зап;
});

// ===========================================================================
// АКТ 9. Операции дня — перевес мастера (слот), союз-замена предмета, снятие
// покрывает: [56 слот .set перевес][57 слот .unset][52 pivot перевес][36 versions]
// ===========================================================================
test('Акт 9. Перенос исполнителя: позиции Ольги в комбо-записи → Ирине; союз-замена; снятие', async () => {
  const { зКомбо, ольга, ирина, стрижка, набор, зАни } = S;
  // перевес: позиции комбо-записи, где мастер Ольга → Ирине (pivot-поиск + слот-запись)
  const перевес = await db.Запись(зКомбо).позиция().Сотрудник(ольга).позиция().update().Сотрудник.set(ирина).rows(); // [52][56]
  assert.equal(перевес.length, 1);
  assert.equal(перевес[0].links.Staff, ирина.id);
  // версий позиции стало 2 (создание + перевес)
  assert.equal((await db.позиция(перевес[0].id).versions()).length, 2);          // [36]

  // союз-замена: у позиции записи Ани предмет Стрижка → Комплекс «Образ» (конец один)
  const [позАни] = await db.Запись(зАни).позиция().rows();
  const [зам] = await db.позиция(позАни.id).update().Комплекс.set(набор).rows();
  assert.ok(!('Service' in зам.links), 'Услуга снята');
  assert.equal(зам.links.Complex, набор.id);
  // вернуть обратно (для дальнейших актов) — Услуга замещает Комплекс
  await db.позиция(позАни.id).update().Услуга.set(стрижка).rows();

  // снятие optional-конца: у занятости Ани убрать связь Запись (станет hold без брони)
  const [busyAni] = await db.Запись(зАни).занятость().rows();
  const [снято] = await db.занятость(busyAni.id).update({ kind: 'hold' }).Запись.unset().rows();  // [57]
  assert.ok(!('Booking' in снято.links));
  // required-конец снять нельзя
  assert.throws(() => db.занятость(busyAni.id).update().Окно.unset(), /required — cannot unset/);
  // вернуть booking-связь
  await db.занятость(busyAni.id).update({ kind: 'booking' }).Запись.set(зАни).rows();
});

// ===========================================================================
// АКТ 10. Отмена записи — превью delete, затем каскадный tombstone
// покрывает: [54 delete превью/confirm][32]
// ===========================================================================
test('Акт 10. Отмена комбо-записи: превью каскада, затем tombstone', async () => {
  const { зКомбо } = S;
  const превью = await db.Запись(зКомбо).delete().rows();          // [54 без confirm]
  const классыПревью = new Set(превью.map((r) => r.class));
  assert.ok(классыПревью.has('Booking') && классыПревью.has('item') && классыПревью.has('busy'));
  assert.ok(превью.every((r) => r.$deleted === undefined));        // БД не тронута
  assert.ok(await db.Запись(зКомбо).first());

  const удалено = await db.Запись(зКомбо).delete({ confirm: true }).rows(); // [54 confirm]
  assert.ok(удалено.every((r) => r.$deleted === true));
  assert.equal(await db.Запись(зКомбо).count(), 0);
  // каскад освободил окна Ольги и Ирины в 12:00
  assert.equal(await db.занятость({ kind: 'booking' }).Запись(зКомбо).занятость().count(), 0);
});

// ===========================================================================
// АКТ 11. entity() — узел-переменная и старт с готового Row
// покрывает: [29 db.entity][52 entity внутри]
// ===========================================================================
test('Акт 11. entity(): переменная-узел в пути и старт от Row', async () => {
  const { зАни, стрижка } = S;
  // entity(Row): начать путь с конкретной позиции
  const [позАни] = await db.Запись(зАни).позиция().rows();
  const услугаПоз = await db.entity(позАни).Услуга().first();                    // [29]
  assert.equal(услугаПоз?.id, стрижка.id);

  // entity(chain) как узел-переменная: та же переменная = тот же узел (pivot)
  const поз = db.позиция();
  const пути = await db.Запись(зАни).entity(поз).Услуга(стрижка).entity(поз).Сотрудник().run(); // [52]
  assert.ok(пути.length >= 1);
  assert.ok(пути.every((p) => p['Сотрудник']));
});

// ===========================================================================
// АКТ 12. Отчёты — все 18 операторов фильтра
// покрывает: [60-77 операторы][35 count]
// ===========================================================================
test('Акт 12. Отчёты: 18 операторов фильтра на каталоге', async () => {
  const c = (f: Parameters<typeof db.Услуга>[0]) => db.Услуга(f).count();
  assert.equal(await c({ duration: ne(60) }), 2);              // [60] ne (укладка30,борода30)
  assert.equal(await c({ duration: gt(30) }), 1);             // [61] gt
  assert.equal(await c({ duration: gte(30) }), 3);            // [62] gte
  assert.equal(await c({ duration: lt(60) }), 2);            // [63] lt
  assert.equal(await c({ duration: lte(30) }), 2);           // [64] lte
  assert.equal(await c({ duration: between(25, 35) }), 2);   // [65] between
  assert.equal(await c({ name: inList(['Стрижка', 'Борода']) }), 2); // [66] inList
  assert.equal(await c({ name: like('Стр%') }), 1);          // [67] like
  assert.equal(await c({ name: ilike('бОрОдА') }), 1);       // [68] ilike
  assert.equal(await c({ name: starts('Укл') }), 1);         // [69] starts
  assert.equal(await c({ name: ends('дка') }), 1);           // [70] ends
  assert.equal(await db.Сотрудник({ roles: has('owner') }).count(), 1);            // [71] has
  assert.equal(await db.Сотрудник({ roles: hasAny(['owner', 'x']) }).count(), 1);  // [72] hasAny
  assert.equal(await db.Сотрудник({ roles: hasAll(['owner', 'master']) }).count(), 1); // [73] hasAll
  assert.equal(await c({ description: exists() }), 1);       // [74] exists
  assert.equal(await c({ description: isNull() }), 2);       // [75] isNull
  assert.equal(await c({ name: not(ilike('стр%')) }), 2);    // [76] not
  assert.equal(await db.Услуга(or({ name: 'Стрижка' }, { duration: lt(40) })).count(), 3); // [77] or
});

// ===========================================================================
// АКТ 13. Аналитика — агрегации, сортировки, keyset-пагинация, alias, tags
// покрывает: [43 sum][44 avg][45 min][46 max][47 countBy][39 sort][38 offset]
//            [41 after][3 cursorOf][48 alias][49 tags][34 ids][31 run]
// ===========================================================================
test('Акт 13. Аналитика: агрегации, keyset, alias, tags', async () => {
  // агрегации по цене услуг (record-путь data.price.RUB)
  assert.equal(await db.Услуга().sum('data.price.RUB'), 1500 + 900 + 800);        // [43]
  assert.ok(Math.abs((await db.Услуга().avg('data.price.RUB'))! - 1066.67) < 1);  // [44]
  assert.equal(await db.Услуга().min('data.duration'), 30);                       // [45]
  assert.equal(await db.Услуга().max('data.duration'), 60);                       // [46]
  const byDur = await db.Услуга().countBy('data.duration');                       // [47]
  assert.equal(byDur['30'], 2);

  // keyset-пагинация по длительности: страница 1 → курсор → страница 2
  const p1 = await db.Услуга().sort('data.duration').limit(2).rows();
  assert.equal(p1.length, 2);
  const cur = cursorOf(p1[p1.length - 1], 'data.duration');                       // [3]
  const p2 = await db.Услуга().sort('data.duration').after(cur).rows();           // [41]
  assert.equal(p2.length, 1);
  assert.ok(!p2.some((r) => p1.find((x) => x.id === r.id)));                      // без пересечений

  // offset/ids
  assert.equal((await db.Услуга().sort('data.duration').offset(1).ids()).length, 2); // [38][34]

  // alias: переименование ключа шага в путях
  const пути = await db.Сотрудник(S.ольга).alias('Мастер').навык().Услуга().run();   // [48][31]
  assert.ok(пути[0]['Мастер'] && пути[0]['Мастер'].data.name === 'Ольга');

  // tags: значение при создании (модификатор tags в записи = метки строки) + поиск по тегу
  const [хит] = await db.Организация(S.org).Услуга().tags('топ').create({ name: 'Хит сезона', duration: 45, price: { RUB: 2500 } }).rows(); // [49]
  const поТегу = await db.Услуга().tags('топ').rows();
  assert.equal(поТегу.length, 1);
  assert.equal(поТегу[0].id, хит.id);
  await db.Услуга(хит.id).delete({ confirm: true }).rows();
});

// ===========================================================================
// АКТ 14. История — asOf, versions (машина времени по цене услуги)
// покрывает: [40 asOf][36 versions]
// ===========================================================================
test('Акт 14. История: asOf и versions по изменению цены', async () => {
  const { борода } = S;
  const before = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 10));
  await db.Услуга(борода).update({ price: { RUB: 1000 } }).rows();  // подорожание

  const сейчас = await db.Услуга(борода).first();
  assert.equal((сейчас!.data.price as { RUB: number }).RUB, 1000);
  const тогда = await db.Услуга(борода).asOf(before).first();       // [40]
  assert.equal((тогда!.data.price as { RUB: number }).RUB, 800);

  const версии = await db.Услуга(борода).versions();                // [36]
  assert.ok(версии.length >= 2);
  assert.deepEqual(версии.map((v) => (v.data.price as { RUB: number }).RUB), [800, 1000]);
});

// ===========================================================================
// АКТ 15. Realtime — watch (все классы и один класс)
// покрывает: [18 watch all][19 watch cls][20 close сокрыт в others]
// ===========================================================================
test('Акт 15. Realtime: watch ловит новые версии', async () => {
  const события: string[] = [];
  const stopAll = await db.watch((e) => события.push(`*:${e.class}`));            // [18]
  const клиентские: string[] = [];
  const stopCls = await db.watch('Клиент', (e) => клиентские.push(e.id));         // [19]
  await new Promise((r) => setTimeout(r, 100));

  const [гость] = await db.Организация(S.org).Клиент().create({ name: 'Гость' }).rows();
  await new Promise((r) => setTimeout(r, 200));

  await stopAll();
  await stopCls();
  assert.ok(события.some((s) => s === '*:Customer'));
  assert.ok(клиентские.includes(гость.id));
});

// ===========================================================================
// АКТ 16. Приватность — anonymize (GDPR), проверка что история цела
// покрывает: [55 anonymize]
// ===========================================================================
test('Акт 16. GDPR: anonymize клиента, история сохранена', async () => {
  const { org } = S;
  const [клиент] = await db.Организация(org).Клиент().create({ name: 'Пётр Удаляев', contact: 'secret@mail' }).rows();
  const [аноним] = await db.Клиент(клиент.id).anonymize(['name', 'contact']).rows();  // [55]
  assert.equal(аноним.data.name, '[erased]');
  assert.equal(аноним.data.contact, '[erased]');
  assert.ok(аноним.tags.includes('anonymized'));
  // история: первая версия ещё хранит настоящее имя
  const версии = await db.Клиент(клиент.id).versions();
  assert.equal(версии[0].data.name, 'Пётр Удаляев');
});

// ===========================================================================
// АКТ 17. Вход — db.auth: пароль, api-key, key-secret, TOTP, OTP, внешний identity
// покрывает: [27 db.auth][23 db.accounts][82-88 accounts/credentials][96-108 auth]
// ===========================================================================
test('Акт 17. Вход: все способы аутентификации мастера', async () => {
  // аккаунт мастера (служебные таблицы)
  const acc = await db.accounts.set({ categories: ['Staff'], data: { name: 'Ольга' } }); // [84]
  assert.ok(await db.accounts.get(acc.id));                                        // [83]
  assert.ok((await db.accounts.find({ category: 'Staff' })).length >= 1);          // [82]

  // пароль
  await db.auth.setPassword({ account: acc.id, identifier: 'olga@salon.ru', password: 'Secr3t!' }); // [96]
  assert.ok(await db.auth.verifyPassword({ identifier: 'olga@salon.ru', password: 'Secr3t!' }));    // [97]
  assert.equal(await db.auth.verifyPassword({ identifier: 'olga@salon.ru', password: 'wrong' }), null);

  // api-key (в БД только sha256)
  const { key } = await db.auth.issueApiKey({ account: acc.id, name: 'касса' });   // [98]
  assert.ok(await db.auth.verifyApiKey(key));                                      // [99]
  assert.equal(await db.auth.verifyApiKey('lts_deadbeef'), null);

  // key-secret
  const ks = await db.auth.issueKeySecret({ account: acc.id });                    // [100]
  assert.ok(await db.auth.verifyKeySecret(ks.key, ks.secret));                     // [101]

  // TOTP: enroll → код → verify (активирует фактор)
  const totp = await db.auth.enrollTotp({ account: acc.id, issuer: 'Локоны' });    // [102]
  assert.equal(await db.auth.totpEnabled(acc.id), false);                          // [104] до подтверждения
  const code = totpCode(totp.secret);                                              // [4]
  assert.ok(await db.auth.verifyTotp({ account: acc.id, code }));                  // [103]
  assert.equal(await db.auth.totpEnabled(acc.id), true);

  // OTP: одноразовый код
  const otp = await db.auth.issueOtp({ account: acc.id, identifier: '+7 900 111' }); // [105]
  assert.ok(await db.auth.verifyOtp({ identifier: '+7 900 111', code: otp.code }));  // [106]
  assert.equal(await db.auth.verifyOtp({ identifier: '+7 900 111', code: otp.code }), null); // погашен

  // внешний identity: link + lookup (Telegram)
  await db.auth.link({ account: acc.id, category: 'TELEGRAM', identifier: '777000999' }); // [107]
  const found = await db.auth.lookup({ category: 'TELEGRAM', identifier: '777000999' });  // [108]
  assert.equal(found?.account.id, acc.id);

  // credentials-фасад: перечислить креды аккаунта, мягкое удаление
  const creds = await db.credentials.find({ account: acc.id });                    // [86]
  assert.ok(creds.length >= 5); // PASSWORD/APIKEY/KEYSECRET/TOTP/TELEGRAM (OTP погашен при verify)
  const apiCred = creds.find((c) => c.category === 'APIKEY')!;
  assert.ok(await db.credentials.delete(apiCred.id));                              // [88]
  assert.equal(await db.auth.verifyApiKey(key), null);                             // ключ отозван

  S.accOlga = acc as unknown as Row;
});

// ===========================================================================
// АКТ 18. Сессии в Redis — start/check/revoke/revokeAll
// покрывает: [109 sessions][110-113 session-методы]
// ===========================================================================
test('Акт 18. Сессии: живой Redis — вход, проверка, отзыв', async () => {
  const acc = S.accOlga as unknown as { id: string };
  const sessions = db.auth.sessions(redis);                                        // [109]
  const token = await sessions.start(acc.id, { ttlSec: 3600, meta: { ip: '10.0.0.1' } }); // [110]
  const checked = await sessions.check(token);                                     // [111]
  assert.equal(checked?.account, acc.id);
  assert.equal((checked?.meta as { ip: string }).ip, '10.0.0.1');

  assert.ok(await sessions.revoke(token));                                         // [112]
  assert.equal(await sessions.check(token), null);

  // revokeAll: две сессии гаснут разом
  await sessions.start(acc.id);
  await sessions.start(acc.id);
  assert.ok(await sessions.revokeAll(acc.id) >= 2);                                // [113]
});

// ===========================================================================
// АКТ 19. Доступ — db.acl + Resource/Rule фасады
// покрывает: [28 db.acl][25 resources][26 rules][89-95][114-116 acl]
// ===========================================================================
test('Акт 19. ACL: ресурс-субъект, ресурс-объект, правило, check/checkData', async () => {
  const мастер = await db.accounts.set({ categories: ['SalonStaff'] });            // субъект с категорией
  // ресурс-СУБЪЕКТ (маска категорий) + ресурс-ОБЪЕКТЫ (эндпоинт + данные класса)
  await db.resources.set({ alias: 'salonStaff:ACCOUNT', category: 'ACCOUNT', pattern: { categories: '{SalonStaff}' } }); // [91]
  await db.resources.set({ alias: 'salon.book.read:API', category: 'API', pattern: { endpoint: 'salon.book.read' } });
  await db.resources.set({ alias: 'booking.read:READ', category: 'READ', pattern: { class: 'Booking' } });
  assert.ok(await db.resources.get('salonStaff:ACCOUNT'));                          // [90]
  assert.ok((await db.resources.find({ category: 'API' })).length >= 1);           // [89]

  // Rule.account = alias ресурса-СУБЪЕКТА, Rule.resource = alias ресурса-объекта
  await db.rules.set({ account: 'salonStaff:ACCOUNT', resource: 'salon.book.read:API', permission: 'allow', weight: 50 }); // [92]
  await db.rules.set({ account: 'salonStaff:ACCOUNT', resource: 'booking.read:READ', permission: 'allow', weight: 50 });
  assert.ok((await db.rules.find({ account: 'salonStaff:ACCOUNT' })).length >= 2); // [93]

  // проверка доступа: эндпоинт (категории субъекта резолвятся из Account.categories)
  const d = await db.acl.check(мастер.id, 'salon.book.read');                       // [114]
  assert.equal(d.allow, true);
  // операция над данными класса
  const dd = await db.acl.checkData(мастер.id, 'Booking', 'READ');                  // [115]
  assert.equal(dd.allow, true);
  db.acl.reload();                                                                  // [116]

  // уборка: rules.delete по PK, resources.delete каскадит на правила
  assert.ok(await db.rules.delete('salonStaff:ACCOUNT', 'salon.book.read:API'));    // [95]
  assert.ok(await db.resources.delete('salon.book.read:API'));                      // [94]
  await db.resources.delete('salonStaff:ACCOUNT');
  await db.resources.delete('booking.read:READ');
});

// ===========================================================================
// АКТ 20. Изоляция арендатора + наблюдаемость — enforceAccount, onQuery/slowMs
// покрывает: [123 enforceAccount][125 onQuery][126 slowMs][138-141 set-контекст]
// ===========================================================================
test('Акт 20. Аренда и наблюдаемость: enforceAccount, onQuery/slowMs, tags/owner в create', async () => {
  // отдельный арендатор: свои строки видит, чужие — нет
  const tenant = await db.accounts.set({ categories: ['Client'] });
  const iso = await connect({ dsn: DSN, schema: SCHEMA, account: tenant.id, owner: tenant.id, enforceAccount: true }); // [123]
  const [своя] = await iso.Организация().create({ name: 'Частная' }).rows();
  assert.equal(своя.account, tenant.id);                                           // [139 owner/account в create INSERT]
  assert.equal(своя.owner, tenant.id);
  assert.equal(await iso.Организация().count(), 1);                                // только своя (чужие невидимы)
  await iso.close();

  // onQuery/slowMs — событие на каждый запрос
  const события: { mode: string; ms: number; slow: boolean }[] = [];
  const obs = await connect({ dsn: DSN, schema: SCHEMA, onQuery: (e) => события.push(e), slowMs: 0 }); // [125][126]
  await obs.Услуга().count();
  await obs.close();
  assert.ok(события.length >= 1);
  assert.equal(события[0].slow, true);                                             // slowMs:0 → всё slow

  // tags/owner как значения при INSERT (create-контекст)
  const [svc] = await db.Организация(S.org).Услуга().tags(['акция', 'сезон']).create({ name: 'Спец', duration: 20, price: { RUB: 500 } }).rows(); // [138]
  assert.deepEqual(svc.tags.sort(), ['акция', 'сезон']);
  await db.Услуга(svc.id).delete({ confirm: true }).rows();
});

// ===========================================================================
// АКТ 21. Гарды и ошибки — валидация, снесённые/переименованные методы, пути
// покрывает: [5 ValidationError][143 .link removed][144 .execute][145 batch.execute]
//            [58 no-path/LINK→LINK][59 слот-гард][12 commit-гард]
// ===========================================================================
test('Акт 21. Гарды: валидация, снесённые set()/.link/.delete-слот, execute→run, пути', async () => {
  // строгая валидация данных
  await assert.rejects(db.Организация(S.org).Услуга().create({ name: 'Плохая', duration: -1, price: { RUB: 1 } }).rows(), ValidationError); // [5]
  await assert.rejects(db.Организация(S.org).Услуга().create({ name: 'Лишнее', duration: 10, price: { RUB: 1 }, xx: 1 }).rows(), ValidationError);

  // невалидные пути — синхронно при построении
  assert.throws(() => db.Запись(S.зАни).Сотрудник(), /no path/);                   // [58] Booking→Staff
  assert.throws(() => db.позиция().навык(), /LINK → LINK/);                         // [58]

  // глаголы: create не ищет, update не создаёт; set() снесён
  assert.throws(() => db.Услуга({ name: 'X' }).create({}), /takes no filter/);     // [53] фильтр → update
  assert.throws(() => (db.Услуга() as unknown as { set: (d: object) => void }).set({}), /set\(\) split into create\(\)\/update\(\)/);

  // слот-гарды
  assert.throws(() => db.Запись(S.зАни).update().Сотрудник.set('x'), /is not a link end/);  // [59] не конец
  assert.throws(() => (db as unknown as { Сотрудник: { set(x: string): void } }).Сотрудник.set('x'), /needs an owner step/); // [59] без владельца
  assert.throws(() => db.занятость('x').Окно.set('y'), /needs a write/);           // [59] слот без операции
  assert.throws(
    () => (db.занятость('x').update() as unknown as { Запись: { delete(): void } }).Запись.delete(),
    /renamed to \.unset\(\)/,                                                      // [57] слот .delete снесён
  );

  // снесённые/переименованные
  assert.throws(() => (db.Услуга() as unknown as { link: (a: string, b: string) => void }).link('X', 'y'), /\.link\(\) removed/); // [143]
  assert.throws(() => (db.Услуга() as unknown as { execute: () => void }).execute(), /renamed to run/); // [144]
  assert.throws(() => (db.batch('g') as unknown as { execute: () => void }).execute(), /renamed to batch\.run/); // [145]

  // commit вне транзакции — ошибка
  await assert.rejects(async () => db.commit(), /needs a transaction/);            // [12]
});

/* =============================================================================
 * МАТРИЦА ПОКРЫТИЯ API (145 публичных точек) → акт
 * -----------------------------------------------------------------------------
 * Модуль:        connect[1]А1 up[2]А2 cursorOf[3]А13 totpCode[4]А17
 *                ValidationError[5]А21 Registry.add/find/resolve/has/all[6-10]А1
 * DbCore:        begin[11]А6 commit[12]А21гард rollback[13]А7 tr.commit[14]А6
 *                tr.rollback[15]А7 tr.lock[16]А6 batch[17]А1 watch·all[18]А15
 *                watch·cls[19]А15 close[20]везде registry[21]А1 sql[22]А1
 *                accounts[23]А17 credentials[24]А17 resources[25]А19 rules[26]А19
 *                auth[27]А17 acl[28]А19 db.entity[29]А11 db.Класс[30]А1
 * Чтение:        run[31]А13 rows[32]А3 first[33]А6 ids[34]А13 count[35]А8
 *                versions[36]А9/А14 limit[37]А13 offset[38]А13 sort[39]А5
 *                asOf[40]А14 after[41]А13 deep[42]А3 sum[43]А13 avg[44]А13
 *                min[45]А13 max[46]А13 countBy[47]А13 alias[48]А13 tags[49]А13
 *                account[50]А20 owner[51]А20 entity·pivot[52]А4/А9/А11
 * Запись:        create/update[53]А1/А9/А14 delete[54]А10 anonymize[55]А16
 *                слот.set[56]А3/А4/А9 слот.unset[57]А9
 * Навигация:     Класс()·pivot[58]А4/А9 слот-гард[59]А21
 * Операторы(18): ne..or[60-77]А12
 * Batch:         run[78]А1 discard[79]А1 size[80]А1 batch.Класс[81]А1/А5
 * accounts:      find[82] get[83] set[84]А17 delete·неявно
 * credentials:   find[86] set·неявно(auth) delete[88]А17
 * resources:     find[89] get[90] set[91] delete[94]А19
 * rules:         find[93] set[92] delete[95]А19
 * auth:          setPassword[96] verifyPassword[97] issueApiKey[98] verifyApiKey[99]
 *                issueKeySecret[100] verifyKeySecret[101] enrollTotp[102] verifyTotp[103]
 *                totpEnabled[104] issueOtp[105] verifyOtp[106] link[107] lookup[108] — все А17
 * sessions:      sessions[109] start[110] check[111] revoke[112] revokeAll[113] — А18
 * acl:           check[114] checkData[115] reload[116] — А19
 * ConnectOpts:   dsn/schema/partition/account/owner/max[117-122]А1 enforceAccount[123]А20
 *                enforceAcl[124]см.acl.test onQuery[125]А20 slowMs[126]А20
 * UpOpts:        dsn/schema/version[127-129]А2 quiet[136]А2 (+ прочие поля up.test)
 * create-контекст: tags-значение[138]А13/А20 account/owner-INSERT[139]А20
 * Гарды:         .link()removed[143] execute→run[144] batch.execute[145] — А21
 *
 * Не в салоне (покрыто прицельно в других файлах): enforceAcl-цепочки [124] — acl.test;
 * accounts.delete[85]/credentials.set[87] прямые — tables.test; up-докер-ветки — миграция.
 * ============================================================================= */
