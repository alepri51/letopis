/**
 * «Реальная жизнь»: салон «Ласточка», пятница 2026-07-10, смены 10:00–16:00.
 * 16 сцен: запись, «4 руки» (двумя записями), race двойной брони, длинная услуга
 * одним интервалом, переносы (время/мастер/race — пересоздание: id = v5(мастер, старт)),
 * отмена delete-ом (+идемпотентность), no-show тегом, walk-in без клиента,
 * отказы (навык/вне смены), race отмена-vs-перенос, отчёты дня.
 *
 * Модель 0.17: окно (slot) = СМЕНА мастера (интервал доступности, позитивная модель);
 * запись (booking) — наследник окна: сама несёт интервал, предмет (союз) и клиента.
 * Хелперы bookVisit/reschedule/cancel — «сервис записи» поверх dot-цепочек.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../src/index.js';
import { uuidv5 } from '../src/uuid.js';
import type { EntityDb } from '../src/chain.js';
import type { Row } from '../src/types.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';

let db: EntityDb;
const S: Record<string, Row> = {};  // сцена: организация, мастера, услуги, клиенты, записи

const iso = (h: number, m = 0) =>
  `2026-07-10T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+03:00`;
const ms = (v: unknown) => Date.parse(String(v));
const час = (r: Row) => new Date(String(r.data.start_datetime)).getUTCHours() + 3; // Europe/Moscow
// id записи детерминирован схемой: v5(Мастер, старт) — двойная бронь мертва самим id
const bookingId = (master: Row, startIso: string) => uuidv5(`v1.booking:entity:booking:${master.id}:${startIso}`);

before(async () => {
  db = await connect({ dsn: DSN, schema: 'v1.booking' });
  await db.sql.unsafe('TRUNCATE "v1.booking"."Entity"');

  // Салон, зал, мастера, каталог, навыки — связи dot-цепочками
  [S.салон] = await db.Организация().create({ name: 'Ласточка' }).rows();
  [S.зал] = await db.Организация(S.салон).Локация().create({ address: 'Садовая, 5' }).rows();
  [S.марина] = await db.Организация(S.салон).Мастер().create({ name: 'Марина', phone: '+7 921 001' }).rows();
  [S.света] = await db.Организация(S.салон).Мастер().create({ name: 'Света', phone: '+7 921 002' }).rows();

  [S.маникюр] = await db.Организация(S.салон).Услуга().create({ name: 'Маникюр', duration: 60 }).rows();
  [S.педикюр] = await db.Организация(S.салон).Услуга().create({ name: 'Педикюр', duration: 90 }).rows();
  [S.комплекс] = await db.Организация(S.салон).Комплекс().create({ name: 'М+П', duration: 150, cost: 4500 }).rows();
  // цены услуг — отдельный LINK «цена» (вариант «базовая», сумма в amounts.RUB); у комплекса — свой cost
  await db.Услуга(S.маникюр).цена().create({ amounts: { RUB: 2000 } }).rows();
  await db.Услуга(S.педикюр).цена().create({ amounts: { RUB: 3000 } }).rows();
  await db.Комплекс(S.комплекс).состав().create({ quantity: 1, order: 1 }).Услуга.set(S.маникюр).rows();
  await db.Комплекс(S.комплекс).состав().create({ quantity: 1, order: 2 }).Услуга.set(S.педикюр).rows();

  await db.Мастер(S.марина).навык().create().Услуга.set(S.маникюр).rows();
  await db.Мастер(S.марина).навык().create().Услуга.set(S.педикюр).rows();
  await db.Мастер(S.света).навык().create().Услуга.set(S.маникюр).rows();

  let n = 0;
  for (const имя of ['Аня', 'Оля', 'Катя', 'Боря']) {
    [S[имя]] = await db.Организация(S.салон).Клиент().create({ name: имя, phone: `+7 931 00${++n}` }).rows();
  }

  // Календарь: июльское расписание + смены пятницы 10:00–16:00 (окно = интервал доступности)
  [S.расписание] = await db.Организация(S.салон).Расписание().create({ name: 'Июль-26', year: 2026, month: 7 }).rows();
  for (const m of [S.марина, S.света]) {
    await db.Мастер(m).окно()
      .create({ start_datetime: iso(10), end_datetime: iso(16) })
      .Локация.set(S.зал).Расписание.set(S.расписание).rows();
  }
});

after(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------
// Хелперы «сервиса записи»
// ---------------------------------------------------------------------------

/** Живые записи мастера. */
const visitsOf = (t: EntityDb, master: Row) => t.Мастер(master.id).запись().rows();

