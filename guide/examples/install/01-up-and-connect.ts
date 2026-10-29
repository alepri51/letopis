import { up, createTenant } from 'letopis';
import type { UpResult, TenantResult } from 'letopis';
import { example } from '../../kit/example.ts';

let r: UpResult;
let tenant: TenantResult;

export default example({
  title: 'Установка, первый арендатор и вход',
  summary:
    'up() ставит схему: таблицы, проверки и системные объекты. createTenant заводит арендатора и его первого ' +
    'пользователя. Приложение подключается отдельной ролью и действует от имени пользователя.',
  setup: 'none',
  tables: ['counts', 'secret'],
  covers: [
    'export.up', 'up.dsn', 'up.schema', 'up.quiet', 'export.createTenant', 'connect.dsn', 'connect.schema',
    'connect.apiKey', 'connect.token', 'connect.allowBypassRls', 'db.as', 'db.schema', 'db.tenant', 'db.token',
    'error.bypass_rls', 'nuance.up-idempotent', 'nuance.service-key-once',
  ],
  steps: [
    {
      title: 'Ставим схему',
      text:
        '`up()` вызывают от администратора (`dsn.admin` — его строка подключения). Схема пустая, поэтому `up()` ' +
        'создаёт всё: три таблицы, системные классы, аккаунты System и сервиса, ресурсы и правила доступа. В `secret` — ' +
        'ключ сервиса (`APIKEY`) и служебный ключ установки (`KEY`). Сам ключ сервиса приходит в ответе — `serviceKey`: ' +
        'его нужно сохранить, повторно он не выдаётся.',
      run: async ({ dsn, schema }) => {
        r = await up({ dsn: dsn.admin, schema, quiet: true });
        return { schema: r.schema, created: r.created, revision: r.revision, signals: r.signals, serviceKey: r.serviceKey };
      },
    },
    {
      title: 'Повторный up() безопасен',
      text:
        'Второй вызов ничего не дублирует: `created: false`, данные на месте (сводка не изменилась), а ключ сервиса ' +
        'не выдаётся — `serviceKey: null`. Поэтому `up()` можно вызывать при каждом старте приложения.',
      run: async ({ dsn, schema }) => {
        const again = await up({ dsn: dsn.admin, schema, quiet: true });
        return { created: again.created, serviceKey: again.serviceKey };
      },
    },
    {
      title: 'Первый арендатор и пользователь',
      text:
        'Арендатор — это «чьи данные»: магазин, салон, компания. `createTenant` одной транзакцией заводит ' +
        'арендатора «Ромашка», правила «своим можно всё», пользователя Анну с членством, пароль и сессию. ' +
        'В сводке: +2 аккаунта (арендатор и Анна), +1 членство (`member`), +3 правила (`rule`), пароль и сессия в `secret`.',
      run: async ({ admin, schema }) => {
        tenant = await createTenant(admin, schema, {
          name: 'Ромашка',
          user: { name: 'Анна', login: 'anna@romashka.ru', password: 'Ромашка-2026!' },
        });
        return tenant;
      },
    },
    {
      title: 'Сервис входит по ключу и действует от имени Анны',
      text:
        'Приложение подключается своей ролью (`dsn.app`, она состоит в `letopis_app`) по ключу сервиса. ' +
        'Сессий стало на две больше: вход сервиса по ключу — тоже сессия, а `verifyPassword` проверил пароль и выдал ' +
        'сессию Анне. `svc.as()` — тот же пул соединений, но запросы идут от имени Анны в её арендаторе.',
      run: async ({ connect, dsn, schema }) => {
        const svc = await connect({ dsn: dsn.app, schema, apiKey: r.serviceKey! });
        const login = await svc.auth.verifyPassword({ identifier: 'anna@romashka.ru', password: 'Ромашка-2026!' });
        const db = await svc.as(login!.account, { tenant: tenant.tenant });
        return { schema: db.schema, tenant: db.tenant, account: login!.account };
      },
    },
    {
      title: 'Своё подключение по токену сессии',
      text: 'Другой процесс может подключиться прямо по токену сессии Анны. `db.tenant` — арендатор этой сессии.',
      run: async ({ connect, dsn, schema }) => {
        const anna = await connect({ dsn: dsn.app, schema, token: tenant.token! });
        return { tenant: anna.tenant, token: anna.token };
      },
    },
    {
      title: 'Роль в обход проверок доступа не пускают',
      text:
        'Администратор базы обходит политики доступа (RLS). Если приложение по ошибке подключится им, ' +
        'изоляция арендаторов пропала бы. Поэтому `connect()` такую роль отклоняет: ошибка `bypass_rls`.',
      run: async ({ connect, dsn, schema }) => {
        await connect({ dsn: dsn.admin, schema, token: tenant.token! });
      },
      expect: { error: 'bypass_rls' },
    },
    {
      title: 'Администраторское подключение — только явно',
      text:
        'Загрузчику и проекторам администраторское подключение нужно. Его разрешают явно — `allowBypassRls: true`, ' +
        'и библиотека печатает предупреждение. Держите такое подключение в отдельном процессе, не в веб-приложении. ' +
        '(`warnings(…)` — помощник документации: собирает напечатанные предупреждения.)',
      run: async ({ connect, warnings, dsn, schema }) => {
        const { result: adm, warnings: printed } = await warnings(() =>
          connect({ dsn: dsn.admin, schema, token: tenant.token!, allowBypassRls: true }));
        return { tenant: adm.tenant, printed };
      },
    },
  ],
});
