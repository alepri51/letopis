/**
 * ТЕСТ-ПЛАН «САЛОН»: имитация работы салона красоты, покрывающая ВСЕ публичные API letopis.
 *
 * Сквозной сценарий: открытие салона → каталог и мастера → расписание → записи клиентов
 * (гонки, переносы, отмены) → отчёты → realtime → приватность → вход/доступ → администрирование.
 * Каждый акт (test) в шапке перечисляет покрываемые API-точки [#N] из матрицы (см. конец файла).
 *
 * Модель 0.17: окно (slot) — LINK Мастер×Локация×Расписание, доступность ПОЗИТИВНАЯ
 * (окно есть = мастер доступен, нет busy/shift); запись (booking) — LINK-наследник окна
 * с предметом (союз Услуга|Товар|Комплекс) и опциональным Клиентом; id записи =
 * v5(Мастер, старт) — двойная бронь мертва самим id.
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
  exists, isNull, not, or,
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

// детерминированные часы дня 1 августа: 10:00…18:00
const iso = (h: number) => `2026-08-01T${String(h).padStart(2, '0')}:00:00+03:00`;
/** Schema: запись id = uuidv5(Мастер, старт) — формула открыта, id знаем ДО создания. */
const bookingId = (staff: Row, start: string) => uuidv5(`${SCHEMA}:entity:booking:${staff.id}:${start}`);

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
test('Акт 1. Открытие: организация, локация, мастера — HUB-создание и батч', async () => {
  // connect уже открыт в before (schema/partition/dsn/max — ConnectOpts [117-122])
  assert.ok(db.registry instanceof Registry);                       // [21][6-10 Registry]
  assert.equal(db.registry.resolve('Организация').id, 'Org');       // [8]
  assert.ok(db.registry.has('содержимое'));                         // [9]
  assert.ok(db.registry.all.length >= 19);                          // [10]

  const [org] = await db.Организация().create({ name: 'Салон «Локоны»', phone: '+7 900 111', timezone: 'Europe/Moscow' }).rows(); // [30][53]
  assert.equal(org.data.name, 'Салон «Локоны»');

  // System-fallback: без account в connect строки получают System-аккаунт
  const sysRows = await db.sql.unsafe(`SELECT id FROM "${SCHEMA}"."Account" WHERE 'System' = ANY(categories) LIMIT 1`); // [22]
  assert.equal(org.account, (sysRows as unknown as { id: string }[])[0].id);

  const [зал] = await db.Организация(org).Локация().create({ address: 'Тверская, 7', coordinates: { lat: 55.76, lng: 37.61 } }).rows();

  // батч: два мастера одним заходом (планы в очереди, одна транзакция)
  const b = db.batch('setup');                                      // [17]
  b.Организация(org).Мастер().create({ name: 'Ольга', phone: '+7 900 222', specialization: 'парикмахер' }); // [81]
  b.Организация(org).Мастер().create({ name: 'Ирина', phone: '+7 900 333', specialization: 'барбер' });
  assert.equal(b.size(), 2);                                        // [80]
  const res = await b.run();                                        // [78]
  assert.equal(res.length, 2);
  assert.equal(b.size(), 0);                                        // очередь дренирована

  Object.assign(S, { org, зал, ольга: res[0][0], ирина: res[1][0] });

  // discard: план в очередь — и выброшен
  const b2 = db.batch('scratch');
  b2.Организация(org).Клиент().create({ name: 'Черновик', phone: '+7 000 000' });
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
// АКТ 3. Каталог — папки (deep-иерархия), услуги/товар, комплекс, состав, содержимое
// покрывает: [30][53][42 deep][32 rows][58 навигация][56 слот .set]
// ===========================================================================
test('Акт 3. Каталог: папки-дерево, услуги, комплекс + состав, наполнение папок', async () => {
  const { org } = S;
  const [корень] = await db.Организация(org).Папка().create({ name: 'Каталог' }).rows();
  const [волосы] = await db.Организация(org).Папка(корень).Папка().create({ name: 'Волосы' }).rows(); // Папка→Папка (self)

  const [стрижка] = await db.Организация(org).Услуга().create({ name: 'Стрижка', duration: 60, price: 1500 }).rows();
  const [укладка] = await db.Организация(org).Услуга().create({ name: 'Укладка', duration: 30, price: 900 }).rows();
  const [борода] = await db.Организация(org).Услуга().create({ name: 'Борода', duration: 30, price: 800, description: 'моделирование' }).rows();
  const [шампунь] = await db.Организация(org).Товар().create({ name: 'Шампунь', price: 700, sku: 'SH-01' }).rows();

  // комплекс + его состав (LINK «состав» = [Комплекс, Услуга|Товар]) — предмет слотом
  const [набор] = await db.Организация(org).Комплекс().create({ name: 'Образ', duration: 90, cost: 2200 }).rows();
  await db.Комплекс(набор).состав().create({ quantity: 1, order: 1 }).Услуга.set(стрижка).rows();  // [56 слот]
  await db.Комплекс(набор).состав().create({ quantity: 1, order: 2 }).Услуга.set(укладка).rows();
  await db.Комплекс(набор).состав().create({ quantity: 1, order: 3 }).Товар.set(шампунь).rows();   // товар в составе

  // наполнение папки: LINK «содержимое» = [Папка, Услуга|Товар|Комплекс]
  await db.Папка(волосы).содержимое().create({ order: 1 }).Услуга.set(стрижка).rows();
  await db.Папка(волосы).содержимое().create({ order: 2 }).Услуга.set(укладка).rows();
  await db.Папка(корень).содержимое().create({ order: 1 }).Комплекс.set(набор).rows();

  // deep: вся ветка папок от корня
  const ветка = await db.Организация(org).Папка(корень).Папка().deep().rows();    // [42]
  assert.ok(ветка.some((f) => f.data.name === 'Волосы'));

  // состав комплекса читается: Комплекс→состав→Услуга (+ Товар отдельным концом союза)
  const услугиНабора = await db.Комплекс(набор).состав().Услуга().rows();         // [58]
  assert.deepEqual(услугиНабора.map((r) => r.data.name).sort(), ['Стрижка', 'Укладка']);
  assert.equal(await db.Комплекс(набор).состав().Товар().count(), 1);
  // содержимое папки
  const вПапке = await db.Папка(волосы).содержимое().Услуга().rows();
  assert.deepEqual(вПапке.map((r) => r.data.name).sort(), ['Стрижка', 'Укладка']);

  Object.assign(S, { корень, волосы, стрижка, укладка, борода, шампунь, набор });
});

// ===========================================================================
// АКТ 4. Мастера и навыки — слоты, pivot-фильтр умений, умение комплекса по составу
// покрывает: [56][58 чтение навык][52 pivot/entity через повтор]
// ===========================================================================
test('Акт 4. Навыки мастеров: слоты, pivot-проверка, комплекс вычислим по составу', async () => {
  const { ольга, ирина, стрижка, укладка, борода, набор } = S;
  // навык [Мастер, Услуга] — владелец из пути, предмет слотом
  await db.Мастер(ольга).навык().create({ level: 'expert' }).Услуга.set(стрижка).rows();
  await db.Мастер(ольга).навык().create().Услуга.set(укладка).rows();
  await db.Мастер(ирина).навык().create().Услуга.set(стрижка).rows();
  await db.Мастер(ирина).навык().create({ level: 'advanced' }).Услуга.set(борода).rows();

  // умения Ольги
  const уменияО = await db.Мастер(ольга).навык().Услуга().rows();
  assert.deepEqual(уменияО.map((r) => r.data.name).sort(), ['Стрижка', 'Укладка']);

  // «умеет ли Ирина бороду» — pivot: навык, дофильтр по предмету, возврат
  const умеет = await db.Мастер(ирина).навык().Услуга(борода).навык().count();  // [52 pivot]
  assert.equal(умеет, 1);
  const неУмеет = await db.Мастер(ирина).навык().Услуга(укладка).навык().count();
  assert.equal(неУмеет, 0);

  // умение комплекса ВЫЧИСЛИМО: Ольга покрывает все услуги состава «Образа», Ирина — нет
  const услугиСостава = await db.Комплекс(набор).состав().Услуга().ids();
  const покрытоОльгой = await db.Мастер(ольга).навык().Услуга(услугиСостава).count(); // фильтр-массив id
  assert.equal(покрытоОльгой, услугиСостава.length);
  const покрытоИриной = await db.Мастер(ирина).навык().Услуга(услугиСостава).count();
  assert.ok(покрытоИриной < услугиСостава.length);
});

// ===========================================================================
// АКТ 5. Расписание и доступность — окна мастеров батчем (позитивная модель)
// покрывает: [53][81][56 слот][39 sort][37 limit]
// ===========================================================================
test('Акт 5. Расписание: месяц + окна мастеров батчем; выходной час = отсутствие окна', async () => {
  const { org, зал, ольга, ирина } = S;
  const [расп] = await db.Организация(org).Расписание().create({ name: 'Август-26', year: 2026, month: 8 }).rows();

  // окна персональные: Мастер×Локация×Расписание + интервал; id = v5(мастер, старт)
  const b = db.batch('окна');
  for (let h = 10; h < 18; h++)
    b.Мастер(ольга).окно().create({ start_datetime: iso(h), end_datetime: iso(h + 1) }).Локация.set(зал).Расписание.set(расп);
  for (let h = 10; h < 17; h++) // Ирина в 17:00 не работает — окна просто НЕТ (позитивная доступность)
    b.Мастер(ирина).окно().create({ start_datetime: iso(h), end_datetime: iso(h + 1) }).Локация.set(зал).Расписание.set(расп);
  const созданы = await b.run();
  assert.equal(созданы.length, 15);
  assert.ok(созданы.every(([r]) => r.class === 'slot' && r.links.Schedule === расп.id));

  // sort по дате начала; окна расписания читаются reverse-цепочкой
  assert.equal((await db.Расписание(расп).окно().sort('data.start_datetime').rows()).length, 15); // [39]
  assert.equal((await db.Расписание(расп).окно().limit(3).rows()).length, 3);                     // [37]

  // ростер = мастера, у которых есть окна в расписании
  const ростер = await db.Расписание(расп).окно().Мастер().rows();
  assert.deepEqual([...new Set(ростер.map((r) => r.data.name))].sort(), ['Ирина', 'Ольга']);
  // у Ирины нет окна на 17:00 — свободный вечер (дата в data — момент: сравнение оператором)
  assert.equal(await db.Мастер(ирина).окно({ start_datetime: between(iso(17), iso(17)) }).count(), 0);
  assert.equal(await db.Мастер(ольга).окно({ start_datetime: between(iso(17), iso(17)) }).count(), 1);

  Object.assign(S, { расп });
});

// ===========================================================================
// АКТ 6. Клиенты и первая бронь — транзакция + advisory-lock, запись со слотами
// покрывает: [11 begin][14 tr.commit][16 tr.lock][53][56][33 first]
// ===========================================================================
test('Акт 6. Бронь №1: Аня → Ольга, стрижка 10:00 (транзакция + lock)', async () => {
  const { org, зал, расп, ольга, стрижка } = S;
  const [аня] = await db.Организация(org).Клиент().create({ name: 'Аня', phone: '+7 911 001' }).rows();

  const tr: EntityTx = await db.begin();                            // [11]
  try {
    await tr.lock('booking', ольга.id, iso(10));                    // [16]
    assert.equal(await tr.запись(bookingId(ольга, iso(10))).first(), null); // [33] время свободно
    // запись: мастер из пути, локация/расписание/предмет/клиент — слотами; id = v5(мастер, старт)
    await tr.Мастер(ольга).запись()
      .create({ start_datetime: iso(10), end_datetime: iso(11) })
      .Локация.set(зал).Расписание.set(расп).Услуга.set(стрижка).Клиент.set(аня).rows();
    await tr.commit();                                             // [14]
    S.аня = аня;
  } catch (e) {
    await tr.rollback();
    throw e;
  }
  assert.equal(await db.запись(bookingId(ольга, iso(10))).count(), 1);
  S.зАни = (await db.запись(bookingId(ольга, iso(10))).first())!;
});

// ===========================================================================
// АКТ 7. Гонка двойной брони — две транзакции на пару (мастер, старт)
// покрывает: [11][15 tr.rollback][16 lock]
// ===========================================================================
test('Акт 7. Гонка: Боря и Вера одновременно на Ольгу 11:00 → ровно один успех', async () => {
  const { org, зал, расп, ольга, стрижка } = S;
  const [боря] = await db.Организация(org).Клиент().create({ name: 'Боря', phone: '+7 911 002' }).rows();
  const [вера] = await db.Организация(org).Клиент().create({ name: 'Вера', phone: '+7 911 003' }).rows();

  const попытка = async (клиент: Row, label: string): Promise<string | null> => {
    const tr = await db.begin();
    try {
      await tr.lock('booking', ольга.id, iso(11));
      if (await tr.запись(bookingId(ольга, iso(11))).first()) { await tr.rollback(); return null; } // [15]
      await tr.Мастер(ольга).запись()
        .create({ start_datetime: iso(11), end_datetime: iso(12) })
        .Локация.set(зал).Расписание.set(расп).Услуга.set(стрижка).Клиент.set(клиент).rows();
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
  assert.equal(await db.запись(bookingId(ольга, iso(11))).count(), 1);
});

// ===========================================================================
// АКТ 8. «4 руки»: две записи в один час у двух мастеров (клиентка одна)
// покрывает: [53][56][32][35 count]
// ===========================================================================
test('Акт 8. Параллель: Аня в 12:00 — стрижка у Ольги и борода у Ирины', async () => {
  const { зал, расп, ольга, ирина, стрижка, борода, аня } = S;
  const мк = (мастер: Row, услуга: Row) =>
    db.Мастер(мастер).запись()
      .create({ start_datetime: iso(12), end_datetime: iso(13) })
      .Локация.set(зал).Расписание.set(расп).Услуга.set(услуга).Клиент.set(аня).rows();
  await мк(ольга, стрижка);
  await мк(ирина, борода);

  // обе записи Ани в 12:00 (Клиент→запись, фильтр по дате — момент: between-оператор с кастом)
  const в12 = { start_datetime: between(iso(12), iso(12)) };
  assert.equal(await db.Клиент(аня).запись(в12).count(), 2);
  // заняты оба мастера (запись→Мастер)
  const занятыеВ12 = await db.запись(в12).Мастер().rows();
  assert.deepEqual([...new Set(занятыеВ12.map((r) => r.data.name))].sort(), ['Ирина', 'Ольга']);
  S.зОльга12 = (await db.запись(bookingId(ольга, iso(12))).first())!;
});

// ===========================================================================
// АКТ 9. Операции дня — союз-замена предмета, unset клиента, перенос = пересоздание
// покрывает: [56 слот .set замена][57 слот .unset][36 versions][54]
// ===========================================================================
test('Акт 9. Изменения броней: союз-замена предмета, снятие клиента, перенос времени', async () => {
  const { зАни, набор, стрижка, шампунь, аня, зал, расп, ольга } = S;

  // союз-замена: предмет записи Ани Стрижка → Комплекс «Образ» (конец один — союз)
  const [зам] = await db.запись(зАни.id).update().Комплекс.set(набор).rows();
  assert.ok(!('Service' in зам.links), 'Услуга снята');
  assert.equal(зам.links.Complex, набор.id);
  // и в Товар (продажа шампуня визитом) — тоже союз
  const [зам2] = await db.запись(зАни.id).update().Товар.set(шампунь).rows();
  assert.ok(!('Complex' in зам2.links));
  // вернуть обратно услугу
  await db.запись(зАни.id).update().Услуга.set(стрижка).rows();

  // снятие optional-конца: ручная бронь — клиент отвязан, имя в notes
  const [снято] = await db.запись(зАни.id).update({ notes: 'бронь по телефону: Аня' }).Клиент.unset().rows();  // [57]
  assert.ok(!('Customer' in снято.links));
  // required-конец снять нельзя
  assert.throws(() => db.запись(зАни.id).update().Локация.unset(), /required — cannot unset/);
  // вернуть клиента
  await db.запись(зАни.id).update().Клиент.set(аня).rows();

  // версий записи накопилось: создание + 5 правок
  assert.ok((await db.запись(зАни.id).versions()).length >= 6);     // [36]

  // ПЕРЕНОС: id = v5(мастер, старт) ⇒ смена времени/мастера = пересоздание (в транзакции)
  const tr = await db.begin();
  try {
    await tr.запись(bookingId(ольга, iso(10))).delete({ confirm: true }).rows();   // [54]
    await tr.Мастер(ольга).запись()
      .create({ start_datetime: iso(15), end_datetime: iso(16) })
      .Локация.set(зал).Расписание.set(расп).Услуга.set(стрижка).Клиент.set(аня).rows();
    await tr.commit();
  } catch (e) {
    await tr.rollback();
    throw e;
  }
  assert.equal(await db.запись(bookingId(ольга, iso(10))).count(), 0); // 10:00 свободно
  assert.equal(await db.запись(bookingId(ольга, iso(15))).count(), 1); // 15:00 занято
  S.зАни15 = (await db.запись(bookingId(ольга, iso(15))).first())!;
});

// ===========================================================================
// АКТ 10. Отмена записи — превью delete, затем tombstone
// покрывает: [54 delete превью/confirm][32]
// ===========================================================================
test('Акт 10. Отмена записи Ольги 12:00: превью, затем tombstone', async () => {
  const { зОльга12, ольга } = S;
  const превью = await db.запись(зОльга12.id).delete().rows();      // [54 без confirm]
  assert.deepEqual([...new Set(превью.map((r) => r.class))], ['booking']);
  assert.ok(превью.every((r) => r.$deleted === undefined));         // БД не тронута
  assert.ok(await db.запись(зОльга12.id).first());

  const удалено = await db.запись(зОльга12.id).delete({ confirm: true }).rows(); // [54 confirm]
  assert.ok(удалено.every((r) => r.$deleted === true));
  assert.equal(await db.запись(зОльга12.id).count(), 0);
  // время Ольги 12:00 снова свободно (позитивная модель: нет записи — свободен)
  assert.equal(await db.запись(bookingId(ольга, iso(12))).count(), 0);
});

// ===========================================================================
// АКТ 11. entity() — узел-переменная и старт с готового Row
// покрывает: [29 db.entity][52 entity внутри]
// ===========================================================================
test('Акт 11. entity(): переменная-узел в пути и старт от Row', async () => {
  const { зАни15, стрижка, аня } = S;
  // entity(Row): начать путь с конкретной записи
  const услугаЗаписи = await db.entity(зАни15).Услуга().first();                  // [29]
  assert.equal(услугаЗаписи?.id, стрижка.id);

  // entity(chain) как узел-переменная: та же переменная = тот же узел (pivot)
  const зап = db.запись();
  const пути = await db.Клиент(аня).entity(зап).Услуга(стрижка).entity(зап).Мастер().run(); // [52]
  assert.ok(пути.length >= 1);
  assert.ok(пути.every((p) => p['Мастер']));
});

// ===========================================================================
// АКТ 12. Отчёты — операторы фильтра (полный набор для скаляров/строк)
// покрывает: [60-70, 74-77 операторы][35 count]  (has/hasAny/hasAll [71-73] — api-full)
// ===========================================================================
test('Акт 12. Отчёты: операторы фильтра на каталоге', async () => {
  const c = (f: Parameters<typeof db.Услуга>[0]) => db.Услуга(f).count();
  assert.equal(await c({ duration: ne(60) }), 2);              // [60] ne (укладка30, борода30)
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
  assert.equal(await c({ description: exists() }), 1);       // [74] exists
  assert.equal(await c({ description: isNull() }), 2);       // [75] isNull
  assert.equal(await c({ name: not(ilike('стр%')) }), 2);    // [76] not
  assert.equal(await db.Услуга(or({ name: 'Стрижка' }, { duration: lt(40) })).count(), 3); // [77] or
  // цены теперь скаляр: сравнение прямо по data.price
  assert.equal(await c({ price: gte(1000) }), 1);
});

// ===========================================================================
// АКТ 13. Аналитика — агрегации, сортировки, keyset-пагинация, alias, tags
// покрывает: [43 sum][44 avg][45 min][46 max][47 countBy][39 sort][38 offset]
//            [41 after][3 cursorOf][48 alias][49 tags][34 ids][31 run]
// ===========================================================================
test('Акт 13. Аналитика: агрегации, keyset, alias, tags', async () => {
  // агрегации по цене услуг (data.price — число)
  assert.equal(await db.Услуга().sum('data.price'), 1500 + 900 + 800);            // [43]
  assert.ok(Math.abs((await db.Услуга().avg('data.price'))! - 1066.67) < 1);      // [44]
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
  const пути = await db.Мастер(S.ольга).alias('Исполнитель').навык().Услуга().run();   // [48][31]
  assert.ok(пути[0]['Исполнитель'] && пути[0]['Исполнитель'].data.name === 'Ольга');

  // tags: значение при создании (модификатор tags в записи = метки строки) + поиск по тегу
  const [хит] = await db.Организация(S.org).Услуга().tags('топ').create({ name: 'Хит сезона', duration: 45, price: 2500 }).rows(); // [49]
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
  await new Promise((r) => setTimeout(r, 30));   // > гранулярности таймера Windows (~15 мс) — before строго до новой версии
  await db.Услуга(борода).update({ price: 1000 }).rows();  // подорожание

  const сейчас = await db.Услуга(борода).first();
  assert.equal(сейчас!.data.price, 1000);
  const тогда = await db.Услуга(борода).asOf(before).first();       // [40]
  assert.equal(тогда!.data.price, 800);

  const версии = await db.Услуга(борода).versions();                // [36]
  assert.ok(версии.length >= 2);
  assert.deepEqual(версии.map((v) => v.data.price), [800, 1000]);
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

  const [гость] = await db.Организация(S.org).Клиент().create({ name: 'Гость', phone: '+7 911 004' }).rows();
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
  const [клиент] = await db.Организация(org).Клиент().create({ name: 'Пётр Удаляев', phone: '+7 917 005' }).rows();
  const [аноним] = await db.Клиент(клиент.id).anonymize(['name', 'phone']).rows();  // [55]
  assert.equal(аноним.data.name, '[erased]');
  assert.equal(аноним.data.phone, '[erased]');
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
  await db.resources.set({ alias: 'booking.read:READ', category: 'READ', pattern: { class: 'booking' } });
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
  const dd = await db.acl.checkData(мастер.id, 'booking', 'READ');                  // [115]
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
  const isoDb = await connect({ dsn: DSN, schema: SCHEMA, account: tenant.id, owner: tenant.id, enforceAccount: true }); // [123]
  const [своя] = await isoDb.Организация().create({ name: 'Частная' }).rows();
  assert.equal(своя.account, tenant.id);                                           // [139 owner/account в create INSERT]
  assert.equal(своя.owner, tenant.id);
  assert.equal(await isoDb.Организация().count(), 1);                              // только своя (чужие невидимы)
  await isoDb.close();

  // onQuery/slowMs — событие на каждый запрос
  const события: { mode: string; ms: number; slow: boolean }[] = [];
  const obs = await connect({ dsn: DSN, schema: SCHEMA, onQuery: (e) => события.push(e), slowMs: 0 }); // [125][126]
  await obs.Услуга().count();
  await obs.close();
  assert.ok(события.length >= 1);
  assert.equal(события[0].slow, true);                                             // slowMs:0 → всё slow

  // tags/owner как значения при INSERT (create-контекст)
  const [svc] = await db.Организация(S.org).Услуга().tags(['акция', 'сезон']).create({ name: 'Спец', duration: 20, price: 500 }).rows(); // [138]
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
  await assert.rejects(db.Организация(S.org).Услуга().create({ name: 'Плохая', duration: -1, price: 1 }).rows(), ValidationError); // [5]
  await assert.rejects(db.Организация(S.org).Услуга().create({ name: 'Лишнее', duration: 10, price: 1, xx: 1 }).rows(), ValidationError);

  // невалидные пути — синхронно при построении
  assert.throws(() => db.Локация(S.зал).Клиент(), /no path/);                      // [58] Location→Customer
  assert.throws(() => db.запись().навык(), /LINK → LINK/);                         // [58]

  // глаголы: create не ищет, update не создаёт; set() снесён
  assert.throws(() => db.Услуга({ name: 'X' }).create({}), /takes no filter/);     // [53] фильтр → update
  assert.throws(() => (db.Услуга() as unknown as { set: (d: object) => void }).set({}), /set\(\) split into create\(\)\/update\(\)/);

  // слот-гарды
  assert.throws(() => db.запись(S.зАни15).update().Папка.set('x'), /is not a link end/);  // [59] не конец
  assert.throws(() => (db as unknown as { Мастер: { set(x: string): void } }).Мастер.set('x'), /needs an owner step/); // [59] без владельца
  assert.throws(() => db.запись('x').Локация.set('y'), /needs a write/);           // [59] слот без операции
  assert.throws(
    () => (db.запись('x').update() as unknown as { Клиент: { delete(): void } }).Клиент.delete(),
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
 *                versions[36]А9/А14 limit[37]А5 offset[38]А13 sort[39]А5
 *                asOf[40]А14 after[41]А13 deep[42]А3 sum[43]А13 avg[44]А13
 *                min[45]А13 max[46]А13 countBy[47]А13 alias[48]А13 tags[49]А13
 *                account[50]А20 owner[51]А20 entity·pivot[52]А4/А11
 * Запись:        create/update[53]А1/А9/А14 delete[54]А9/А10 anonymize[55]А16
 *                слот.set[56]А3/А4/А9 слот.unset[57]А9
 * Навигация:     Класс()·pivot[58]А4 слот-гард[59]А21
 * Операторы:     ne..ends, exists..or[60-70,74-77]А12; has/hasAny/hasAll[71-73] —
 *                в новой демо-схеме нет массивов data → покрыты в api-full.test
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
 * accounts.delete[85]/credentials.set[87] прямые — tables.test; up-докер-ветки — up.test.
 * ============================================================================= */