/** Свободные ЧАСОВЫЕ старты мастера: часы внутри смен − пересечения с записями. */
async function freeHours(master: Row): Promise<Set<number>> {
  const смены = await db.Мастер(master.id).окно().rows();
  const записи = await visitsOf(db, master);
  const свободно = new Set<number>();
  for (const w of смены) {
    for (let t = ms(w.data.start_datetime); t + 3600_000 <= ms(w.data.end_datetime); t += 3600_000) {
      const busy = записи.some((з) => ms(з.data.start_datetime) < t + 3600_000 && t < ms(з.data.end_datetime));
      if (!busy) свободно.add(new Date(t).getUTCHours() + 3);
    }
  }
  return свободно;
}

interface VisitReq {
  client: Row | null;              // null = walk-in «на имя» (имя в notes)
  notes?: string;
  master: Row;
  item: Row;                       // Услуга | Комплекс
  startHour: number;
}

/** Проверки брони: навык (комплекс — по составу), смена, пересечения. Бросает с причиной. */
async function guardVisit(tr: EntityDb, req: VisitReq, startIso: string, endIso: string, skipId?: string): Promise<void> {
  // навык: услуга — прямой; комплекс — покрытие ВСЕХ услуг состава
  if (req.item.class === 'Service') {
    if (!(await tr.Мастер(req.master.id).навык().Услуга(req.item.id).count()))
      throw new Error(`нет навыка: ${String(req.master.data.name)} не делает ${String(req.item.data.name)}`);
  } else {
    const услуги = await tr.Комплекс(req.item.id).состав().Услуга().ids();
    const покрыто = await tr.Мастер(req.master.id).навык().Услуга(услуги).count();
    if (покрыто !== услуги.length)
      throw new Error(`нет навыка: ${String(req.master.data.name)} не делает ${String(req.item.data.name)}`);
  }
  // интервал записи внутри какой-то смены мастера (позитивная доступность)
  const смены = await tr.Мастер(req.master.id).окно().rows();
  const внутри = смены.some((w) => ms(w.data.start_datetime) <= ms(startIso) && ms(endIso) <= ms(w.data.end_datetime));
  if (!внутри) throw new Error(`вне смены: ${String(req.master.data.name)} не работает в это время`);
  // пересечения с живыми записями
  const записи = await visitsOf(tr as never, req.master);
  const конфликт = записи.some((з) => з.id !== skipId && ms(з.data.start_datetime) < ms(endIso) && ms(startIso) < ms(з.data.end_datetime));
  if (конфликт) throw new Error(`слот занят: ${req.startHour}:00`);
}

/** Бронь под advisory-lock мастера; id записи считает схема — v5(мастер, старт). */
async function bookVisit(req: VisitReq): Promise<Row> {
  const startIso = iso(req.startHour);
  const dur = req.item.data.duration as number;
  const endIso = new Date(ms(startIso) + dur * 60_000).toISOString();
  const tr = await db.begin();
  try {
    await tr.lock('visits', req.master.id);            // сериализация всех броней мастера
    await guardVisit(tr as never, req, startIso, endIso);

    let цепочка = tr.Мастер(req.master).запись()
      .create({ start_datetime: startIso, end_datetime: endIso, ...(req.notes ? { notes: req.notes } : {}) })
      .Локация.set(S.зал).Расписание.set(S.расписание);
    цепочка = req.item.class === 'Service' ? цепочка.Услуга.set(req.item) : цепочка.Комплекс.set(req.item);
    if (req.client) цепочка = цепочка.Клиент.set(req.client);
    const [запись] = await цепочка.rows();
    await tr.commit();
    return запись;
  } catch (e) {
    await tr.rollback();
    throw e;
  }
}

