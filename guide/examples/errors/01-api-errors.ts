import { connect } from 'letopis';
import { createMcpServer } from 'letopis/mcp';
import { example } from '../../kit/example.ts';
import { seedShop, type ShopData } from '../../kit/shop.ts';

let d: ShopData;

export default example({
  title: 'Ошибки цепочек и подключения: что значит код и что делать',
  summary:
    'Ошибка letopis — LetopisError с кодом: по коду и решают, что делать. Здесь — те, что приходят от цепочек, ' +
    'транзакций и подключения.',
  tables: [],
  covers: ['error.target_not_found', 'error.id_mismatch', 'error.no_path', 'error.lock_unsupported', 'error.no_session',
    'error.user_session_required', 'error.tx_rolled_back', 'error.invalid_query', 'nuance.bad-uuid-letopis-error', 'nuance.begin-options-only'],
  steps: [
    {
      title: 'target_not_found — правка того, чего нет',
      text: 'Объекта с таким ключом нет (или он удалён). Что делать: проверить ключ; создать — `create` или `upsert`.',
      run: async ({ db }) => {
        d = await seedShop(db);
        return db.Shop({ name: 'Нет такого' }).update({ city: 'Тверь' }, { rev: 1 }).rows();
      },
      expect: { error: 'target_not_found' },
    },
    {
      title: 'id_mismatch — id не сходится с ключом',
      text: 'У класса с ключом id вычисляется из ключа: создать по id одного магазина строку с другим ключом нельзя. Что делать: не передавать id — он вычислится из ключа.',
      run: async ({ db }) => db.Shop(d.romashka).create({ name: 'Другое имя' }).rows(),
      expect: { error: 'id_mismatch' },
    },
    {
      title: 'no_path — между классами нет связи',
      text: 'Шаг цепочки ищет конец между соседними классами. Что делать: идти через класс, который связан с обоими.',
      run: async ({ db }) => db.Category().Customer().rows(),
      expect: { error: 'no_path' },
    },
    {
      title: 'lock_unsupported — forUpdate с count()',
      text:
        '`forUpdate()` блокирует строки, а `count()` строк не отдаёт. Текст называет, что именно нельзя: терминал, `asOf()`, ' +
        '`withDeleted()`, `deep()` или глагол. Что делать: заблокировать `rows()`, `first()` или `ids()`, потом считать.',
      run: async ({ db }) => {
        const tr = await db.begin();
        try { return await tr.Product().forUpdate().count(); } finally { await tr.rollback(); }
      },
      expect: { error: 'lock_unsupported' },
    },
    {
      title: 'no_session — неверный ключ API',
      text: 'Сессии нет: ключ неверный или отозван, срок вышел. Что делать: войти заново, выпустить новый ключ.',
      run: async ({ dsn, schema }) => connect({ dsn: dsn.app, schema, apiKey: 'lts_' + '0'.repeat(48) }),
      expect: { error: 'no_session' },
    },
    {
      title: 'user_session_required — MCP от имени сервиса',
      text: 'Инструменты MCP работают только с правами пользователя. Что делать: `createMcpServer(await svc.as(пользователь))`.',
      run: async ({ svc }) => createMcpServer(svc),
      expect: { error: 'user_session_required' },
    },
    {
      title: 'tx_rolled_back — ошибку внутри транзакции поймали и проигнорировали',
      text: 'PostgreSQL откатывает транзакцию после любой ошибки в ней, даже пойманной. `commit()` честно сообщает: зафиксировать нечего. Что делать: не подавлять ошибки внутри `db.begin()` — или сразу откатывать транзакцию.',
      run: async ({ db }) => {
        const tr = await db.begin();
        await tr.transaction(async (q) => { await q.unsafe('select 1/0').catch(() => {}); });
        return tr.commit();
      },
      expect: { error: 'tx_rolled_back' },
    },
    {
      title: 'invalid_query — id шага не uuid',
      text:
        'id шага, список id и `{ id }` в фильтре проверяются до запроса: не uuid (и `null`) — отказ `invalid_query` с ' +
        'ключом `query.bad_uuid` и подсказкой. Что делать: брать id из ответа (`row.id`) или `db.idOf(…)`, проверить ' +
        'переменную — `undefined` и `null` не id.',
      run: async ({ db }) => db.Product('42').rows(),
      expect: { error: 'invalid_query' },
    },
    {
      title: 'invalid_query — значение не того типа в сыром SQL',
      text:
        'Значение не того типа, которое не поймала проверка до запроса (SQLSTATE `22P02`), тоже приходит как ' +
        '`LetopisError`: код `invalid_query`, ключ `api.db_bad_value`, исходная ошибка драйвера — в `err.cause`.',
      run: async ({ db }) =>
        db.sql`select ${'42'}::uuid as id`.then(() => 'прошло', (e) => ({ code: e.code, key: e.key, message: e.message, 'cause.code': e.cause?.code })),
    },
    {
      title: 'invalid_query — забыли .rows()',
      text:
        'Цепочка — не массив: `length`, `map`, `filter`, `forEach` и другие свойства массива у неё — отказ `invalid_query` ' +
        '(ключ `api.chain_not_rows`), а не поиск класса с таким именем. Что делать: `await ….rows()` или `await ….first()`.',
      run: async ({ db }) => (db.Product() as unknown as unknown[]).length,
      expect: { error: 'invalid_query' },
    },
    {
      title: 'invalid_query — db.begin(функция)',
      text:
        '`db.begin()` принимает только опции `{ reason }`: функцию он не вызывает. Отказ `invalid_query` (ключ ' +
        '`api.begin_arg`), транзакция не открыта. Что делать: `const tr = await db.begin(); try { …; await tr.commit() } ' +
        'catch (e) { await tr.rollback(); throw e }`.',
      run: async ({ db }) => (db as unknown as { begin(f: unknown): Promise<unknown> }).begin(async () => 'тело транзакции'),
      expect: { error: 'invalid_query' },
    },
  ],
});

