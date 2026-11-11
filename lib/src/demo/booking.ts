/**
 * Демо-домен booking на Zod: 18 классов салона записи.
 * - Классы с ключом получают id v5 из полей ключа; у остальных ключа нет — id выдаёт база.
 * - Концы названы ролями: полиморфный конец `Item: one(Element)` ведёт на любого потомка Element; состав комплекса —
 *   `Part` (Service или Product); самоссылка Folder — `Parent`.
 * - Описание, значок, цвет и порядок класса — в meta.
 * Из моделей генерируется lib/sql/seed.booking.sql (`npm run seed:booking`).
 */
import { z } from 'zod';
import { hub, link, one, type AnyModel } from '../model.js';

const CURRENCY = z.enum(['RUB', 'USD', 'EUR', 'AED']);
const meta = (description: string, icon: string, color: string, order: number) => ({ description, icon, color, order });

export const Org = hub('Org', {
  alias: 'Организация',
  fields: z.object({
    name: z.string(),
    timezone: z.string().default('Europe/Moscow'),
    address: z.string().optional(),
    phone: z.string().optional(),
    active: z.boolean().default(true),
    settings: z.strictObject({
      booking: z.strictObject({
        deposit: z.strictObject({ amount: z.number().int().min(0).default(0), currency: CURRENCY.default('RUB') }).optional(),
        autoconfirm: z.boolean().default(false),
      }).optional(),
    }).optional(),
  }),
  meta: meta('Организация — владелец каталога, локаций и расписаний в квартире; settings — вложенные настройки (глубина 4)', 'mdi:domain', 'text-blue-600', 200),
});

export const Person = hub('Person', {
  alias: 'Контрагент',
  abstract: true,
  ends: { Org },
  fields: z.object({ name: z.string(), phone: z.string() }),
  meta: meta('Абстрактный контрагент: имя и телефон; наследуют Мастер и Клиент', 'mdi:account-outline', 'text-blue-500', 300),
});

export const Staff = hub('Staff', {
  alias: 'Мастер',
  extends: Person,
  fields: z.object({ photo: z.string().optional(), description: z.string().optional(), specialization: z.string().optional() }),
  meta: meta('Мастер — бронируемый исполнитель; локации — связь адрес, доступность — связь окно', 'mdi:account-star', 'text-indigo-500', 400),
});

export const Customer = hub('Customer', {
  alias: 'Клиент',
  extends: Person,
  fields: z.object({ notes: z.string().optional(), preferred_contact: z.enum(['phone', 'email', 'messenger']).default('phone') }),
  meta: meta('Клиент — записывается на услуги', 'mdi:account', 'text-green-500', 500),
});

export const Location = hub('Location', {
  alias: 'Локация',
  ends: { Org },
  fields: z.object({ address: z.string(), coordinates: z.object({ lat: z.number(), lng: z.number() }).optional(), description: z.string().optional() }),
  meta: meta('Локация — точка обслуживания организации', 'mdi:map-marker', 'text-red-500', 600),
});

export const Element = hub('Element', {
  alias: 'Элемент',
  abstract: true,
  ends: { Org },
  fields: z.object({ name: z.string(), description: z.string().optional() }),
  key: ['Org', 'name'],
  meta: meta('Абстрактная каталожная единица (Услуга, Товар, Комплекс): имя уникально в организации; цена — связь цена', 'mdi:view-list', 'text-teal-500', 700),
});

export const Service = hub('Service', {
  alias: 'Услуга',
  extends: Element,
  fields: z.object({ duration: z.number().min(0).optional() }),
  meta: meta('Услуга: длительность в минутах', 'mdi:spa', 'text-purple-500', 800),
});

export const Product = hub('Product', {
  alias: 'Товар',
  extends: Element,
  fields: z.object({ sku: z.string().optional(), unit: z.string().default('шт') }),
  meta: meta('Товар: артикул и единица измерения', 'mdi:package', 'text-blue-400', 900),
});

export const Complex = hub('Complex', {
  alias: 'Комплекс',
  extends: Element,
  fields: z.object({ cost: z.number().min(0), duration: z.number().min(0) }),
  meta: meta('Комплекс: собственные стоимость и длительность; состав — связь состав', 'mdi:package-variant-closed', 'text-orange-500', 1000),
});