/** Перенос: id жёстко держит (мастер, старт) ⇒ смена времени/мастера = пересоздание. */
async function reschedule(запись: Row, master: Row, startHour: number): Promise<Row | false> {
  const tr = await db.begin();
  try {
    await tr.lock('visits', запись.links.Staff);       // мастер-источник
    if (master.id !== запись.links.Staff) await tr.lock('visits', master.id); // и цель
    const тек = await tr.запись(запись.id).first();
    if (!тек) {
      await tr.rollback();
      return false;                                    // уже отменена/перенесена
    }
    const предметId = тек.links.Service ?? тек.links.Complex ?? тек.links.Product;
    const предмет = (тек.links.Service ? await tr.Услуга(предметId).first() : await tr.Комплекс(предметId).first())!;
    const startIso = iso(startHour);
    const endIso = new Date(ms(startIso) + (предмет.data.duration as number) * 60_000).toISOString();
    const клиент = тек.links.Customer ? ({ id: тек.links.Customer } as Row) : null;
    try {
      await guardVisit(tr as never, { client: клиент, master, item: предмет, startHour } as VisitReq, startIso, endIso, тек.id);
    } catch {
      await tr.rollback();
      return false;                                    // цель занята / вне смены
    }
    await tr.запись(тек.id).delete({ confirm: true }).rows();   // старый (мастер, старт) свободен
    let цепочка = tr.Мастер(master).запись()
      .create({ start_datetime: startIso, end_datetime: endIso, ...(тек.data.notes ? { notes: тек.data.notes } : {}) })
      .Локация.set(S.зал).Расписание.set(S.расписание);
    цепочка = тек.links.Service ? цепочка.Услуга.set(предмет) : цепочка.Комплекс.set(предмет);
    if (клиент) цепочка = цепочка.Клиент.set(клиент.id);
    const [новая] = await цепочка.rows();
    await tr.commit();
    return новая;
  } catch (e) {
    await tr.rollback();
    throw e;
  }
}

/** Отмена = tombstone-delete (история в versions). Идемпотентна: false — уже нет. */
async function cancel(запись: Row): Promise<boolean> {
  const gone = await db.запись(запись.id).delete({ confirm: true }).rows();
  return gone.length > 0;
}

/** Неявка: пометка в notes новой версией (запись остаётся фактом дня).
 *  (.tags() перед update — фильтр чтения целей, тегом существующее не пометить.) */
async function noShow(запись: Row): Promise<Row | null> {
  const [v] = await db.запись(запись.id).update({ notes: 'no-show' }).rows();
  return v ?? null;
}

// ---------------------------------------------------------------------------
// Сцены
// ---------------------------------------------------------------------------

test('С1. Happy path: Аня → Света, маникюр 10:00', async () => {
  S.зАни = await bookVisit({ client: S.Аня, master: S.света, item: S.маникюр, startHour: 10 });
  assert.equal(S.зАни.id, bookingId(S.света, iso(10)));   // id предсказуем до создания

  const светаFree = await freeHours(S.света);
  assert.equal(светаFree.size, 5);                        // из 6 часов смены занят один
  assert.ok(!светаFree.has(10));
  assert.ok((await freeHours(S.марина)).has(10));         // Марина свободна

  // старт визита лежит внутри смены Светы
  const [смена] = await db.Мастер(S.света.id).окно().rows();
  assert.ok(ms(смена.data.start_datetime) <= ms(S.зАни.data.start_datetime));
});

