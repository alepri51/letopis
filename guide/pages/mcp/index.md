# ИИ-агенты: MCP

## Зачем

ИИ-агенту нужен доступ к данным — но только в пределах прав человека, от имени которого он работает, и с подтверждением человека для удаления.

`createMcpServer(me)` из `letopis/mcp` даёт ИИ-агенту (Claude и другим клиентам MCP) четыре инструмента: `letopis_model` (какие есть классы), `letopis_query` (чтение JSON-цепочкой), `letopis_history` (версии одного объекта с автором и причиной) и `letopis_write` (запись — только с `write: true`). Сервер открывают от **корня квартиры жильца** — того, что открыл его ключ (`db.open`, `db.resume`, `db.accept`): агент работает с правами этого жильца в его квартире и видит только то, что разрешено ему. Консьержу в квартире (`db.in`, `db.as`) агент не открывается — у консьержа полный доступ дома.

## Пример: агент читает и пишет

<Example id="mcp/01-agent-tools" />

## Что внутри: как агент работает с базой

<Flow name="mcp" />

## Опции сервера

`maxRows` и `maxBytes` ограничивают ответ инструмента: агенту не уйдёт вся квартира разом, продолжение — по курсору. `allowAclWrite` разрешает агенту запись в классы прав (правила, ресурсы, прописки, аккаунты, описания классов) — без неё агент, которому в данных подсунули чужие инструкции, не выдаст себе права без человека.

<Example id="mcp/02-options" />

| Опция | По умолчанию | Что делает |
|---|---|---|
| `write` | `false` | инструмент записи `letopis_write` |
| `maxRows` | 100 (1–10 000) | строк в одном ответе; остальное — по курсору, у версий и групп `countBy` — пометка `more` или `truncated` |
| `maxBytes` | 50 000 (1 000–50 000 000) | байт JSON строк в одном ответе; хотя бы одна строка в ответе есть всегда |
| `allowAclWrite` | `false` | писать классы прав `rule`, `Resource`, `member`, `Account`, `Class` и их потомков |

## Агент в отдельной программе: letopis mcp

Клиенту MCP (Claude Code, Claude Desktop, Cursor) сервер отдают по stdio командой `letopis mcp`. Ей нужны пропуск дома и ключ API жильца: жилец выпускает ключ для агента сам — `me.keys.issueApiKey({ name: 'агент' })`, — и агент работает с его правами в его квартире. Отзыв ключа (`me.keys.revoke(id)`) или выписка жильца отключают агента.

```sh
LETOPIS_PASS='<пропуск>' LETOPIS_KEY='<ключ жильца>' npx letopis mcp --write
# то же флагами: npx letopis mcp --pass '<пропуск>' --api-key '<ключ жильца>' --write
```

Без пропуска или ключа команда не стартует — код 2; ключ не подошёл или пропуск устарел — текст в stderr и код 1. В stdout идёт только протокол MCP; журнал letopis — флагом `--log` в stderr. Опций `maxRows`, `maxBytes` и `allowAclWrite` у команды нет: классы прав она не пишет. Нужен пакет `@modelcontextprotocol/server`. Как запустить команду из кода — [«Эксплуатация»](../ops/#ex-ops-03-cli).

## MCP-клиент в процессе

Вызвать инструменты можно и из своего кода, в том же процессе, — например, чтобы проверить, что увидит агент. Нужны два пакета SDK: сервер `@modelcontextprotocol/server` (его использует `letopis/mcp`) и клиент `@modelcontextprotocol/client` — в нём `Client` и транспорт в памяти `InMemoryTransport`.

Программа целиком (`npm i letopis@4 zod @modelcontextprotocol/server @modelcontextprotocol/client` и `npm i -D tsx`; в `package.json` — `"type": "module"`; запуск — `ADMIN_DSN=… npx tsx agent.ts`, где `ADMIN_DSN` — мастер-ключ, строка подключения администратора PostgreSQL):

```ts
import { setup, demolish, connect, type Letter } from 'letopis'
import { hub } from 'letopis/model'
import { createMcpServer } from 'letopis/mcp'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { z } from 'zod'

const ADMIN_DSN = process.env.ADMIN_DSN!   // мастер-ключ: строит дом
const Note = hub('Note', { text: z.string() })

// учебный дом — каждый запуск заново; setup() строит его с моделью и отдаёт пропуск консьержа
await demolish(ADMIN_DSN, 'agent_demo', { quiet: true })
const { pass } = await setup(ADMIN_DSN, 'agent_demo', { models: [Note], quiet: true })
const mail: Letter[] = []                                        // учебный почтальон: письма с приглашениями — в массив
const db = await connect(pass, { postman: async (letter) => { mail.push(letter) } })   // консьерж
await db.createTenant('Ромашка')
await (await db.in('Ромашка')).invite({ email: 'anna@romashka.ru' }, ['owner'])       // письмо со ссылкой — почтальону
const letter = mail.at(-1)!.message
const anna = await db.accept(letter.kind === 'invite' ? letter.token : '', { name: 'Анна' })   // корень квартиры Анны

// сервер и клиент MCP в одном процессе, связанные транспортом в памяти: агент получит ровно права Анны
const server = await createMcpServer(anna, { write: true })
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

## MCP по HTTP в своём сервере

В веб-сервисе сервер MCP отдают обработчиком `createMcpHandler(() => createMcpServer(me))` из `@modelcontextprotocol/server`. Кто вызывает агента, решает ваше приложение: по cookie вкладки — корень квартиры `db.resume(token)`, по ключу API в заголовке `Authorization` — `db.open({ apiKey })`; корень на запрос и передаётся в `createMcpServer`. Так сделан помощник в сервисе [Helpdesk](../services/helpdesk) — адрес `/mcp`.

## Подводные камни

- **Агент — только жилец.** Консьерж в квартире (`db.in`, `db.as`) — `user_session_required`; транзакция `begin()` — `invalid_query`; подключение в обход прав — `bypass_rls`.
- **Правка — только с `rev`:** агент обязан передать версию, которую прочитал, иначе он затёр бы чужую правку.
- **Удаление требует подтверждения человека** (запрос подтверждения клиенту MCP); клиент, который не умеет его передать, получает `confirmation_required`.
- **Ответ — данные, а не инструкции:** текст из базы помечен как недоверенный, чтобы агент не исполнял «указания» из данных.
- **Пределы.** У ответа ограничены число строк и байт, у цепочки — число шагов (16) и условий `$or` (64). Время запроса ограничьте сами — параметром `statement_timeout` в базе.
- **`letopis_history` отдаёт только версии** одного объекта (`kind` — необязательный, только `versions`): последние в пределах ответа, от старой к новой, `more: true` — есть и более ранние.
- **Неизвестная опция `createMcpServer()` — отказ** `invalid_data` с похожими именами; неизвестный класс, роль, поле, параметр или оператор в вызове инструмента — ответ `isError` с подсказкой похожих имён.
- **Сервер по stdio в своём процессе** пишет в stdout только протокол: не передавайте консьержу `log: console` — `console.info` пишет в stdout и ломает протокол; журнал — в stderr или файл.

## Где это в сервисах

Helpdesk встраивает сервер MCP: помощник во вкладке и внешний ИИ-агент по ключу API читают заявки и отвечают на них с правами того сотрудника, от чьего имени работают.
