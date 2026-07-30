/**
 * Оверхед ACL на полигоне v1.salondemo (~982k строк; booking — 440k записей × 2 версии).
 * Три режима одних и тех же запросов:
 *   base    — без enforceAcl;
 *   allow   — enforceAcl, безусловное правило (класс целиком);
 *   filter  — enforceAcl, правило с предикатом owner=$account (вливается в WHERE).
 *
 * ВАЖНО: все три хендла идут с enforceAccount: false. Мерится цена АВТОРИЗАЦИИ, и только её.
 * Если у ACL-хендлов оставить изоляцию арендатора (по умолчанию она включена), колонки
 * перестают быть сравнимыми: в них попадает предикат account, а base его не платит — так
 * бенч однажды уже приписал ACL 18× чужой цены. Цена изоляции мерится отдельно и зависит от
 * ДОЛИ арендатора в классе (на полигоне System владеет всем — вырожденный худший случай).
 *
 * Полигон обязан быть проанализирован (`ANALYZE "v1.salondemo"."Entity"`): без статистики
 * планировщик оценивает подзапрос кандидатов в 200 строк и берёт Nested Loop — цифры
 * раздуваются в разы и мерят не то, что написано в заголовках колонок.
 *
 * Запуск: npx tsx bench/acl.bench.mjs
 */
import { connect } from '../src/index.js';

const DSN = 'postgres://postgres:test@localhost:15432/clockz';
const S = 'v1.salondemo';
const SYS = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const bu = (n) => `00000009-0000-4000-8000-${String(n).padStart(12, '0')}`; // id записей генератора salon-seed (booking = code 9)

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

const sys = await connect({ enforceAccount: false, dsn: DSN, schema: S });

// словарь бенча: READ на booking + Service (для цепочки запись→Услуга; deny-by-default закрыл бы её)
async function setRules(bookingPattern) {
  await sys.resources.set({ alias: 'bench.booking:READ', category: 'READ', pattern: bookingPattern });
  await sys.resources.set({ alias: 'bench.svc:READ', category: 'READ', pattern: { class: 'Service' } });
  await sys.rules.set({ account: 'authenticated:ACCOUNT', resource: 'bench.booking:READ', permission: 'allow', weight: 90 });
  await sys.rules.set({ account: 'authenticated:ACCOUNT', resource: 'bench.svc:READ', permission: 'allow', weight: 90 });
}

const scenes = (db) => [
  ['точечный first(id)', () => db.запись(bu(777)).first()],
  ["фильтр rows: {notes:'подтверждена'}.limit(100)", () => db.запись({ notes: 'подтверждена' }).limit(100).rows()],
  ['keyset-страница: sort(updated desc).limit(100)', () => db.запись().sort('updated', 'desc').limit(100).rows()],
  ['count всего класса (440k)', () => db.запись().count()],
  ['цепочка: запись(id).Услуга().rows()', () => db.запись(bu(778)).Услуга().rows()],
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
await setRules({ class: 'booking' });
const dbAllow = await (await connect({ dsn: DSN, schema: S, enforceAcl: true, enforceAccount: false })).as(SYS);
await run('allow', dbAllow);
await dbAllow.close();

console.log('--- filter: предикат owner=$account (все строки booking — SYS, селективность 100%)');
await setRules({ class: 'booking', owner: '$account' });
const dbFilter = await (await connect({ dsn: DSN, schema: S, enforceAcl: true, enforceAccount: false })).as(SYS);
await run('filter', dbFilter);

// цена справочного checkData (каждый вызов — SQL за категориями аккаунта)
const t0 = performance.now();
for (let i = 0; i < 100; i++) await dbFilter.acl.checkData(SYS, 'booking', 'READ');
console.log(`db.acl.checkData ×100: ${((performance.now() - t0) / 100).toFixed(2)} ms/вызов (кэш правил, но SQL за Account)`);
await dbFilter.close();

// уборка
await sys.rules.delete('authenticated:ACCOUNT', 'bench.booking:READ');
await sys.rules.delete('authenticated:ACCOUNT', 'bench.svc:READ');
await sys.resources.delete('bench.booking:READ');
await sys.resources.delete('bench.svc:READ');
await sys.close();

console.log('\n| Сцена | base | allow | filter |');
console.log('|---|---|---|---|');
for (const [label, m] of Object.entries(out)) {
  console.log(`| ${label} | ${m.base} | ${m.allow} | ${m.filter} |`);
}
