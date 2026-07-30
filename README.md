# letopis (летопись)

Темпоральное **append-only** хранилище сущностей поверх PostgreSQL 17 + TimescaleDB.
Каждое изменение — новая строка-версия; история first-class (`asOf`, `versions`, `watch`,
каскадные tombstone). Обход графа — dot-цепочками, схема классов живёт в таблице БД,
auth / ACL / сессии встроены.

```bash
npm install letopis
```

```ts
import { up } from 'letopis'

const db = await up({ schema: 'booking', version: 1 })   // Docker: TimescaleDB + Redis → PG-схема "v1.booking"

// db — безличный пул: изоляция арендатора включена по умолчанию, цепочки идут ОТ ИМЕНИ
// аккаунта. В вебе scope живёт на запрос: await db.as(req.accountId)
const [sys] = await db.accounts.find({ category: 'System' })
const t = await db.as(sys.id)

const [org] = await t.Организация().create({ name: 'BarberPro' }).rows()
await t.Организация(org).Мастер().create({ name: 'Вася', phone: '+7 900 …' }).rows()
await t.Мастер({ name: 'Вася' }).навык().Услуга().run()   // пути по графу
await db.close()                                          // один раз на пул
```

ESM-only, Node 20+. Рантайм-зависимости: `postgres`, `fastest-validator`
(Redis-клиент внешний, нужен только для сессий). Лицензия MIT.

## Куда идти дальше

| Хочу | Файл |
|---|---|
| **быстро начать / я ИИ-агент** | [`AGENT-CHEATSHEET.md`](AGENT-CHEATSHEET.md) — рабочий цикл на одной странице + частые ошибки |
| полное руководство | [`lib/README.md`](lib/README.md) — §11 API Reference, §12 каталог ошибок, §14 перф, §15 E2E |
| машиночитаемый контракт API | [`docs/api-contract.json`](docs/api-contract.json) — экспорты, поверхность цепочки, снесённые имена (генерируется) |
| работать над самой библиотекой | [`AGENTS.md`](AGENTS.md) — точка входа в слой документации, протокол правок |
| что изменилось | [`lib/CHANGELOG.md`](lib/CHANGELOG.md) — источник истины версии вместе с `lib/package.json` |

## Структура репозитория

```
lib/            ← сам npm-пакет (src, sql, scripts, docker, test, bench)
docs/*.xml      ← машинная карта проекта (модули M-*, use cases, потоки, план проверки)
db/             ← repo-only скрипты: apply.mjs (накат схемы), policies.mjs (Timescale-политики)
```

Пакет — это `lib/`; в корне репозитория `package.json` нет.

## Разработка

```bash
cd lib
npm ci
npm run typecheck        # tsc --noEmit
npm run check:docs       # сверка документации с кодом (версии, ссылки, контракт API)
npm test                 # весь набор против живого docker (TimescaleDB pg17 + Redis)
```

Тесты интеграционные, без моков БД: `up()` сам поднимает контейнер.
`ENTITY_DSN` / `ENTITY_REDIS` переопределяют подключения.
