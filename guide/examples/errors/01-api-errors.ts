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
    'error.user_session_required', 'error.tx_rolled_back'],
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
      text: 'У класса с ключом id вычисляется из ключа: создать по id одного товара строку с другим ключом нельзя. Что делать: не передавать id, его даст ключ.',
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
      title: 'lock_unsupported — forUpdate с агрегатом',
      text: '`forUpdate()` блокирует строки, а `count()` строк не отдаёт. Что делать: заблокировать `rows()`, потом считать.',
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
      title: 'tx_rolled_back — ошибку внутри транзакции проглотили',
      text: 'PostgreSQL откатывает транзакцию после любой ошибки в ней, даже пойманной. `commit()` честно сообщает: зафиксировать нечего. Что делать: не глотать ошибки внутри `db.begin()` — или откатывать сразу.',
      run: async ({ db }) => {
        const tr = await db.begin();
        await tr.transaction(async (q) => { await q.unsafe('select 1/0').catch(() => {}); });
        return tr.commit();
      },
      expect: { error: 'tx_rolled_back' },
    },
  ],
});
