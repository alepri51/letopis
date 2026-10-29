# Переход с 0.21

letopis 1.0 — новая реализация на PostgreSQL 18: три таблицы вместо прежних, права и арендаторы проверяет база, сессии хранятся в ней же. Код с 0.21 не ломается молча: всё снятое бросает ошибку `removed` с подсказкой, чем заменить. Данные переносит команда `letopis import` ([глава 13](../load/#импорт-из-letopis-0-21)). Подробный перечень изменений — `lib/MIGRATION.md` в репозитории.

## Пример: снятое API и подсказки

<Example id="migrate/01-removed-api" />

| Было в 0.21 | Стало |
|---|---|
| `connect({ partition })` | отдельная схема установки: `up({ schema: 'имя' })` → `v2.имя` |
| `enforceAccount`, `enforceAcl` | изоляция арендаторов (RLS) и права включены всегда |
| `container`, `image`, `dataDir`, `redisPort` | Docker и Redis не нужны: `up()` ставит схему в вашу базу, сессии — в ней |
| `.account(…)` в цепочке | арендатор сессии; другой — `auth.switch()` или `db.as(…, { tenant })` |
| `execute()`, `run()` | `paths()`, `rows()` и другие окончания цепочки |
| `batch.execute()` | `batch.run()` |
| `compact()` | политика хранения `history` и `db.trimHistory(цель, момент)` |
| `reloadSchema()`, `acl.reload()` | реестр и права обновляются сами по сигналу; принудительно — `db.refresh()` |
| `auth.sessions(store)` | сессии в базе: `sessionFor`, `refresh`, `revoke`, `revokeAll` |
| `watch(cb)`, `watch('Класс', cb)` | `watch({ from, classes })` — подписка по курсору |
| `load({ trust })` | проверка целей вне загрузки стоит доли процента — всегда включена |
| `uuidv7()`, `LETOPIS_NS` | id вычисляется из ключа: `idOf(класс, ключ, { tenant })`, `uuidv5()` |
| `db.accounts`, `db.credentials`, `db.resources`, `db.rules` | системные классы `Account`, `Resource`, `rule`, `member` и `db.auth` |

## Подводные камни

- **`count()` стал числом сущностей**, а не путей: число путей — `count({ paths: true })`.
- **`purge()` — стирание истории уже удалённой сущности**; удалить аккаунт — `db.auth.purgeAccount`.
- **Классы, записанные `syncModels`, принадлежат арендатору**; общие для всех — классы System (сиды установки, импорт).
- **Импорт проверяет всё до первой записи**: класс с нарушенным в 0.21 ключом переносят с `--keyless`.