test('С2. «4 РУКИ»: Катя 11:00 — Света маникюр + Марина педикюр (две записи, один час)', async () => {
  S.зКатяС = await bookVisit({ client: S.Катя, master: S.света, item: S.маникюр, startHour: 11 });
  S.зКатяМ = await bookVisit({ client: S.Катя, master: S.марина, item: S.педикюр, startHour: 11 });

  // в 11:00 заняты ОБЕ — записями одной клиентки
  const обе = await db.Клиент(S.Катя.id).запись().Мастер().rows();
  assert.deepEqual([...new Set(обе.map((r) => r.data.name))].sort(), ['Марина', 'Света']);

  // педикюр 90м: интервал 11:00–12:30 одной записью — час 12 у Марины частично занят
  assert.ok(!(await freeHours(S.марина)).has(12));
  assert.deepEqual((await db.Клиент(S.Катя.id).запись().count()), 2);
});

test('С3. Race: Оля и Боря одновременно на Марину 13:00 → ровно один успех', async () => {
  const попытка = async (client: Row) => {
    try {
      return await bookVisit({ client, master: S.марина, item: S.маникюр, startHour: 13 });
    } catch (e) {
      if (/слот занят/.test((e as Error).message)) return null;
      throw e;
    }
  };
  const [оля, боря] = await Promise.all([попытка(S.Оля), попытка(S.Боря)]);
  assert.ok((оля === null) !== (боря === null), 'ровно один должен выиграть');
  S.зОли13 = (оля ?? боря)!;
  S.проигравший = оля ? S.Боря : S.Оля;

  // живая запись на (Марина, 13:00) физически одна — id детерминирован
  assert.equal((await db.запись(bookingId(S.марина, iso(13))).rows()).length, 1);
});

test('С4. «Любой мастер»: проигравший ищет 13:00 с навыком маникюр → Света', async () => {
  const мастера = [];
  for (const m of [S.марина, S.света]) {
    const умеет = await db.Мастер(m.id).навык().Услуга(S.маникюр.id).count();
    const свободен = (await freeHours(m)).has(13);
    if (умеет && свободен) мастера.push(m);
  }
  assert.deepEqual(мастера.map((m) => m.data.name), ['Света']);

  S.зПроигравшего = await bookVisit({ client: S.проигравший, master: S.света, item: S.маникюр, startHour: 13 });
});

test('С5. Длинная услуга: Оля педикюр 90м у Марины 14:00 — один интервал 14:00–15:30', async () => {
  S.зОлиПедикюр = await bookVisit({ client: S.Оля, master: S.марина, item: S.педикюр, startHour: 14 });

  const з = (await db.запись(S.зОлиПедикюр.id).first())!;
  assert.equal(ms(з.data.end_datetime) - ms(з.data.start_datetime), 90 * 60_000);
  assert.equal((await freeHours(S.марина)).size, 1);      // остался только час 10:00
  // хвост 15:00–15:30 блокирует бронь на 15:00
  await assert.rejects(bookVisit({ client: S.Боря, master: S.марина, item: S.маникюр, startHour: 15 }), /слот занят/);
});

test('С6. Перенос времени: Аня 10:00 → 12:00 (та же Света) — пересоздание', async () => {
  const старая = S.зАни;
  const новая = await reschedule(S.зАни, S.света, 12);
  assert.ok(новая);
  S.зАни = новая as Row;

  assert.equal(час(S.зАни), 12);
  assert.notEqual(S.зАни.id, старая.id);                  // id держит (мастер, старт) — новый
  assert.ok((await freeHours(S.света)).has(10));          // 10:00 свободно
  assert.equal(await db.запись(старая.id).count(), 0);    // старая — tombstone
  const история = await db.запись(старая.id).versions();  // но история цела
  assert.ok(история.length >= 2 && история.at(-1)?.$deleted === true);
});

