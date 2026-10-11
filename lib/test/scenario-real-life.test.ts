/**
 * scenario-real-life — «реальная жизнь» салона (план, этап 4; тест-план §7.6 №4.12): перенос 16 сцен
 * 0.21 `lib/test/real-life.test.ts` на API 1.0 и демо-домен booking. Салон «Ласточка», пятница
 * 2026-07-10, смены 10:00–16:00 (Москва). Окно (slot) — смена мастера; запись (booking) — наследник
 * окна: интервал, предмет (полиморфный конец Item) и клиент. Хелперы bookVisit, reschedule, cancel —
 * «сервис записи» поверх цепочек; брони сериализует advisory-lock мастера, как в 0.21.
 * Отличия 1.0, учтённые при переносе: id записи — v5 от ключа (Staff, start_datetime) в арендаторе
 * (db.idOf), время ключа — ISO с миллисекундами и Z, run() заменён на paths(), повтор create занятого
 * ключа — exists.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, waitForLock, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, type Db, type Row, type Chain } from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;
const S: Record<string, Row> = {}; // сцена: организация, мастера, услуги, клиенты, записи
const R: Record<string, Row | null> = {};

/** Час по Москве (UTC+3) — в UTC с миллисекундами и Z, как требует ключевое поле. */
const iso = (h: number) => `2026-07-10T${String(h - 3).padStart(2, '0')}:00:00.000Z`;
const ms = (v: unknown) => Date.parse(String(v));
const час = (r: Row) => new Date(String(r.data.start_datetime)).getUTCHours() + 3;
/** id записи предсказуем: v5 от (мастер, старт) — двойная бронь невозможна самим id. */
const bookingId = (master: Row, startIso: string) => db.idOf('booking', { Staff: master.id, start_datetime: startIso });

before(async () => {
  e = await engine(import.meta.filename, { seeds: ['booking'] });
  t = await e.tenant('real-life');
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 6 });

  // салон, зал, мастера, каталог, навыки — связи цепочками
  [S.салон] = await db.Организация().create({ name: 'Ласточка' }).rows();
  [S.зал] = await db.Организация(S.салон).Локация().create({ address: 'Садовая, 5' }).rows();
  [S.марина] = await db.Организация(S.салон).Мастер().create({ name: 'Марина', phone: '+7 921 001' }).rows();
  [S.света] = await db.Организация(S.салон).Мастер().create({ name: 'Света', phone: '+7 921 002' }).rows();

  [S.маникюр] = await db.Организация(S.салон).Услуга().create({ name: 'Маникюр', duration: 60 }).rows();
  [S.педикюр] = await db.Организация(S.салон).Услуга().create({ name: 'Педикюр', duration: 90 }).rows();
  [S.комплекс] = await db.Организация(S.салон).Комплекс().create({ name: 'М+П', duration: 150, cost: 4500 }).rows();
  // цены услуг — связь «цена» (вариант «базовая» по умолчанию, сумма в amounts.RUB); у комплекса — cost
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

  // календарь: июльское расписание и смены пятницы 10:00–16:00 (окно — интервал доступности)
  [S.расписание] = await db.Организация(S.салон).Расписание().create({ name: 'Июль-26', year: 2026, month: 7 }).rows();
  for (const m of [S.марина, S.света]) {
    await db.Мастер(m).окно()
      .create({ start_datetime: iso(10), end_datetime: iso(16) })
      .Локация.set(S.зал).Расписание.set(S.расписание).rows();
  }
});

after(async () => {
  await db?.close();
  await e?.close();
});

// ---------------------------------------------------------------------------
// Хелперы «сервиса записи»
// ---------------------------------------------------------------------------

/** Живые записи мастера. */
const visitsOf = (q: Db, master: { id: string }) => q.Мастер(master.id).запись().rows();

