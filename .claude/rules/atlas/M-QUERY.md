---
paths:
  - 'lib/sql/70-read.sql'
  - 'lib/src/{sql,ops}.ts'
synced: 447fae7
---
# M-QUERY — поиск id под RLS (find_*), построитель чтения

**Инварианты и грабли**
- Узел обратного перехода в срезе `asOf()` и с надгробиями `withDeleted()` строится из пар переходов `(источник, цель)` через `logPart` — пары берутся `distinct` по `(id, rev)`, иначе объект, ссылающийся на несколько объектов прошлого шага, удвоит `rows()`, `count()` и итоги (`lib/src/sql.ts`, ветка обратного перехода). `min`/`max` по листу `boolean` — `bool_and`/`bool_or`: у `boolean` в PostgreSQL нет `min` и `max`.
- Функции владельца (`find_*`) идут без RLS и фильтруют сами: `row_visible(…)` с планом `acl_actor('READ')` — копия условия политик `entity_select` и `log_select` (`lib/sql/50-acl.sql`). Меняешь видимость — политики и `row_visible` вместе, здесь — колонки, которые подзапросы передают в `row_visible`. Расхождение ловит `find-ids-parity` (режим `direct` в `buildRead`).
- `find_ids` по классу, данным и концам берёт строки только арендатора сессии и System (`v_tenants`), свои членства в других арендаторах — ветками `member` по концу User: это повтор правила арендаторов из `row_visible`. Расширишь межарендаторную видимость там — поправь эти ветки, иначе строки пропадут молча (37bc6c4; `find-ids-parity`, `explain` — индекс `log_class_tenant_at`).
- Поле фильтра (и внутри `or()`), `sort('data.…')` и агрегата `checkField` ищет в описаниях всех классов шага (`typingOf`: потомки без `exact()`, у роли — её цели; в фильтре годится и роль конца; сверяется первый ключ пути); нет ни в одном — `invalid_query` (`query.unknown_field`) с похожими. Поля строк `Class` — список `CLASS_ROW_FIELDS`: их `data` проверяет метасхема, а в описании `Class` только `name`.
- Курсор `after()` — keyset в порядке `order by`: поле `sort`, id строки и разделители равных — `rev` в `versions()` и id прочих узлов пути в `paths()` (`buildRead`: `after(a, ties)`, `orderBy(a, more)`). Порядок и условие курсора меняют вместе, иначе страницы теряют или повторяют строки (план 2.0, 7.1 №3–4; `read-contract`). Ключи пути — `BuiltQuery.keys`: шаги по порядку, узел последнего шага последним; терминал `paths()` собирает объект в этом порядке, и по нему `cursorOf(путь, поле)` находит последний узел.
- Условие по id фильтра (`asFrags`): один id — `x.id = $n::uuid`, несколько — `= any ($n::uuid[])`. Общий план подготовленного запроса для `= any` PostgreSQL считает на ~10 элементов, и при неудачной выборке ANALYZE чтение по ключу остаётся на планах под вызов — 0,5–0,8 мс планирования на каждое чтение (замер 02.11.2026); общий план равенства стоит как план вызова. Параметры функций (`find_ids(…, ids uuid[], …)`) — массивом.
- Надгробие — всегда `op = 'delete'`: по нему срезы и withDeleted узнают удалённый id.

**Что ещё менять вместе**
- Новая функция для приложения: права — `do $$` и `grant` в конце файла, белый список в `lib/test/roles.test.ts`; у функции владельца (`security definer`) — там же проверка «без сессии — пусто», у `find_*` — ещё режим `direct` в `buildRead`.
- Новый оператор фильтра: фабрика и запись реестра `OPERATORS` в `lib/src/ops.ts` (ключ MCP, вид значения `OpArg`, смысл `ru`; один словарь фильтров — план 2.0, 7.9 №8), `compileOp`, `chain-read` («18 операторов…»), случай в `llms` (№8); затем `cd lib && npm run ops:tables` — таблицы README, шпаргалки и главы «Чтение» сайта (`guide/pages/read/index.md`, без колонки MCP), и `cd guide && npx tsx scripts/gen-api.ts` — справочник сайта. Таблицы руками не правят: их сверяет `check:docs` (`ops`).
- Отказ построителя по шагу, которому не нужны база и путь, — в `compileFilter`/`checkField` или ещё и в `precheckStep`: его зовёт `lib/src/write.ts:precheckPlan`, чтобы план записи отказал до первого оператора и ошибка не сломала `db.begin()`.
- Новый режим чтения: `ReadMode` и ветка в `buildRead` → терминал в `lib/src/chain.ts:makeChain`; в `lib/src/types.ts` — `CHAIN_METHODS` (из него же зарезервированные имена), `ChainMods`, `QueryEvent.mode`; чтение после глагола — `lib/src/write.ts:execPlan`. Образец — c199d09.
- Колонка журнала: `grant select (…) on log` в `lib/sql/10-core.sql` (приложению выданы все колонки) и `lib/src/sql.ts:LOG_COLS` — один список.
- Служебных записей журнала (не версий) нет: срезы, `withDeleted` и `versions()` считают версией каждую строку журнала. Новая служебная запись → исключение во всех запросах к журналу: `lib/sql/70-read.sql`, `lib/sql/90-time.sql` (`restore`, `class_has_history` в `60-write.sql`), `lib/src/sql.ts`.

**Неимпортные связи**
- Время в ответах — UTC: пояс ставит `lib/src/tx.ts:setupSql`; построитель отдаёт `at` как есть.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `chain-read`, `find-ids-parity`, `explain`, `chain-api` (курсоры, keyset с null, кэш плана), `read-contract`, `roles`, `engine-attacks` (№27).
- Сайт: `cd guide && npm run examples -- --check` — нюансы `asof-reverse-once`, `unknown-field`.
- Скорость: `cd lib && BENCH_SCALE=0.1 npx tsx bench/chain-read.mjs` (широкий запрос — не медленнее владельца вдвое).

**Точки входа**
- `lib/sql/70-read.sql:find_ids` — поиск id шага
- `lib/sql/70-read.sql:find_hop` — обратный переход
- `lib/src/sql.ts:buildRead` — запрос цепочки во всех режимах
- `lib/src/sql.ts:resolveHop` — направление перехода

**Не здесь**
- политики и `row_visible` → M-ACCESS; запись журнала → M-ENGINE; терминалы цепочки → M-API
