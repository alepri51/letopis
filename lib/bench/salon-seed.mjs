/**
 * Генератор ОГРОМНОГО полигона «сеть салонов» по схеме 0.16.0 (v1.salondemo).
 * Bulk-INSERT напрямую в Entity (валидируется триггером entity_check по Schema.links v2).
 * Детерминированный (mulberry32) — воспроизводим. Итог ~1.3M строк.
 *
 *   node bench/salon-seed.mjs            # пересоздать v1.salondemo и засеять
 *   node bench/salon-seed.mjs --keep     # не пересоздавать схему (досев)
 *
 * Entity.links хранит {Класс: id} как всегда; концы валидируются по Schema.links v2:
 *   позиция [Booking, Service|Complex, Staff?]  состав [Complex, Service]
 *   навык [Staff, Service|Complex]  смена [Schedule, Staff]  занятость [Staff, Slot, Booking?]
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const S = 'v1.salondemo';
const SYS = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const DAY = 24 * 3600e3;
const BASE = Date.parse('2025-08-01T00:00:00Z'); // год истории до «сегодня» статьи

// id-хелпер: код класса + номер → детерминированный uuid-подобный
const id = (code, n) => `${String(code).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const C = { Org: 1, Folder: 2, Staff: 3, Service: 4, Complex: 5, Customer: 6, Schedule: 7, Slot: 8, Booking: 9, item: 10, busy: 11, skill: 12, shift: 13, compo: 14 };

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// масштаб полигона
const N = {
  orgs: 30, foldersPerOrg: 5, staffPerOrg: 12, servicesPerOrg: 20, complexesPerOrg: 4,
  customers: 40000, slotsPerSched: 300, bookings: 240000, skills: 3000, shifts: 1500,
};
const CITY = ['Москва', 'Питер', 'Казань', 'Сочи', 'Уфа'];
const SVC = ['Стрижка', 'Окрашивание', 'Укладка', 'Маникюр', 'Педикюр', 'Борода', 'Бритьё', 'Массаж', 'Спа', 'Брови'];
const NAME = ['Ольга', 'Ирина', 'Света', 'Марина', 'Анна', 'Пётр', 'Иван', 'Олег', 'Катя', 'Вера', 'Боря', 'Женя'];

function makeRows() {
  const rnd = mulberry32(2025);
  const t = () => new Date(BASE + rnd() * 360 * DAY);
  const iso = (d) => d.toISOString();
  const rows = [];
  const push = (cls, n, data, links, when) => rows.push([id(C[cls], n), cls, data, links, iso(when)]);

  // орг-структура
  for (let o = 0; o < N.orgs; o++)
    push('Org', o, { name: `Салон «${SVC[o % SVC.length]}» №${o}`, timezone: 'Europe/Moscow', phone: `+7 495 ${String(1000000 + o).slice(-7)}` }, {}, new Date(BASE));

  let fId = 0, sId = 0, svcId = 0, cxId = 0, schId = 0;
  const orgFolders = [], orgServices = [], orgComplexes = [], orgStaff = [], orgSched = [];
  for (let o = 0; o < N.orgs; o++) {
    orgFolders[o] = []; orgServices[o] = []; orgComplexes[o] = []; orgStaff[o] = []; orgSched[o] = [];
    // папки: первая корневая, остальные вложены в неё
    const root = fId;
    for (let f = 0; f < N.foldersPerOrg; f++) {
      const links = { Org: id(C.Org, o) };
      if (f > 0) links.Folder = id(C.Folder, root);
      push('Folder', fId, { name: `Раздел ${f}`, kind: f % 2 ? 'masters' : 'services' }, links, new Date(BASE));
      orgFolders[o].push(fId); fId++;
    }
    // мастера
    for (let s = 0; s < N.staffPerOrg; s++) {
      const roles = s === 0 ? ['owner', 'master'] : s % 4 === 0 ? ['administrator'] : ['master'];
      push('Staff', sId, { name: `${NAME[sId % NAME.length]} ${o}.${s}`, roles, active: true }, { Org: id(C.Org, o) }, new Date(BASE));
      orgStaff[o].push(sId); sId++;
    }
    // услуги (×2 версии — история цены)
    for (let v = 0; v < N.servicesPerOrg; v++) {
      const base = new Date(BASE + rnd() * 30 * DAY);
      const price = 800 + (v % 10) * 250;
      push('Service', svcId, { name: `${SVC[v % SVC.length]} ${v}`, duration: 30 + (v % 4) * 15, price: { RUB: price }, active: true, description: v % 3 ? undefined : 'популярное' }, { Org: id(C.Org, o), Folder: id(C.Folder, orgFolders[o][v % N.foldersPerOrg]) }, base);
      push('Service', svcId, { name: `${SVC[v % SVC.length]} ${v}`, duration: 30 + (v % 4) * 15, price: { RUB: price + 100 }, active: true }, { Org: id(C.Org, o), Folder: id(C.Folder, orgFolders[o][v % N.foldersPerOrg]) }, new Date(+base + 90 * DAY));
      orgServices[o].push(svcId); svcId++;
    }
    // комплексы + состав (compo = [Complex, Service])
    for (let c = 0; c < N.complexesPerOrg; c++) {
      push('Complex', cxId, { name: `Комплекс ${c}`, duration: 90 + c * 30, discount: 10 + c }, { Org: id(C.Org, o), Folder: id(C.Folder, orgFolders[o][0]) }, new Date(BASE));
      // 2 услуги в составе
      for (let k = 0; k < 2; k++) {
        const svc = orgServices[o][(c * 2 + k) % orgServices[o].length];
        push('compo', cxId * 4 + k, { qty: 1 }, { Complex: id(C.Complex, cxId), Service: id(C.Service, svc) }, new Date(BASE));
      }
      orgComplexes[o].push(cxId); cxId++;
    }
    // расписание года + окна
    push('Schedule', schId, { start: iso(new Date(BASE)), end: iso(new Date(BASE + 360 * DAY)), active: true }, { Org: id(C.Org, o) }, new Date(BASE));
    orgSched[o].push(schId); schId++;
  }

  // окна по расписаниям
  let slId = 0;
  const schedSlots = [];
  for (let sc = 0; sc < schId; sc++) {
    schedSlots[sc] = [];
    for (let w = 0; w < N.slotsPerSched; w++) {
      const start = new Date(BASE + w * 3600e3 + Math.floor(rnd() * 360) * DAY);
      push('Slot', slId, { start: iso(start), end: iso(new Date(+start + 3600e3)) }, { Schedule: id(C.Schedule, sc) }, start);
      schedSlots[sc].push(slId); slId++;
    }
  }

  // клиенты
  for (let c = 0; c < N.customers; c++)
    push('Customer', c, { name: `${NAME[c % NAME.length]} ${CITY[c % CITY.length]}`, contact: `+7 900 ${String(c).padStart(7, '0')}`, language: c % 7 ? 'ru' : 'en', active: true }, { Org: id(C.Org, c % N.orgs) }, t());

  // навыки: мастер умеет услуги/комплексы своей орг
  for (let i = 0; i < N.skills; i++) {
    const o = i % N.orgs;
    const st = orgStaff[o][i % orgStaff[o].length];
    if (i % 5 === 0 && orgComplexes[o].length) {
      push('skill', i, {}, { Staff: id(C.Staff, st), Complex: id(C.Complex, orgComplexes[o][i % orgComplexes[o].length]) }, new Date(BASE));
    } else {
      push('skill', i, {}, { Staff: id(C.Staff, st), Service: id(C.Service, orgServices[o][i % orgServices[o].length]) }, new Date(BASE));
    }
  }
  // смены: мастер в расписании своей орг
  for (let i = 0; i < N.shifts; i++) {
    const o = i % N.orgs;
    push('shift', i, {}, { Schedule: id(C.Schedule, orgSched[o][0]), Staff: id(C.Staff, orgStaff[o][i % orgStaff[o].length]) }, new Date(BASE));
  }

  // записи (×2 версии) + позиция + занятость
  const statuses = ['confirmed', 'confirmed', 'completed', 'completed', 'cancelled', 'no_show'];
  for (let b = 0; b < N.bookings; b++) {
    const o = b % N.orgs;
    const t1 = t();
    const t2 = new Date(+t1 + (1 + rnd() * 3) * DAY);
    const total = 800 + (b % 40) * 150;
    const links = b % 11 === 0 ? {} : { Customer: id(C.Customer, b % N.customers) }; // ~9% ручных броней (без клиента)
    push('Booking', b, { status: 'created', source: ['online', 'web', 'admin', 'telegram'][b % 4], total: { RUB: total }, comment: b % 11 === 0 ? `по телефону: ${NAME[b % NAME.length]}` : undefined }, links, t1);
    push('Booking', b, { status: statuses[b % 6], source: ['online', 'web', 'admin', 'telegram'][b % 4], total: { RUB: total } }, links, t2);

    // позиция: предмет — услуга (или комплекс каждый 6-й), исполнитель — часть без мастера
    const st = orgStaff[o][b % orgStaff[o].length];
    const itemLinks = { Booking: id(C.Booking, b) };
    if (b % 6 === 0 && orgComplexes[o].length) itemLinks.Complex = id(C.Complex, orgComplexes[o][b % orgComplexes[o].length]);
    else itemLinks.Service = id(C.Service, orgServices[o][b % orgServices[o].length]);
    if (b % 3 !== 0) itemLinks.Staff = id(C.Staff, st); // 2/3 позиций с назначенным мастером
    push('item', b, { qty: 1, price: { RUB: total } }, itemLinks, t2);

    // занятость мастера в окне (booking); каждая 10-я — off/hold без записи
    const sc = orgSched[o][0];
    const sl = schedSlots[sc][b % schedSlots[sc].length];
    if (b % 10 === 0) push('busy', b, { kind: b % 20 === 0 ? 'off' : 'hold', reason: 'служебное' }, { Staff: id(C.Staff, st), Slot: id(C.Slot, sl) }, t2);
    else push('busy', b, { kind: 'booking' }, { Staff: id(C.Staff, st), Slot: id(C.Slot, sl), Booking: id(C.Booking, b) }, t2);
  }
  return rows;
}

async function bulk(sql, rows) {
  const CHUNK = 4000;
  await sql.unsafe('BEGIN');
  try {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      for (const [rid, cls, data, links, updated] of part) {
        const o = params.length;
        values.push(`('entity',$${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5}::timestamptz,'${SYS}','${SYS}')`);
        params.push(rid, cls, data, links, updated);
      }
      await sql.unsafe(
        `INSERT INTO "${S}"."Entity" (partition, id, class, data, links, updated, account, owner) VALUES ${values.join(',')}`,
        params);
      if ((i / CHUNK) % 20 === 0) process.stdout.write(`  seeded ${i + part.length}/${rows.length}\r`);
    }
    await sql.unsafe('COMMIT');
  } catch (e) { await sql.unsafe('ROLLBACK'); throw e; }
}

const keep = process.argv.includes('--keep');
const admin = postgres(DSN, { max: 1, onnotice: () => {} });
if (!keep) {
  console.log('recreate schema v1.salondemo…');
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${S}" CASCADE`);
  await admin.end();
  execFileSync('node', [fileURLToPath(new URL('../../db/apply.mjs', import.meta.url)), `--dsn=${DSN}`, '--schema=salondemo', '--version=1'], { stdio: 'inherit' });
} else {
  await admin.end();
}

console.log('generating rows…');
const t0 = performance.now();
const rows = makeRows();
console.log(`  ${rows.length} rows in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const sql = postgres(DSN, { max: 1, onnotice: () => {} });
console.log('bulk insert…');
const t1 = performance.now();
await bulk(sql, rows);
const cnt = await sql.unsafe(`SELECT count(*)::int n FROM "${S}"."Entity"`);
console.log(`\n✓ seeded ${cnt[0].n} rows in ${((performance.now() - t1) / 1000).toFixed(1)}s → schema "${S}"`);
await sql.end();
