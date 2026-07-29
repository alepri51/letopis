/** Волна 2: asOf/versions, keyset after, enforceAccount, anonymize, gen-types. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect, cursorOf } from '../src/index.js';
import type { EntityDb } from '../src/chain.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
/** Корень пакета (lib/) — cwd для scripts/* и база для paths/typeRoots в tsc-фикстурах. */
const LIB_DIR = fileURLToPath(new URL('..', import.meta.url));
let db: EntityDb;

before(async () => {
  db = await connect({ dsn: DSN, schema: 'v1.booking' });
  await db.sql.unsafe('TRUNCATE "v1.booking"."Entity"');
});
after(async () => db.close());

test('asOf: чтение «как было»; versions: вся история с $deleted', async () => {
  const [org] = await db.Организация().create({ name: 'Хронос' }).rows();
  const [svc] = await db.Организация(org).Услуга().create({ name: 'Стрижка', duration: 30 }).rows();
  // история цены — на отдельном LINK «цена» (amounts.RUB), не на самой услуге
  const [ц] = await db.Услуга(svc.id).цена().create({ amounts: { RUB: 1000 } }).rows();
  const t1 = ц.updated; // серверное время версии (clock skew клиент/БД не влияет)
  await db.цена(ц.id).update({ amounts: { RUB: 2000 } }).rows();

  // сейчас 2000, на момент t1 — 1000
  assert.equal(((await db.цена(ц.id).first())!.data.amounts as Record<string, number>).RUB, 2000);
  const тогда = await db.цена(ц.id).asOf(t1).first();
  assert.equal((тогда!.data.amounts as Record<string, number>).RUB, 1000);

  // до создания — не существует; после delete на «сейчас» — нет, на t1 — есть
  assert.equal(await db.цена(ц.id).asOf('2020-01-01').count(), 0);
  await db.цена(ц.id).delete({ confirm: true }).rows();
  assert.equal(await db.цена(ц.id).count(), 0);
  assert.equal((await db.цена(ц.id).asOf(t1).first())!.id, ц.id);

  // versions: 3 версии (1000, 2000, tombstone) по возрастанию
  const вс = await db.цена(ц.id).versions();
  assert.equal(вс.length, 3);
  assert.deepEqual(вс.map((v) => v.$deleted ?? false), [false, false, true]);
  assert.equal((вс[0].data.amounts as Record<string, number>).RUB, 1000);
});

test('after: keyset-пагинация стабильна и совпадает с полной выборкой', async () => {
  const [org] = await db.Организация({ name: 'Хронос' }).rows();
  for (let i = 0; i < 7; i++) {
    await db.Организация(org).Клиент().create({ name: `К${i}`, phone: `+7900000000${i}` }).rows();
  }
  const все = await db.Клиент().sort('data.name').rows();
  assert.equal(все.length, 7);

  const p1 = await db.Клиент().sort('data.name').limit(3).rows();
  const p2 = await db.Клиент().sort('data.name').after(cursorOf(p1[2], 'data.name')).limit(3).rows();
  const p3 = await db.Клиент().sort('data.name').after(cursorOf(p2[2], 'data.name')).limit(3).rows();
  assert.deepEqual(
    [...p1, ...p2, ...p3].map((r) => r.data.name),
    все.map((r) => r.data.name),
  );
  // desc + updated-курсор
  const d1 = await db.Клиент().sort('updated', 'desc').limit(4).rows();
  const d2 = await db.Клиент().sort('updated', 'desc').after(cursorOf(d1[3])).rows();
  assert.equal(d1.length + d2.length, 7);
  // .after без .sort — ошибка
  await assert.rejects(db.Клиент().after({ v: 'x', id: 'y' }).rows(), /requires \.sort/);
});

test('enforceAccount: чужое невидимо, запись пришпилена', async () => {
  const a1 = await db.accounts.set({ categories: ['User'], data: { name: 'Салон1' } });
  const a2 = await db.accounts.set({ categories: ['User'], data: { name: 'Салон2' } });
  await db.Организация().account(a1.id).create({ name: 'Org-A1' }).rows();
  await db.Организация().account(a2.id).create({ name: 'Org-A2' }).rows();

  const t1 = await connect({ dsn: DSN, schema: 'v1.booking', account: a1.id, enforceAccount: true });
  try {
    const мои = await t1.Организация().rows();
    assert.deepEqual(мои.map((r) => r.data.name), ['Org-A1']);           // чужого не видно
    assert.equal(await t1.Организация({ name: 'Org-A2' }).count(), 0);
    await assert.rejects(t1.Организация().account(a2.id).rows(), /pinned/); // подмена фильтра — ошибка
    await assert.rejects(t1.Организация().account(a2.id).create({ name: 'X' }).rows(), /pinned/);
    const [своё] = await t1.Организация().create({ name: 'Org-A1-new' }).rows();
    assert.equal(своё.account, a1.id);                                   // запись всегда своя
  } finally {
    await t1.close();
  }
});

