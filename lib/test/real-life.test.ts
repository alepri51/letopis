/**
 * «Реальная жизнь»: салон «Ласточка», пятница 2026-07-10, 10:00–16:00.
 * 16 сцен: запись, «4 руки» (два мастера — одна запись), race двойной брони,
 * мульти-слот, переносы (время/мастер/race), отмена (+идемпотентность), no-show,
 * walk-in без клиента, отказы (навык/off), race отмена-vs-перенос, отчёты дня.
 *
 * Хелперы bookVisit/reschedule/cancel — «сервис записи» поверх dot-цепочек.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../src/index.js';
import type { EntityDb, EntityTx } from '../src/chain.js';
import type { Row } from '../src/types.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';

let db: EntityDb;
const S: Record<string, Row> = {};  // сцена: организация, мастера, услуги, клиенты, записи
let W: Row[] = [];                  // окна дня: W[0]=10:00 … W[5]=15:00

const час = (w: Row) => new Date(String(w.data.start)).getUTCHours() + 3; // Europe/Moscow (+03)
const окно = (h: number) => {
  const w = W.find((x) => час(x) === h);
  assert.ok(w, `нет окна ${h}:00`);
  return w!;
};
const rub = (item: Row) => (item.data.price as { RUB: number }).RUB;
const busyId = (master: Row, win: Row) => `busy-${master.id}-${win.id}`;

before(async () => {
  db = await connect({ dsn: DSN, schema: 'booking' });
  await db.sql.unsafe('TRUNCATE "booking"."Entity"');

  // Салон, мастера, каталог, навыки — связи dot-цепочками
  [S.салон] = await db.Организация().set({ name: 'Ласточка' });
  [S.марина] = await db.Организация(S.салон).Сотрудник().set({ name: 'Марина', roles: ['owner', 'master'] });
  [S.света] = await db.Организация(S.салон).Сотрудник().set({ name: 'Света', roles: ['master'] });

  [S.маникюр] = await db.Организация(S.салон).Услуга().set({ name: 'Маникюр', duration: 60, price: { RUB: 2000 } });
  [S.педикюр] = await db.Организация(S.салон).Услуга().set({ name: 'Педикюр', duration: 90, price: { RUB: 3000 } });
  [S.комплекс] = await db.Организация(S.салон).Комплекс().set({ name: 'М+П', duration: 150, price: { RUB: 4500 } });
  await db.Комплекс(S.комплекс).Услуга(S.маникюр).позиция().set({ qty: 1 });
  await db.Комплекс(S.комплекс).Услуга(S.педикюр).позиция().set({ qty: 1 });

  await db.Сотрудник(S.марина).Услуга(S.маникюр).навык().set({});
  await db.Сотрудник(S.марина).Услуга(S.педикюр).навык().set({});
  await db.Сотрудник(S.марина).Комплекс(S.комплекс).навык().set({});
  await db.Сотрудник(S.света).Услуга(S.маникюр).навык().set({});

  for (const имя of ['Аня', 'Оля', 'Катя', 'Боря']) {
    [S[имя]] = await db.Организация(S.салон).Клиент().set({ name: имя });
  }

  // Календарь: расписание пятницы + 6 окон по 60м + обе в смене
  [S.расписание] = await db.Организация(S.салон).Расписание().set({
    start: '2026-07-10T10:00:00+03:00', end: '2026-07-10T16:00:00+03:00',
  });
  for (let h = 10; h <= 15; h++) {
    db.batch('окна').Расписание(S.расписание).Окно().set({
      start: `2026-07-10T${h}:00:00+03:00`, end: `2026-07-10T${h + 1}:00:00+03:00`,
    });
  }
  W = (await db.batch('окна').execute()).map((r) => r[0]);
  await db.Расписание(S.расписание).Сотрудник(S.марина).смена().set({});
  await db.Расписание(S.расписание).Сотрудник(S.света).смена().set({});
});

after(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------
// Хелперы «сервиса записи»
// ---------------------------------------------------------------------------

/** Свободные окна мастера: окна расписаний его смен − его живые занятости. */
async function freeSlots(master: Row): Promise<Set<string>> {
  const все = await db.Сотрудник(master.id).смена().Расписание().Окно().ids();
  const занятости = await db.Сотрудник(master.id).занятость().execute();
  const заняты = new Set(занятости.map((p) => p.занятость.links.Slot));
  return new Set(все.filter((id) => !заняты.has(id)));
}

/** N подряд идущих окон с часа h. */
function оконПодряд(h: number, n: number): Row[] {
  return Array.from({ length: n }, (_, i) => окно(h + i));
}

