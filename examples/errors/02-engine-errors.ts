import { fromDbError } from 'letopis';
import { example } from '../_shared/example.ts';
import { inviteAndAccept } from '../_shared/postman.ts';
import { seedShop, shopModels, type ShopData } from '../_shared/shop.ts';

let d: ShopData;
const T = (schema: string) => `"${schema}".entity`;
/** Код отказа — или «прошло». */
const why = (p: Promise<unknown>) => p.then(() => 'прошло', (e) => e.code);

export default example({
  title: 'Ошибки базы: целостность, квартиры и права',
  summary:
    'Целостность данных, прописку и права проверяет сама база — одинаково для библиотеки и для прямых SQL-запросов. ' +
    'Здесь запись идёт и прямым SQL в сессии жильца (me.transaction), и обычными вызовами — база отвечает теми же ' +
    'кодами.',
  models: shopModels,
  tables: [],
  covers: [
    'error.undeclared_end', 'error.id_from_db', 'error.immutable_key', 'error.recreated_in_statement', 'error.isolation_level',
    'error.exists', 'error.last_owner', 'error.acl_ambiguous', 'db.leave', 'nuance.engine-checks-raw-sql', 'export.fromDbError',
  ],
  steps: [
    {
      title: 'undeclared_end — конец с ролью, которой нет в классе',
      text: 'Концы класса описаны в модели; чужую роль база не примет. Что делать: описать конец в модели или убрать его из данных.',
      run: async ({ me, schema }) => {
        d = await seedShop(me);
        return me.transaction((tx) => tx.unsafe(`insert into ${T(schema)} (class, data, links) values ('Customer', '{"name":"Х","email":"x@x.ru"}', jsonb_build_object('Stranger', $1::text))`, [d.romashka]));
      },
      expect: { error: 'undeclared_end' },
    },
    {
      title: 'id_from_db — свой id у класса без ключа',
      text: 'У класса без ключа id выдаёт база (UUID v7). Что делать: не передавать id; постоянный id из внешнего ключа — `$ext` при загрузке.',
      run: async ({ me, schema }) => me.transaction((tx) => tx.unsafe(`insert into ${T(schema)} (id, class, data) values (gen_random_uuid(), 'Customer', '{"name":"Х","email":"x@x.ru"}')`)),
      expect: { error: 'id_from_db' },
    },
    {
      title: 'immutable_key — сменить класс простым UPDATE',
      text: 'Класс, ключ, id, квартира и владелец строки неизменны — и для своего SQL. Что делать: объект другого класса — новый объект: создать его, перевести на него концы других строк, удалить прежний.',
      run: async ({ me, schema }) => me.transaction((tx) => tx.unsafe(`update ${T(schema)} set class = 'Category' where id = $1`, [d.romashka])),
      expect: { error: 'immutable_key' },
    },
    {
      title: 'recreated_in_statement — удалить и создать тот же id одним оператором',
      text: 'Журнал не может записать удаление и повторное создание одного id в одном операторе. Что делать: двумя операторами — или `upsert`.',
      run: async ({ me, schema }) => me.transaction((tx) => tx.unsafe(
        `with gone as (delete from ${T(schema)} where id = $1 returning id) insert into ${T(schema)} (class, data) select 'Shop', '{"name":"Ромашка"}' from gone`, [d.romashka])),
      expect: { error: 'recreated_in_statement' },
    },
    {
      title: 'isolation_level — удаление в транзакции REPEATABLE READ',
      text:
        'Удаление с каскадом требует READ COMMITTED (так работает библиотека). Здесь SQL мастер-ключом открывает ' +
        'транзакцию REPEATABLE READ с токеном сессии Анны; ошибку драйвера в `LetopisError` переводит `fromDbError`. ' +
        'Что делать: не менять уровень изоляции для удаления.',
      run: async ({ me, admin, schema }) => {
        try {
          return await admin.begin('isolation level repeatable read', async (tx) => {
            await tx`select set_config('letopis.token', ${me.token!}, true)`;
            return tx.unsafe(`delete from ${T(schema)} where id = $1`, [d.mug]);
          });
        } catch (e) { throw fromDbError(e); }
      },
      expect: { error: 'isolation_level' },
    },
    {
      title: 'exists и last_owner — квартира и её хозяин',
      text:
        'Имя квартиры уникально в доме: второй `createTenant(\'Ромашка\')` — `exists`. Анна — единственный owner ' +
        '«Ромашки»: выписаться (`leave()`) она не может — квартира осталась бы без хозяина, `last_owner`. Что делать: ' +
        'другое имя квартиры; сначала дать роль `owner` другому жильцу, потом выписываться.',
      run: async ({ db, me }) => ({
        'вторая «Ромашка»': await why(db.createTenant('Ромашка')),
        'последний owner выписывается': await why(me.leave()),
      }),
    },
    {
      title: 'acl_ambiguous — правила с равным счётом спорят',
      text:
        'Анна зовёт Олега с ролью `staff` и пишет два правила: запрет читать заказы (счёт 1 + 1 + 0 + 1 + 50 = 53) и ' +
        'разрешение читать оплаченные (1 + 1 + 1 + 0 + 50 = 53). Для оплаченного заказа подходят оба, счёт равный, одно ' +
        'разрешает, другое запрещает — база не выбирает наугад: такую строку не видно, а остальные строки читаются как ' +
        'обычно. Ошибку отдаёт проверка прав — `acl.checkData` отвечает `acl_ambiguous`, в тексте id обоих правил. Что ' +
        'делать: развести счёт весом — у разрешения 51 оно сильнее, оплаченные видны, остальные нет.',
      run: async ({ db, me }) => {
        const oleg = await inviteAndAccept(db, me, { email: 'oleg@romashka.ru' }, ['staff'], { password: 'Олег-2026!', name: 'Олег' });
        await me.acl.deny({ role: 'staff', read: 'Order' });
        await me.acl.grant({ role: 'staff', read: { class: 'Order', data: { status: 'paid' } } });
        const tie = { 'Олег видит заказов': (await oleg.Order().rows()).length, 'acl.checkData': await why(oleg.acl.checkData('Order', 'READ')) };
        await me.acl.grant({ role: 'staff', read: { class: 'Order', data: { status: 'paid' } }, weight: 51 });
        return { 'ничья': tie, 'разрешение с весом 51': (await oleg.Order().sort('data.number').rows()).map((o) => `${o.data.number} ${o.data.status}`) };
      },
    },
  ],
});