/** Свободные часовые старты мастера: часы внутри смен минус пересечения с записями. */
async function freeHours(master: Row): Promise<Set<number>> {
  const смены = await db.Мастер(master.id).окно().exact().rows();
  const записи = await visitsOf(db, master);
  const свободно = new Set<number>();
  for (const w of смены) {
    for (let x = ms(w.data.start_datetime); x + 3600_000 <= ms(w.data.end_datetime); x += 3600_000) {
      const busy = записи.some((з) => ms(з.data.start_datetime) < x + 3600_000 && x < ms(з.data.end_datetime));
      if (!busy) свободно.add(new Date(x).getUTCHours() + 3);
    }
  }
  return свободно;
}

interface VisitReq {
  client: { id: string } | null; // null — walk-in «на имя» (имя в notes)
  notes?: string;
  master: Row;
  item: Row;                     // Услуга | Комплекс
  startHour: number;
}

/** Проверки брони: навык (комплекс — по составу), смена, пересечения. Бросает с причиной. */
async function guardVisit(tr: Db, req: VisitReq, startIso: string, endIso: string, skipId?: string): Promise<void> {
  // навык: услуга — прямой; комплекс — покрытие всех услуг состава
  if (req.item.class === 'Service') {
    if (!(await tr.Мастер(req.master.id).навык().Услуга(req.item.id).count())) {
      throw new Error(`нет навыка: ${String(req.master.data.name)} не делает ${String(req.item.data.name)}`);
    }
  } else {
    const услуги = await tr.Комплекс(req.item.id).состав().Услуга().ids();
    const покрыто = await tr.Мастер(req.master.id).навык().Услуга(услуги).count();
    if (покрыто !== услуги.length) {
      throw new Error(`нет навыка: ${String(req.master.data.name)} не делает ${String(req.item.data.name)}`);
    }
  }
  // интервал записи внутри какой-то смены мастера (позитивная доступность)
  const смены = await tr.Мастер(req.master.id).окно().exact().rows();
  const внутри = смены.some((w) => ms(w.data.start_datetime) <= ms(startIso) && ms(endIso) <= ms(w.data.end_datetime));
  if (!внутри) throw new Error(`вне смены: ${String(req.master.data.name)} не работает в это время`);
  // пересечения с живыми записями
  const записи = await visitsOf(tr, req.master);
  const конфликт = записи.some((з) => з.id !== skipId && ms(з.data.start_datetime) < ms(endIso) && ms(startIso) < ms(з.data.end_datetime));
  if (конфликт) throw new Error(`слот занят: ${req.startHour}:00`);
}

/** Цепочка создания записи: концы из пути (мастер) и слотов. */
function визит(tr: Db, master: { id: string }, item: { id: string }, client: { id: string } | null, startIso: string, endIso: string, notes?: unknown): Chain {
  let ц = tr.Мастер(master.id).запись()
    .create({ start_datetime: startIso, end_datetime: endIso, ...(notes ? { notes } : {}) })
    .Локация.set(S.зал).Расписание.set(S.расписание).Item.set(item.id);
  if (client) ц = ц.Клиент.set(client.id);
  return ц;
}

/** Бронь под advisory-lock мастера; id записи — v5 от (мастер, старт). */
async function bookVisit(req: VisitReq): Promise<Row> {
  const startIso = iso(req.startHour);
  const endIso = new Date(ms(startIso) + (req.item.data.duration as number) * 60_000).toISOString();
  const tr = await db.begin();
  try {
    await tr.lock('visits', req.master.id); // сериализация всех броней мастера
    await guardVisit(tr, req, startIso, endIso);
    const [запись] = await визит(tr, req.master, req.item, req.client, startIso, endIso, req.notes).rows();
    await tr.commit();
    return запись;
  } catch (err) {
    await tr.rollback();
    throw err;
  }
}

/**
 * Перенос: id держит (мастер, старт) — смена времени или мастера есть пересоздание. пауза — перед
 * фиксацией: сцена гонки держит транзакцию переноса открытой.
 */
