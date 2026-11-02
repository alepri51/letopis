import { fromDbError } from 'letopis';
import { example } from '../../kit/example.ts';
import { seedShop, type ShopData } from '../../kit/shop.ts';

let d: ShopData;
const T = (schema: string) => `"${schema}".entity`;

export default example({
  title: 'Ошибки базы: что ловят триггеры при записи в обход библиотеки',
  summary:
    'Целостность данных проверяет сама база — одинаково для библиотеки и для прямых SQL-запросов. Здесь запись идёт ' +
    'прямым SQL в сессии пользователя (db.transaction) — и база отвечает теми же кодами, что и цепочкам.',
  tables: [],
  covers: ['error.undeclared_end', 'error.id_from_db', 'error.use_reclass', 'error.recreated_in_statement', 'error.isolation_level',
    'nuance.engine-checks-raw-sql', 'export.fromDbError'],
  steps: [
    {
      title: 'undeclared_end — конец с ролью, которой нет в классе',
      text: 'Концы класса описаны в модели; чужую роль база не примет. Что делать: описать конец в модели или убрать его из данных.',
      run: async ({ db, schema }) => {
        d = await seedShop(db);
        return db.transaction((tx) => tx.unsafe(`insert into ${T(schema)} (class, data, links) values ('Customer', '{"name":"Х","email":"x@x.ru"}', jsonb_build_object('Stranger', $1::text))`, [d.romashka]));
      },
      expect: { error: 'undeclared_end' },
    },
    {
      title: 'id_from_db — свой id у класса без ключа',
      text: 'У класса без ключа id выдаёт база (UUID v7). Что делать: не передавать id; постоянный id из внешнего идентификатора — `$ext` при загрузке.',
      run: async ({ db, schema }) => db.transaction((tx) => tx.unsafe(`insert into ${T(schema)} (id, class, data) values (gen_random_uuid(), 'Customer', '{"name":"Х","email":"x@x.ru"}')`)),
      expect: { error: 'id_from_db' },
    },
    {
      title: 'use_reclass — сменить класс простым UPDATE',
      text: 'Смена класса меняет id и концы других строк — её делает функция `reclass`. Что делать: `db.Класс(id).reclass(\'Другой\', данные)`.',
      run: async ({ db, schema }) => db.transaction((tx) => tx.unsafe(`update ${T(schema)} set class = 'Category' where id = $1`, [d.romashka])),
      expect: { error: 'use_reclass' },
    },
    {
      title: 'recreated_in_statement — удалить и создать тот же id одним оператором',
      text: 'Журнал не может записать удаление и повторное создание одного id в одном операторе. Что делать: двумя операторами — или `upsert`.',
      run: async ({ db, schema }) => db.transaction((tx) => tx.unsafe(
        `with gone as (delete from ${T(schema)} where id = $1 returning id) insert into ${T(schema)} (class, data) select 'Shop', '{"name":"Ромашка"}' from gone`, [d.romashka])),
      expect: { error: 'recreated_in_statement' },
    },
    {
      title: 'isolation_level — удаление в транзакции REPEATABLE READ',
      text: 'Каскады, смена класса и ключа требуют READ COMMITTED (так работает библиотека). Что делать: не менять уровень изоляции для таких операций.',
      run: async ({ admin, schema, up }) => {
        try {
          return await admin.begin('isolation level repeatable read', async (tx) => {
            await tx`select set_config('letopis.token', ${up.tenant!.token!}, true)`;
            return tx.unsafe(`delete from ${T(schema)} where id = $1`, [d.mug]);
          });
        } catch (e) { throw fromDbError(e); }
      },
      expect: { error: 'isolation_level' },
    },
  ],
});