interface VisitReq {
  client: Row | null;              // null = walk-in «на имя»
  comment?: string;
  master: Row;
  item: Row;                       // Услуга | Комплекс
  startHour: number;
  source?: string;
}

/** Бронь: навык + свободность нужного числа подряд окон, под advisory-lock. */
async function bookVisit(req: VisitReq): Promise<Row> {
  const need = Math.ceil((req.item.data.duration as number) / 60);
  const wins = оконПодряд(req.startHour, need);
  const tr = await db.begin();
  try {
    for (const w of wins) await tr.lock('busy', req.master.id, w.id);

    const kind = req.item.class === 'Service' ? 'Услуга' : 'Комплекс';
    const умеет = await (tr.Сотрудник(req.master.id).навык() as never as Record<string, (f?: unknown) => { count(): Promise<number> }>)[kind](req.item.id).count();
    if (!умеет) throw new Error(`нет навыка: ${String(req.master.data.name)} не делает ${String(req.item.data.name)}`);

    for (const w of wins) {
      if (await tr.занятость(busyId(req.master, w)).first()) throw new Error(`слот занят: ${час(w)}:00`);
    }

    const запись = req.client
      ? (await tr.Клиент(req.client).Запись().set({
          status: 'created', source: req.source ?? 'online', total: { RUB: rub(req.item) },
        }))[0]
      : (await tr.Запись().set({
          status: 'created', source: 'admin', comment: req.comment, total: { RUB: rub(req.item) },
        }))[0];

    const поз = tr.Запись(запись).Сотрудник(req.master).позиция().set({ qty: 1, price: { RUB: rub(req.item) } });
    (поз as never as Record<string, (t: Row) => unknown>)[kind](req.item);
    await поз;

    for (const w of wins) {
      await tr.Сотрудник(req.master).Окно(w).Запись(запись).занятость(busyId(req.master, w)).set({ kind: 'booking' });
    }
    await tr.commit();
    return запись;
  } catch (e) {
    await tr.rollback();
    throw e;
  }
}

/** Перенос: время и/или мастер. Атомарно; false — цель занята/запись отменена. */
async function reschedule(запись: Row, master: Row, startHour: number, need = 1): Promise<boolean> {
  const wins = оконПодряд(startHour, need);
  const tr = await db.begin();
  try {
    await tr.lock('booking', запись.id);
    const тек = await tr.Запись(запись.id).first();
    if (!тек || тек.data.status === 'cancelled' || тек.data.status === 'no_show') {
      await tr.rollback();
      return false;
    }
    for (const w of wins) await tr.lock('busy', master.id, w.id);
    for (const w of wins) {
      if (await tr.занятость(busyId(master, w)).first()) {
        await tr.rollback();
        return false;
      }
    }
    await tr.Запись(запись.id).занятость().delete();                    // освободить старые
    for (const w of wins) {
      await tr.Сотрудник(master).Окно(w).Запись(запись).занятость(busyId(master, w)).set({ kind: 'booking' });
    }
    await tr.Запись(запись.id).позиция({}).set({}).Сотрудник(master);   // ({}) = все позиции записи → новый исполнитель
    await tr.Запись(запись.id).set({ status: 'confirmed' });
    await tr.commit();
    return true;
  } catch (e) {
    await tr.rollback();
    throw e;
  }
}

/** Отмена/неявка: статус + освобождение окон. Идемпотентна (false = уже завершена). */
async function finishNegative(запись: Row, status: 'cancelled' | 'no_show'): Promise<boolean> {
  const tr = await db.begin();
  try {
    await tr.lock('booking', запись.id);
    const тек = await tr.Запись(запись.id).first();
    if (!тек || тек.data.status === 'cancelled' || тек.data.status === 'no_show') {
      await tr.rollback();
      return false;
    }
    await tr.Запись(запись.id).set({ status });
    await tr.Запись(запись.id).занятость().delete();
    await tr.commit();
    return true;
  } catch (e) {
    await tr.rollback();
    throw e;
  }
}
const cancel = (з: Row) => finishNegative(з, 'cancelled');

// ---------------------------------------------------------------------------
// Сцены
// ---------------------------------------------------------------------------

test('С1. Happy path: Аня → Света, маникюр 10:00', async () => {
  S.зАни = await bookVisit({ client: S.Аня, master: S.света, item: S.маникюр, startHour: 10 });

  const светаFree = await freeSlots(S.света);
  assert.equal(светаFree.size, 5);
  assert.ok(!светаFree.has(окно(10).id));
  assert.ok((await freeSlots(S.марина)).has(окно(10).id)); // Марина свободна

  // дата приёма = start окна брони
  const [w] = await db.Запись(S.зАни.id).занятость().Окно().rows();
  assert.equal(String(w.data.start), String(окно(10).data.start));
});