async function reschedule(запись: Row, master: Row, startHour: number, пауза?: () => Promise<void>): Promise<Row | false> {
  const tr = await db.begin();
  try {
    const мастера = [...new Set([запись.links.Staff as string, master.id])].sort(); // один порядок блокировок
    for (const m of мастера) await tr.lock('visits', m);
    const тек = await tr.запись(запись.id).first();
    if (!тек) {
      await tr.rollback();
      return false; // уже отменена или перенесена
    }
    const предмет = (await tr.запись(тек.id).Item().first())!;
    const startIso = iso(startHour);
    const endIso = new Date(ms(startIso) + (предмет.data.duration as number) * 60_000).toISOString();
    const клиент = тек.links.Customer ? { id: тек.links.Customer as string } : null;
    try {
      await guardVisit(tr, { client: клиент, master, item: предмет, startHour }, startIso, endIso, тек.id);
    } catch {
      await tr.rollback();
      return false; // цель занята или вне смены
    }
    // старая пара (мастер, старт) свободна; target_not_found — запись нашлась, но параллельная отмена
    // удалила её, пока удаление переноса ждало строку (правило числа строк, §2.5)
    const снято = await tr.запись(тек.id).delete({ confirm: true }).rows().catch((err: { code?: string }) => {
      if (err.code === 'target_not_found') return [];
      throw err;
    });
    if (!снято.length) {
      await tr.rollback();
      return false; // запись отменили между чтением и удалением
    }
    const [новая] = await визит(tr, master, предмет, клиент, startIso, endIso, тек.data.notes).rows();
    await пауза?.();
    await tr.commit();
    return новая;
  } catch (err) {
    await tr.rollback();
    throw err;
  }
}

/** Отмена — удаление с надгробием (история в versions). Идемпотентна: false — записи уже нет. q — пул или db.begin(). */
async function cancel(запись: Row, q: Db = db): Promise<boolean> {
  try {
    const gone = await q.запись(запись.id).delete({ confirm: true }).rows();
    return gone.length > 0;
  } catch (err) {
    // запись нашлась, но параллельный перенос успел её удалить (правило числа строк, §2.5)
    if ((err as { code?: string }).code === 'target_not_found') return false;
    throw err;
  }
}

/** Неявка: пометка в notes новой версией (запись остаётся фактом дня). */
async function noShow(запись: Row): Promise<Row | null> {
  const [v] = await db.запись(запись.id).update({ notes: 'no-show' }).rows();
  return v ?? null;
}

const занято = (err: unknown) => /слот занят/.test((err as Error).message);

// ---------------------------------------------------------------------------
// Сцены
// ---------------------------------------------------------------------------

test('С1. Happy path: Аня → Света, маникюр 10:00', async () => {
  S.зАни = await bookVisit({ client: S.Аня, master: S.света, item: S.маникюр, startHour: 10 });
  assert.equal(S.зАни.id, bookingId(S.света, iso(10)), 'id предсказуем до создания');
  assert.equal(S.зАни.links.Item, S.маникюр.id);

  const светаFree = await freeHours(S.света);
  assert.equal(светаFree.size, 5, 'из шести часов смены занят один');
  assert.ok(!светаFree.has(10));
  assert.ok((await freeHours(S.марина)).has(10), 'Марина свободна');

  const [смена] = await db.Мастер(S.света.id).окно().exact().rows();
  assert.ok(ms(смена.data.start_datetime) <= ms(S.зАни.data.start_datetime), 'старт визита внутри смены');
});

test('С2. «4 руки»: Катя 11:00 — Света маникюр и Марина педикюр (две записи, один час)', async () => {
  S.зКатяС = await bookVisit({ client: S.Катя, master: S.света, item: S.маникюр, startHour: 11 });
  S.зКатяМ = await bookVisit({ client: S.Катя, master: S.марина, item: S.педикюр, startHour: 11 });

  const обе = await db.Клиент(S.Катя.id).запись().Мастер().rows();
  assert.deepEqual([...new Set(обе.map((r) => r.data.name))].sort(), ['Марина', 'Света']);
  // педикюр 90 минут: интервал 11:00–12:30 одной записью — час 12 у Марины частично занят
  assert.ok(!(await freeHours(S.марина)).has(12));
  assert.equal(await db.Клиент(S.Катя.id).запись().count(), 2);
});

