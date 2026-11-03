/**
 * letopis с нуля на вашей базе: пустая установка, роль приложения, арендатор, своя модель, данные.
 *
 *   cd guide/start && npm install
 *   ADMIN_DSN=postgres://postgres:ПАРОЛЬ@localhost:5432/letopis node start.mjs
 *
 * Без ADMIN_DSN берётся postgres://postgres:guide@127.0.0.1:15440/letopis — например, из
 *   docker run -d --name pg18 -e POSTGRES_PASSWORD=guide -e POSTGRES_DB=letopis -p 127.0.0.1:15440:5432 postgres:18
 * Повторный запуск безопасен: up() и createTenant ничего не дублируют, существующие объекты пропускаются.
 */
import postgres from 'postgres';
import { up, connect, createTenant, syncModels, LetopisError } from 'letopis';
import { hub, link } from 'letopis/model';
import { z } from 'zod';

const ADMIN = process.env.ADMIN_DSN ?? 'postgres://postgres:guide@127.0.0.1:15440/letopis';
const SCHEMA = process.env.SCHEMA ?? 'myapp';
const APP_ROLE = 'myapp_app', APP_PASSWORD = 'myapp-secret';
// свой ключ сервиса — чтобы повторный запуск мог войти снова (lts_ и 32–128 шестнадцатеричных знаков)
const SERVICE_KEY = process.env.SERVICE_KEY ?? 'lts_' + '0f1e2d3c4b5a6978'.repeat(2);

// 1. Пустая установка: схема v2.myapp — таблицы, проверки, системные классы
const r = await up({ dsn: ADMIN, schema: SCHEMA, serviceKey: SERVICE_KEY, quiet: true });
console.log(`1. схема ${r.schema}: ${r.created ? 'поставлена' : 'уже была — накатили повторно'}`);

// 2. Роль приложения (один раз) и арендатор с первым пользователем
const admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
await admin.unsafe(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
  create role ${APP_ROLE} login password '${APP_PASSWORD}'; end if; end $$`);
await admin.unsafe(`grant letopis_app to ${APP_ROLE}`);
const team = await createTenant(admin, r.schema, { name: 'Альфа', user: { name: 'Вера', login: 'vera@alpha.ru', password: 'Alpha-2026!' } });
await admin.end();
console.log(`2. арендатор «Альфа» ${team.created ? 'создан' : 'уже был'}, пользователь vera@alpha.ru`);

// 3. Приложение: своя роль, ключ сервиса, вход пользователя
const app = new URL(ADMIN);
app.username = APP_ROLE;
app.password = APP_PASSWORD;
const svc = await connect({ dsn: app.toString(), schema: r.schema, apiKey: SERVICE_KEY });
const login = await svc.auth.verifyPassword({ identifier: 'vera@alpha.ru', password: 'Alpha-2026!' });
const db = await svc.as(login.account, { tenant: team.tenant });
console.log('3. вошли как Вера');

// 4. Своя модель
const Project = hub('Project', { name: z.string(), deadline: z.iso.date().optional() }, { key: ['name'] });
const Task = link('Task', { title: z.string(), done: z.boolean().default(false), hours: z.number().int().min(0).optional() }, {
  ends: { Project }, key: ['Project', 'title'],
});
const sync = await syncModels(db, [Project, Task], { apply: true });
console.log(`4. модель: создано ${JSON.stringify(sync.created)}, без изменений ${JSON.stringify(sync.unchanged)}`);

// 5. Данные (upsert — повторный запуск не падает на занятом ключе)
const [site] = await db.Project().upsert({ name: 'Сайт', deadline: '2026-12-01' }).rows();
for (const [title, hours] of [['Макет', 8], ['Вёрстка', 16], ['Запуск', 2]]) {
  await db.Project(site).Task().create({ title, hours }).rows().catch((e) => {
    if (!(e instanceof LetopisError && e.code === 'exists')) throw e; // уже есть с прошлого запуска
  });
}
const tasks = await db.Project(site).Task().sort('data.title').rows();
console.log('5. задачи проекта «Сайт»:', tasks.map((t) => `${t.data.title} (${t.data.hours} ч)`).join(', '));
console.log(`   часов всего: ${await db.Project(site).Task().sum('data.hours')}; история задачи «Макет»: ${(await db.Task(tasks.find((t) => t.data.title === 'Макет')).versions()).length} верс.`);

// 6. Много данных сразу: db.load — только администраторское подключение; сессия Веры задаёт арендатора «Альфа».
// existing: 'skip' — при повторном запуске уже загруженные строки пропускаются
const adm = await connect({ dsn: ADMIN, schema: r.schema, token: team.token, allowBypassRls: true });
const report = await adm.load({
  Project: [{ name: 'Приложение', deadline: '2027-03-01' }],
  Task: [
    { title: 'Тексты', hours: 4, Project: { $key: ['Сайт'] } },
    { title: 'Фото', hours: 6, Project: { $key: ['Сайт'] } },
    { title: 'Прототип', hours: 12, Project: { $key: ['Приложение'] } },
  ],
}, { existing: 'skip' });
await adm.close();
console.log(`6. загрузка: записано ${report.loaded}, пропущено ${report.skipped}; задач в «Сайте»: ${await db.Project(site).Task().count()}`);

await svc.close();
console.log('\nГотово. Дальше — главы «Модели», «Запись», «Чтение» на сайте документации.');
