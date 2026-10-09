# letopis (летопись)

[English](README.en.md)

Хранилище версионированных сущностей на **PostgreSQL 18** для Node.js. Целостность, история, изоляция арендаторов
и права проверяет сама база: триггеры и политики RLS действуют и для библиотеки, и для сырого SQL.
Каждое изменение — версия в журнале (`versions`, `asOf`, подписка по курсору), обход графа — цепочками,
классы описываются моделями на Zod и хранятся в базе, вход, сессии и права встроены.

```bash
npm install letopis zod
```

<!-- run -->
```ts
import { up, connect } from 'letopis'

const ADMIN = 'postgres://postgres:secret@localhost:5432/app'   // администратор: ставит схему
const APP = 'postgres://app:app-secret@localhost:5432/app'      // приложение: роль-член letopis_app

// схема v2.salon с демо-доменом салона (seeds), первым арендатором и его пользователем
const r = await up({ dsn: ADMIN, schema: 'salon', seeds: ['booking'],
  tenant: { name: 'Салон', user: { name: 'Анна', login: 'anna@salon.ru', password: 'Сирень-2026!' } } })
const svc = await connect({ dsn: APP, schema: r.schema, apiKey: r.serviceKey! })   // r.serviceKey — ключ сервиса
const login = await svc.auth.verifyPassword({ identifier: 'anna@salon.ru', password: 'Сирень-2026!' })
const db = await svc.as(login!.account, { tenant: r.tenant!.tenant })             // от имени Анны в её салоне

const [org] = await db.Org().create({ name: 'Салон на Мира' }).rows()
const [vasya] = await db.Org(org).Staff().create({ name: 'Вася', phone: '+7 900' }).rows()
const services = await db.Staff(vasya).skill().Service().rows()                  // пути по графу
const earlier = await db.Org(org).Staff().asOf('2026-10-01T00:00:00Z').count()    // срез на дату
await svc.close()
```

ESM, Node 22 и новее. Рантайм-зависимость одна — `postgres`; Zod 4 — необязательная peer-зависимость для
описания моделей (`letopis/model`). TimescaleDB, Redis и Docker не нужны. Лицензия MIT.

## Куда идти дальше

| Хочу | Файл |
|---|---|
| **быстро начать / я ИИ-агент** | [`lib/AGENT-CHEATSHEET.md`](lib/AGENT-CHEATSHEET.md) — рабочий цикл на одной странице и частые ошибки (входит в пакет); [`lib/llms.txt`](lib/llms.txt) — указатель для языковых моделей |
| полное руководство | [`lib/README.md`](lib/README.md) — по задачам: быстрый старт, установка, модель, запись, чтение, транзакции и деньги, загрузка, вход и права, история, подписка, эксплуатация; справочник API, ошибки, ограничения |
| перейти с 0.21 | [`lib/MIGRATION.md`](lib/MIGRATION.md) — импорт данных и таблица замен API |
| что изменилось | [`lib/CHANGELOG.md`](lib/CHANGELOG.md) — источник истины версии вместе с `lib/package.json` |
| машиночитаемый контракт API | [`docs/api-contract.json`](docs/api-contract.json) — экспорты, методы цепочки, тексты ошибок, снесённые имена (генерируется) |
| сравнение с аналогами | [`COMPARISON.md`](COMPARISON.md) |
| работать над самой библиотекой | [`AGENTS.md`](AGENTS.md) — карта проекта для агента (atlas): модули, трассы сценариев, протокол |

## Структура репозитория

```
lib/            ← сам npm-пакет (src, sql, scripts, test, bench) и его документация
docs/atlas/     ← трассы сценариев (F-*); карточки модулей — .claude/rules/atlas/ (M-*)
db/             ← скрипт репозитория apply.mjs — обёртка над up() для CI
```

Пакет — это `lib/`; в корне репозитория `package.json` нет.

## Разработка

```bash
cd lib
npm ci
npm run typecheck        # tsc --noEmit
npm run check:docs       # сверка документации с кодом (версии, ссылки, якоря, список тестов, контракт API, имена, английские версии)
npm test                 # весь набор против живого PostgreSQL 18, включая исполнение примеров документации
```

Тесты интеграционные, без моков базы: обвязка сама поднимает контейнер `letopis-pg18` (`postgres:18`, порт 15433),
если база не отвечает. `ENTITY_DSN` и `ENTITY_APP_DSN` переопределяют подключения.
