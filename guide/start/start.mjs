/**
 * letopis с нуля на вашей базе: дом, пропуск, почтальон, квартира и её хозяйка, своя модель, данные.
 *
 *   cd guide/start && npm install          (или в своей папке: npm init -y && npm pkg set type=module && npm i letopis@4 zod)
 *   ADMIN_DSN=postgres://postgres:ПАРОЛЬ@localhost:5432/letopis node start.mjs
 *
 * ADMIN_DSN — мастер-ключ: строка подключения администратора PostgreSQL. Без неё берётся
 * postgres://postgres:guide@127.0.0.1:15440/letopis — например, из
 *   docker run -d --name pg18 -e POSTGRES_PASSWORD=guide -e POSTGRES_DB=letopis -p 127.0.0.1:15440:5432 postgres:18
 * HOUSE — имя дома (по умолчанию myapp: схема v2.myapp). Повторный запуск безопасен: setup() отдаёт тот же пропуск,
 * квартира и хозяйка уже есть — скрипт входит её паролем, проект пишется через upsert, готовые задачи пропускаются.
 */
import { setup, connect, LetopisError } from 'letopis';
import { hub, link } from 'letopis/model';
import { z } from 'zod';

const ADMIN_DSN = process.env.ADMIN_DSN ?? 'postgres://postgres:guide@127.0.0.1:15440/letopis';
const HOUSE = process.env.HOUSE ?? 'myapp';
const VERA = { email: 'vera@alpha.ru', password: 'Alpha-2026!' }; // контакт (он же имя для входа) и пароль

// Своя модель: проект и задачи в нём.
const Project = hub('Project', { name: z.string(), deadline: z.iso.date().optional() }, { key: ['name'] });
const Task = link('Task', { title: z.string(), done: z.boolean().default(false), hours: z.number().int().min(0).optional() }, {
  ends: { Project }, key: ['Project', 'title'],
});

// 1. Дом: setup() мастер-ключом строит схему с моделью и отдаёт пропуск консьержа; повтор — тот же пропуск
const r = await setup(ADMIN_DSN, HOUSE, { models: [Project, Task], quiet: true });
console.log(`1. дом ${r.schema}: ${r.created ? 'построен' : 'уже был — достроен'}; пропуск — в настройки приложения (например, LETOPIS_PASS)`);

// 2. Консьерж: connect(pass, { postman }) — так подключается веб-сервис, мастер-ключ ему не нужен.
// Почтальон — функция приложения, которая доставляет письма: библиотека сама ничего не шлёт. Здесь он учебный —
// запоминает письма. В настоящем сервисе он отправляет ссылку вида https://ваш-сайт/invite/<token> почтой или СМС.
const mail = [];
const postman = async (letter) => { mail.push(letter); };
const db = await connect(r.pass, { postman });
console.log('2. консьерж подключён пропуском, почтальон задан');

// 3. Квартира «Альфа» и её хозяйка Вера: в первый раз — приглашение и его принятие, потом — вход паролем.
// invite() отдаёт письмо с токеном почтальону; страница по ссылке приняла бы его так же: db.accept(token, { password })
let vera;
if (!(await db.tenants()).some((t) => t.name === 'Альфа')) {
  await db.createTenant('Альфа');
  await (await db.in('Альфа')).invite({ email: VERA.email }, ['owner']);
  const { token } = mail.at(-1).message; // токен приглашения — из письма
  vera = await db.accept(token, { password: VERA.password, name: 'Вера' });
  console.log('3. квартира «Альфа» заведена, Вера приняла приглашение (роль owner)');
} else {
  vera = await db.open(VERA);
  console.log('3. квартира «Альфа» уже была — Вера вошла паролем');
}

// 4. Данные: проект (upsert — повторный запуск не падает на занятом ключе) и задачи
const [site] = await vera.Project().upsert({ name: 'Сайт', deadline: '2026-12-01' }).rows();
for (const [title, hours] of [['Макет', 8], ['Вёрстка', 16], ['Запуск', 2]]) {
  await vera.Project(site).Task().create({ title, hours }).rows().catch((e) => {
    if (!(e instanceof LetopisError && e.code === 'exists')) throw e; // уже есть с прошлого запуска
  });
}
const tasks = await vera.Project(site).Task().sort('data.title').rows();
console.log('4. задачи проекта «Сайт»:', tasks.map((t) => `${t.data.title} (${t.data.hours} ч)`).join(', '));

// 5. Чтение: итог и история
const layout = tasks.find((t) => t.data.title === 'Макет');
console.log(`5. часов всего: ${await vera.Project(site).Task().sum('data.hours')}; версий задачи «Макет»: ${(await vera.Task(layout).versions()).length}`);

await db.close();
console.log(`\nГотово. Много данных сразу — команда мастер-ключом: npx letopis load файл.ndjson --dsn "$ADMIN_DSN" --schema ${HOUSE} --tenant Альфа.`);
console.log('Дальше — главы «Модели», «Запись», «Чтение» на сайте документации.');
