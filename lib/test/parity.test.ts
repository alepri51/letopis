/**
 * ПАРИТЕТ клиент ↔ триггер БД.
 *
 * Часть инвариантов реализована ДВАЖДЫ: в plpgsql (`entity_check` в sql/ddl.sql) — чтобы
 * голый SQL нельзя было обойти, и в TypeScript (`validate` в src/write.ts) — чтобы ошибка
 * была адресной до похода в базу. Две реализации на двух языках могут разойтись, и без
 * этого файла расхождение обнаружилось бы только случайно.
 *
 * Тест НЕ пишется под каждую схему потребителя: правило одно для всех схем, поэтому здесь
 * один маленький полигон, а проверяется САМО ПРАВИЛО. Каждый кейс исполняется двумя путями —
 * через либу и голым INSERT в Entity — и утверждается, что оба ведут себя одинаково.
 *
 * Отдельно закреплена ИЗВЕСТНАЯ асимметрия: валидация данных по attributes живёт только в
 * либе (fastest-validator нельзя запустить в plpgsql), поэтому голый SQL структурный мусор
 * в data принимает. Если это когда-нибудь изменится — тест упадёт и напомнит поправить
 * README §2 и §12.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { connect, ValidationError } from '../src/index.js';
import type { EntityDb } from '../src/chain.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const SCHEMA = 'v1.parity';
const here = dirname(fileURLToPath(import.meta.url));

let db: EntityDb;
let SYS: string;

/**
 * Голый INSERT в Entity — путь, обходящий либу целиком (остаются только триггеры БД).
 * NB: каст именно `::text::jsonb`. Просто `::jsonb` даёт jsonb-СТРОКУ (postgres.js отдаёт
 * параметр как есть), и триггер падает на `jsonb_each on a non-object` — то есть тест
 * «зелёного» пути ловил бы собственную ошибку связывания, а не поведение движка.
 */
const raw = (cls: string, links: Record<string, string>, data: object = {}, id = randomUUID()) =>
  db.sql.unsafe(
    `INSERT INTO "${SCHEMA}"."Entity" (partition, class, id, data, links, account, owner)
     VALUES ('entity', $1, $2, $3::text::jsonb, $4::text::jsonb, $5::uuid, $5::uuid)`,
    [cls, id, JSON.stringify(data), JSON.stringify(links), SYS],
  );

/** Оба пути обязаны ОТВЕРГНУТЬ операцию. */
const bothReject = async (
  label: string,
  lib: () => Promise<unknown>,
  rawArgs: Parameters<typeof raw>,
  libRe: RegExp,
) => {
  await assert.rejects(lib(), libRe, `${label}: либа приняла то, что должна отвергать`);
  await assert.rejects(
    raw(...rawArgs),
    /ENTITY_CHECK|violates|invalid/i,
    `${label}: триггер БД принял то, что отвергает либа — реализации РАСОШЛИСЬ`,
  );
};

/** Оба пути обязаны ПРИНЯТЬ операцию. */
const bothAccept = async (label: string, lib: () => Promise<unknown>, rawArgs: Parameters<typeof raw>) => {
  await lib().catch((e: Error) => assert.fail(`${label}: либа отвергла валидное — ${e.message}`));
  await raw(...rawArgs).catch((e: Error) =>
    assert.fail(`${label}: триггер отверг валидное, принятое либой — реализации РАСОШЛИСЬ — ${e.message}`),
  );
};