test('С3. Гонка: Оля и Боря одновременно на Марину 13:00 — ровно один успех', async () => {
  const попытка = (client: Row) =>
    bookVisit({ client, master: S.марина, item: S.маникюр, startHour: 13 }).catch((err) => {
      if (занято(err)) return null;
      throw err;
    });
  const [оля, боря] = await Promise.all([попытка(S.Оля), попытка(S.Боря)]);
  assert.ok((оля === null) !== (боря === null), 'ровно один должен выиграть');
  S.зОли13 = (оля ?? боря)!;
  S.проигравший = оля ? S.Боря : S.Оля;
  assert.equal((await db.запись(bookingId(S.марина, iso(13))).rows()).length, 1, 'живая запись на (Марина, 13:00) одна');
});

test('С4. «Любой мастер»: проигравший ищет 13:00 с навыком маникюр → Света', async () => {
  const мастера: Row[] = [];
  for (const m of [S.марина, S.света]) {
    const умеет = await db.Мастер(m.id).навык().Услуга(S.маникюр.id).count();
    const свободен = (await freeHours(m)).has(13);
    if (умеет && свободен) мастера.push(m);
  }
  assert.deepEqual(мастера.map((m) => m.data.name), ['Света']);
  S.зПроигравшего = await bookVisit({ client: S.проигравший, master: S.света, item: S.маникюр, startHour: 13 });
});

test('С5. Длинная услуга: Оля, педикюр 90 минут у Марины 14:00 — один интервал 14:00–15:30', async () => {
  S.зОлиПедикюр = await bookVisit({ client: S.Оля, master: S.марина, item: S.педикюр, startHour: 14 });
  const з = (await db.запись(S.зОлиПедикюр.id).first())!;
  assert.equal(ms(з.data.end_datetime) - ms(з.data.start_datetime), 90 * 60_000);
  assert.equal((await freeHours(S.марина)).size, 1, 'остался только час 10:00');
  // хвост 15:00–15:30 не пускает бронь на 15:00
  await assert.rejects(bookVisit({ client: S.Боря, master: S.марина, item: S.маникюр, startHour: 15 }), /слот занят/);
});

test('С6. Перенос времени: Аня 10:00 → 12:00 (та же Света) — пересоздание', async () => {
  const старая = S.зАни;
  const новая = await reschedule(S.зАни, S.света, 12);
  assert.ok(новая);
  S.зАни = новая;
  assert.equal(час(S.зАни), 12);
  assert.notEqual(S.зАни.id, старая.id, 'id держит (мастер, старт) — новый');
  assert.equal(S.зАни.links.Customer, S.Аня.id, 'клиент перенесён');
  assert.ok((await freeHours(S.света)).has(10), '10:00 свободно');
  assert.equal(await db.запись(старая.id).count(), 0, 'старая — надгробие');
  const история = await db.запись(старая.id).withDeleted().versions(); // удалённый id — с withDeleted()
  assert.ok(история.length >= 2 && история.at(-1)?.$deleted === true, 'история цела');
});

test('С7. Гонка: перенос Ани на 14:00 Светы против новой брони Бори туда же', async () => {
  const перенос = reschedule(S.зАни, S.света, 14);
  const бронь = bookVisit({ client: S.Боря, master: S.света, item: S.маникюр, startHour: 14 }).catch((err) => {
    if (занято(err)) return null;
    throw err;
  });
  const [ок, зБори2] = await Promise.all([перенос, бронь]);
  assert.ok((ок !== false) !== (зБори2 !== null), 'слот 14:00 достался ровно одному');
  if (ок) S.зАни = ок;
  R.зБори2 = зБори2;
  assert.equal(час((await db.запись(S.зАни.id).first())!), ок ? 14 : 12, 'проигравший перенос не тронул запись');
});

test('С8. Перенос к другому мастеру: запись с 13:00 Светы → 10:00 Марины', async () => {
  const новая = await reschedule(S.зПроигравшего, S.марина, 10);
  assert.ok(новая);
  S.зПроигравшего = новая;
  assert.equal(час(S.зПроигравшего), 10);
  assert.equal(S.зПроигравшего.links.Staff, S.марина.id, 'исполнитель сменён (он в ключе)');
  assert.equal(S.зПроигравшего.id, bookingId(S.марина, iso(10)));
  assert.ok((await freeHours(S.света)).has(13));
});

