/**
 * Оверхед ACL на article-полигоне (1.1M строк; Booking — 250k сущностей × 2 версии).
 * Три режима одних и тех же запросов:
 *   base    — без enforceAcl;
 *   allow   — enforceAcl, безусловное правило (класс целиком);
 *   filter  — enforceAcl, правило с предикатом owner=$account (вливается в WHERE).
 * Запуск: npx tsx bench/acl.bench.mjs
 */
import { connect } from '../src/index.js';

const DSN = 'postgres://postgres:test@localhost:15432/clockz';
const S = 'v1.article';
const SYS = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const bu = (n) => `00000007-0000-4000-8000-${String(n).padStart(12, '0')}`; // id записей генератора

const N = 20;
const p50 = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function bench(label, fn) {
  await fn(); // прогрев
  const times = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  return { label, ms: +p50(times).toFixed(1) };
}

const sys = await connect({ dsn: DSN, schema: S });

// словарь бенча: READ на Booking/item (deny-by-default закрыл бы цепочку)
async function setRules(bookingPattern) {
  await sys.resources.set({ alias: 'bench.booking:READ', category: 'READ', pattern: bookingPattern });
  await sys.resources.set({ alias: 'bench.item:READ', category: 'READ', pattern: { class: 'item' } });
  await sys.rules.set({ account: 'authenticated:ACCOUNT', resource: 'bench.booking:READ', permission: 'allow', weight: 90 });
  await sys.rules.set({ account: 'authenticated:ACCOUNT', resource: 'bench.item:READ', permission: 'allow', weight: 90 });
}

const scenes = (db) => [
  ['точечный first(id)', () => db.Запись(bu(777)).first()],
  ["фильтр rows: {status:'cancelled'}.limit(100)", () => db.Запись({ status: 'cancelled' }).limit(100).rows()],
  ['keyset-страница: sort(updated desc).limit(100)', () => db.Запись().sort('updated', 'desc').limit(100).rows()],
  ['count всего класса (250k)', () => db.Запись().count()],
  ['цепочка: Запись(id).позиция().rows()', () => db.Запись(bu(778)).позиция().rows()],
];

const out = {};
async function run(mode, db) {
  for (const [label, fn] of scenes(db)) {
    const { ms } = await bench(label, fn);
    (out[label] ??= {})[mode] = ms;
    console.log(`${mode.padEnd(7)} ${label}: ${ms} ms`);
  }
}

console.log('--- base: без enforceAcl');
await run('base', sys);

console.log('--- allow: безусловное правило (класс целиком)');
await setRules({ class: 'Booking' });
const dbAllow = await connect({ dsn: DSN, schema: S, account: SYS, enforceAcl: true });
await run('allow', dbAllow);
await dbAllow.close();

console.log('--- filter: предикат owner=$account (все строки Booking — SYS, селективность 100%)');
await setRules({ class: 'Booking', owner: '$account' });
const dbFilter = await connect({ dsn: DSN, schema: S, account: SYS, enforceAcl: true });
await run('filter', dbFilter);

// цена справочного checkData (каждый вызов — SQL за категориями аккаунта)
const t0 = performance.now();
for (let i = 0; i < 100; i++) await dbFilter.acl.checkData(SYS, 'Booking', 'READ');
console.log(`db.acl.checkData ×100: ${((performance.now() - t0) / 100).toFixed(2)} ms/вызов (кэш правил, но SQL за Account)`);
await dbFilter.close();

// уборка
await sys.rules.delete('authenticated:ACCOUNT', 'bench.booking:READ');
await sys.rules.delete('authenticated:ACCOUNT', 'bench.item:READ');
await sys.resources.delete('bench.booking:READ');
await sys.resources.delete('bench.item:READ');
await sys.close();

console.log('\n| Сцена | base | allow | filter |');
console.log('|---|---|---|---|');
for (const [label, m] of Object.entries(out)) {
  console.log(`| ${label} | ${m.base} | ${m.allow} | ${m.filter} |`);
}