before(async () => {
  const admin = postgres(DSN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.end();
  execFileSync('node', [join(here, '../../db/apply.mjs'), `--dsn=${DSN}`, '--schema=parity', '--version=1'], {
    stdio: 'ignore',
  });
  db = await connect({ enforceAccount: false, dsn: DSN, schema: SCHEMA });
  const rows = (await db.sql.unsafe(
    `SELECT id FROM "${SCHEMA}"."Account" WHERE 'System' = ANY(categories) LIMIT 1`,
  )) as unknown as { id: string }[];
  SYS = rows[0].id;
});
after(async () => db.close());

test('паритет: запись в abstract-класс отвергают оба пути', async () => {
  // Сущность/Entity — абстрактный корень домена
  await bothReject(
    'abstract',
    () => db.Сущность().create({}).rows(),
    ['Entity', {}],
    /is abstract/,
  );
});

test('паритет: неизвестный класс отвергают оба пути', async () => {
  // либа не доходит до SQL: класс не резолвится в реестре — ошибка синхронная
  assert.throws(() => db.НетТакогоКласса(), /unknown class/);
  await assert.rejects(raw('NoSuchClass', {}), /ENTITY_CHECK: unknown class/);
});

test('паритет: LINK без обязательного конца отвергают оба пути', async () => {
  // навык = [Мастер, Услуга] — оба конца обязательны; даём только один.
  // NB: у навыка id считается как v5 из концов, поэтому либа отвергает РАНЬШЕ проверки
  // концов — на вычислении id. Важно, что отвергает; текст сообщения другой.
  const staff = randomUUID();
  await bothReject(
    'missing required end',
    () => db.навык().create({ level: 'expert' }).Мастер.set(staff).rows(),
    ['skill', { Staff: staff }, { level: 'expert' }],
    /requires end|needs end/,
  );
});

test('паритет: посторонняя связь (не конец по Schema.links) отвергается обоими', async () => {
  // Папка не объявлена концом навыка.
  // Либа ловит это СИНХРОННО при построении слота (лучше, чем в терминале), поэтому
  // здесь throws, а не rejects — но отвергают по-прежнему оба пути.
  const staff = randomUUID();
  const svc = randomUUID();
  assert.throws(
    () => db.навык().create({ level: 'expert' }).Мастер.set(staff).Услуга.set(svc).Папка.set(randomUUID()),
    /is not a link end/,
    'либа приняла постороннюю связь',
  );
  await assert.rejects(
    raw('skill', { Staff: staff, Service: svc, Folder: randomUUID() }, { level: 'expert' }),
    /ENTITY_CHECK/,
    'триггер принял постороннюю связь — реализации РАСОШЛИСЬ',
  );
});

test('паритет: ключ links, не являющийся классом, отвергается обоими', async () => {
  const staff = randomUUID();
  const svc = randomUUID();
  // через либу такой ключ невозможен слотом (слот резолвит класс) — проверяем синхронный гард
  assert.throws(() => db.навык().create({}).НеКласс, /unknown class/);
  await assert.rejects(
    raw('skill', { Staff: staff, Service: svc, NotAClass: randomUUID() }, { level: 'x' }),
    /links key .* is not a class/,
  );
});

test('паритет: союз ролей, закрытый одним классом, принимают оба пути', async () => {
  // запись = [Мастер, Локация, Расписание, {Услуга|Товар|Комплекс}, Клиент?]
  const ends = { Staff: randomUUID(), Location: randomUUID(), Schedule: randomUUID(), Service: randomUUID() };
  const data = { start_datetime: '2026-08-01T10:00:00+03:00', end_datetime: '2026-08-01T11:00:00+03:00' };
  await bothAccept(
    'union end satisfied',
    () =>
      db
        .запись()
        .create(data)
        .Мастер.set(ends.Staff)
        .Локация.set(ends.Location)
        .Расписание.set(ends.Schedule)
        .Услуга.set(ends.Service)
        .rows(),
    ['booking', ends, data],
  );
});

test('паритет: отсутствие OPTIONAL-конца принимают оба пути', async () => {
  // Клиент у записи объявлен optional — его отсутствие законно (ручная бронь)
  const ends = { Staff: randomUUID(), Location: randomUUID(), Schedule: randomUUID(), Product: randomUUID() };
  const data = { start_datetime: '2026-08-02T10:00:00+03:00', end_datetime: '2026-08-02T11:00:00+03:00' };
  await bothAccept(
    'optional end omitted',
    () =>
      db
        .запись()
        .create(data)
        .Мастер.set(ends.Staff)
        .Локация.set(ends.Location)
        .Расписание.set(ends.Schedule)
        .Товар.set(ends.Product)
        .rows(),
    ['booking', ends, data],
  );
});

test('ИЗВЕСТНАЯ асимметрия: валидацию данных делает ТОЛЬКО либа, голый SQL мусор принимает', async () => {
  const ends = { Staff: randomUUID(), Location: randomUUID(), Schedule: randomUUID(), Service: randomUUID() };
  // либа: строгая валидация attributes (fastest-validator, $$strict) — лишнее поле и мусор в типе
  await assert.rejects(
    db
      .запись()
      .create({ start_datetime: 'не дата', end_datetime: 123 as never, лишнее: 1 } as never)
      .Мастер.set(ends.Staff)
      .Локация.set(ends.Location)
      .Расписание.set(ends.Schedule)
      .Услуга.set(ends.Service)
      .rows(),
    ValidationError,
  );
  // голый SQL: структура links проверена триггером, а СОДЕРЖИМОЕ data — нет
  await raw('booking', ends, { start_datetime: 'не дата', end_datetime: 123, лишнее: 1 }).catch((e: Error) =>
    assert.fail(
      'триггер начал валидировать data — асимметрия исчезла, поправьте README §2 «либа добавляет ' +
        `строгую валидацию данных» и этот тест: ${e.message}`,
    ),
  );
});
