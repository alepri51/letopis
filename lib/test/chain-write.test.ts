/**
 * chain-write — запись цепочками (план, этап 4; тест-план §7.6 №4.1–4.8, 4.13, 4.17, 4.19).
 * Эталон — планы записи 0.21 (plan, core, idgen, api-full, wave2): звенья плана, продолжение от
 * результата, fan-out, self-update, превью и удаление, откат плана целиком, слоты, хвост-чтение,
 * anonymize. Объявленное отличие: create занятого ключа — ошибка exists, замена — upsert.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { seedSalon, type Salon } from './_salon.js';
import { connect, inc, idOf, type Db, type Row } from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;
let s: Salon;

const code = (c: string) => (err: { code?: string }) => {
  assert.equal(err.code, c, String((err as Error).message));
  return true;
};
const at = (d: number, h: number) => `2026-11-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`;

before(async () => {
  e = await engine(import.meta.filename, { seeds: ['booking'] });
  t = await e.tenant('write');
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 6 });
  s = await seedSalon(db);
  // классы с каскадом и unset — в арендаторе теста (в демо-домене концы по умолчанию restrict)
  await e.defineClass(t, { name: 'Team', kind: 'hub', key: ['name'],
    fields: { properties: { name: { type: 'string' }, city: { type: 'string' } }, required: ['name'] } });
  await e.defineClass(t, { name: 'Member', kind: 'hub', key: ['Team', 'name'],
    fields: { properties: { name: { type: 'string' }, level: { type: 'integer', minimum: 0, default: 0 } }, required: ['name'] },
    ends: { Team: { class: 'Team', required: true, onDelete: 'cascade' } } });
  await e.defineClass(t, { name: 'duty', kind: 'link',
    fields: { properties: { day: { type: 'string' } }, required: ['day'] },
    ends: { Member: { class: 'Member', required: true, onDelete: 'cascade' }, Backup: { class: 'Member', onDelete: 'unset' } } });
  await e.defineClass(t, { name: 'Wallet', kind: 'hub', key: ['number'],
    fields: { properties: { number: { type: 'string' }, balance: { type: 'integer', minimum: 0, default: 0 },
      stats: { type: 'object', additionalProperties: { type: 'integer' } } }, required: ['number'] } });
  await e.defineClass(t, { name: 'Box', kind: 'hub',
    fields: { properties: { name: { type: 'string' } }, required: ['name'] },
    ends: { Items: { class: 'Element', many: true } } });
  await db.refresh();
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('4.1 create: пишет только терминал; концы — из пути; id класса с ключом — v5 от ключа', async () => {
  void db.Team().create({ name: 'Призрак' });
  assert.equal(await db.Team({ name: 'Призрак' }).count(), 0, 'цепочка без терминала не пишет');
  const [team] = await db.Team().create({ name: 'Альфа', city: 'Тверь' }).rows();
  assert.equal(team.id, db.idOf('Team', { name: 'Альфа' }));
  assert.equal(team.rev, 1);
  assert.equal(team.op, 'create');
  const [m] = await db.Team(team.id).Member().create({ name: 'Вася' }).rows();
  assert.deepEqual(m.links, { Team: team.id });
  assert.equal(m.data.level, 0, 'умолчание подставила база');
  // класс без ключа: id выдаёт база
  const [c] = await db.Org(s.org).Customer().create({ name: 'Гость', phone: '+7 999' }).rows();
  assert.match(c.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(c.links, { Org: s.org });
});

test('4.2 повтор create с тем же ключом — exists с id; Класс(id).create() сверяет id', async () => {
  const [w] = await db.Wallet().create({ number: 'W-dup' }).rows();
  await assert.rejects(db.Wallet().create({ number: 'W-dup' }).rows(), (err: { code?: string; detail?: { id?: string } }) => {
    assert.equal(err.code, 'exists');
    assert.equal(err.detail?.id, w.id);
    return true;
  });
  await assert.rejects(db.Wallet(w.id).create({ number: 'W-другой' }).rows(), code('id_mismatch'));
  await assert.rejects(db.Wallet().create({ number: 'W-x', лишнее: 1 } as never).rows(), code('invalid_data'));
});

test('4.1 несколько create в цепочке: продолжение от записанного, связь — от результата', async () => {
  const rows = await db.Org(s.org).Customer().create({ name: 'Боря-2', phone: '+7 900' })
    .booking().create({ start_datetime: at(4, 10), end_datetime: at(4, 11), notes: 'создана' })
    .Staff.set(s.vasya).Location.set(s.loc).Schedule.set(s.sch).Item.set(s.cut)
    .rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].class, 'booking');
  const borya = await db.Customer({ name: 'Боря-2' }).first();
  assert.equal(rows[0].links.Customer, borya!.id, 'связь от результата первого сегмента');
  assert.equal(rows[0].links.Staff, s.vasya);
});

test('4.1 self-update: глагол сразу после глагола пишет в те же сущности', async () => {
  const [b] = await db.Customer({ name: 'Боря-2' }).booking().update({ notes: 'подтверждена' }).update({ notes: 'завершена' }).rows();
  assert.equal(b.data.notes, 'завершена');
  const notes = (await db.booking(b.id).versions()).map((r) => r.data.notes);
  assert.deepEqual(notes, ['создана', 'подтверждена', 'завершена']);
});

test('4.1 fan-out: сегмент исполняется от каждой строки результата; удалённое — $deleted', async () => {
  await db.Team().tags(['сеть']).create({ name: 'Сеть-1' }).rows();
  await db.Team().tags(['сеть']).create({ name: 'Сеть-2' }).rows();
  const all = await db.Team().tags('сеть').update({ city: 'Москва' }).Member().create({ name: 'Дежурный' }).rows();
  assert.equal(all.length, 2);
  assert.deepEqual(new Set(all.map((r) => r.class)), new Set(['Member']));
  assert.equal(new Set(all.map((r) => r.links.Team)).size, 2, 'по участнику на каждую команду');
  const gone = await db.Team().tags('сеть').update({}).Member().delete({ confirm: true }).rows();
  assert.equal(gone.length, 2);
  assert.ok(gone.every((r) => r.$deleted === true && r.op === 'delete'));
});

test('4.5 превью удаления совпадает с удалённым: цель, каскад, снятие конца', async () => {
  const [team] = await db.Team().create({ name: 'Бета' }).rows();
  const [m1] = await db.Team(team.id).Member().create({ name: 'Первый' }).rows();
  const [m2] = await db.Team(team.id).Member().create({ name: 'Второй' }).rows();
  const [d1] = await db.Member(m1.id).duty().create({ day: 'пн' }).Backup.set(m2.id).rows();
  const [d2] = await db.Member(m2.id).duty().create({ day: 'вт' }).Backup.set(m1.id).rows();
  const preview = await db.Member(m1.id).delete().rows();
  const byId = new Map(preview.map((r) => [r.id, r.$action]));
  assert.equal(byId.get(m1.id), 'delete');
  assert.equal(byId.get(d1.id), 'delete', 'дежурство каскадом');
  assert.equal(byId.get(d2.id), 'unset', 'Backup снимается');
  assert.ok(preview.every((r) => r.$deleted === undefined), 'превью ничего не удаляет');
  assert.ok(await db.Member(m1.id).first());
  // чужой арендатор: превью (функция владельца без RLS) не раскрывает ни строк, ни классов
  const t2 = await e.tenant('write-other');
  const foreign = await e.as(t2.token, (tx) => tx.unsafe(`select * from ${e.S}.delete_preview(array[$1::uuid, $2::uuid])`, [m1.id, d1.id]));
  assert.equal(foreign.length, 0);
  const gone = await db.Member(m1.id).delete({ confirm: true }).rows();
  assert.deepEqual(gone.map((r) => r.id).sort(), [m1.id, d1.id].sort());
  const d2now = await db.duty(d2.id).first();
  assert.equal(d2now!.links.Backup, undefined);
  assert.equal(d2now!.rev, 2);
});

test('4.6 удаление связанных целей одним оператором: цель входит в каскад другой', async () => {
  const [team] = await db.Team().create({ name: 'Гамма' }).rows();
  await db.Team(team.id).Member().create({ name: 'А' }).rows();
  await db.Team(team.id).Member().create({ name: 'Б' }).rows();
  // команда и её участники одним delete: участников удалил бы и каскад
  const gone = await db.Team({ name: 'Гамма' }).Member().delete({ confirm: true }).rows();
  assert.equal(gone.length, 2);
  const gone2 = await db.Team({ name: 'Гамма' }).delete({ confirm: true }).rows();
  assert.equal(gone2.length, 1);
  assert.equal(await db.Team({ name: 'Гамма' }).count(), 0);
});

test('4.1 откат: ошибка любого сегмента откатывает весь план', async () => {
  const [team] = await db.Team().create({ name: 'Дельта', city: 'Тула' }).rows();
  await assert.rejects(
    db.Team(team.id).update({ city: 'Казань' }).Member().create({ name: 'X', level: -1 }).rows(),
    code('invalid_data'),
  );
  const after = await db.Team(team.id).first();
  assert.equal(after!.data.city, 'Тула');
  assert.equal((await db.Team(team.id).versions()).length, 1);
});

test('4.1 слоты: перевес конца при update; повтор слота и слот без глагола — ошибки', async () => {
  const [team] = await db.Team().create({ name: 'Эпсилон' }).rows();
  const [a] = await db.Team(team.id).Member().create({ name: 'А' }).rows();
  const [b] = await db.Team(team.id).Member().create({ name: 'Б' }).rows();
  const [d] = await db.Member(a.id).duty().create({ day: 'ср' }).rows();
  const [moved] = await db.duty(d.id).update({}).Backup.set(b.id).rows();
  assert.equal(moved.links.Backup, b.id);
  const [cleared] = await db.duty(d.id).update({}).Backup.unset().rows();
  assert.equal(cleared.links.Backup, undefined);
  // имя роли — сама роль; класс, который не принимает ни одна роль, — ошибка
  const [swapped] = await db.duty(d.id).update({}).Member.set(b.id).rows();
  assert.equal(swapped.links.Member, b.id);
  assert.throws(() => db.duty(d.id).update({}).Team.set(team.id), code('invalid_query'));
  assert.throws(() => db.duty(d.id).update({}).Backup.set(a.id).Backup.set(b.id), code('invalid_query'));
  assert.throws(() => db.duty(d.id).Backup.set(b.id), code('invalid_query'));
  assert.throws(() => db.duty(d.id).update({}).Member.unset(), code('invalid_query'));
});

test('4.1 слоты множественного конца: add и remove без чтения списка', async () => {
  const [box] = await db.Box().create({ name: 'Набор' }).Items.set([s.cut, s.wax]).rows();
  assert.deepEqual(box.links.Items, [s.cut, s.wax]);
  const [b2] = await db.Box(box.id).update({}).Items.add(s.color).Items.add(s.cut).rows();
  assert.deepEqual(b2.links.Items, [s.cut, s.wax, s.color], 'повтор в add не добавляется');
  const [b3] = await db.Box(box.id).update({}).Items.remove([s.wax, s.shave]).rows();
  assert.deepEqual(b3.links.Items, [s.cut, s.color]);
  assert.throws(() => db.Org(s.org).update({}).Parent.set(s.root), code('invalid_class'));
  assert.throws(() => db.duty().update({}).Backup.add('x'), code('invalid_query'));
});

test('4.1 хвост-чтение после глагола: та же транзакция, обычные терминалы', async () => {
  const n = await db.Customer({ name: 'Аня' }).update({ preferred_contact: 'messenger' }).booking().count();
  assert.equal(n, 2);
  const paths = await db.Customer({ name: 'Аня' }).update({ preferred_contact: 'phone' }).paths();
  assert.equal(paths.length, 1);
  assert.equal(paths[0].Customer.data.name, 'Аня');
  const hist = await db.Customer({ name: 'Аня' }).update({ phone: '+7 911 1' }).versions();
  assert.ok(hist.length >= 4);
  assert.deepEqual(await db.Customer({ name: 'Никто' }).update({ phone: '0' }).rows(), [], 'update никогда не создаёт');
});

test('4.7 правка на полиморфном шаге: каждая строка проверена и записана своим классом', async () => {
  const rows = await db.Org(s.org).Person().update({ phone: '+7 000' }).rows();
  assert.ok(rows.length >= 4);
  assert.deepEqual(new Set(rows.map((r) => r.class)), new Set(['Staff', 'Customer']));
  // поле потомка проходит только у своего класса
  await assert.rejects(db.Org(s.org).Person().update({ specialization: 'все' }).rows(), code('invalid_data'));
});

test('4.8 смена класса: без ключа id тот же; с ключом — новый id, ссылки переведены', async () => {
  const [c] = await db.Org(s.org).Customer().create({ name: 'Стажёр', phone: '+7 77' }).rows();
  // данные заменяются целиком: у мастера нет поля клиента preferred_contact
  await assert.rejects(db.Customer(c.id).reclass('Staff').rows(), code('invalid_data'));
  const [st] = await db.Customer(c.id).reclass('Staff', { name: 'Стажёр', phone: '+7 77' }).rows();
  assert.equal(st.id, c.id);
  assert.equal(st.class, 'Staff');
  const [svc] = await db.Org(s.org).Service().create({ name: 'Массаж', duration: 30 }).rows();
  const [pr] = await db.Org(s.org).Service(svc.id).price().create({ amounts: { RUB: 900 } }).rows();
  const [prod] = await db.Service(svc.id).reclass('Product', { name: 'Массаж' }).rows();
  assert.notEqual(prod.id, svc.id);
  assert.equal(prod.id, db.idOf('Product', { Org: s.org, name: 'Массаж' }));
  const price = await db.price(pr.id).first();
  assert.equal(price, null, 'цена с ключом [Item, note] переехала на новый id');
  assert.equal(await db.Product(prod.id).price().count(), 1);
});

test('4.17 приращение: маркер, а не данные; путь, старт, ошибки до отправки', async () => {
  const [w] = await db.Wallet().create({ number: 'W-inc', balance: 1000 }).rows();
  const [w2] = await db.Wallet(w.id).update({ balance: inc(-300) }).rows();
  assert.equal(w2.data.balance, 700);
  assert.equal(w2.rev, 2);
  await assert.rejects(db.Wallet(w.id).update({ balance: inc(-701) }).rows(), code('invalid_data'));
  // JSON-объект — это данные, а не команда
  await assert.rejects(db.Wallet(w.id).update(JSON.parse('{"balance": {"$inc": 5}}')).rows(), code('invalid_data'));
  // счётчик, которого ещё нет: без start — ошибка, со start — от него
  await assert.rejects(db.Wallet(w.id).update({ stats: { hits: inc(1) } }).rows(), code('invalid_data'), 'промежуточного объекта нет');
  await db.Wallet(w.id).update({ stats: {} }).rows();
  await assert.rejects(db.Wallet(w.id).update({ stats: { hits: inc(1) } }).rows(), code('invalid_data'));
  const [w3] = await db.Wallet(w.id).update({ stats: { hits: inc(1, { start: 0 }) }, balance: inc(5) }).rows();
  assert.deepEqual(w3.data.stats, { hits: 1 });
  assert.equal(w3.data.balance, 705);
  // до отправки: маркер в create, upsert и в массиве, не число, оператор фильтра в патче
  await assert.rejects(db.Wallet().create({ number: 'W-m', balance: inc(1) as never }).rows(), code('invalid_data'));
  await assert.rejects(db.Wallet().upsert({ number: 'W-m', balance: inc(1) as never }).rows(), code('invalid_data'));
  await assert.rejects(db.Wallet(w.id).update({ tags: [inc(1)] }).rows(), code('invalid_data'));
  await assert.rejects(db.Wallet(w.id).update({ balance: inc(Number.NaN) }).rows(), code('invalid_data'));
  await assert.rejects(db.Wallet(w.id).update({ balance: inc(Infinity) }).rows(), code('invalid_data'));
  const { gt } = await import('../src/index.js');
  await assert.rejects(db.Wallet(w.id).update({ balance: gt(1) as never }).rows(), code('invalid_data'));
  // параллельные приращения не теряются
  await Promise.all(Array.from({ length: 10 }, () => db.Wallet(w.id).update({ balance: inc(10) }).rows()));
  assert.equal((await db.Wallet(w.id).first())!.data.balance, 805);
});

test('4.19 строгий режим { rev }: conflict, нет цели, несколько целей', async () => {
  const [w] = await db.Wallet().create({ number: 'W-rev', balance: 100 }).rows();
  const [w2] = await db.Wallet(w.id).update({ balance: 90 }, { rev: 1 }).rows();
  assert.equal(w2.rev, 2);
  await assert.rejects(db.Wallet(w.id).update({ balance: 80 }, { rev: 1 }).rows(), (err: { code?: string; detail?: { rev?: number } }) => {
    assert.equal(err.code, 'conflict');
    assert.equal(err.detail?.rev, 2);
    return true;
  });
  assert.equal((await db.Wallet(w.id).first())!.data.balance, 90);
  await assert.rejects(db.Wallet({ number: 'нет' }).update({ balance: 1 }, { rev: 1 }).rows(), code('target_not_found'));
  await assert.rejects(db.Wallet().update({ balance: 1 }, { rev: 1 }).rows(), code('rev_ambiguous'));
  const [gone] = await db.Wallet().create({ number: 'W-gone' }).rows();
  await db.Wallet(gone.id).delete({ confirm: true }).rows();
  await assert.rejects(db.Wallet(gone.id).update({ balance: 1 }, { rev: 1 }).rows(), code('target_not_found'));
});

test('4.13 upsert: created, updated, unchanged; класс без ключа — no_key без запроса', async () => {
  const [a] = await db.Team().upsert({ name: 'Омега', city: 'Омск' }).rows();
  assert.equal((a as Row & { $upsert?: string }).$upsert, 'created');
  const [b] = await db.Team().upsert({ name: 'Омега', city: 'Томск' }).rows();
  assert.equal((b as Row & { $upsert?: string }).$upsert, 'updated');
  assert.equal(b.id, a.id);
  assert.equal(b.rev, 2);
  const [c] = await db.Team().upsert({ name: 'Омега', city: 'Томск' }).rows();
  assert.equal((c as Row & { $upsert?: string }).$upsert, 'unchanged');
  assert.equal(c.rev, 2);
  // замена целиком: поле, которого нет в объекте, пропадает
  const [d] = await db.Team().upsert({ name: 'Омега' }).rows();
  assert.equal(d.data.city, undefined);
  await assert.rejects(db.Org(s.org).Customer().upsert({ name: 'X', phone: '1' }).rows(), code('no_key'));
});

test('4.1 anonymize: строковые поля затираются, тег anonymized, история сохраняется', async () => {
  const [c] = await db.Org(s.org).Customer().create({ name: 'Иван', phone: '+7 123', notes: 'VIP' }).rows();
  const [a] = await db.Customer(c.id).anonymize(['name', 'notes']).rows();
  assert.equal(a.data.name, '[erased]');
  assert.equal(a.data.notes, '[erased]');
  assert.equal(a.data.phone, '+7 123');
  assert.ok(a.tags.includes('anonymized'));
  assert.equal((await db.Customer(c.id).versions()).length, 2);
  await assert.rejects(db.Org(s.org).anonymize(['active']).rows(), code('invalid_query'));
});

test('цели записи сужаются limit и sort; data.id — цель без фильтра шага', async () => {
  const [team] = await db.Team().create({ name: 'Сигма' }).rows();
  for (const n of ['a', 'b', 'c']) await db.Team(team.id).Member().create({ name: n, level: n.charCodeAt(0) - 96 }).rows();
  const top = await db.Team(team.id).Member().sort('data.level', 'desc').limit(1).update({ level: 10 }).rows();
  assert.equal(top.length, 1);
  assert.equal(top[0].data.name, 'c');
  // ключевое поле обычной правкой не изменить
  await assert.rejects(db.Team(team.id).Member({ name: 'a' }).update({ name: 'лидер' }).rows(), code('immutable_key'));
  const [m] = await db.Team(team.id).Member({ name: 'a' }).rows();
  const [u] = await db.Member().update({ id: m.id, level: 9 }).rows();
  assert.equal(u.id, m.id);
  assert.equal(u.data.level, 9);
  assert.equal(u.data.id, undefined);
});

test('ошибки построения записи: create с фильтром, create после глагола, модификатор шага после глагола', async () => {
  await assert.rejects(db.Team({ name: 'x' }).create({ name: 'y' }).rows(), code('invalid_query'));
  await assert.rejects(db.Team().create({ name: 'y' }).create({ name: 'z' }).rows(), code('invalid_query'));
  await assert.rejects(db.Team().asOf('2026-01-01').update({}).rows(), code('invalid_query'));
  assert.throws(() => db.Team().update({}).exact(), code('invalid_query'));
  assert.throws(() => db.entity(db.Team().update({})), code('invalid_query'));
});

test('idOf из библиотеки совпадает с id созданного объекта класса с ключом', async () => {
  const [m] = await db.Team({ name: 'Альфа' }).Member().create({ name: 'Петя' }).rows();
  assert.equal(m.id, idOf({ name: 'Member', key: ['Team', 'name'], ends: ['Team'] }, { Team: m.links.Team as string, name: 'Петя' }, { tenant: db.tenant! }));
});