test('С9. Отмена: Оля отменяет педикюр → 14:00–15:30 Марины свободны', async () => {
  assert.equal(await cancel(S.зОлиПедикюр), true);
  const free = await freeHours(S.марина);
  assert.ok(free.has(14) && free.has(15));
  assert.equal(await db.запись(S.зОлиПедикюр.id).count(), 0, 'надгробие');
  assert.equal(await db.Клиент(S.Катя.id).запись().count(), 2, 'чужие записи целы («4 руки» Кати)');
});

test('С10. Повторная отмена — идемпотентна, версий не прибавилось', async () => {
  const версииДо = (await db.запись(S.зОлиПедикюр.id).withDeleted().versions()).length;
  assert.equal(версииДо, 2, 'создание и надгробие');
  assert.equal(await cancel(S.зОлиПедикюр), false);
  assert.equal((await db.запись(S.зОлиПедикюр.id).withDeleted().versions()).length, версииДо);
});

test('С11. Неявка: Аня не пришла — пометка на записи, время задним числом не освобождается', async () => {
  const v = await noShow(S.зАни);
  assert.ok(v);
  assert.equal(v.data.notes, 'no-show');
  assert.equal(await db.запись({ notes: 'no-show' }).count(), 1);
  assert.ok((await db.запись(S.зАни.id).versions()).length >= 2);
  assert.equal(await db.запись(S.зАни.id).count(), 1, 'запись осталась');
});

test('С12. Walk-in: Надя по телефону, без клиента — Марина 14:00', async () => {
  S.зНади = await bookVisit({ client: null, notes: 'Надя', master: S.марина, item: S.маникюр, startHour: 14 });
  const тек = (await db.запись(S.зНади.id).first())!;
  assert.equal(тек.data.notes, 'Надя');
  assert.equal(тек.links.Customer, undefined, 'клиента нет — ручная бронь');
  assert.equal(тек.id, bookingId(S.марина, iso(14)));
  // в календаре Марины видна; в историях клиентов — нет
  assert.ok((await db.Мастер(S.марина.id).запись().ids()).includes(S.зНади.id));
  for (const имя of ['Аня', 'Оля', 'Катя', 'Боря']) {
    assert.ok(!(await db.Клиент(S[имя].id).запись().ids()).includes(S.зНади.id));
  }
});

test('С13. Отказ: комплекс к Свете (не покрывает состав) — ничего не создано', async () => {
  const записейДо = await db.запись().count();
  await assert.rejects(bookVisit({ client: S.Катя, master: S.света, item: S.комплекс, startHour: 13 }), /нет навыка/);
  assert.equal(await db.запись().count(), записейДо);
});

test('С14. Отказ: бронь вне смены (16:00 при смене до 16:00) — отклонена', async () => {
  await assert.rejects(bookVisit({ client: S.Оля, master: S.марина, item: S.маникюр, startHour: 16 }), /вне смены/);
  assert.equal(await db.Мастер(S.марина.id).окно().exact().count(), 1, 'смены нетронуты');
});

