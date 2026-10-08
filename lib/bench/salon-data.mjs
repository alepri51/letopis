/**
 * Полигон «сеть салонов» (план, этап 7, п. 2–3): генератор строк 0.21 — дословно makeRows из
 * lib/bench/salon-seed.mjs тега v0.21.0 (детерминированный mulberry32, ~982 тыс. строк при scale = 1),
 * и перевод тех же строк в загрузку 1.0 на демо-домене (seed booking): данные — в арендаторе, а не у
 * System; роли концов 1.0 (Parent, Item, Part); версии — режим истории загрузчика.
 *
 * Строка 0.21: [id, класс, data, links {Класс: id}, updated, tags].
 */
import { v5Id } from '../src/uuid.ts';

export const SYS = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
export const DAY = 24 * 3600e3;
const BASE = Date.parse('2025-08-01T00:00:00Z'); // год истории до «сегодня» статьи

// id-хелпер: код класса + номер → детерминированный uuid-подобный
export const id = (code, n) => `${String(code).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const C = {
  Org: 1, Folder: 2, Staff: 3, Service: 4, Complex: 5, Customer: 6, Schedule: 7,
  slot: 8, booking: 9, skill: 12, compo: 14, Location: 15, content: 16, address: 17, Product: 18, price: 19,
};

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// масштаб полигона
let N = {};
const sizes = (scale) => ({
  orgs: Math.max(1, Math.round(30 * Math.min(1, scale * 4))), locationsPerOrg: 2, foldersPerOrg: 5, staffPerOrg: 12,
  servicesPerOrg: 20, productsPerOrg: 5, complexesPerOrg: 4,
  monthsPerOrg: 12, shiftsPerStaff: Math.max(1, Math.round(150 * scale)), customers: Math.max(1, Math.round(40000 * scale)),
  bookings: Math.max(1, Math.round(440000 * scale)),
});
const CITY = ['Москва', 'Питер', 'Казань', 'Сочи', 'Уфа'];
const SVC = ['Стрижка', 'Окрашивание', 'Укладка', 'Маникюр', 'Педикюр', 'Борода', 'Бритьё', 'Массаж', 'Спа', 'Брови'];
const GOODS = ['Шампунь', 'Бальзам', 'Воск', 'Масло', 'Лак'];
const NAME = ['Ольга', 'Ирина', 'Света', 'Марина', 'Анна', 'Пётр', 'Иван', 'Олег', 'Катя', 'Вера', 'Боря', 'Женя'];
const SPEC = ['парикмахер', 'барбер', 'колорист', 'мастер ногтевого сервиса', undefined];
// папки: дерево 3 уровней (Каталог → Мужской зал → Борода и усы → Уход; Женский зал под корнем)
const FOLDER_NAMES = ['Каталог', 'Мужской зал', 'Женский зал', 'Борода и усы', 'Уход'];
const FOLDER_PARENT = [null, 0, 0, 1, 3]; // родитель по локальному индексу папки (offset от корня орг); null = корень

export function makeRows(scale = 1) {
  N = sizes(scale);
  const rnd = mulberry32(2025);
  const t = () => new Date(BASE + rnd() * 360 * DAY);
  const iso = (d) => d.toISOString();
  const rows = [];
  const push = (cls, n, data, links, when, tags = []) => rows.push([id(C[cls], n), cls, data, links, iso(when), tags]);

  // орг-структура
  for (let o = 0; o < N.orgs; o++)
    push('Org', o, { name: `Салон «${SVC[o % SVC.length]}» №${o}`, timezone: 'Europe/Moscow', phone: `+7 495 ${String(1000000 + o).slice(-7)}` }, {}, new Date(BASE));

  let locId = 0, fId = 0, sId = 0, svcId = 0, prodId = 0, cxId = 0, schId = 0, contentId = 0, compoId = 0, priceId = 0;
  const orgLocations = [], orgFolders = [], orgServices = [], orgProducts = [], orgComplexes = [], orgStaff = [], orgSched = [];
  for (let o = 0; o < N.orgs; o++) {
    orgLocations[o] = []; orgFolders[o] = []; orgServices[o] = []; orgProducts[o] = []; orgComplexes[o] = []; orgStaff[o] = []; orgSched[o] = [];
    // локации — точки обслуживания
    for (let l = 0; l < N.locationsPerOrg; l++) {
      push('Location', locId, { address: `${CITY[o % CITY.length]}, ${SVC[o % SVC.length]}-стрит, ${l + 1}`, coordinates: { lat: 55 + rnd(), lng: 37 + rnd() } }, { Org: id(C.Org, o) }, new Date(BASE));
      orgLocations[o].push(locId); locId++;
    }
    // папки: дерево по FOLDER_PARENT (глубина до 3 — наглядный deep())
    const root = fId;
    for (let f = 0; f < N.foldersPerOrg; f++) {
      const links = { Org: id(C.Org, o) };
      if (FOLDER_PARENT[f] !== null) links.Folder = id(C.Folder, root + FOLDER_PARENT[f]);
      push('Folder', fId, { name: FOLDER_NAMES[f] }, links, new Date(BASE));
      orgFolders[o].push(fId); fId++;
    }
    // мастера (name/phone — от Контрагента)
    for (let s = 0; s < N.staffPerOrg; s++) {
      const data = { name: `${NAME[sId % NAME.length]} ${o}.${s}`, phone: `+7 921 ${String(sId).padStart(7, '0')}` };
      if (SPEC[s % SPEC.length]) data.specialization = SPEC[s % SPEC.length];
      push('Staff', sId, data, { Org: id(C.Org, o) }, new Date(BASE));
      // адрес: мастер закреплён за локацией
      push('address', sId, { default: true }, { Staff: id(C.Staff, sId), Location: id(C.Location, orgLocations[o][s % orgLocations[o].length]) }, new Date(BASE));
      orgStaff[o].push(sId); sId++;
    }
    // услуги + вариант(ы) цены (LINK «цена»: note+amounts, мультивалюта) + раскладка по папкам
    for (let v = 0; v < N.servicesPerOrg; v++) {
      const base = new Date(BASE + rnd() * 30 * DAY);
      const rub = 800 + (v % 10) * 250;
      const data = { name: `${SVC[v % SVC.length]} ${v}`, duration: 30 + (v % 4) * 15 };
      if (v % 3 === 0) data.description = 'популярное';
      else if (v % 3 === 2) data.description = null; // явный null — чтобы isNull() ловил больше, чем exists(false)
      push('Service', svcId, data, { Org: id(C.Org, o) }, base);
      // цена «базовая» — 2 версии (история подорожания); иногда второй вариант «с дизайном»
      push('price', priceId, { note: 'базовая', amounts: { RUB: rub } }, { Service: id(C.Service, svcId) }, base);
      push('price', priceId, { note: 'базовая', amounts: { RUB: rub + 100 } }, { Service: id(C.Service, svcId) }, new Date(+base + 90 * DAY));
      priceId++;
      if (v % 4 === 0) { push('price', priceId++, { note: 'с дизайном', amounts: { RUB: rub + 500, USD: Math.round(rub / 80) } }, { Service: id(C.Service, svcId) }, base); }
      push('content', contentId++, { order: v }, { Folder: id(C.Folder, orgFolders[o][v % N.foldersPerOrg]), Service: id(C.Service, svcId) }, base);
      orgServices[o].push(svcId); svcId++;
    }
    // товары + цена
    for (let p = 0; p < N.productsPerOrg; p++) {
      push('Product', prodId, { name: `${GOODS[p % GOODS.length]} ${p}`, sku: `SKU-${o}-${p}`, unit: 'шт' }, { Org: id(C.Org, o) }, new Date(BASE));
      push('price', priceId++, { note: 'базовая', amounts: { RUB: 300 + p * 120 } }, { Product: id(C.Product, prodId) }, new Date(BASE));
      push('content', contentId++, { order: p }, { Folder: id(C.Folder, orgFolders[o][0]), Product: id(C.Product, prodId) }, new Date(BASE));
      orgProducts[o].push(prodId); prodId++;
    }
    // комплексы + состав (compo = [Complex, Service|Product]) + цена
    for (let c = 0; c < N.complexesPerOrg; c++) {
      push('Complex', cxId, { name: `Комплекс ${c}`, cost: 2000 + c * 800, duration: 90 + c * 30 }, { Org: id(C.Org, o) }, new Date(BASE));
      push('price', priceId++, { note: 'базовая', amounts: { RUB: 2500 + c * 900 + o * 100 } }, { Complex: id(C.Complex, cxId) }, new Date(BASE));
      for (let k = 0; k < 2; k++) {
        const svc = orgServices[o][(c * 2 + k) % orgServices[o].length];
        push('compo', compoId++, { quantity: 1, order: k }, { Complex: id(C.Complex, cxId), Service: id(C.Service, svc) }, new Date(BASE));
      }
      // и товар в составе
      push('compo', compoId++, { quantity: 1, order: 2 }, { Complex: id(C.Complex, cxId), Product: id(C.Product, orgProducts[o][c % orgProducts[o].length]) }, new Date(BASE));
      orgComplexes[o].push(cxId); cxId++;
    }
    // помесячные расписания на год
    for (let m = 0; m < N.monthsPerOrg; m++) {
      const d = new Date(BASE + m * 30 * DAY);
      push('Schedule', schId, { name: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }, { Org: id(C.Org, o) }, new Date(BASE));
      orgSched[o].push(schId); schId++;
    }
  }

  // окна-смены мастеров: интервал доступности 10:00–20:00 в свой день
  let slId = 0;
  for (let o = 0; o < N.orgs; o++) {
    for (const st of orgStaff[o]) {
      for (let w = 0; w < N.shiftsPerStaff; w++) {
        const day = Math.floor((w * 353 + st * 7) % 360); // детерминированное «через день-два»
        const start = new Date(BASE + day * DAY + 10 * 3600e3);
        const sched = orgSched[o][Math.min(Math.floor(day / 30), N.monthsPerOrg - 1)];
        push('slot', slId++, { start_datetime: iso(start), end_datetime: iso(new Date(+start + 10 * 3600e3)) },
          { Staff: id(C.Staff, st), Location: id(C.Location, orgLocations[o][st % orgLocations[o].length]), Schedule: id(C.Schedule, sched) }, start);
      }
    }
  }

  // клиенты (name/phone — от Контрагента)
  for (let c = 0; c < N.customers; c++) {
    const data = { name: `${NAME[c % NAME.length]} ${CITY[c % CITY.length]}`, phone: `+7 900 ${String(c).padStart(7, '0')}` };
    if (c % 7 === 0) data.preferred_contact = 'messenger';
    const tags = []; // vip=400, telegram=500, оба=100 (наглядный has/hasAny/hasAll)
    if (c % 100 === 0) tags.push('vip');
    if (c % 80 === 0) tags.push('telegram');
    push('Customer', c, data, { Org: id(C.Org, c % N.orgs) }, t(), tags);
  }

  // навыки: каждый мастер умеет 2–5 РАЗНЫХ услуг своей орг (+уровень)
  const LEVEL = ['basic', 'intermediate', 'advanced', 'expert'];
  let skId = 0;
  for (let o = 0; o < N.orgs; o++) {
    for (let si = 0; si < orgStaff[o].length; si++) {
      const st = orgStaff[o][si];
      const k = 2 + (st % 4); // 2..5 навыков на мастера
      for (let j = 0; j < k; j++) {
        const svc = orgServices[o][(si * 3 + j * 7) % orgServices[o].length]; // разные услуги (j*7 mod 20)
        push('skill', skId++, { level: LEVEL[(si + j) % 4] }, { Staff: id(C.Staff, st), Service: id(C.Service, svc) }, new Date(BASE));
      }
    }
  }

  // записи (×2 версии — живая история): наследник окна, сам несёт интервал и предмет
  for (let b = 0; b < N.bookings; b++) {
    const o = b % N.orgs;
    const st = orgStaff[o][b % orgStaff[o].length];
    const day = Math.floor(rnd() * 360);
    const startMs = BASE + day * DAY + (10 + (b % 9)) * 3600e3; // старты 10:00–18:00
    const dur = 30 + (b % 4) * 30;
    const t1 = new Date(startMs - 2 * DAY);                      // создана заранее
    const t2 = new Date(startMs - 1 * DAY);                      // правка накануне
    const links = {
      Staff: id(C.Staff, st),
      Location: id(C.Location, orgLocations[o][st % orgLocations[o].length]),
      Schedule: id(C.Schedule, orgSched[o][Math.min(Math.floor(day / 30), N.monthsPerOrg - 1)]),
    };
    if (b % 6 === 0 && orgComplexes[o].length) links.Complex = id(C.Complex, orgComplexes[o][b % orgComplexes[o].length]);
    else if (b % 15 === 0) links.Product = id(C.Product, orgProducts[o][b % orgProducts[o].length]);
    else links.Service = id(C.Service, orgServices[o][b % orgServices[o].length]);
    const data = { start_datetime: new Date(startMs).toISOString(), end_datetime: new Date(startMs + dur * 60e3).toISOString() };
    if (b % 11 === 0) data.notes = `по телефону: ${NAME[b % NAME.length]}`; // ~9% ручных броней
    else links.Customer = id(C.Customer, b % N.customers);
    push('booking', b, data, links, t1);
    push('booking', b, b % 11 === 0 ? data : { ...data, notes: 'подтверждена' }, links, t2);
  }
  return rows;
}


/** Роль конца 1.0 по классу строки и классу цели 0.21. */
function roleOf(cls, target) {
  if (cls === 'Folder' && target === 'Folder') return 'Parent';
  if (cls === 'compo') return target === 'Complex' ? 'Complex' : 'Part';
  if (['booking', 'content', 'price'].includes(cls) && ['Service', 'Product', 'Complex'].includes(target)) return 'Item';
  return target;
}

const KEYED = new Set(['Service', 'Product', 'Complex', 'address', 'slot', 'booking', 'content', 'compo', 'skill', 'price']);

/**
 * Строки 0.21 → строки загрузчика 1.0 (режим истории): id классов без ключа — v5 от старого id ($ext),
 * с ключом — от ключа демо-домена 1.0; концы — уже вычисленные id. Совпавшие старты записей одного
 * мастера (ключ [Staff, start_datetime]) сдвигаются на минуты: в 0.21 полигон писался мимо правил v5.
 */
export function toLoad10(rows, tenant) {
  const objs = new Map();
  for (const r of rows) {
    const [id, cls, data, links, updated, tags] = r;
    const key = `${cls}:${id}`;
    if (!objs.has(key)) objs.set(key, { cls, id, versions: [] });
    // явный null у необязательного поля (0.21 его пропускала) — в модели 1.0 это отсутствие поля
    objs.get(key).versions.push({ data: Object.fromEntries(Object.entries(data).filter(([, x]) => x !== null)), links, updated, tags });
  }
  // старты записей: на мастера — без повторов
  const used = new Set();
  for (const o of objs.values()) {
    if (o.cls !== 'booking') continue;
    const staff = o.versions[0].links.Staff;
    let start = Date.parse(o.versions[0].data.start_datetime);
    while (used.has(`${staff}:${start}`)) start += 60e3;
    used.add(`${staff}:${start}`);
    const shift = start - Date.parse(o.versions[0].data.start_datetime);
    if (shift) for (const v of o.versions) {
      v.data.start_datetime = new Date(start).toISOString();
      v.data.end_datetime = new Date(Date.parse(v.data.end_datetime) + shift).toISOString();
    }
  }
  const ids = new Map();
  const idOf = (cls, old) => {
    const key = `${cls}:${old}`;
    if (ids.has(key)) return ids.get(key);
    const o = objs.get(key);
    if (!o) return null;
    const last = o.versions[o.versions.length - 1];
    let vals;
    if (!KEYED.has(cls)) vals = [old];
    else if (['Service', 'Product', 'Complex'].includes(cls)) vals = [idOf('Org', last.links.Org), last.data.name];
    else if (cls === 'address') vals = [idOf('Staff', last.links.Staff), idOf('Location', last.links.Location)];
    else if (cls === 'slot' || cls === 'booking') vals = [idOf('Staff', last.links.Staff), last.data.start_datetime];
    else if (cls === 'skill') vals = [idOf('Staff', last.links.Staff), idOf('Service', last.links.Service)];
    else {
      const item = ['Service', 'Product', 'Complex'].find((c) => last.links[c]);
      if (cls === 'content') vals = [idOf('Folder', last.links.Folder), idOf(item, last.links[item])];
      else if (cls === 'compo') vals = [idOf('Complex', last.links.Complex), idOf(item, last.links[item])];
      else vals = [idOf(item, last.links[item]), last.data.note];
    }
    const id = v5Id(tenant, cls, vals);
    ids.set(key, id);
    return id;
  };
  const out = [];
  for (const o of objs.values()) {
    o.versions.forEach((v, k) => {
      const row = { $class: o.cls, $rev: k + 1, $at: v.updated, ...(KEYED.has(o.cls) ? {} : { $ext: o.id }), ...(v.tags.length ? { $tags: v.tags } : {}), ...v.data };
      for (const [t, old] of Object.entries(v.links)) row[roleOf(o.cls, t)] = idOf(t, old);
      out.push(row);
    });
  }
  return out;
}

/** Число объектов и версий по классам. */
export function countRows(rows) {
  const out = {};
  const seen = new Set();
  for (const [id, cls] of rows) {
    const c = (out[cls] ??= { objects: 0, versions: 0 });
    c.versions++;
    if (!seen.has(`${cls}:${id}`)) {
      seen.add(`${cls}:${id}`);
      c.objects++;
    }
  }
  return out;
}

/** Полигон «арендаторы» (tenants-seed.mjs 0.21): 10 арендаторов с долями, по 2 версии клиента. */
export const SHARES = [0.50, 0.20, 0.10, 0.08, 0.05, 0.03, 0.02, 0.01, 0.007, 0.003];
export const tenantId = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const TENANTS = SHARES.map((share, i) => ({ id: tenantId(i + 1), share, name: `Арендатор ${i + 1} (${(share * 100).toFixed(1)}%)` }));