export const Schedule = hub('Schedule', {
  alias: 'Расписание',
  ends: { Org },
  fields: z.object({ name: z.string(), year: z.number().int(), month: z.number().int().min(1).max(12) }),
  meta: meta('Месячное расписание организации; наполнение — связь окно', 'mdi:calendar', 'text-cyan-500', 1100),
});

export const Folder = hub('Folder', {
  alias: 'Папка',
  ends: { Org, Parent: one('Folder').optional() },
  fields: z.object({ name: z.string() }),
  meta: meta('Папка-категория; вложенность — конец Parent на родительскую папку; наполнение — связь содержимое', 'mdi:folder', 'text-yellow-500', 1200),
});

export const address = link('address', {
  alias: 'адрес',
  ends: { Staff, Location },
  fields: z.object({ default: z.boolean().default(false), schedule_info: z.string().optional() }),
  key: ['Staff', 'Location'],
  meta: meta('Адрес: Мастер работает в Локации; default — основная точка мастера', 'mdi:link', 'text-sky-500', 200),
});

export const slot = link('slot', {
  alias: 'окно',
  ends: { Staff, Location, Schedule },
  fields: z.object({ start_datetime: z.iso.datetime({ precision: 3 }), end_datetime: z.iso.datetime({ precision: 3 }) }),
  key: ['Staff', 'start_datetime'],
  meta: meta('Окно доступности: Мастер × Локация × Расписание и интервал; мастер не задваивает время', 'mdi:clock-outline', 'text-amber-500', 300),
});

export const booking = link('booking', {
  alias: 'запись',
  extends: slot,
  ends: { Item: one(Element), Customer: one(Customer).optional() },
  onDelete: { Customer: 'unset' },
  fields: z.object({ notes: z.string().optional() }),
  meta: meta('Запись — наследник окна: бронь мастера на элемент каталога для клиента; ручная бронь — без клиента', 'mdi:calendar-check', 'text-emerald-500', 400),
});

export const content = link('content', {
  alias: 'содержимое',
  ends: { Folder, Item: one(Element) },
  fields: z.object({ order: z.number().int().default(0) }),
  key: ['Folder', 'Item'],
  meta: meta('Содержимое папки: элемент может лежать в нескольких папках', 'mdi:link', 'text-sky-500', 500),
});

export const compo = link('compo', {
  alias: 'состав',
  ends: { Complex, Part: one(Service, Product) },
  fields: z.object({ order: z.number().int().default(0), quantity: z.number().int().min(1).default(1) }),
  key: ['Complex', 'Part'],
  meta: meta('Состав комплекса: услуги и товары с порядком и количеством', 'mdi:link', 'text-sky-500', 600),
});

export const skill = link('skill', {
  alias: 'навык',
  ends: { Staff, Service },
  fields: z.object({ level: z.enum(['basic', 'intermediate', 'advanced', 'expert']).default('intermediate') }),
  key: ['Staff', 'Service'],
  meta: meta('Навык: Мастер умеет Услугу; умение комплекса вычислимо по составу', 'mdi:link', 'text-sky-500', 700),
});

export const price = link('price', {
  alias: 'цена',
  ends: { Item: one(Element) },
  fields: z.object({ note: z.string().default('базовая'), amounts: z.partialRecord(CURRENCY, z.number().int().min(0)) }),
  key: ['Item', 'note'],
  meta: meta('Вариант цены элемента: мультивалютные суммы и описание варианта', 'mdi:cash-multiple', 'text-green-600', 800),
});

/** Все классы в порядке «предок раньше потомка». */
export const BOOKING = [Org, Person, Staff, Customer, Location, Element, Service, Product, Complex, Schedule, Folder,
  address, slot, booking, content, compo, skill, price] as const satisfies readonly AnyModel[];

/** Текст lib/sql/seed.booking.sql: строки Class в System (общие классы дома), записанные владельцем схемы. */
export function bookingSeedSql(models: readonly AnyModel[] = BOOKING): string {
  const lines = [
    '-- letopis — демо-домен booking. Сгенерировано из lib/src/demo/booking.ts',
    '-- командой `npm run seed:booking`; руками не править. Классы — общие классы дома (System), пишет владелец.',
    '',
  ];
  for (const m of models) {
    const json = JSON.stringify(m.describe());
    lines.push(`select @SCHEMA@.sys_create(@SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array['${m.name}']), 'Class', '@SYSTEM@'::uuid, '{}',\n  $json$${json}$json$::jsonb);`);
  }
  return lines.join('\n') + '\n';
}
