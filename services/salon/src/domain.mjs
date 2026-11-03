/**
 * Предметная логика салона поверх цепочек letopis (по мотивам lib/test/scenario-real-life.test.ts).
 * База гарантирует уникальность брони мастера на время начала (ключ [Staff, start_datetime]);
 * пересечения и порядок броней одного мастера сервис сериализует блокировкой db.begin() + lock().
 * Перенос брони — новая бронь на новом слоте и удаление прежней одной транзакцией: время начала в ключе, а ключ правкой
 * не меняется. Прайс — класс price сида: правка — upsert, список — db.load().
 */
import { LetopisError, gte, lt } from 'letopis';

/** Причина переноса: у новой брони — версия создания с ней, у прежней — версия удаления (надгробие переноса). */
export const MOVE_REASON = 'перенос брони';

/** Отказ сервиса с HTTP-статусом — не код библиотеки. */
export class ServiceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Часы работы салона (UTC — для простоты примера). */
export const HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18];

export const iso = (day, hour) => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
export const today = () => new Date().toISOString().slice(0, 10);

/** Справочники салона арендатора: организация, локация, расписание, мастера, услуги. */
export async function directory(db) {
  const [org] = await db.Org().rows();
  if (!org) return null;
  const [location] = await db.Org(org).Location().rows();
  const [schedule] = await db.Org(org).Schedule().rows();
  const staff = await db.Org(org).Staff().sort('data.name').rows();
  // каталог читается часто и меняется редко — кэш результатов (сбрасывается сигналом при правке)
  const services = await db.Org(org).Service().sort('data.name').cache({ ttl: 60_000 }).rows();
  return { org, location, schedule, staff, services };
}

/** Брони дня: по мастеру и часу начала. */
export async function dayBookings(db, day) {
  const rows = await db.booking({ start_datetime: gte(iso(day, 0)) }).rows();
  const end = iso(day, 23);
  return rows.filter((b) => b.data.start_datetime < end);
}

/**
 * Записать клиента. Всё — одной транзакцией: блокировка мастера, проверка пересечения, клиент, бронь.
 * Вторая вкладка с тем же мастером ждёт блокировку и после неё видит занятый слот.
 * @returns {{ booking, log: string[] }}
 */
export async function book(db, { day, hour, staffId, serviceId, name, phone }, trace = []) {
  const dir = await directory(db);
  const start = iso(day, hour);
  const end = iso(day, hour + 1);
  const tr = await db.begin({ reason: 'бронь с сайта' });
  try {
    trace.push(`db.begin({ reason: 'бронь с сайта' }); tr.lock('visits', мастер)`);
    await tr.lock('visits', staffId); // все брони мастера — по очереди
    const busy = await tr.Staff(staffId).booking({ start_datetime: start }).count();
    if (busy) throw new LetopisError('exists', `слот ${hour}:00 у мастера уже занят`);
    trace.push(`tr.Org(салон).Customer().create({ name, phone })`);
    const [customer] = await tr.Org(dir.org).Customer().create({ name, phone }).rows();
    trace.push(`tr.Staff(мастер).booking().create({ start_datetime, end_datetime })…Item.set(услуга).Customer.set(клиент)`);
    const [row] = await tr.Staff(staffId).booking()
      .create({ start_datetime: start, end_datetime: end })
      .Location.set(dir.location).Schedule.set(dir.schedule).Item.set(serviceId).Customer.set(customer)
      .rows();
    await tr.commit();
    trace.push('tr.commit()');
    return row;
  } catch (e) {
    await tr.rollback().catch(() => {});
    trace.push(`tr.rollback() — ${e.code ?? e.message}`);
    throw e;
  }
}

/** Отменить бронь: удаление с надгробием, история остаётся. */
export async function cancel(db, bookingId, trace = []) {
  trace.push(`db.booking(id).delete({ confirm: true, reason: 'отмена клиентом' })`);
  return db.booking(bookingId).delete({ confirm: true, reason: 'отмена клиентом' }).rows();
}

/**
 * Вернуть отменённую бронь. Прежний слот переноса не возвращается: его удалила транзакция переноса (причина версии
 * удаления — MOVE_REASON), бронь живёт на новом слоте, и restore дал бы клиенту две брони.
 */
export async function restore(db, bookingId, trace = []) {
  const [was] = await db.booking(bookingId).withDeleted().rows();
  if (was?.$deleted && was.reason === MOVE_REASON) throw new ServiceError(409, 'бронь не отменена, а перенесена — она в расписании на новом слоте');
  trace.push(`db.booking(id).restore()`);
  return db.booking(bookingId).restore().rows();
}