test('С15. Гонка: отмена против переноса одной записи — согласованный исход', async () => {
  // порядок задают блокировки, а не скорость машины (§7.1): вторая операция ждёт строку, которую
  // удалила незафиксированная первая (waitForLock), и только потом первая фиксируется
  // 1) перенос первым: запись 10:00 Марины удалена и пересоздана у Светы в 15:00, отмена ждёт строку
  const запись = S.зПроигравшего;
  let отмена: Promise<boolean> | undefined;
  const перенеслось = await reschedule(запись, S.света, 15, async () => {
    отмена = cancel(запись);
    await waitForLock(e.sql);
  });
  assert.ok(перенеслось, 'перенос прошёл');
  assert.equal(await отмена, false, 'отмена опоздала: запись уже перенесена');
  assert.equal(await db.запись(запись.id).count(), 0, 'старого id нет');
  S.зПроигравшего = перенеслось;
  assert.equal(час(S.зПроигравшего), 15);
  assert.equal(await db.запись(S.зПроигравшего.id).count(), 1);

  // 2) отмена первой: её транзакция удалила запись и не зафиксирована, удаление переноса ждёт строку
  const тр = await db.begin();
  assert.equal(await cancel(S.зПроигравшего, тр), true);
  const перенос = reschedule(S.зПроигравшего, S.марина, 15);
  await waitForLock(e.sql);
  await тр.commit();
  assert.equal(await перенос, false, 'перенос опоздал: запись уже отменена');
  assert.equal(await db.запись(S.зПроигравшего.id).count(), 0, 'отменённой записи нет');
  assert.equal(await db.запись(bookingId(S.марина, iso(15))).count(), 0, 'на 15:00 Марины ничего не создано');
  assert.equal(await reschedule(S.зПроигравшего, S.марина, 15), false, 'отменённую запись не перенести');
});

test('С16. Конец дня: отчёты и сквозные инварианты', async () => {
  // расписание дня: каждая живая запись — у известного мастера
  const пути = await db.запись().Мастер().paths();
  assert.ok(пути.length > 0);
  for (const p of пути) assert.ok(['Марина', 'Света'].includes(String(p.Мастер.data.name)));

  // выручка дня — сумма цен предметов живых записей (услуги — цена RUB из связи «цена», комплексы — cost)
  const прайс = new Map<string, number>();
  for (const s of [S.маникюр, S.педикюр]) {
    const [ц] = await db.Услуга(s.id).цена().rows();
    прайс.set(s.id, (ц.data.amounts as Record<string, number>).RUB);
  }
  const поУслугам = await db.запись().Услуга().paths();
  const поКомплексам = await db.запись().Комплекс().paths();
  const выручка = поУслугам.reduce((sum, p) => sum + (прайс.get(p.Услуга.id) ?? 0), 0)
    + поКомплексам.reduce((sum, p) => sum + (p.Комплекс.data.cost as number), 0);
  assert.ok(выручка >= 2000 + 3000 + 2000 + 2000, `выручка ${выручка}: минимум Катя (раздельно), Оля 13 и Надя`);

  // неявка помечена в notes
  assert.deepEqual(await db.запись({ notes: 'no-show' }).ids(), [S.зАни.id]);
  // отменённый педикюр Оли (Марина, 14:00) воскрешён walk-in-бронью Нади: та же пара
  // (мастер, старт) — тот же id, в истории надгробие посередине
  assert.equal(S.зНади.id, S.зОлиПедикюр.id);
  assert.ok((await db.запись(S.зОлиПедикюр.id).versions()).some((v) => v.$deleted === true));
  assert.equal((await db.запись(S.зОлиПедикюр.id).first())!.data.notes, 'Надя');

  // инварианты: (а) двойная бронь невозможна — пара (мастер, старт) уникальна
  const все = await db.запись().rows();
  const пары = new Set<string>();
  for (const з of все) {
    const ключ = `${з.links.Staff}|${String(з.data.start_datetime)}`;
    assert.ok(!пары.has(ключ), `две живые записи на пару ${ключ}`);
    пары.add(ключ);
  }
  // (б) каждая запись внутри смены своего мастера
  for (const з of все) {
    const смены = await db.Мастер(з.links.Staff as string).окно().exact().rows();
    assert.ok(смены.some((w) => ms(w.data.start_datetime) <= ms(з.data.start_datetime) && ms(з.data.end_datetime) <= ms(w.data.end_datetime)),
      `запись ${з.id} вне смен мастера`);
  }
  // (в) история цела: у записи Ани (неявка) не меньше двух версий; история воскрешённого id
  // хранит и жизнь педикюра Оли, и надгробие, и бронь Нади
  assert.ok((await db.запись(S.зАни.id).versions()).length >= 2);
  assert.ok((await db.запись(S.зНади.id).versions()).length >= 3);
  // (г) журнал и цепочки хэшей сходятся
  const [{ v }] = await e.sql.unsafe(`select ${e.S}.verify() as v`);
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});