test('С7. Race: перенос Ани на 14:00 Светы vs новая бронь Бори туда же', async () => {
  const перенос = reschedule(S.зАни, S.света, 14);
  const бронь = bookVisit({ client: S.Боря, master: S.света, item: S.маникюр, startHour: 14 })
    .then((з) => з)
    .catch((e) => {
      if (/слот занят/.test((e as Error).message)) return null;
      throw e;
    });
  const [ок, зБори2] = await Promise.all([перенос, бронь]);
  assert.ok((ок !== false) !== (зБори2 !== null), 'слот 14:00 достался ровно одному');
  if (ок) S.зАни = ок as Row;
  S.зБори2 = зБори2 as Row | null;

  assert.equal(час((await db.запись(S.зАни.id).first())!), ок ? 14 : 12); // проигравший перенос не тронул запись
});

test('С8. Перенос к другому мастеру: запись с 13:00 Светы → 10:00 Марины', async () => {
  const новая = await reschedule(S.зПроигравшего, S.марина, 10);
  assert.ok(новая);
  S.зПроигравшего = новая as Row;

  assert.equal(час(S.зПроигравшего), 10);
  assert.equal(S.зПроигравшего.links.Staff, S.марина.id); // исполнитель сменён (в id!)
  assert.equal(S.зПроигравшего.id, bookingId(S.марина, iso(10)));
  assert.ok((await freeHours(S.света)).has(13));
});

test('С9. Отмена: Оля отменяет педикюр → 14:00–15:30 Марины свободны', async () => {
  assert.equal(await cancel(S.зОлиПедикюр), true);

  const free = await freeHours(S.марина);
  assert.ok(free.has(14) && free.has(15));
  assert.equal(await db.запись(S.зОлиПедикюр.id).count(), 0);   // tombstone
  // чужие записи целы (Катины «4 руки»)
  assert.equal(await db.Клиент(S.Катя.id).запись().count(), 2);
});

test('С10. Повторная отмена — идемпотентный no-op', async () => {
  const версииДо = (await db.запись(S.зОлиПедикюр.id).versions()).length;
  assert.equal(await cancel(S.зОлиПедикюр), false);
  assert.equal((await db.запись(S.зОлиПедикюр.id).versions()).length, версииДо); // версий не прибавилось
});

test('С11. No-show: Аня не пришла — пометка на записи, время не освобождаем задним числом', async () => {
  const v = await noShow(S.зАни);
  assert.ok(v);
  assert.equal(v!.data.notes, 'no-show');
  assert.equal(await db.запись({ notes: 'no-show' }).count(), 1);
  assert.ok((await db.запись(S.зАни.id).versions()).length >= 2);
});

test('С12. Walk-in: Надя по телефону, без клиента — Марина 14:00', async () => {
  S.зНади = await bookVisit({ client: null, notes: 'Надя', master: S.марина, item: S.маникюр, startHour: 14 });

  const тек = (await db.запись(S.зНади.id).first())!;
  assert.equal(тек.data.notes, 'Надя');
  assert.equal(тек.links.Customer, undefined);        // клиента нет — ручная бронь
  assert.equal(тек.id, bookingId(S.марина, iso(14)));

  // в календаре Марины видна; в историях клиентов — нет
  const записиМарины = await db.Мастер(S.марина.id).запись().ids();
  assert.ok(записиМарины.includes(S.зНади.id));
  for (const имя of ['Аня', 'Оля', 'Катя', 'Боря']) {
    const истории = await db.Клиент(S[имя].id).запись().ids();
    assert.ok(!истории.includes(S.зНади.id));
  }
});

test('С13. Отказ: комплекс к Свете (не покрывает состав) — ничего не создано', async () => {
  const записейДо = await db.запись().count();
  await assert.rejects(
    bookVisit({ client: S.Катя, master: S.света, item: S.комплекс, startHour: 13 }),
    /нет навыка/,
  );
  assert.equal(await db.запись().count(), записейДо);
});

test('С14. Отказ: бронь вне смены (16:00 при смене до 16:00) — отклонена', async () => {
  await assert.rejects(
    bookVisit({ client: S.Оля, master: S.марина, item: S.маникюр, startHour: 16 }),
    /вне смены/,
  );
  // смены нетронуты: у Марины по-прежнему одна
  assert.equal(await db.Мастер(S.марина.id).окно().count(), 1);
});

