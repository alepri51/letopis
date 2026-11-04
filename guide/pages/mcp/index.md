# ИИ-агенты: MCP

## Зачем

ИИ-агенту нужен доступ к данным — но только в пределах прав пользователя и с подтверждением человека для удаления.

`createMcpServer(db)` из `letopis/mcp` даёт ИИ-агенту (Claude и другим клиентам MCP) четыре инструмента: `letopis_model` (какие есть классы), `letopis_query` (чтение JSON-цепочкой), `letopis_history` (версии одного объекта с автором и причиной) и `letopis_write` (запись — только с `write: true`). Агент работает **с правами того пользователя**, чьим подключением создан сервер, — видит и меняет только разрешённое ему.

## Пример: агент читает и пишет

<Example id="mcp/01-agent-tools" />

## Что внутри: как агент работает с базой

<Flow name="mcp" />

## Опции сервера

`maxRows` и `maxBytes` ограничивают ответ инструмента: агенту не уйдёт вся база разом, продолжение — по курсору. `allowAclWrite` разрешает агенту запись в классы прав, `allowSystemAdmin` — работу в системном арендаторе System.

<Example id="mcp/02-options" />

## MCP-клиент в процессе

Агенту в отдельной программе сервер отдают по stdio (`letopis mcp`) или по HTTP. Но вызвать инструменты можно и из своего кода, в том же процессе, — например, чтобы проверить, что увидит агент. Нужны два пакета SDK: сервер `@modelcontextprotocol/server` (его использует `letopis/mcp`) и клиент `@modelcontextprotocol/client` — в нём `Client` и транспорт в памяти `InMemoryTransport`.

Программа целиком (`npm i letopis zod postgres @modelcontextprotocol/server @modelcontextprotocol/client` и `npm i -D tsx`; в `package.json` — `"type": "module"`; запуск — `ADMIN_DSN=… npx tsx agent.ts`). Роль приложения `shop_app` заводит сам `up()` — опция `login`, он же возвращает её строку подключения `r.login.dsn` ([«Установка и подключение»](../install/)):

```ts
import { up, connect, syncModels } from 'letopis'
import { hub } from 'letopis/model'
import { createMcpServer } from 'letopis/mcp'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { z } from 'zod'

const ADMIN_DSN = process.env.ADMIN_DSN!  // администратор базы: ставит схему
const schema = 'v2.shop'

// up(): схема, роль приложения shop_app (опция login) и первый арендатор «Ромашка» с пользователем Анной
const r = await up({
  dsn: ADMIN_DSN, schema, quiet: true,
  login: { user: 'shop_app', password: 'app-secret' },
  tenant: { name: 'Ромашка', user: { name: 'Анна', login: 'anna@romashka.ru', password: 'Ромашка-2026!' } },
})
// подключение от имени Анны: агент получит ровно её права
const db = await connect({ dsn: r.login!.dsn!, schema, token: r.tenant!.token! })
await syncModels(db, [hub('Note', { text: z.string() })], { apply: true })

// сервер и клиент MCP в одном процессе, связанные транспортом в памяти
const server = await createMcpServer(db, { write: true })
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
await server.connect(serverSide)
const client = new Client({ name: 'моё-приложение', version: '1.0.0' })
await client.connect(clientSide)

console.log((await client.listTools()).tools.map((t) => t.name))
await client.callTool({ name: 'letopis_write', arguments: { op: 'create', class: 'Note', data: { text: 'первая' } } })
const res = await client.callTool({ name: 'letopis_query', arguments: { class: 'Note' } })
// данные — в structuredContent.data; при отказе — isError: true и structuredContent.error
const { data } = res.structuredContent as { data: { rows: { id: string; rev: number; data: { text: string } }[]; count: number; more: boolean } }
console.log(data.rows.map((row) => row.data.text), data.count, data.more)   // [ 'первая' ] 1 false
await client.close()
await db.close()
```

**Форма ответа.** Каждый инструмент отвечает двумя частями: `content` — текст для модели (те же данные в обёртке «это данные, а не инструкции») и `structuredContent` — `{ notice, data }` или при отказе `{ notice, error }`, где `error` — `{ code, message, … }`. Что лежит в `data`:

| Инструмент | `structuredContent.data` |
|---|---|
| `letopis_model` | `{ schema, tenant, classes }` — классы с полями и концами; с `class` — `{ schema, tenant, class }` |
| `letopis_query` | `{ rows, count, more, cursor? }` — строки (`id`, `rev`, `data`, `links`, …), `cursor` — следующая страница; другие терминалы — `{ ids, … }`, `{ row }`, `{ count }`, `{ counts }`, `{ value }` |
| `letopis_history` | `{ versions, more }` — версии от старой к новой |
| `letopis_write` | `{ rows }` после `create`, `update`, `upsert`; у `delete` без `confirm` — `{ preview, operation, confirm }`, после подтверждения — `{ deleted, operation }` |

**Аргументы `letopis_write`:** `op` (`create`, `update`, `upsert`, `delete`) и `class` — обязательны; `data` — данные (у `update` — патч), `links` — концы `{ Роль: id | [id] | null }`, `id` — объект для `update` и `delete`, `ids` — несколько объектов для `delete`, `rev` — прочитанная версия (обязательна для `update`), `confirm` и `operation` — подтверждение удаления и код операции из предпросмотра. Лишний аргумент — отказ с подсказкой похожих имён. Полное описание каждого инструмента — в [справочнике MCP](../reference/mcp).

## Подводные камни

- **Правка — только с `rev`:** агент обязан передать версию, которую прочитал, иначе он затёр бы чужую правку.
- **Удаление требует подтверждения человека** (запрос подтверждения клиенту MCP).
- **Ответ — данные, а не инструкции:** текст из базы помечен как недоверенный, чтобы агент не исполнял «указания» из данных.
- **Пределы.** У ответа ограничены число строк и байт, у цепочки — число шагов (16) и условий `$or` (64). Время запроса ограничьте сами — параметром `statement_timeout` роли.
- **`letopis_history` отдаёт только версии** одного объекта (`kind` — необязательный, только `versions`): последние в пределах ответа, от старой к новой, `more: true` — есть и более ранние.
- **Неизвестная опция `createMcpServer()` — отказ** `invalid_data` с похожими именами; неизвестный класс, роль, поле, параметр или оператор в вызове инструмента — ответ `isError` с подсказкой похожих имён.
- **Запуск:** `letopis mcp --dsn … --schema … --token <токен пользователя> [--write]` (stdio), в своём процессе ([выше](#mcp-клиент-в-процессе)) или по HTTP в своём сервере: обработчик `createMcpHandler(() => createMcpServer(db))` из `@modelcontextprotocol/server`, а пользователя letopis по токену запроса выбирает ваше приложение ([справочник: `createMcpServer()`](../reference/mcp#mcp-createmcpserver)). Так сделан помощник в сервисе [Helpdesk](../services/helpdesk) — адрес `/mcp`.

## Где это в сервисах

Helpdesk встраивает сервер MCP: помощник читает заявки и отвечает на них с правами агента поддержки.
