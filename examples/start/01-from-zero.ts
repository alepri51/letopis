import { up, createTenant, syncModels } from 'letopis';
import type { UpResult, TenantResult, Db } from 'letopis';
import { hub, link } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

// Своя модель: проект и задачи в нём.
const Project = hub('Project', { name: z.string(), deadline: z.iso.date().optional() }, { key: ['name'] });
const Task = link('Task', { title: z.string(), done: z.boolean().default(false), hours: z.number().int().min(0).optional() }, {
  ends: { Project }, key: ['Project', 'title'],
});
// Ключ сервиса задан заранее: в приложении — из переменной окружения (lts_ и 32–128 шестнадцатеричных знаков).
const SERVICE_KEY = process.env.SERVICE_KEY ?? 'lts_' + '0f1e2d3c4b5a6978'.repeat(2);
let r: UpResult, team: TenantResult, db: Db;

export default example({
  title: 'С нуля: пустая установка, своя модель, первые данные',
  summary:
    'Шесть шагов от пустой базы до работающих данных: поставить схему и роль приложения, завести арендатора и ' +
    'пользователя, подключиться по ключу сервиса, описать модель, наполнить данными цепочками и массовой загрузкой ' +
    'db.load. Те же шесть шагов делает скрипт start.mjs из репозитория letopis на вашей базе.',
  setup: 'none',
  tables: ['entity', 'log'],
  covers: ['nuance.start-from-zero'],
  steps: [
    {
      title: '1. Поставить схему и роль приложения',
      text:
        '`up()` от имени администратора базы ставит пустую установку `v2.<имя>`: таблицы, проверки, системные классы. ' +
        '`serviceKey` — ключ сервиса, заданный заранее: `up()` регистрирует его и возвращает в `r.serviceKey`; ' +
        'повторный `up()` с тем же ключом ничего не меняет и отвечает `null`. `login` заводит роль приложения ' +
        '`guide_start_app` — ею приложение ходит в базу; её строка подключения — `r.login.dsn`.',
      run: async ({ dsn, schema }) => {
        r = await up({
          dsn: dsn.admin, schema, quiet: true, serviceKey: SERVICE_KEY,
          login: { user: 'guide_start_app', password: 'start-app-secret' },
        });
        return { schema: r.schema, created: r.created, serviceKey: r.serviceKey, 'роль приложения': r.login!.user };
      },
    },
    {
      title: '2. Арендатор и первый пользователь',
      text: 'Без арендатора с правилами пользователям запрещено всё. `createTenant` заводит команду «Альфа» и её участницу Веру с паролем.',
      run: async ({ admin, schema }) => {
        team = await createTenant(admin, schema, { name: 'Альфа', user: { name: 'Вера', login: 'vera@alpha.ru', password: 'Alpha-2026!' } });
        return team;
      },
    },
    {
      title: '3. Подключиться от имени пользователя',
      text:
        'Приложение подключается к базе ролью из шага 1 (`r.login.dsn`) по ключу сервиса — пароль администратора ему ' +
        'не нужен. Сервис проверяет пароль Веры (`svc.auth.verifyPassword`) и дальше работает от её имени в арендаторе ' +
        '«Альфа» (`svc.as`).',
      run: async ({ connect, schema }) => {
        const svc = await connect({ dsn: r.login!.dsn!, schema, apiKey: SERVICE_KEY });
        const login = await svc.auth.verifyPassword({ identifier: 'vera@alpha.ru', password: 'Alpha-2026!' });
        db = await svc.as(login!.account, { tenant: team.tenant });
        return { tenant: db.tenant };
      },
    },
    {
      title: '4. Описать свою модель',
      text: 'Проект (ключ — название) и задача (ключ — проект и заголовок). `syncModels` записывает описания в базу.',
      run: async () => (await syncModels(db, [Project, Task], { apply: true })).created,
    },
    {
      title: '5. Наполнить данными',
      text: 'Проект и три задачи. Задачи — одним батчем: одна транзакция, а подряд идущие вставки объединяются в один SQL-оператор.',
      run: async () => {
        const [p] = await db.Project().create({ name: 'Сайт', deadline: '2026-12-01' }).rows();
        const b = db.batch('задачи');
        b.Project(p).Task().create({ title: 'Макет', hours: 8 });
        b.Project(p).Task().create({ title: 'Вёрстка', hours: 16 });
        b.Project(p).Task().create({ title: 'Запуск', hours: 2 });
        await b.run();
        return { задач: await db.Project(p).Task().count(), часов: await db.Project(p).Task().sum('data.hours') };
      },
    },
    {
      title: '6. Много данных сразу: db.load',
      text:
        'Когда данных много — перенос из старой системы, прайс, справочник, — их грузят `db.load`: пачками через COPY, ' +
        'данные проверяются тем же описанием классов, что и в базе. COPY пишет от роли-владельца схемы в обход правил ' +
        'доступа, поэтому `load` работает только на администраторском подключении (строка администратора `dsn.admin` и ' +
        '`allowBypassRls: true`); на подключении сервиса — отказ `admin_required`. Такое подключение печатает ' +
        'предупреждение «администраторское подключение — RLS не действует». Это администраторская работа — в настоящем ' +
        'приложении её делает отдельный процесс (скрипт переноса), а веб-сервис пароля администратора не держит. ' +
        'Подключение работает в сессии Веры (`team.token`), поэтому строки попадают в арендатор «Альфа». Задача ссылается ' +
        'на проект его ключом: `{ $key: [\'Сайт\'] }`.',
      run: async ({ connect, dsn, schema }) => {
        const adm = await connect({ dsn: dsn.admin, schema, token: team.token!, allowBypassRls: true });
        const report = await adm.load({
          Project: [{ name: 'Приложение', deadline: '2027-03-01' }],
          Task: [
            { title: 'Тексты', hours: 4, Project: { $key: ['Сайт'] } },
            { title: 'Фото', hours: 6, Project: { $key: ['Сайт'] } },
            { title: 'Прототип', hours: 12, Project: { $key: ['Приложение'] } },
          ],
        });
        return { report, 'задач в «Сайте»': await db.Project({ name: 'Сайт' }).Task().count(), 'проектов': await db.Project().count() };
      },
    },
    {
      title: 'Дальше — обычная работа',
      text: 'Отметили задачу выполненной: новая версия в журнале. Всё остальное — в главах про запись, чтение и историю.',
      run: async () => db.Task({ title: 'Макет' }).update({ done: true }).rows(),
    },
  ],
});