test('С2. «4 РУКИ»: Катя 11:00 — Света маникюр + Марина педикюр, ОДНА запись', async () => {
  const tr = await db.begin();
  try {
    for (const [m, wins] of [[S.света, [окно(11)]], [S.марина, [окно(11), окно(12)]]] as [Row, Row[]][]) {
      for (const w of wins) {
        await tr.lock('busy', m.id, w.id);
        assert.equal(await tr.занятость(busyId(m, w)).first(), null);
      }
    }
    [S.з4руки] = await tr.Клиент(S.Катя).Запись().set({ status: 'created', total: { RUB: 5000 } });
    await tr.Запись(S.з4руки).Услуга(S.маникюр).Сотрудник(S.света).позиция().set({ qty: 1, price: { RUB: 2000 } });
    await tr.Запись(S.з4руки).Услуга(S.педикюр).Сотрудник(S.марина).позиция().set({ qty: 1, price: { RUB: 3000 } });
    await tr.Сотрудник(S.света).Окно(окно(11)).Запись(S.з4руки).занятость(busyId(S.света, окно(11))).set({ kind: 'booking' });
    await tr.Сотрудник(S.марина).Окно(окно(11)).Запись(S.з4руки).занятость(busyId(S.марина, окно(11))).set({ kind: 'booking' });
    await tr.Сотрудник(S.марина).Окно(окно(12)).Запись(S.з4руки).занятость(busyId(S.марина, окно(12))).set({ kind: 'booking' });
    await tr.commit();
  } catch (e) {
    await tr.rollback();
    throw e;
  }

  // в 11:00 заняты ОБЕ — одной записью
  const мастера11 = await db.Окно(окно(11).id).занятость({ kind: 'booking' }).Сотрудник().rows();
  assert.deepEqual(мастера11.map((r) => r.data.name).sort(), ['Марина', 'Света']);

  const занятости = await db.Запись(S.з4руки.id).занятость().execute();
  assert.equal(занятости.length, 3); // Света×1 + Марина×2 (педикюр 90м)

  const позиции = await db.Запись(S.з4руки.id).позиция().execute();
  const исполнители = позиции.map((p) => p.позиция.links.Staff).sort();
  assert.deepEqual(исполнители, [S.марина.id, S.света.id].sort());
  assert.deepEqual((await db.Запись(S.з4руки.id).first())!.data.total, { RUB: 5000 });
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

  const живые = (await db.sql.unsafe(
    `SELECT count(*)::int n FROM (
       SELECT DISTINCT ON (id) deleted FROM "booking"."Entity"
       WHERE partition='entity' AND class='busy' AND id=$1 ORDER BY id, updated DESC
     ) t WHERE t.deleted IS NULL`,
    [busyId(S.марина, окно(13))] as never[],
  )) as never as { n: number }[];
  assert.equal(живые[0].n, 1);
});

test('С4. «Любой мастер»: проигравший ищет 13:00 с навыком маникюр → Света', async () => {
  const мастера = [];
  for (const m of [S.марина, S.света]) {
    const умеет = await db.Сотрудник(m.id).навык().Услуга(S.маникюр.id).count();
    const свободен = (await freeSlots(m)).has(окно(13).id);
    if (умеет && свободен) мастера.push(m);
  }
  assert.deepEqual(мастера.map((m) => m.data.name), ['Света']);

  S.зПроигравшего = await bookVisit({ client: S.проигравший, master: S.света, item: S.маникюр, startHour: 13 });
});

test('С5. Мульти-слот: Оля педикюр 90м у Марины 14:00 → окна 14+15', async () => {
  S.зОлиПедикюр = await bookVisit({ client: S.Оля, master: S.марина, item: S.педикюр, startHour: 14 });

  const окна = await db.Запись(S.зОлиПедикюр.id).занятость().Окно().sort('data.start').rows();
  assert.deepEqual(окна.map((w) => час(w)), [14, 15]);
  assert.equal((await freeSlots(S.марина)).size, 1); // осталась только 10:00
});

