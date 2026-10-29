/**
 * Предметная логика салона поверх цепочек letopis (по мотивам lib/test/scenario-real-life.test.ts).
 * База гарантирует уникальность брони мастера на время начала (ключ [Staff, start_datetime]);
 * пересечения и порядок броней одного мастера сервис сериализует блокировкой db.begin() + lock().
 */
import { LetopisError, gte, lt } from 'letopis';

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

/** Вернуть отменённую бронь. */
export async function restore(db, bookingId, trace = []) {
  trace.push(`db.booking(id).restore()`);
  return db.booking(bookingId).restore().rows();
}

/** История брони: все версии и что менялось между ними. */
export async function history(db, bookingId) {
  const versions = await db.booking(bookingId).withDeleted().versions();
  return versions;
}

/** Отчёт дня: сколько броней по каждому мастеру. */
export async function report(db, day) {
  const rows = await dayBookings(db, day);
  const byStaff = {};
  for (const b of rows) byStaff[b.links.Staff] = (byStaff[b.links.Staff] ?? 0) + 1;
  return { total: rows.length, byStaff };
}

export { lt };
