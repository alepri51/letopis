/**
 * chain-types — типы цепочек по моделям (план, этап 3, п. 9): connect({ models }) даёт типы шагов
 * по именам и алиасам, строк и фильтров. Отрицательные примеры проверяет tsc (npm run typecheck):
 * строка с @ts-expect-error без ошибки типов — сама ошибка.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, gt, type TypedDb } from '../src/index.js';
import { BOOKING } from '../src/demo/booking.js';

let e: Engine;
let t: Tenant;
let db: TypedDb<typeof BOOKING>;

before(async () => {
  e = await engine(import.meta.filename, { seeds: ['booking'] });
  t = await e.tenant('types');
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 2, models: BOOKING });
  const S = `"${e.schema}"`;
  await db.transaction(async (tx) => {
    const [org] = await tx.unsafe(`insert into ${S}.entity (class, data) values ('Org', '{"name": "Типы"}') returning id`);
    await tx.unsafe(`insert into ${S}.entity (class, data, links) values ('Service', '{"name": "Стрижка", "duration": 60}', $1::jsonb)`, [{ Org: org.id } as never]);
  });
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('шаги по имени и алиасу, типизированные строки и фильтры', async () => {
  const rows = await db.Service({ duration: gt(30) }).rows();
  const name: string = rows[0].data.name;
  const duration: number | undefined = rows[0].data.duration;
  assert.equal(name, 'Стрижка');
  assert.equal(duration, 60);
  const viaAlias = await db.Услуга({ name: 'Стрижка' }).Org().first();
  const orgName: string | undefined = viaAlias?.data.name;
  assert.equal(orgName, 'Типы');
  const org: string | undefined = rows[0].links.Org;
  assert.ok(org);
});

// Только проверка типов: функция не вызывается.
export function typeChecks(): void {
  // @ts-expect-error — поля nme нет в модели Service
  void db.Service({ nme: 'x' });
  // @ts-expect-error — duration — число
  void db.Service({ duration: 'долго' });
  // @ts-expect-error — сортировка только по at, rev, id или data.<путь>
  void db.Service().sort('duration');
  void db.Service({ Org: 'id' }).Staff({ specialization: 'барбер' }).limit(1).rows().then((r) => r[0]?.data.specialization);
}