/**
 * Перенести бронь на другой час (или к другому мастеру). id брони — из ключа [Staff, start_datetime], а ключ правкой не
 * меняется (immutable_key). Поэтому перенос — новая бронь на новом слоте с теми же концами (клиент, услуга, место,
 * расписание) и удаление прежней, одной транзакцией с причиной MOVE_REASON. У новой брони — новый id и своя история; у
 * прежнего слота остаётся надгробие — версия удаления с той же причиной, это не отмена. Конец брони сдвигается вместе с
 * началом, длительность — прежняя. Как в book(): под блокировкой мастера (при переносе к другому — обоих, в порядке id:
 * встречные переносы не заблокируют друг друга), занятый слот — exists.
 */
export async function move(db, bookingId, { day, hour, staffId }, trace = []) {
  const cur = await db.booking(bookingId).first();
  if (!cur) throw new LetopisError('not_found', 'брони нет — её отменили или уже перенесли');
  const from = cur.links.Staff;
  const to = staffId || from;
  const start = iso(day || String(cur.data.start_datetime).slice(0, 10), hour);
  if (to === from && start === cur.data.start_datetime) throw new LetopisError('invalid_data', 'бронь уже на этом слоте');
  const end = new Date(Date.parse(start) + Date.parse(cur.data.end_datetime) - Date.parse(cur.data.start_datetime)).toISOString();
  const tr = await db.begin({ reason: MOVE_REASON });
  try {
    trace.push(`db.begin({ reason: '${MOVE_REASON}' }); tr.lock('visits', мастер)${to === from ? '' : ' — обоих, в порядке id'}`);
    for (const id of [...new Set([from, to])].sort()) await tr.lock('visits', id);
    // бронь — заново, с блокировкой строки до commit: пока ждали замок, её могли отменить или перенести из другой вкладки
    const live = await tr.booking(cur.id).forUpdate().first();
    if (!live) throw new LetopisError('not_found', 'брони нет — её отменили или уже перенесли');
    const busy = await tr.Staff(to).booking({ start_datetime: start }).count();
    if (busy) throw new LetopisError('exists', `слот ${hour}:00 у мастера уже занят`);
    trace.push(`tr.Staff(${to === from ? 'мастер' : 'другой мастер'}).booking().create({ start_datetime, end_datetime })…Item.set(услуга).Customer.set(клиент) — новая бронь: id из нового ключа`);
    let plan = tr.Staff(to).booking()
      .create({ start_datetime: start, end_datetime: end, ...(live.data.notes === undefined ? {} : { notes: live.data.notes }) })
      .Location.set(live.links.Location).Schedule.set(live.links.Schedule).Item.set(live.links.Item);
    if (live.links.Customer) plan = plan.Customer.set(live.links.Customer);
    const [row] = await plan.rows();
    trace.push(`tr.booking(прежняя).delete({ confirm: true }) — прежний слот освобождён: надгробие с причиной «${MOVE_REASON}»`);
    await tr.booking(live.id).delete({ confirm: true }).rows();
    await tr.commit();
    trace.push('tr.commit()');
    return row;
  } catch (e) {
    await tr.rollback().catch(() => {});
    trace.push(`tr.rollback() — ${e.code ?? e.message}`);
    throw e;
  }
}

/**
 * История брони: все версии этого id и что менялось между ними. id — из ключа, поэтому у слота одна история: бронь на
 * месте отменённой или перенесённой продолжает её версии. Перенос — другой слот, другой id и своя история.
 */
export async function history(db, bookingId, trace = []) {
  trace.push('db.booking(id).withDeleted().versions() — версии этой брони (этого id)');
  return db.booking(bookingId).withDeleted().versions();
}

/** Вариант цены в ключе price [Item, note]; у сида он же по умолчанию — одна цена услуги на салон. */
export const NOTE = 'базовая';

/** Прайс салона: услуги каталога и их цены (вариант NOTE, рубли; нет цены — null). */
export async function priceList(db) {
  const dir = await directory(db);
  const prices = new Map((await db.price({ note: NOTE }).rows()).map((p) => [p.links.Item, p]));
  return dir.services.map((x) => ({
    id: x.id, name: x.data.name, duration: x.data.duration ?? null,
    price: prices.get(x.id)?.data.amounts.RUB ?? null, rev: prices.get(x.id)?.rev ?? null,
  }));
}

/**
 * Цена услуги — upsert по ключу [Item, note]: цены нет — создаётся, есть — заменяется целиком (amounts — только
 * переданные валюты), те же данные — без новой версии. $upsert строки: created, updated или unchanged.
 */
