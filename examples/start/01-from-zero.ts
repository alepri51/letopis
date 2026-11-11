import { setup } from 'letopis';
import type { House, Room } from 'letopis';
import { hub, link } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { postman, lastLetter } from '../_shared/postman.ts';

// Своя модель: проект и задачи в нём.
const Project = hub('Project', { name: z.string(), deadline: z.iso.date().optional() }, { key: ['name'] });
const Task = link('Task', { title: z.string(), done: z.boolean().default(false), hours: z.number().int().min(0).optional() }, {
  ends: { Project }, key: ['Project', 'title'],
});
let pass: string, db: House, cookie: string, petya: Room;

export default example({
  title: 'С нуля: дом, пропуск, вход по ключу и второй жилец',
  summary:
    'Путь настоящего веб-сервиса от пустой базы: скрипт развёртывания строит дом мастер-ключом, сервис подключается ' +
    'пропуском со своим почтальоном, заводит квартиру и зовёт её хозяйку письмом со ссылкой, хозяйка входит паролем и ' +
    'работает по токену из cookie, выдаёт правила и зовёт сотрудника, а тот видит и правит только то, что ему разрешено.',
  setup: 'none',
  tables: ['entity', 'log'],
  covers: [
    'export.setup', 'setup.models', 'export.connect', 'connect.postman', 'house.createTenant', 'house.in', 'db.invite',
    'house.invitation', 'house.accept',
    'house.open', 'house.resume', 'db.token', 'acl.grant', 'db.batch', 'error.acl_denied', 'error.auth_failed',
    'nuance.start-from-zero',
  ],
  steps: [
    {
      title: '1. Развёртывание: setup() строит дом',
      text:
        'Скрипт развёртывания вызывает `setup(ADMIN_DSN, имя, { models })` мастер-ключом — строкой администратора ' +
        'PostgreSQL: дом с таблицами, системными классами и моделью «проект и задача». Ответ — пропуск консьержа: его ' +
        'кладут в настройки веб-сервиса (например, переменная `LETOPIS_PASS`), а мастер-ключ остаётся у скрипта. ' +
        'Повторный `setup()` при следующем развёртывании отдаёт тот же пропуск и дописывает новые модели.',
      run: async ({ ADMIN_DSN, name }) => {
        const r = await setup(ADMIN_DSN, name, { models: [Project, Task], quiet: true });
        pass = r.pass;
        return { 'дом': r.schema, 'построен': r.created, 'классы': r.models?.created };
      },
    },
    {
      title: '2. Веб-сервис: connect(pass, { postman }) и квартира',
      text:
        'Веб-сервис при запуске подключается пропуском — `connect(pass, { postman })` даёт консьержа, одно подключение ' +
        'на процесс. Почтальон — функция сервиса, которая отправляет письма: ссылки-приглашения и коды входа. Здесь это ' +
        'заглушка с ящиком `mail`; в настоящем сервисе — отправка письма или СМС. Новый клиент сервиса — новая квартира: ' +
        '`createTenant(\'Альфа\')`. Имя квартиры уникально в доме.',
      run: async ({ connect }) => {
        db = await connect(pass, { postman });
        const alpha = await db.createTenant('Альфа');
        return { 'квартира': alpha.name };
      },
    },
    {
      title: '3. Хозяйка квартиры: приглашение и accept()',
      text:
        'Консьерж в квартире (`db.in`) зовёт Веру с ролью `owner`. Почтальон сервиса отправляет Вере письмо со ссылкой — ' +
        'в ней токен приглашения. Страница по ссылке показывает приглашение (`db.invitation(token)`: квартира, роли, ' +
        'срок), Вера задаёт пароль — `db.accept(token, { password, name })` заводит её аккаунт, прописку и пароль от ' +
        'квартиры. Роли `owner` консьерж при `createTenant` дал правило «можно всё».',
      run: async () => {
        await (await db.in('Альфа')).invite({ email: 'vera@alpha.ru' }, ['owner']);
        const { token } = lastLetter('vera@alpha.ru', 'invite'); // токен из ссылки в письме
        const page = await db.invitation(token);
        const vera = await db.accept(token, { password: 'Alpha-2026!', name: 'Вера' });
        return { 'страница приглашения': { 'квартира': page.tenantName, 'роли': page.roles }, 'квартира': vera.tenantName };
      },
    },
    {
      title: '4. Вход: open() и токен в cookie',
      text:
        'Форма входа: `db.open({ email, password })` — консьерж сверяет ключ и открывает корень квартиры, которую ' +
        'этот ключ открывает. Токен сессии `token` сервис кладёт в cookie (httpOnly). Неверный пароль — `auth_failed`.',
      run: async () => {
        const vera = await db.open({ email: 'vera@alpha.ru', password: 'Alpha-2026!' });
        cookie = vera.token!;
        const wrong = await db.open({ email: 'vera@alpha.ru', password: 'не тот' }).then(() => 'вошла', (e) => e.code);
        return { 'квартира': vera.tenantName, 'неверный пароль': wrong };
      },
    },
    {
      title: '5. Следующий запрос: resume(token) и данные',
      text:
        'Каждый запрос сервис начинает с `db.resume(token)` из cookie — корень той же сессии, права Веры проверяет база. ' +
        'Проект и три задачи — одним батчем: одна транзакция, подряд идущие вставки — один SQL-оператор.',
      run: async () => {
        const me = await db.resume(cookie);
        const [p] = await me.Project().create({ name: 'Сайт', deadline: '2026-12-01' }).rows();
        const b = me.batch('задачи');
        b.Project(p).Task().create({ title: 'Макет', hours: 8 });
        b.Project(p).Task().create({ title: 'Вёрстка', hours: 16 });
        b.Project(p).Task().create({ title: 'Запуск', hours: 2 });
        await b.run();
        return { 'задач': await me.Project(p).Task().count(), 'часов': await me.Project(p).Task().sum('data.hours') };
      },
    },
    {
      title: '6. Правила и второй жилец',
      text:
        'Вера разрешает роли `dev` читать проекты и читать и править задачи (`acl.grant`) и зовёт Петю с этой ролью. ' +
        'Петя принимает приглашение своим паролем: задачи он видит и отмечает выполненными, а завести проект не может — ' +
        'писать `Project` роли `dev` не разрешено, а без правила запрещено всё (`acl_denied`).',
      run: async () => {
        const me = await db.resume(cookie);
        await me.acl.grant({ role: 'dev', read: ['Project', 'Task'], write: 'Task' });
        await me.invite({ email: 'petya@alpha.ru' }, ['dev']);
        petya = await db.accept(lastLetter('petya@alpha.ru', 'invite').token, { password: 'Petya-2026!', name: 'Петя' });
        const [done] = await petya.Task({ title: 'Макет' }).update({ done: true }).rows();
        const project = await petya.Project().create({ name: 'Свой' }).rows().then(() => 'заведён', (e) => e.code);
        return {
          'задачи Пети': (await petya.Task().sort('data.title').rows()).map((t) => `${t.data.title}${t.data.done ? ' ✓' : ''}`),
          'отметил': done.data.title,
          'новый проект': project,
        };
      },
    },
    {
      title: '7. Выход: close()',
      text:
        '«Выйти» — `close()` у корня по cookie: сессия погашена, следующий `resume()` с тем же токеном — `auth_failed`, ' +
        'сервис отвечает «войдите заново».',
      run: async () => {
        await (await db.resume(cookie)).close();
        return { 'resume(тот же токен)': await db.resume(cookie).then(() => 'вошла', (e) => e.code) };
      },
    },
  ],
});