test('anonymize: string-поля затёрты, тег anonymized, история хранит оригинал', async () => {
  const [org] = await db.Организация({ name: 'Хронос' }).rows();
  const [cli] = await db.Организация(org).Клиент().create({ name: 'Персональный', phone: '+79219876543' }).rows();
  const [anon] = await db.Клиент(cli.id).anonymize(['name', 'phone']).rows();
  assert.equal(anon.data.name, '[erased]');
  assert.equal(anon.data.phone, '[erased]');
  assert.ok(anon.tags.includes('anonymized'));
  const история = await db.Клиент(cli.id).versions();
  assert.equal(история[0].data.name, 'Персональный'); // старая версия жива (документированное ограничение)
  // не-строковое поле — отказ (у Клиента все поля строковые — берём boolean active Организации)
  await assert.rejects(db.Организация(org.id).anonymize(['active' as never]).rows(), /string fields only/);
});

test('gen-types: генерирует интерфейсы классов, слоты и фасады', async () => {
  execFileSync('npx', ['tsx', 'scripts/gen-types.mjs', `--dsn=${DSN}`, '--schema=v1.booking', '--out=entity-types.gen.d.ts'], {
    cwd: LIB_DIR,
    shell: true,
  });
  const { readFile, rm } = await import('node:fs/promises');
  const path = new URL('../entity-types.gen.d.ts', import.meta.url);
  const text = await readFile(path, 'utf8');

  // data-интерфейсы: свои поля + УНАСЛЕДОВАННЫЕ по ancestors (Staff ← Person ← Entity)
  assert.match(text, /export interface StaffData \{/);
  assert.match(text, /specialization\?: string/);
  assert.match(text, /name: string/, 'name наследуется от Person');
  assert.match(text, /phone: string/, 'phone наследуется от Person');
  assert.match(text, /preferred_contact: "phone" \| "email" \| "messenger"/);
  assert.match(text, /deposit\?: \{ amount: number; currency: "RUB" \| "USD" \| "EUR" \| "AED" \}/);

  // шаги по классам типизированы (id и alias), фасады на месте
  assert.match(text, /"Мастер"\(filter\?: Filter\): StaffChain;/);
  assert.match(text, /Staff\(filter\?: Filter\): StaffChain;/);
  assert.match(text, /export type TypedDb = Steps;/);
  assert.match(text, /export type TypedFullDb = Steps & EntityDb;/);

  // слоты из Schema.links: обязательный конец — только set(), optional — set()+unset()
  assert.match(text, /"Услуга": \{ set\(target: SlotTarget\): bookingChain \};/);
  assert.match(text, /"Клиент": \{ set\(target: SlotTarget\): bookingChain; unset\(\): bookingChain \};/);

  await rm(path);
});

test('gen-types: фасад не содержит снесённых имён и покрывает текущие терминалы', async () => {
  execFileSync('npx', ['tsx', 'scripts/gen-types.mjs', `--dsn=${DSN}`, '--schema=v1.booking', '--out=entity-types.gen2.d.ts'], {
    cwd: LIB_DIR,
    shell: true,
  });
  const { readFile, rm } = await import('node:fs/promises');
  const path = new URL('../entity-types.gen2.d.ts', import.meta.url);
  const text = await readFile(path, 'utf8');

  // снесённые глаголы НЕ должны появляться как методы цепочки (иначе типы обещают то, что бросает)
  assert.doesNotMatch(text, /^\s*execute\(/m, 'execute() снесён в 0.11.0 — см. chain.ts case "execute"');
  assert.doesNotMatch(text, /^\s*set\(data/m, 'глагол set(data) снесён в 0.16.0 — create()/update()');
  // индекс-сигнатура глушила бы любую опечатку
  assert.doesNotMatch(text, /\[className: string\]/, 'индекс-сигнатура возвращает дыру в типизации');

  // Поверхность ChainCore берётся из docs/api-contract.json (он генерируется из chain.ts),
  // а НЕ из захардкоженного списка: иначе новый метод цепочки молча не попадёт в кодоген —
  // именно так .exact() однажды и уехал.
  const { readFile: rf } = await import('node:fs/promises');
  const contract = JSON.parse(await rf(new URL('../../docs/api-contract.json', import.meta.url), 'utf8'));
  const core: string[] = contract.chain.core.map((m: { name: string }) => m.name);
  assert.ok(core.length >= 28, `в контракте подозрительно мало методов: ${core.length}`);
  for (const m of core) {
    assert.match(text, new RegExp(`^\\s*${m}\\(`, 'm'), `ChainOps не покрывает ${m}() из ChainCore`);
  }

  // класс, чьё имя перехватывает Proxy, не должен выдаваться как типизированный шаг
  const steps = text.slice(text.indexOf('export interface Steps {'));
  for (const reserved of ['count', 'sort', 'account', 'owner', 'link', 'set', 'update']) {
    assert.doesNotMatch(steps, new RegExp(`^\\s*${reserved}\\(filter`, 'm'),
      `"${reserved}" зарезервировано цепочкой — шаг под этим именем недостижим`);
  }

  await rm(path);
});

test('gen-types: сгенерированный .d.ts компилируется, снесённый API — ошибка компиляции', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'letopis-gentypes-'));
  try {
    execFileSync('npx', ['tsx', 'scripts/gen-types.mjs', `--dsn=${DSN}`, '--schema=v1.booking',
      `--out=${join(dir, 'entity-types.d.ts')}`], { cwd: LIB_DIR, shell: true });

    const tsconfig = (files: string[]) => JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
        strict: true, noEmit: true, skipLibCheck: true, baseUrl: '.',
        typeRoots: [join(LIB_DIR, 'node_modules', '@types')], types: ['node'],
        paths: { letopis: [join(LIB_DIR, 'src', 'index.ts')] },
      },
      files: ['entity-types.d.ts', ...files],
    });

    // ПОЗИТИВ: реальное использование текущего API типизируется
    await writeFile(join(dir, 'ok.ts'), `
import type { TypedDb, StaffData } from './entity-types.js';
declare const t: TypedDb;
export async function ok() {
  const м = await t.Мастер({ specialization: 'барбер' }).rows();
  const s: StaffData = м[0].data;
  const _name: string = s.name;                       // унаследовано от Person
  await t.Мастер().навык().Услуга().run();
  await t.цена().sum('data.amounts.RUB');
  await t.Мастер().sort('updated', 'desc').limit(5).withDeleted().first();
  await t.Мастер().create({ name: 'Вася', phone: '+7 900' }).rows();
  await t.запись().delete({ confirm: true }).rows();
  await t.запись().purge({ confirm: true }).rows();
  await t.Клиент().anonymize(['name']).rows();
  await t.Мастер().запись().create({}).Услуга.set('id').Клиент.unset().rows();
}
`, 'utf8');
    await writeFile(join(dir, 'tsconfig.json'), tsconfig(['ok.ts']), 'utf8');
    execFileSync('npx', ['tsc', '-p', join(dir, 'tsconfig.json')], { cwd: LIB_DIR, shell: true });

    // НЕГАТИВ: снесённые глаголы и опечатки обязаны падать НА КОМПИЛЯЦИИ, не в рантайме
    await writeFile(join(dir, 'bad.ts'), `
import type { TypedDb } from './entity-types.js';
declare const t: TypedDb;
export async function bad() {
  await t.Мастер().set({ name: 'x' });      // снесён 0.16.0
  await t.Мастер().execute();               // снесён 0.11.0
  await t.Мастеp().rows();                  // опечатка в классе (латинская p)
  await t.Мастер().create({ nam: 'x' }).rows();          // опечатка в поле
  await t.Мастер().запись().create({}).Услуга.unset();   // unset() обязательного конца
}
`, 'utf8');
    await writeFile(join(dir, 'tsconfig.bad.json'), tsconfig(['bad.ts']), 'utf8');
    let out = '';
    assert.throws(
      () => execFileSync('npx', ['tsc', '-p', join(dir, 'tsconfig.bad.json')],
        { cwd: LIB_DIR, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e: unknown) => { out = String((e as { stdout?: string }).stdout ?? ''); return true; },
      'снесённый API обязан не компилироваться',
    );
    for (const frag of ['set', 'execute', 'Мастеp', 'nam', 'unset']) {
      assert.ok(out.includes(frag), `tsc не отверг "${frag}":\n${out}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