test('С15. Race: отмена vs перенос одной записи → ровно один исход', async () => {
  const запись = S.зПроигравшего; // 10:00 Марины
  const [отменилось, перенеслось] = await Promise.all([
    cancel(запись),
    reschedule(запись, S.света, 15),
  ]);
  // ровно одна операция видит живую запись (обе идут через tombstone-delete старого id)
  assert.ok(отменилось || перенеслось !== false, 'хотя бы одна операция должна пройти');
  assert.equal(await db.запись(запись.id).count(), 0);    // старого id больше нет в любом исходе
  if (перенеслось !== false) {
    S.зПроигравшего = перенеслось as Row;
    assert.equal(час(S.зПроигравшего), 15);
    assert.equal(await db.запись(S.зПроигравшего.id).count(), 1);
  }
});

test('С16. Конец дня: отчёты и сквозные инварианты', async () => {
  // расписание дня: каждая живая запись — у известного мастера, внутри его смены
  const пути = await db.запись().Мастер().run();
  for (const p of пути) assert.ok(['Марина', 'Света'].includes(String(p.Мастер.data.name)));

  // выручка дня = Σ цен предметов живых записей (услуги — цена RUB из LINK «цена», комплексы — cost)
  const прайс = new Map<string, number>();
  for (const s of [S.маникюр, S.педикюр]) {
    const [ц] = await db.Услуга(s.id).цена().rows();
    прайс.set(s.id, (ц.data.amounts as Record<string, number>).RUB);
  }
  const поУслугам = await db.запись().Услуга().run();
  const поКомплексам = await db.запись().Комплекс().run();
  const выручка =
    поУслугам.reduce((s, p) => s + (прайс.get(p.Услуга.id) ?? 0), 0) +
    поКомплексам.reduce((s, p) => s + (p.Комплекс.data.cost as number), 0);
  assert.ok(выручка >= 2000 + 3000 + 2000 + 2000); // минимум: Катя (М+П раздельно) + Оля 13 + Надя

  // но-шоу помечен в notes
  assert.deepEqual(await db.запись({ notes: 'no-show' }).ids(), [S.зАни.id]);
  // отменённый педикюр Оли (Марина, 14:00) ВОСКРЕШЁН walk-in-бронью Нади: та же
  // v5-пара (мастер, старт) → тот же id, в истории — tombstone посередине
  assert.equal(S.зНади.id, S.зОлиПедикюр.id);
  assert.ok((await db.запись(S.зОлиПедикюр.id).versions()).some((v) => v.$deleted === true));
  assert.equal((await db.запись(S.зОлиПедикюр.id).first())!.data.notes, 'Надя');

  // ИНВАРИАНТЫ:
  // (а) двойная бронь невозможна: пара (мастер, старт) уникальна — id v5 совпал бы
  const все = await db.запись().rows();
  const пары = new Set<string>();
  for (const з of все) {
    const ключ = `${з.links.Staff}|${String(з.data.start_datetime)}`;
    assert.ok(!пары.has(ключ), `две живые записи на пару ${ключ}`);
    пары.add(ключ);
  }
  // (б) каждая запись внутри смены своего мастера
  for (const з of все) {
    const смены = await db.Мастер(з.links.Staff).окно().rows();
    assert.ok(
      смены.some((w) => ms(w.data.start_datetime) <= ms(з.data.start_datetime) && ms(з.data.end_datetime) <= ms(w.data.end_datetime)),
      `запись ${з.id} вне смен мастера`,
    );
  }
  // (в) история цела: у записи Ани (но-шоу) ≥ 2 версий; история воскрешённого id
  // хранит и жизнь педикюра Оли, и tombstone, и Надину бронь
  assert.ok((await db.запись(S.зАни.id).versions()).length >= 2);
  assert.ok((await db.запись(S.зНади.id).versions()).length >= 3);
});
