/**
 * Фикстура демо-домена booking для тестов чтения (этап 3): небольшой салон, записанный сырым SQL
 * под сессией арендатора. Запись цепочками — этап 4, поэтому здесь обычные insert.
 */
import type { Db } from '../src/index.js';

export interface Salon {
  org: string;
  org2: string;
  vasya: string;
  petya: string;
  masha: string;
  anya: string;
  borya: string;
  loc: string;
  sch: string;
  cut: string;
  color: string;
  shave: string;
  wax: string;
  combo: string;
  root: string;
  men: string;
  beards: string;
  /** Записи: [мастер, начало, элемент, клиент?]. */
  bookings: string[];
  /** Окна Пети (без брони). */
  slots: string[];
  /** Время между двумя волнами правок — для asOf. */
  mid: string;
}

export async function seedSalon(db: Db): Promise<Salon> {
  const S = `"${db.schema}"`;
  const ins = async (cls: string, data: Record<string, unknown>, links: Record<string, unknown> = {}, tags: string[] = []): Promise<string> =>
    (await db.transaction((tx) => tx.unsafe(`insert into ${S}.entity (class, data, links, tags) values ($1, $2::jsonb, $3::jsonb, $4::text[]) returning id`,
      [cls, data as never, links as never, tags]))).at(0)!.id as string;
  const upd = (id: string, patch: Record<string, unknown>) =>
    db.transaction((tx) => tx.unsafe(`update ${S}.entity set data = ${S}.merge(data, $2::jsonb) where id = $1`, [id, patch as never]));

  const org = await ins('Org', { name: 'BarberPro', settings: { booking: { deposit: { amount: 500, currency: 'RUB' }, autoconfirm: true } } });
  const org2 = await ins('Org', { name: 'Второй салон', active: false });
  const vasya = await ins('Staff', { name: 'Вася', phone: '+7 901', specialization: 'барбер' }, { Org: org }, ['senior']);
  const petya = await ins('Staff', { name: 'Петя', phone: '+7 902', specialization: 'колорист' }, { Org: org }, ['junior']);
  const masha = await ins('Staff', { name: 'Маша', phone: '+7 903' }, { Org: org2 });
  const anya = await ins('Customer', { name: 'Аня', phone: '+7 911', preferred_contact: 'email' }, { Org: org });
  const borya = await ins('Customer', { name: 'Боря', phone: '+7 912' }, { Org: org });
  const loc = await ins('Location', { address: 'Тверская, 1', coordinates: { lat: 55.76, lng: 37.61 } }, { Org: org });
  const sch = await ins('Schedule', { name: 'Октябрь', year: 2026, month: 10 }, { Org: org });
  const cut = await ins('Service', { name: 'Стрижка', duration: 60 }, { Org: org });
  const color = await ins('Service', { name: 'Окрашивание', duration: 120 }, { Org: org });
  const shave = await ins('Service', { name: 'Бритьё', duration: 30 }, { Org: org });
  const wax = await ins('Product', { name: 'Воск', sku: 'W-1' }, { Org: org });
  const combo = await ins('Complex', { name: 'Стрижка и борода', cost: 2500, duration: 90 }, { Org: org });
  await ins('compo', { order: 1 }, { Complex: combo, Part: cut });
  await ins('compo', { order: 2, quantity: 2 }, { Complex: combo, Part: wax });
  await ins('skill', { level: 'expert' }, { Staff: vasya, Service: cut });
  await ins('skill', { level: 'basic' }, { Staff: vasya, Service: shave });
  await ins('skill', {}, { Staff: petya, Service: color });
  await ins('address', { default: true }, { Staff: vasya, Location: loc });
  await ins('address', {}, { Staff: petya, Location: loc });
  await ins('price', { amounts: { RUB: 1500, AED: 60 } }, { Item: cut });
  await ins('price', { note: 'выходные', amounts: { RUB: 1800 } }, { Item: cut });
  await ins('price', { amounts: { RUB: 3000 } }, { Item: color });
  await ins('price', { amounts: { RUB: 2500 } }, { Item: combo });
  const root = await ins('Folder', { name: 'Каталог' }, { Org: org });
  const men = await ins('Folder', { name: 'Мужское' }, { Org: org, Parent: root });
  const beards = await ins('Folder', { name: 'Бороды' }, { Org: org, Parent: men });
  await ins('content', { order: 1 }, { Folder: men, Item: cut });
  await ins('content', { order: 2 }, { Folder: beards, Item: shave });
  await ins('content', {}, { Folder: root, Item: combo });
  const at = (h: number) => `2026-10-07T${String(h).padStart(2, '0')}:00:00.000Z`;
  const book = (staff: string, h: number, item: string, customer?: string, notes?: string) =>
    ins('booking', { start_datetime: at(h), end_datetime: at(h + 1), ...(notes ? { notes } : {}) },
      { Staff: staff, Location: loc, Schedule: sch, Item: item, ...(customer ? { Customer: customer } : {}) });
  const bookings = [
    await book(vasya, 10, cut, anya, 'первый визит'),
    await book(vasya, 12, shave, borya),
    await book(vasya, 14, combo, anya),
    await book(petya, 11, color, borya),
    await book(petya, 15, color),
  ];
  const slots = [
    await ins('slot', { start_datetime: at(16), end_datetime: at(17) }, { Staff: petya, Location: loc, Schedule: sch }),
    await ins('slot', { start_datetime: at(17), end_datetime: at(18) }, { Staff: petya, Location: loc, Schedule: sch }),
  ];
  // две волны правок для среза asOf: длительность стрижки 60 → 45 после mid
  const [{ mid }] = await db.sql`select clock_timestamp()::text as mid`;
  await upd(cut, { duration: 45 });
  await upd(vasya, { specialization: 'топ-барбер' });
  return { org, org2, vasya, petya, masha, anya, borya, loc, sch, cut, color, shave, wax, combo, root, men, beards, bookings, slots, mid: mid as string };
}
