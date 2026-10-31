import { createTenant } from 'letopis';
import type { Db } from 'letopis';
import { example } from '../../kit/example.ts';
import { seedShop, type ShopData } from '../../kit/shop.ts';

let d: ShopData, oleg: string, asOleg: Db;

export default example({
  title: 'Права: роль сотрудника, запрет удаления, право на отчёты',
  summary:
    'Права в letopis всегда включены и по умолчанию запрещают всё. Правило — связь «кто» (ресурс-группа) и «что» ' +
    '(ресурс-объект) с разрешением и весом. Проверяет их сама база — одинаково для библиотеки и для прямых SQL-запросов.',
  tables: ['entity'],
  classes: ['member', 'Resource', 'rule'],
  covers: ['db.acl', 'nuance.deny-by-default', 'nuance.rule-weight', 'nuance.tenant-classes', 'error.acl_denied', 'error.invalid_class'],
  steps: [
    {
      title: 'Магазин и второй сотрудник — Олег',
      text: '`createTenant` с именем того же магазина заводит только пользователя. Ему дают роль `staff` в членстве.',
      run: async ({ db, admin, schema, up }) => {
        d = await seedShop(db);
        oleg = (await createTenant(admin, schema, { name: 'Ромашка', user: { name: 'Олег', login: 'oleg@romashka.ru', password: 'Олег-2026!' } })).user!;
        return db.member(await db.idOf('member', { User: oleg, Tenant: up.tenant!.tenant })).update({ roles: ['staff'] }).rows();
      },
    },
    {
      title: 'Правило: сотрудникам нельзя удалять товары',
      text:
        'Ресурс-группа «роль staff», ресурс-объект «удаление товаров» и запрет с весом 50 — сильнее правила «своим можно всё» (вес 10). ' +
        'Второе правило разрешает той же роли отчёты — эндпоинты `shop.reports.*`.',
      run: async ({ db }) => {
        const [staff] = await db.Resource().create({ alias: 'staff:ACCOUNT', category: 'ACCOUNT', pattern: { roles: '{staff}' } }).rows();
        const [delProduct] = await db.Resource().create({ alias: 'product:DELETE', category: 'DELETE', pattern: { class: 'Product' } }).rows();
        await db.rule().create({ permission: 'deny', weight: 50 }).Group.set(staff).Object.set(delProduct).rows();
        const [reports] = await db.Resource().create({ alias: 'reports:API', category: 'API', pattern: { endpoint: 'shop.reports.*' } }).rows();
        return db.rule().create({ permission: 'allow', weight: 50 }).Group.set(staff).Object.set(reports).rows();
      },
    },
    {
      title: 'Что Олегу можно',
      text: '`acl.checkData` — право на строки класса, `acl.check` — на эндпоинт приложения (отчёты). Интерфейс по ним прячет кнопки.',
      run: async ({ svc, up }) => {
        asOleg = await svc.as(oleg, { tenant: up.tenant!.tenant });
        return {
          'читать товары': (await asOleg.acl.checkData('Product', 'READ')).allow,
          'удалять товары': (await asOleg.acl.checkData('Product', 'DELETE')).allow,
          'отчёты shop.reports.daily': (await asOleg.acl.check('shop.reports.daily')).allow,
        };
      },
    },
    {
      title: 'Олег пробует удалить товар — отказ базы',
      text: 'Запрет проверяет база, а не интерфейс: даже прямой вызов удаления получает `acl_denied`, ничего не удалено.',
      run: async () => asOleg.Product(d.mug).delete({ confirm: true }).rows(),
      expect: { error: 'acl_denied' },
    },
    {
      title: 'Чужой арендатор не видит даже класса',
      text:
        'Пользователь другого магазина («Лютик») обращается к товарам — и получает `invalid_class`: классы, записанные ' +
        '`syncModels`, принадлежат арендатору «Ромашка». Изоляция двойная: чужие классы не видны, а чужие строки ' +
        'отсекают политики доступа. Общие для всех классы лежат в System (их ставит сид установки).',
      run: async ({ svc, admin, schema }) => {
        const boris = await createTenant(admin, schema, { name: 'Лютик', user: { name: 'Борис', login: 'boris@lutik.ru', password: 'Лютик-2026!' } });
        const asBoris = await svc.as(boris.user!, { tenant: boris.tenant });
        return asBoris.Product().count();
      },
      expect: { error: 'invalid_class' },
    },
  ],
});
