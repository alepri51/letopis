/**
 * chain-types — строгие типы цепочек по моделям (план 2.0, этап 4, п. 1; до 2.0 — план 1.0, этап 3, п. 9):
 * connect({ models }) даёт шаги только известных классов и алиасов (модели и системные классы), переходы по концам,
 * слоты ролей класса, поля фильтров, or() и агрегатов; loose(db) — для имён, известных только во время выполнения.
 * Отрицательные примеры 7.10 №1 проверяет tsc (npm run typecheck): строка с @ts-expect-error без ошибки типов — сама
 * ошибка, tsx типы не смотрит. 7.10 №6 — строгие типы из файла `letopis types`: файл пишет CLI, его и пробный модуль
 * компилирует TypeScript в самом тесте.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, gt, inc, loose, or, syncModels, type RowOf, type TypedDb } from '../src/index.js';
import { hub, many, one } from '../src/model.js';
import { BOOKING, Org, Staff } from '../src/demo/booking.js';
import { main } from '../src/cli.js';

/** Класс теста с множественным и необязательным концами: в booking их нет. */
const Crew = hub('TCrew', {
  fields: z.object({ name: z.string(), size: z.number().int().optional() }),
  key: ['name'],
  ends: { Members: many(Staff), Lead: one(Staff).optional(), Base: one(Org) },
});
const MODELS = [...BOOKING, Crew] as const;

let e: Engine;
let t: Tenant;
let db: TypedDb<typeof MODELS>;
const ids: { org: string; service: string; anna: string; boris: string } = { org: '', service: '', anna: '', boris: '' };

