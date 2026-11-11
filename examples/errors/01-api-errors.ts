import { setup, demolish } from 'letopis';
import { createMcpServer } from 'letopis/mcp';
import { example } from '../_shared/example.ts';
import { seedShop, shopModels, type ShopData } from '../_shared/shop.ts';

let d: ShopData;
/** Код и ключ каталога отказа — или «прошло». */
const why = (p: Promise<unknown>) => p.then(() => 'прошло', (e) => `${e.code} (${e.key})`);

export default example({
  title: 'Ошибки цепочек, транзакций и входа: что значит код и что делать',
  summary:
    'Ошибка letopis — LetopisError с кодом: по коду и решают, что делать, а ключ каталога (err.key) точно называет ' +
    'место. Здесь — то, что приходит от цепочек, транзакций, входа по ключу и пропуска.',
  models: shopModels,
  tables: [],
  covers: [
    'error.target_not_found', 'error.id_mismatch', 'error.no_path', 'error.lock_unsupported', 'error.tx_rolled_back',
    'error.invalid_query', 'error.auth_failed', 'error.invalid_data', 'error.user_session_required', 'house.resume',
    'house.accept', 'nuance.bad-uuid-letopis-error', 'nuance.begin-options-only',
  ],
  steps: [
    {
      title: 'target_not_found — правка того, чего нет',
      text: 'Объекта с таким ключом нет (или он удалён). Что делать: проверить ключ; создать — `create` или `upsert`.',
      run: async ({ me }) => {
        d = await seedShop(me);
        return me.Shop({ name: 'Нет такого' }).update({ city: 'Тверь' }, { rev: 1 }).rows();
      },
      expect: { error: 'target_not_found' },
    },
    {
      title: 'id_mismatch — id не сходится с ключом',
      text: 'У класса с ключом id вычисляется из ключа: создать по id одного магазина строку с другим ключом нельзя. Что делать: не передавать id — он вычислится из ключа.',
      run: async ({ me }) => me.Shop(d.romashka).create({ name: 'Другое имя' }).rows(),
      expect: { error: 'id_mismatch' },
    },
    {
      title: 'no_path — между классами нет связи',
      text: 'Шаг цепочки ищет конец между соседними классами. Что делать: идти через класс, который связан с обоими.',
      run: async ({ me }) => me.Category().Customer().rows(),
      expect: { error: 'no_path' },
    },
    {
      title: 'lock_unsupported — forUpdate с count()',
      text:
        '`forUpdate()` блокирует строки, а `count()` строк не отдаёт. Текст называет, что именно нельзя: терминал, `asOf()`, ' +
        '`withDeleted()`, `deep()` или глагол. Что делать: заблокировать `rows()`, `first()` или `ids()`, потом считать.',
      run: async ({ me }) => {
        const tr = await me.begin();
        try { return await tr.Product().forUpdate().count(); } finally { await tr.rollback(); }
      },
      expect: { error: 'lock_unsupported' },
    },
    {
      title: 'tx_rolled_back — ошибку внутри транзакции поймали и проигнорировали',
      text: 'PostgreSQL откатывает транзакцию после любой ошибки в ней, даже пойманной. `commit()` честно сообщает: зафиксировать нечего. Что делать: не подавлять ошибки внутри `begin()` — или сразу откатывать транзакцию.',
      run: async ({ me }) => {
        const tr = await me.begin();
        await tr.transaction(async (q) => { await q.unsafe('select 1/0').catch(() => {}); });
        return tr.commit();
      },
      expect: { error: 'tx_rolled_back' },
    },
    {
      title: 'invalid_query — id шага не uuid',
      text:
        'id шага, список id и `{ id }` в фильтре проверяются до запроса: не uuid (и `null`) — отказ `invalid_query` с ' +
        'ключом `query.bad_uuid` и подсказкой. Что делать: брать id из ответа (`row.id`) или `me.idOf(…)`, проверить ' +
        'переменную — `undefined` и `null` не id.',
      run: async ({ me }) => me.Product('42').rows(),
      expect: { error: 'invalid_query' },
    },
    {
      title: 'invalid_query — значение не того типа в своём SQL',
      text:
        'Значение не того типа, которое не поймала проверка до запроса (SQLSTATE `22P02`), тоже приходит как ' +
        '`LetopisError`: код `invalid_query`, ключ `api.db_bad_value`, исходная ошибка драйвера — в `err.cause`.',
      run: async ({ me }) =>
        me.sql`select ${'42'}::uuid as id`.then(() => 'прошло', (e) => ({ code: e.code, key: e.key, message: e.message, 'cause.code': e.cause?.code })),
    },
    {
      title: 'invalid_query — забыли .rows()',
      text:
        'Цепочка — не массив: `length`, `map`, `filter`, `forEach` и другие свойства массива у неё — отказ `invalid_query` ' +
        '(ключ `api.chain_not_rows`), а не поиск класса с таким именем. Что делать: `await ….rows()` или `await ….first()`.',
      run: async ({ me }) => (me.Product() as unknown as unknown[]).length,
      expect: { error: 'invalid_query' },
    },
    {
      title: 'invalid_query — begin(функция) и свойства корня у транзакции',
      text:
        '`begin()` принимает только опции `{ reason }`: функцию он не вызывает — отказ `api.begin_arg`, транзакция не ' +
        'открыта. Что делать: `const tr = await me.begin(); try { …; await tr.commit() } catch (e) { await ' +
        'tr.rollback(); throw e }`. У транзакции — цепочки и SQL, а приглашения, ключи и выход — только у корня квартиры ' +
        '(`api.room_only`).',
      run: async ({ me }) => {
        const tr = await me.begin();
        const invite = await why((async () => (tr as unknown as typeof me).invite({ email: 'oleg@romashka.ru' }, ['staff']))());
        await tr.rollback();
        return {
          'begin(функция)': await why((me as unknown as { begin(f: unknown): Promise<unknown> }).begin(async () => 'тело транзакции')),
          'tr.invite()': invite,
        };
      },
    },
    {
      title: 'auth_failed и invalid_data — ключ не подошёл',
      text:
        'Неверный пароль и неизвестный контакт — один ответ: `auth_failed` «ключ не подошёл», без подробностей — по ' +
        'ответу не узнать, есть ли такой аккаунт. Чужой или погашенный токен сессии — тоже `auth_failed`, с ключом ' +
        '`api.session_closed`. Что делать: попросить войти заново. ' +
        'Неизвестная ссылка приглашения — тоже `auth_failed`, со своим ключом `api.invite_unknown`: попросить новое ' +
        'приглашение. Ключ не той формы — `invalid_data` (`api.key_form`): это ошибка в коде.',
      run: async ({ db, annaKey }) => ({
        'неверный пароль': await why(db.open({ ...annaKey, password: 'не тот' })),
        'неизвестный контакт': await why(db.open({ email: 'nobody@romashka.ru', password: 'не тот' })),
        'чужой токен': await why(db.resume('lts_' + '0'.repeat(64))),
        'неизвестная ссылка приглашения': await why(db.accept('0'.repeat(48))),
        'ключ не той формы': await why(db.open({ login: annaKey.email, password: annaKey.password } as never)),
      }),
    },
    {
      title: 'Пропуск: не пропуск и устаревший',
      text:
        '`connect()` принимает только пропуск из `setup()`: строка подключения без дома и ключа консьержа — `invalid_data` ' +
        '(`boot.pass_invalid`). Пропуск снесённого дома или после `setup({ rotate: true })` — `auth_failed` ' +
        '(`boot.pass_stale`). Что делать: взять нынешний пропуск — его отдаёт повторный `setup()`.',
      run: async ({ ADMIN_DSN, name, connect }) => {
        const old = await setup(ADMIN_DSN, `${name}_old`, { quiet: true });
        await demolish(ADMIN_DSN, `${name}_old`, { quiet: true });
        return {
          'строка без дома и ключа': await why(connect('postgres://postgres@localhost:5432/letopis')),
          'пропуск снесённого дома': await why(connect(old.pass)),
        };
      },
    },
    {
      title: 'user_session_required — MCP у консьержа',
      text: 'Инструменты MCP работают только с правами жильца. Что делать: открыть квартиру ключом жильца — `db.open(ключ)` — и передать этот корень: `createMcpServer(me)`.',
      run: async ({ db }) => createMcpServer(await db.in('Ромашка')),
      expect: { error: 'user_session_required' },
    },
  ],
});
