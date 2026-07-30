/**
 * Цена изоляции арендатора (enforceAccount) в зависимости от ДОЛИ арендатора в классе.
 * Полигон: v1.tenants (bench/tenants-seed.mjs) — 10 арендаторов, перекос 50%…0.3%.
 *
 *   node bench/tenants-seed.mjs && npx tsx bench/isolation.bench.mjs
 *
 * Мерится три вещи:
 *   scope       — db.as(арендатор), enforceAccount по умолчанию (изоляция включена);
 *   .account()  — тот же фильтр явным модификатором на админском хендле;
 *   весь класс  — чтение без фильтра арендатора (админский хендл).
 *
 * Смысл: предикат account попадает не только в перепроверку, но и в подзапрос КАНДИДАТОВ,
 * то есть сужает выборку по индексу ДО основного скана. Поэтому чтение своего арендатора
 * тем дешевле, чем он мельче, — изоляция не «добавляет фильтр к полному проходу», а
 * заменяет полный проход. Колонка .account() показывает, что изоляция не берёт ничего
 * сверх явного фильтра: SQL у них один и тот же.
 *
 * Полигон обязан быть проанализирован (tenants-seed делает ANALYZE сам): без статистики
 * планировщик оценивает подзапрос кандидатов в 200 строк и цифры мерят не то (README §14.1).
 */
import { connect } from '../src/index.js';
import { TENANTS } from './tenants-seed.mjs';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const S = 'v1.tenants';
const N = 5;
const p50 = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
/** Показываем крайности и середину — по ним видно, как цена зависит от доли. */
const ВЫБОРКА = [1, 3, 8, 10];

const bench = async (fn) => {
  const t = [];
  let v;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    v = await fn();
    t.push(performance.now() - t0);
  }
  return { ms: p50(t), rows: v };
};

const pool = await connect({ dsn: DSN, schema: S });
const admin = await connect({ dsn: DSN, schema: S, enforceAccount: false });

// точка отсчёта: полный проход по классу — то, что платит админский хендл без фильтра
const весь = await bench(() => admin.Клиент().count());

console.log(`полигон ${S}, count() класса Customer, p50 из ${N}`);
console.log(`весь класс без фильтра арендатора: ${весь.ms.toFixed(0)} ms (${весь.rows} сущн.)\n`);
console.log('| Доля арендатора | scope (изоляция) | .account() явным фильтром | против всего класса |');
console.log('|---|---|---|---|');

for (const n of ВЫБОРКА) {
  const t = TENANTS[n - 1];
  const scoped = await pool.as(t.id);
  const s = await bench(() => scoped.Клиент().count());
  const a = await bench(() => admin.Клиент().account(t.id).count());
  if (s.rows !== a.rows) throw new Error(`выборки разошлись: scope=${s.rows} admin=${a.rows}`);
  const d = весь.ms / s.ms;
  const итог = d > 1.15 ? `быстрее ×${d.toFixed(1)}` : d < 0.87 ? `МЕДЛЕННЕЕ ×${(1 / d).toFixed(1)}` : 'равно';
  const доля = `${(t.share * 100).toFixed(1)} %`;
  console.log(`| ${доля} (${s.rows} сущн.) | ${s.ms.toFixed(0)} ms | ${a.ms.toFixed(0)} ms | ${итог} |`);
}

console.log('\nИзоляция не добавляет фильтр к полному проходу, а заменяет его: чем мельче');
console.log('арендатор, тем дешевле чтение. Колонки scope и .account() совпадают — SQL один.');

await pool.close();
await admin.close();
