# letopis (летопись)

Хранилище версионированных сущностей на **PostgreSQL 18**. Целостность, история, изоляция арендаторов
и права проверяет сама база: триггеры и политики RLS действуют и для библиотеки, и для сырого SQL.
Каждое изменение — версия в журнале (`versions`, `asOf`, подписка по курсору), обход графа — цепочками,
классы описываются моделями на Zod и хранятся в базе, вход, сессии и права встроены.

```bash
npm install letopis zod
```

```ts
import { up, connect } from 'letopis'

const r = await up({ dsn: ADMIN_DSN, schema: 'salon' })        // установка схемы v2.salon; r.serviceKey — ключ сервиса
const svc = await connect({ dsn: APP_DSN, schema: 'v2.salon', apiKey: r.serviceKey! })
const login = await svc.auth.verifyPassword({ identifier: 'anna@salon.ru', password })
const db = await svc.as(login!.account, { tenant: org })      // от имени пользователя в его арендаторе

const [vasya] = await db.Org(org).Staff().create({ name: 'Вася', phone: '+7 900' }).rows()
await db.Staff(vasya).skill().Service().rows()                // пути по графу
await db.Staff(vasya).booking().asOf('2026-10-01T00:00:00Z').count()   // срез на дату
await svc.close()
```

ESM, Node 22 и новее. Рантайм-зависимость одна — `postgres`; Zod 4 — необязательная peer-зависимость для
описания моделей (`letopis/model`). TimescaleDB, Redis и Docker не нужны. Лицензия MIT.

## Куда идти дальше

| Хочу | Файл |
|---|---|
| **быстро начать / я ИИ-агент** | [`AGENT-CHEATSHEET.md`](AGENT-CHEATSHEET.md) — рабочий цикл на одной странице и частые ошибки |
| полное руководство | [`lib/README.md`](lib/README.md) — §1 быстрый старт, §2 устройство, §11 API, §12 ошибки, §14 производительность, §15 ограничения |
| перейти с 0.21 | [`lib/MIGRATION.md`](lib/MIGRATION.md) — импорт данных и таблица замен API |
| что изменилось | [`lib/CHANGELOG.md`](lib/CHANGELOG.md) — источник истины версии вместе с `lib/package.json` |
| машиночитаемый контракт API | [`docs/api-contract.json`](docs/api-contract.json) — экспорты, методы цепочки, тексты ошибок, снесённые имена (генерируется) |
| сравнение с аналогами | [`COMPARISON.md`](COMPARISON.md) |
| работать над самой библиотекой | [`AGENTS.md`](AGENTS.md) — карта проекта для агента (atlas): модули, трассы сценариев, протокол |

## Структура репозитория

```
lib/            ← сам npm-пакет (src, sql, scripts, test, bench)
docs/atlas/     ← трассы сценариев (F-*); карточки модулей — .claude/rules/atlas/ (M-*)
db/             ← скрипт репозитория apply.mjs — обёртка над up() для CI
```

Пакет — это `lib/`; в корне репозитория `package.json` нет.

## Разработка

```bash
cd lib
npm ci
npm run typecheck        # tsc --noEmit
npm run check:docs       # сверка документации с кодом (версии, ссылки, список тестов, контракт API, имена)
npm test                 # весь набор против живого PostgreSQL 18
```

Тесты интеграционные, без моков базы: обвязка сама поднимает контейнер `letopis-pg18` (`postgres:18`, порт 15433),
если база не отвечает. `ENTITY_DSN` и `ENTITY_APP_DSN` переопределяют подключения.