export async function setPrice(db, serviceId, rub, trace = []) {
  trace.push(`db.Service(услуга).price().upsert({ note: '${NOTE}', amounts: { RUB: ${rub} } }) — ключ [Item, note]: создать или заменить целиком`);
  const [row] = await db.Service(serviceId).price().upsert({ note: NOTE, amounts: { RUB: rub } }, { reason: 'правка прайса' }).rows();
  trace.push(`$upsert: '${row.$upsert}', rev ${row.rev}`);
  return row;
}

export const PRICE_LINES = 1000; // строк в прайсе списком — не больше
export const PRICE_LINE_CHARS = 200; // знаков в строке — не больше

/**
 * Прайс списком: строка — «услуга; цена» (разделитель — первый из «;», «:» или табуляции), пустые строки пропускаются.
 * Услуга — по названию из каталога салона (без учёта регистра): неизвестная — ошибка с номером строки.
 * Размер ограничен (PRICE_LINES строк по PRICE_LINE_CHARS знаков), а разбор — без регулярных выражений с
 * перекрывающимися квантификаторами: разделитель — indexOf, суффикс валюты — отдельным шагом, цена — якорным
 * /^\d[\d ]*$/. Иначе длинная строка из цифр и пробелов надолго заняла бы поток Node перебором (ReDoS).
 */
export function parsePriceList(text, services) {
  const byName = new Map(services.map((x) => [x.data.name.toLowerCase(), x]));
  const rows = String(text).split(/\r?\n/);
  if (rows.length > PRICE_LINES) throw new Error(`не больше ${PRICE_LINES} строк`);
  const items = [];
  rows.forEach((raw, i) => {
    if (raw.length > PRICE_LINE_CHARS) throw new Error(`строка ${i + 1}: длиннее ${PRICE_LINE_CHARS} знаков`);
    const line = raw.trim();
    if (!line) return;
    const at = Math.min(...[';', ':', '\t'].map((c) => line.indexOf(c)).filter((k) => k >= 0));
    const name = Number.isFinite(at) ? line.slice(0, at).trim() : '';
    let price = Number.isFinite(at) ? line.slice(at + 1).trim() : '';
    for (const unit of ['₽', 'руб.', 'руб']) {
      if (price.endsWith(unit)) { price = price.slice(0, -unit.length).trim(); break; }
    }
    if (!name || !/^\d[\d ]*$/.test(price)) throw new Error(`строка ${i + 1}: «${line}» — нужно «услуга; цена»`);
    const service = byName.get(name.toLowerCase());
    if (!service) throw new Error(`строка ${i + 1}: услуги «${name}» нет в каталоге салона`);
    const rub = Number(price.replace(/ /g, ''));
    if (!Number.isSafeInteger(rub)) throw new Error(`строка ${i + 1}: цена — целое число рублей`);
    items.push({ serviceId: service.id, rub });
  });
  if (!items.length) throw new Error('список пуст: строка — «услуга; цена»');
  return items;
}

/**
 * Загрузить прайс списком — db.load() администраторским подключением adm: COPY от роли владельца схемы мимо
 * триггеров и RLS, одной транзакцией. as — от имени вошедшего: автор версий — он, право WRITE на price и видимость
 * услуг загрузчик проверяет сам (без as автор — System); с as арендатор по умолчанию — собственный аккаунта, поэтому
 * tenant — салон сессии. existing: 'update' — цена есть — новая версия, та же — пропуск (skipped).
 */
export async function loadPrices(adm, { account, tenant }, items, trace = []) {
  const rows = items.map((x) => ({ Item: x.serviceId, note: NOTE, amounts: { RUB: x.rub } }));
  trace.push(`adm.load({ price: [{ Item: услуга, note: '${NOTE}', amounts: { RUB } } × ${rows.length}] }, { existing: 'update', as: вошедший, tenant: салон, agent: 'прайс списком' })`);
  const report = await adm.load({ price: rows }, { existing: 'update', as: account, tenant, agent: 'прайс списком' });
  trace.push(`отчёт: строк ${report.rows} — новых ${report.loaded}, новых версий ${report.updated}, без изменений ${report.skipped}; ${Math.round(report.ms)} мс`);
  return report;
}

/** Отчёт дня: сколько броней по каждому мастеру. */
export async function report(db, day, trace = []) {
  trace.push(`db.booking({ start_datetime: gte('${day}T00:00') }).rows() — брони дня; счёт по мастерам (links.Staff) — в сервисе`);
  const rows = await dayBookings(db, day);
  const byStaff = {};
  for (const b of rows) byStaff[b.links.Staff] = (byStaff[b.links.Staff] ?? 0) + 1;
  return { total: rows.length, byStaff };
}

export { lt };
