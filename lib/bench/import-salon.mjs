/**
 * Полный импорт полигона salon из 0.21 (план, этап 7, п. 2; тест-план §7.9 №7.6): `npm run test:import-salon`.
 * Без ручных шагов: засевает полигон в 0.21 (seed-021.mjs; up() пакета letopis-0 сам поднимает контейнер
 * letopis-timescale), ставит свежую схему 1.0 (контейнер letopis-pg18 поднимает обвязка тестов) и
 * импортирует. Полигон записан в 0.21 сырыми вставками мимо правил v5: старты записей одного мастера
 * совпадают, поэтому booking импортируется без ключа (--keyless — объявленное расхождение). Проверка:
 * объекты и версии по классам в 1.0 равны полигону 0.21, verify() чист; итог — results/import-salon.json,
 * код 1 при расхождении. BENCH_SCALE=0.1 — полигон в десять раз меньше.
 */
import { seedSalon021, DSN_021 } from './seed-021.mjs';
import { countRows } from './salon-data.mjs';
import { save, SCALE, round } from './_core.mjs';
import { up } from '../src/up.ts';
import { import021 } from '../src/import.ts';
import { ensureDatabase, ADMIN_DSN } from '../test/_harness.ts';

const NAME = 'salon_import';
console.log(`0.21: засевка полигона salon (scale ${SCALE})…`);
const seeded = await seedSalon021({ name: NAME, scale: SCALE });
const expected = countRows(seeded.rows);
console.log(`  ${seeded.rows.length} строк за ${(seeded.ms / 1000).toFixed(1)} с`);

await ensureDatabase();
await up({ dsn: ADMIN_DSN, schema: NAME, fresh: true, quiet: true });
console.log('1.0: импорт…');
const t0 = performance.now();
const r = await import021({ from: DSN_021, fromSchema: `v1.${NAME}`, dsn: ADMIN_DSN, schema: `v2.${NAME}`, tenant: 'salon', keyless: ['booking'], quiet: false });
const ms = performance.now() - t0;

const mismatch = [];
for (const [cls, c] of Object.entries(expected)) {
  const s = r.source[cls];
  const t = r.target[cls];
  if (!s || s.objects !== c.objects || s.versions !== c.versions) mismatch.push({ cls, side: '0.21', want: c, got: s });
  if (!t || t.objects !== c.objects || t.versions !== c.versions) mismatch.push({ cls, side: '1.0', want: c, got: t });
}
const rows = seeded.rows.length;
const result = {
  scale: SCALE, rows, importMs: round(ms), rowsPerSec: Math.round(rows / (ms / 1000)), seed021Ms: round(seeded.ms),
  verify: r.verify, keyless: r.classes.keyless, omitted: r.classes.omitted, notes: r.notes.length, counts: r.target, mismatch,
};
await save('import-salon', result);
console.log(JSON.stringify({ rows, importSec: round(ms / 1000), rowsPerSec: result.rowsPerSec, verify: r.verify.ok, mismatch: mismatch.length }));
process.exit(r.verify.ok && !mismatch.length ? 0 : 1);
