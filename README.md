# letopis (летопись)

Хранилище версионированных сущностей на **PostgreSQL 18** для Node.js. Целостность, история, изоляция квартир и
права проверяет сама база: триггеры и политики RLS действуют и для библиотеки, и для сырого SQL. Каждое изменение —
версия в журнале (`versions`, `asOf`, подписка по курсору), обход графа — цепочками, классы описываются моделями на
Zod и хранятся в базе. Дом, консьерж, квартиры, приглашения по ссылке, ключи и матрица прав со счётом встроены.

Первый запуск — PostgreSQL 18 в Docker, пакет в пустой папке и один файл:

```bash
docker run -d --name pg18 -e POSTGRES_PASSWORD=guide -e POSTGRES_DB=letopis -p 127.0.0.1:15440:5432 postgres:18
npm init -y && npm pkg set type=module && npm i letopis@4 zod && npm i -D tsx
```

<!-- run: root -->
```ts
import { setup, connect, type Letter } from 'letopis'

const ADMIN_DSN = process.env.ADMIN_DSN ?? 'postgres://postgres:guide@127.0.0.1:15440/letopis'   // мастер-ключ

// дом salon с демо-моделью салона (seeds); pass — пропуск консьержа
const { pass } = await setup(ADMIN_DSN, 'salon', { seeds: ['booking'], quiet: true })

// консьерж — дверь дома; почтальон-заглушка складывает письма в массив (в приложении — отправка письма или СМС)
const mail: Letter[] = []
const db = await connect(pass, { postman: async (letter) => { mail.push(letter) } })
await db.createTenant('Салон').catch((e) => { if (e.code !== 'exists') throw e })   // квартира

// Анна входит паролем; в первый раз её зовёт консьерж, и она принимает приглашение по ссылке из письма
const anna = await db.open({ email: 'anna@salon.ru', password: 'Сирень-2026!' }).catch(async (e) => {
  if (e.code !== 'auth_failed') throw e
  await (await db.in('Салон')).invite({ email: 'anna@salon.ru' }, ['owner'])   // токен получает только почтальон
  const letter = mail.at(-1)!.message
  if (letter.kind !== 'invite') throw new Error('ждали приглашение')
  return db.accept(letter.token, { password: 'Сирень-2026!', name: 'Анна' })   // аккаунт, прописка owner, пароль
})

const [org] = await anna.Org().create({ name: 'Салон на Мира' }).rows()
const [vasya] = await anna.Org(org).Staff().create({ name: 'Вася', phone: '+7 900' }).rows()
const services = await anna.Staff(vasya).skill().Service().rows()                // пути по графу
const earlier = await anna.Org(org).Staff().asOf('2026-10-01T00:00:00Z').count()  // срез на дату
await db.close()
```

Запуск — `npx tsx app.ts`. Та же история по шагам, с ожидаемым выводом и объяснением каждой строки, —
[«Первый запуск за 10 минут»](lib/README.md#1-первый-запуск-за-10-минут) в руководстве пакета.

ESM, Node 22 и новее. Рантайм-зависимость одна — `postgres`; Zod 4 — необязательная peer-зависимость для
описания моделей (`letopis/model`).

Лицензия — [PolyForm Noncommercial 1.0.0](LICENSE): исходный код открыт, некоммерческое использование бесплатно,
коммерческое — по разрешению владельца ([`lib/LICENSE-COMMERCIAL.md`](lib/LICENSE-COMMERCIAL.md); запрос — issue на
[GitHub](https://github.com/alepri51/letopis/issues)).

## Куда идти дальше

| Хочу | Файл |
|---|---|
| **быстро начать / я ИИ-агент** | [`lib/AGENT-CHEATSHEET.md`](lib/AGENT-CHEATSHEET.md) — рабочий цикл на одной странице и частые ошибки (входит в пакет); [`lib/llms.txt`](lib/llms.txt) — указатель для языковых моделей |
| понять на примерах | [`guide/`](guide/) — сайт документации для людей: главы с исполняемыми примерами (данные после каждого шага), схемы и четыре сервиса-примера; только локально — `cd guide && npm install && npm run dev` (http://127.0.0.1:5173) или стенд `docker compose -f services/compose.yaml up --build` (сайт с песочницей — http://127.0.0.1:8080, сервисы — 8081–8084) |
| полное руководство | [`lib/README.md`](lib/README.md) — первый запуск за 10 минут, слова, дом по шагам, модель, запись, чтение, удаление, транзакции и деньги, история, люди и вход, права, подписка, загрузка, эксплуатация, MCP; справочник API, ошибки, ограничения |
| что изменилось | [`lib/CHANGELOG.md`](lib/CHANGELOG.md) — источник истины версии вместе с `lib/package.json` |
| машиночитаемый контракт API | [`lib/api-contract.json`](lib/api-contract.json) — экспорты, методы цепочки, коды и тексты ошибок (генерируется) |
| работать над самой библиотекой | [`AGENTS.md`](AGENTS.md) — карта проекта для агента (atlas): модули, трассы сценариев, протокол |

## Структура репозитория

```
lib/            ← сам npm-пакет (src, sql, scripts, bench) и его документация
docs/atlas/     ← трассы сценариев (F-*); карточки модулей — .claude/rules/atlas/ (M-*)
db/             ← скрипт репозитория apply.mjs — обёртка над setup() для CI
```

Пакет — это `lib/`; в корне репозитория `package.json` нет.

## Разработка

```bash
cd lib
npm ci
npm run typecheck:all    # проверка типов: исходники и замеры
npm run check:docs       # сверка документации с кодом: версии, ссылки, якоря, контракт API, имена, тексты ошибок
npm run cheatsheet       # программа памятки — дважды подряд на живом PostgreSQL 18
npm run prerelease       # всё перед пушем и выпуском: типы, документы, примеры сайта, песочница, сценарии сервисов, пакет
```

Unit-тестов в проекте нет: поведение проверяют исполняемые примеры сайта со снимками, программа памятки, сценарии
сервисов и долгий прогон — всё на настоящем PostgreSQL 18 (контейнер `letopis-pg18`, порт 15433; `ENTITY_DSN`
переопределяет подключение). Как участвовать — [CONTRIBUTING.md](CONTRIBUTING.md).
