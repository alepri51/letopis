/**
 * Генератор ОГРОМНОГО полигона «сеть салонов» по схеме 0.17 (v1.salondemo).
 * Bulk-INSERT напрямую в Entity (валидируется триггером entity_check по Schema.links v2).
 * Детерминированный (mulberry32) — воспроизводим. Итог ~1M строк.
 *
 *   node bench/salon-seed.mjs            # пересоздать v1.salondemo и засеять
 *   node bench/salon-seed.mjs --keep     # не пересоздавать схему (досев)
 *
 * Entity.links хранит {Класс: id}; концы валидируются по Schema.links v2:
 *   адрес [Staff, Location]                       окно [Staff, Location, Schedule]
 *   запись [Staff, Location, Schedule, Service|Product|Complex, Customer?] (наследник окна)
 *   содержимое [Folder, Service|Product|Complex]  состав [Complex, Service|Product]
 *   навык [Staff, Service]
 * (bulk-путь задаёт id напрямую — v5-правила Schema работают на letopis-пути, не в триггере)
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
const C = {
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
const N = {
  orgs: 30, locationsPerOrg: 2, foldersPerOrg: 5, staffPerOrg: 12,
  servicesPerOrg: 20, productsPerOrg: 5, complexesPerOrg: 4,
  monthsPerOrg: 12, shiftsPerStaff: 150, customers: 40000, bookings: 440000,
};
const CITY = ['Москва', 'Питер', 'Казань', 'Сочи', 'Уфа'];
const SVC = ['Стрижка', 'Окрашивание', 'Укладка', 'Маникюр', 'Педикюр', 'Борода', 'Бритьё', 'Массаж', 'Спа', 'Брови'];
const GOODS = ['Шампунь', 'Бальзам', 'Воск', 'Масло', 'Лак'];
const NAME = ['Ольга', 'Ирина', 'Света', 'Марина', 'Анна', 'Пётр', 'Иван', 'Олег', 'Катя', 'Вера', 'Боря', 'Женя'];
const SPEC = ['парикмахер', 'барбер', 'колорист', 'мастер ногтевого сервиса', undefined];
// папки: дерево 3 уровней (Каталог → Мужской зал → Борода и усы → Уход; Женский зал под корнем)
const FOLDER_NAMES = ['Каталог', 'Мужской зал', 'Женский зал', 'Борода и усы', 'Уход'];
const FOLDER_PARENT = [null, 0, 0, 1, 3]; // родитель по локальному индексу папки (offset от корня орг); null = корень

function makeRows() {
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

async function bulk(sql, rows) {
  const CHUNK = 4000;
  await sql.unsafe('BEGIN');
  try {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      for (const [rid, cls, data, links, updated, tags] of part) {
        const o = params.length;
        values.push(`('entity',$${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5}::timestamptz,$${o + 6}::text[],'${SYS}','${SYS}')`);
        params.push(rid, cls, data, links, updated, tags);
      }
      await sql.unsafe(
        `INSERT INTO "${S}"."Entity" (partition, id, class, data, links, updated, tags, account, owner) VALUES ${values.join(',')}`,
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
