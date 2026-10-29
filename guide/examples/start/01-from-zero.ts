import { up, createTenant, syncModels } from 'letopis';
import type { UpResult, TenantResult, Db } from 'letopis';
import { hub, link } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

// Своя модель: проект и задачи в нём.
const Project = hub('Project', { name: z.string(), deadline: z.iso.date().optional() }, { key: ['name'] });
const Task = link('Task', { title: z.string(), done: z.boolean().default(false), hours: z.number().int().min(0).optional() }, {
  ends: { Project }, key: ['Project', 'title'],
});
let r: UpResult, team: TenantResult, db: Db;

export default example({
  title: 'С нуля: пустая установка, своя модель, первые данные',
  summary:
    'Пять шагов от пустой базы до работающих данных: поставить схему, завести арендатора и пользователя, ' +
    'подключиться, описать модель, наполнить данными. Ровно то же делает скрипт guide/start/start.mjs на вашей базе.',
  setup: 'none',
  tables: ['entity', 'log'],
  covers: ['nuance.start-from-zero'],
  steps: [
    {
      title: '1. Поставить схему',
      text:
        '`up()` от имени администратора базы ставит пустую установку `v2.<имя>`: таблицы, проверки, системные классы. ' +
        'В ответе — ключ сервиса (`serviceKey`): по нему приложение подключается к базе. Сохраните его, повторно он не выдаётся.',
      run: async ({ dsn, schema }) => {
        r = await up({ dsn: dsn.admin, schema, quiet: true });
        return { schema: r.schema, created: r.created, serviceKey: r.serviceKey };
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
      text: 'Приложение подключается к базе своей ролью (`dsn.app`; роль входит в `letopis_app`) по ключу сервиса, проверяет пароль Веры и дальше работает от её имени.',
      run: async ({ connect, dsn, schema }) => {
        const svc = await connect({ dsn: dsn.app, schema, apiKey: r.serviceKey! });
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
      title: 'Дальше — обычная работа',
      text: 'Отметили задачу выполненной: новая версия в журнале. Всё остальное — в главах про запись, чтение и историю.',
      run: async () => db.Task({ title: 'Макет' }).update({ done: true }).rows(),
    },
  ],
});