test('С6. Перенос времени: Аня 10:00 → 12:00 (та же Света)', async () => {
  assert.equal(await reschedule(S.зАни, S.света, 12), true);

  const [w] = await db.Запись(S.зАни.id).занятость().Окно().rows();
  assert.equal(час(w), 12);
  assert.ok((await freeSlots(S.света)).has(окно(10).id)); // 10:00 свободно

  const версии = (await db.sql.unsafe(
    `SELECT count(*)::int n FROM "booking"."Entity" WHERE id=$1 AND class='Booking'`,
    [S.зАни.id] as never[],
  )) as never as { n: number }[];
  assert.equal(версии[0].n, 2); // created → confirmed
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
  assert.ok(ок !== (зБори2 !== null), 'слот 14:00 достался ровно одному');
  S.зБори2 = зБори2 as Row | null;

  const [w] = await db.Запись(S.зАни.id).занятость().Окно().rows();
  assert.equal(час(w), ок ? 14 : 12); // проигравший перенос не тронул запись
  S.часАни = час(w) as never;
});

test('С8. Перенос к другому мастеру: запись с 13:00 Светы → 10:00 Марины', async () => {
  assert.equal(await reschedule(S.зПроигравшего, S.марина, 10), true);

  const [w] = await db.Запись(S.зПроигравшего.id).занятость().Окно().rows();
  assert.equal(час(w), 10);
  const позиции = await db.Запись(S.зПроигравшего.id).позиция().execute();
  assert.ok(позиции.every((p) => p.позиция.links.Staff === S.марина.id)); // исполнитель сменён
  assert.ok((await freeSlots(S.света)).has(окно(13).id));
});

test('С9. Отмена: Оля отменяет педикюр → окна 14, 15 Марины свободны', async () => {
  assert.equal(await cancel(S.зОлиПедикюр), true);

  const free = await freeSlots(S.марина);
  assert.ok(free.has(окно(14).id) && free.has(окно(15).id));
  assert.equal((await db.Запись(S.зОлиПедикюр.id).first())!.data.status, 'cancelled');
  // чужие занятости целы (4 руки Марины 11, 12)
  assert.equal(await db.Запись(S.з4руки.id).занятость().count(), 3);
});

test('С10. Повторная отмена — идемпотентный no-op', async () => {
  const версииДо = (await db.sql.unsafe(
    `SELECT count(*)::int n FROM "booking"."Entity" WHERE id=$1`, [S.зОлиПедикюр.id] as never[],
  )) as never as { n: number }[];
  assert.equal(await cancel(S.зОлиПедикюр), false);
  const версииПосле = (await db.sql.unsafe(
    `SELECT count(*)::int n FROM "booking"."Entity" WHERE id=$1`, [S.зОлиПедикюр.id] as never[],
  )) as never as { n: number }[];
  assert.equal(версииПосле[0].n, версииДо[0].n); // версий не прибавилось
});

test('С11. No-show: Аня не пришла', async () => {
  assert.equal(await finishNegative(S.зАни, 'no_show'), true);
  const тек = (await db.Запись(S.зАни.id).first())!;
  assert.equal(тек.data.status, 'no_show');
  assert.equal(await db.Запись(S.зАни.id).занятость().count(), 0);
  assert.ok((await freeSlots(S.света)).has(окно(S.часАни as never).id));
});

test('С12. Walk-in: Надя по телефону, без клиента — Марина 14:00', async () => {
  S.зНади = await bookVisit({ client: null, comment: 'Надя', master: S.марина, item: S.маникюр, startHour: 14 });

  const тек = (await db.Запись(S.зНади.id).first())!;
  assert.equal(тек.data.comment, 'Надя');
  assert.equal(тек.links.Customer, undefined);        // клиента нет
  assert.equal(тек.data.source, 'admin');

  // в календаре Марины видна (в 14:00 может быть и Света — исход race С7); в историях клиентов — нет
  const занятые = await db.Окно(окно(14).id).занятость({ kind: 'booking' }).Сотрудник().rows();
  assert.ok(занятые.map((r) => r.data.name).includes('Марина'));
  const записьМарины14 = await db.Окно(окно(14).id).занятость({ kind: 'booking' }).Запись().ids();
  assert.ok(записьМарины14.includes(S.зНади.id));
  for (const имя of ['Аня', 'Оля', 'Катя', 'Боря']) {
    const истории = await db.Клиент(S[имя].id).Запись().ids();
    assert.ok(!истории.includes(S.зНади.id));
  }
});

test('С13. Отказ: комплекс к Свете (нет навыка) — ничего не создано', async () => {
  const записейДо = await db.Запись().count();
  await assert.rejects(
    bookVisit({ client: S.Катя, master: S.света, item: S.комплекс, startHour: 13 }),
    /нет навыка/,
  );
  assert.equal(await db.Запись().count(), записейДо);
});