before(async () => {
  e = await engine(import.meta.filename, { seeds: ['booking'] });
  t = await e.tenant('types');
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 2, models: MODELS });
  await syncModels(db, [Crew], { apply: true });
  const S = `"${e.schema}"`;
  await db.transaction(async (tx) => {
    const [org] = await tx.unsafe(`insert into ${S}.entity (class, data) values ('Org', '{"name": "Типы"}') returning id`);
    ids.org = org.id;
    const [service] = await tx.unsafe(`insert into ${S}.entity (class, data, links) values ('Service', '{"name": "Стрижка", "duration": 60}', $1::jsonb) returning id`,
      [{ Org: org.id } as never]);
    ids.service = service.id;
    for (const who of ['anna', 'boris'] as const) {
      const [s] = await tx.unsafe(`insert into ${S}.entity (class, data, links) values ('Staff', $1::jsonb, $2::jsonb) returning id`,
        [{ name: who, phone: '+7' } as never, { Org: org.id } as never]);
      ids[who] = s.id;
    }
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

test('план 2.0, 7.10 №1: строгие типы — системный класс, переходы по концам, слоты ролей, or() и агрегаты по полям класса, loose(db)', async () => {
  // системный класс — из встроенного набора моделей
  const cls = await db.Class({ name: 'Service' }).first();
  const clsName: string | undefined = cls?.data.name;
  assert.equal(clsName, 'Service');
  // переходы: назад (класс, чей конец смотрит на Org), по алиасу, вперёд по унаследованному концу
  assert.deepEqual((await db.Org(ids.org).Service().rows()).map((r) => r.data.name), ['Стрижка']);
  assert.equal(await db.Организация(ids.org).Услуга().count(), 1);
  assert.equal((await db.Staff(ids.anna).Org().first())?.data.name, 'Типы');
  // or() — фильтры класса шага
  assert.equal(await db.Service(or({ name: 'Стрижка' }, { duration: gt(100) })).count(), 1);
  assert.equal(await db.Service(or({ name: 'нет' }, { duration: gt(100) })).count(), 0);
  // агрегаты — поля класса: sum и avg — числовые
  const sum: number | null = await db.Service().sum('data.duration');
  assert.equal(sum, 60);
  assert.equal(await db.Service().avg('data.duration'), 60);
  assert.equal(await db.Service().max('data.duration'), 60);
  assert.deepEqual(await db.Service().countBy('data.name'), { Стрижка: 1 });
  // слоты — роли класса: add у множественного конца, set у одиночного, unset у необязательного
  const [crew] = await db.Org(ids.org).TCrew().create({ name: 'Смена' }).Members.add([ids.anna, ids.boris]).Lead.set(ids.anna).rows();
  assert.deepEqual([...(crew.links.Members ?? [])].sort(), [ids.anna, ids.boris].sort());
  assert.equal(crew.links.Lead, ids.anna);
  assert.equal(crew.links.Base, ids.org);
  const [fixed] = await db.TCrew(crew.id).update({ size: 1 }).Members.remove(ids.boris).Lead.unset().rows();
  assert.deepEqual(fixed.links.Members, [ids.anna]);
  assert.equal(fixed.links.Lead, undefined);
  const [back] = await db.TCrew(crew.id).update().Lead.set(db.Staff(ids.boris)).rows();
  assert.equal(back.links.Lead, ids.boris);
  // переход по роли с множественным концом — в класс цели
  assert.deepEqual((await db.TCrew(crew.id).Members().rows()).map((r) => r.data.name), ['anna']);
  // loose(db): имя, известное только во время выполнения, — то же подключение без строгих типов
  const dynamic: string = ['Ser', 'vice'].join('');
  assert.equal(await loose(db)[dynamic]({ name: 'Стрижка' }).count(), 1);
  assert.equal(loose(db), db);
});

// Только проверка типов: функция не вызывается. На каждое строгое правило — @ts-expect-error (план 2.0, 7.10 №1).
export function typeChecks(): void {
  // @ts-expect-error — поля nme нет в модели Service
  void db.Service({ nme: 'x' });
  // @ts-expect-error — duration — число
  void db.Service({ duration: 'долго' });
  // @ts-expect-error — сортировка только по at, rev, id или data.<путь>
  void db.Service().sort('duration');
  // запись (этап 4): патч по модели, inc() — только у числовых полей
  void db.Service('id').update({ duration: inc(5) }).rows();
  void db.Org('id').update({ settings: { booking: { autoconfirm: true } } }).rows();
  // @ts-expect-error — inc() у строкового поля
  void db.Service('id').update({ name: inc(1) });
  // @ts-expect-error — поля nme нет в модели Service
  void db.Service().create({ nme: 'x' });

  // неизвестный класс: шаг от корня — только класс или алиас моделей и системных классов
  // @ts-expect-error — класса Servise нет
  void db.Servise();
  // @ts-expect-error — роль (Parent у Folder) шагом от корня — нет: только класс или алиас
  void db.Parent();
  void db.Account({ name: 'x' }).member().User().rows().then((r) => r[0]?.data.name);
  void db.rule().Group().first().then((r) => r?.data.alias);

  // переходы — из концов, как resolveHop
  void db.Folder('id').Parent().Parent();
  void db.booking('id').Element().Org();
  void db.booking('id').Item().rows().then((r) => r[0]?.data.name);
  void db.compo('id').Part().rows().then((r) => r[0]?.data.name);
  void db.Person('id').booking().Customer();
  void db.Org('id').Staff().skill().Service({ duration: gt(30) }).Org();
  void db.Staff('id').TCrew().Base().Услуга();
  // @ts-expect-error — Org и skill не связаны концом
  void db.Org('id').skill();
  // @ts-expect-error — Service и Staff не связаны концом (только через skill)
  void db.Service('id').Staff();
  // @ts-expect-error — Org и системный Account не связаны концом
  void db.Org('id').Account();
  // @ts-expect-error — Parent — роль Folder, а не Service
  void db.Service('id').Parent();

  // слоты — только роли класса
  void db.booking('id').update({}).Customer.unset().Staff.set('x').Location.set({ id: 'x' }).Schedule.set(db.Schedule('x'));
  void db.TCrew('id').update().Members.set(['a', 'b']).Members.add('c').Members.remove([{ id: 'a' }]).Lead.unset();
  // @ts-expect-error — Element — класс цели конца Item, а не роль booking
  void db.booking('id').update({}).Element.set('x');
  // @ts-expect-error — роли Nope у booking нет
  void db.booking('id').update({}).Nope.set('x');
  // @ts-expect-error — add() — только у множественного конца
  void db.booking('id').update({}).Staff.add('x');
  // @ts-expect-error — remove() — только у множественного конца
  void db.TCrew('id').update().Lead.remove('x');
  // @ts-expect-error — unset() — только у необязательного конца
  void db.booking('id').update({}).Staff.unset();
  // @ts-expect-error — unset() — только у необязательного конца: Base обязателен
  void db.TCrew('id').update().Base.unset();
  // @ts-expect-error — set() одиночного конца — id, строка ответа или цепочка, не список
  void db.booking('id').update({}).Staff.set(['a', 'b']);

  // агрегаты — поля класса; sum и avg — числовые
  void db.Org().countBy('data.settings.booking.deposit.currency');
  void db.price().sum('data.amounts.RUB');
  void db.TCrew().avg('data.size');
  // @ts-expect-error — name — строка: sum() — только числовые поля
  void db.Service().sum('data.name');
  // @ts-expect-error — поля nme нет в классе Service
  void db.Service().countBy('data.nme');
  // @ts-expect-error — поле агрегата — 'data.<путь>'
  void db.Service().max('duration');
  // @ts-expect-error — поля nme нет в классе Service
  void db.Service().min('data.nme');

  // or() — фильтры класса шага
  void db.Service(or({ name: 'a' }, { duration: gt(1), Org: 'id' }));
  // @ts-expect-error — поля nme нет в модели Service
  void db.Service(or({ nme: 'x' }));
  // @ts-expect-error — duration — число
  void db.Service(or({ name: 'a' }, { duration: 'долго' }));

  // строки типизированы и после entity()
  void db.Org('id').entity(db.Service('id')).rows();
  const row = null as unknown as RowOf<typeof Org>;
  void db.entity(row).rows();
  // loose(db): любое имя, проверки — во время выполнения
  void loose(db).Anything({ x: 1 }).Whatever().rows();
}

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Ошибки TypeScript в файлах каталога dir (и общие) — строками «файл:строка: текст». */
function compile(dir: string, files: string[]): string[] {
  const options: ts.CompilerOptions = {
    strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, baseUrl: dir,
    paths: { letopis: [join(LIB, 'src', 'index.ts')] }, typeRoots: [join(LIB, 'node_modules', '@types')], types: ['node'],
  };
  const program = ts.createProgram(files.map((f) => join(dir, f)), options);
  const inDir = (f?: ts.SourceFile) => !f || f.fileName.replace(/\\/g, '/').startsWith(dir.replace(/\\/g, '/'));
  return ts.getPreEmitDiagnostics(program).filter((d) => inDir(d.file)).map((d) => {
    const at = d.file && d.start !== undefined ? `${d.file.fileName.split(/[\\/]/).pop()}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}: ` : '';
    return at + ts.flattenDiagnosticMessageText(d.messageText, '\n');
  });
}

test('план 2.0, 7.10 №6: строгие типы работают из файла letopis types — без моделей Zod, connect<Models>()', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'letopis-strict-'));
  try {
    const log = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = await main(['types', '--dsn', appDsn(), '--schema', e.schema, '--token', t.token, '--system', '--out', join(dir, 'models.ts')]);
    } finally {
      console.log = log;
    }
    assert.equal(code, 0);
    await writeFile(join(dir, 'probe.ts'), PROBE);
    assert.deepEqual(compile(dir, ['probe.ts']), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Пробный модуль 7.10 №6: те же правила, что в typeChecks(), но типы — из файла letopis types. */
const PROBE = `import { connect, cursorOf, gt, loose, or, type SystemModels, type TypedDb } from 'letopis';
import type { Models } from './models.ts';

// встроенный набор системных моделей — то же, что выдала база (letopis types --system)
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Types<K> = NonNullable<K extends { readonly __types?: infer T } ? T : never>;
type Gen<N> = Types<Extract<Models[number], { readonly name: N }>>;
type Sys<N> = Types<Extract<SystemModels[number], { readonly name: N }>>;
type Part = 'data' | 'links' | 'ends';
type SameClass<N> = { [P in Part]: Same<NonNullable<Gen<N>[P & keyof Gen<N>]>, NonNullable<Sys<N>[P & keyof Sys<N>]>> };
export const system: [SameClass<'Class'>, SameClass<'Account'>, SameClass<'member'>, SameClass<'Resource'>, SameClass<'rule'>] = [
  { data: true, links: true, ends: true }, { data: true, links: true, ends: true }, { data: true, links: true, ends: true },
  { data: true, links: true, ends: true }, { data: true, links: true, ends: true },
];

export async function probe(): Promise<void> {
  const db: TypedDb<Models> = await connect<Models>({ dsn: 'postgres://localhost/x', schema: 'v2.x' });
  const rows = await db.Service({ duration: gt(30) }).rows();
  const name: string = rows[0].data.name;
  const org: string = rows[0].links.Org;
  void name, org;
  // строка из интерфейсов файла подходит туда, где ждут Row
  void db.entity(rows[0]).rows();
  void db.Service().sort('data.name').after(cursorOf(rows[0], 'data.name')).rows();
  void db.Услуга().Org().first();
  void db.Account({ name: 'x' }).member().User();
  void db.Folder('id').Parent().Parent();
  void db.booking('id').Element().Org();
  void db.compo('id').Part().rows();
  void db.Org('id').TCrew().create({ name: 'a' }).Members.add(['a']).Lead.set('b').Lead.unset();
  void db.booking('id').update({}).Customer.unset().Staff.set(db.Staff('x'));
  void db.Service(or({ name: 'a' }, { duration: gt(1) }));
  void db.price().sum('data.amounts.RUB');
  void db.Org().countBy('data.settings.booking.deposit.currency');
  void loose(db).Anything().rows();
  // @ts-expect-error — неизвестный класс
  void db.Servise();
  // @ts-expect-error — переход: Org и skill не связаны концом
  void db.Org('id').skill();
  // @ts-expect-error — роль в слоте: Element — класс, а не роль booking
  void db.booking('id').update({}).Element.set('x');
  // @ts-expect-error — add() у одиночного конца
  void db.booking('id').update({}).Staff.add('x');
  // @ts-expect-error — unset() у обязательного конца
  void db.booking('id').update({}).Staff.unset();
  // @ts-expect-error — поле агрегата: name — строка
  void db.Service().sum('data.name');
  // @ts-expect-error — or(): поля nme нет в классе Service
  void db.Service(or({ nme: 'x' }));
  // @ts-expect-error — поля nme нет в классе Service
  void db.Service({ nme: 'x' });
}
`;
