import { createTenant } from 'letopis';
import type { Db } from 'letopis';
import { example } from '../_shared/example.ts';
import { seedShop, type ShopData } from '../_shared/shop.ts';

let d: ShopData, oleg: string, asOleg: Db;

export default example({
  title: 'Права: роль сотрудника, запрет удаления, право на отчёты',
  summary:
    'Права в letopis всегда включены и по умолчанию запрещают всё. Правило — связь «кто» (ресурс-группа) и «что» ' +
    '(ресурс-объект) с разрешением и весом; `db.acl.grant` и `db.acl.deny` заводят их по роли и цели. Проверяет ' +
    'правила сама база — одинаково для библиотеки и для прямых SQL-запросов.',
  tables: ['entity'],
  classes: ['member', 'Resource', 'rule'],
  covers: ['db.acl', 'nuance.deny-by-default', 'nuance.rule-weight', 'nuance.tenant-classes', 'error.acl_denied', 'error.invalid_class'],
  steps: [
    {
      title: 'Магазин и второй сотрудник — Олег',
      text: '`createTenant` с именем того же магазина заводит только пользователя. `db.acl.roles` даёт ему роль `staff` ' +
        'в текущем арендаторе — это строка членства `member`.',
      run: async ({ db, admin, schema, up }) => {
        d = await seedShop(db);
        oleg = (await createTenant(admin, schema, { name: 'Ромашка', user: { name: 'Олег', login: 'oleg@romashka.ru', password: 'Олег-2026!' } })).user!;
        return db.acl.roles(oleg, ['staff']);
      },
    },
    {
      title: 'Правило: сотрудникам нельзя удалять товары',
      text:
        '`db.acl.deny` — запрет роли `staff` удалять товары с весом 50: сильнее правила «своим можно всё» (вес 10). ' +
        '`db.acl.grant` разрешает той же роли отчёты — эндпоинты `shop.reports.*`. Под капотом — ресурсы ' +
        '`role:staff:ACCOUNT`, `class:Product:DELETE`, `api:shop.reports.*:API` и правила между ними; повтор вызова ничего ' +
        'не меняет. `db.acl.list()` показывает правила арендатора — и эти, и «можно всё» от `createTenant`.',
      run: async ({ db }) => {
        await db.acl.deny({ role: 'staff', delete: 'Product' });
        await db.acl.grant({ role: 'staff', api: 'shop.reports.*' });
        return (await db.acl.list()).map((r) => `${r.role ?? r.group} ${r.op} ${r.target}: ${r.permission}, вес ${r.weight}`);
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
      text:
        'Запрет проверяет база, а не интерфейс: даже прямой вызов удаления — предпросмотр и `delete({ confirm: true, expect })` ' +
        'по нему — получает `acl_denied`, ничего не удалено.',
      run: async () => {
        const shown = await asOleg.Product(d.mug).delete().rows();
        return asOleg.Product(d.mug).delete({ confirm: true, expect: shown }).rows();
      },
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