test('С14. Отказ: Марина снята с 15:00 (off) — бронь отклонена', async () => {
  await db.Сотрудник(S.марина).Окно(окно(15)).занятость(busyId(S.марина, окно(15))).set({ kind: 'off', reason: 'уборка' });

  await assert.rejects(
    bookVisit({ client: S.Оля, master: S.марина, item: S.маникюр, startHour: 15 }),
    /слот занят/,
  );
  // off ≠ booking
  assert.equal(await db.Окно(окно(15).id).занятость({ kind: 'booking' }).count(), 0);
  assert.equal(await db.Окно(окно(15).id).занятость({ kind: 'off' }).count(), 1);
});

test('С15. Race: отмена vs перенос одной записи → инвариант держится', async () => {
  const запись = S.зПроигравшего; // 10:00 Марины
  const [отменилось, перенеслось] = await Promise.all([
    cancel(запись),
    reschedule(запись, S.света, 15),
  ]);
  // допустимы оба порядка, но не «оба не сработали»
  assert.ok(отменилось || перенеслось, 'хотя бы одна операция должна пройти');

  const тек = (await db.Запись(запись.id).first())!;
  const живыеЗанятости = await db.Запись(запись.id).занятость().count();
  if (тек.data.status === 'cancelled') assert.equal(живыеЗанятости, 0);
  else assert.equal(живыеЗанятости, 1);
  S.исходС15 = тек as never;
});

test('С16. Конец дня: завершение визитов, отчёты, сквозные инварианты', async () => {
  // завершаем живые записи (created/confirmed) — визиты состоялись
  const активные = await db.Запись({ status: 'created' }).rows();
  const подтверждённые = await db.Запись({ status: 'confirmed' }).rows();
  for (const з of [...активные, ...подтверждённые]) {
    await db.Запись(з.id).set({ status: 'completed' });
  }

  // расписание дня по мастерам: окно → кто занят
  for (const w of W) {
    const занятые = await db.Окно(w.id).занятость({ kind: 'booking' }).Сотрудник().rows();
    for (const m of занятые) assert.ok(['Марина', 'Света'].includes(String(m.data.name)));
  }

  // выручка = Σ позиций completed-записей — сходится с суммой total
  const пути = await db.Запись({ status: 'completed' }).позиция().execute();
  const выручка = пути.reduce(
    (s, p) => s + (p.позиция.data.price as { RUB: number }).RUB * (p.позиция.data.qty as number), 0,
  );
  const завершённые = await db.Запись({ status: 'completed' }).rows();
  const ожидание = завершённые.reduce((s, з) => s + (з.data.total as { RUB: number }).RUB, 0);
  assert.equal(выручка, ожидание);
  assert.ok(выручка >= 5000 + 2000 + 2000); // минимум: 4 руки + Оля 13:00 + Надя

  // списки cancelled / no_show
  const отменённые = await db.Запись({ status: 'cancelled' }).ids();
  assert.ok(отменённые.includes(S.зОлиПедикюр.id));
  const неявки = await db.Запись({ status: 'no_show' }).ids();
  assert.deepEqual(неявки, [S.зАни.id]);

  // ИНВАРИАНТЫ:
  // (а) каждая живая booking-занятость → живая не-отменённая запись
  const брони = await db.занятость({ kind: 'booking' }).execute();
  for (const p of брони) {
    const bid = p.занятость.links.Booking;
    assert.ok(bid, 'booking-занятость обязана ссылаться на запись');
    const з = (await db.Запись(bid).first())!;
    assert.ok(з && з.data.status !== 'cancelled' && з.data.status !== 'no_show',
      `занятость ${p.занятость.id} висит на ${з?.data.status}`);
  }
  // (б) ≤ 1 живой занятости на пару (мастер, окно)
  const пары = new Set<string>();
  const все = await db.занятость().execute();
  for (const p of все) {
    const ключ = `${p.занятость.links.Staff}|${p.занятость.links.Slot}`;
    assert.ok(!пары.has(ключ), `две живые занятости на пару ${ключ}`);
    пары.add(ключ);
  }
  // (в) история цела: у но-шоу Ани ≥ 3 версий (created→confirmed→no_show)
  const версииАни = (await db.sql.unsafe(
    `SELECT count(*)::int n FROM "booking"."Entity" WHERE id=$1 AND class='Booking'`,
    [S.зАни.id] as never[],
  )) as never as { n: number }[];
  assert.ok(версииАни[0].n >= 3);
});
