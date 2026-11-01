---
paths:
  - 'lib/sql/70-read.sql'
  - 'lib/src/{sql,ops}.ts'
  - 'lib/sql/75-history.sql'
synced: f20b1cf
---
# M-QUERY — поиск id под RLS (find_*), построитель чтения, diff и blame

**Инварианты и грабли**
- Узел обратного перехода в срезе `asOf()` и с надгробиями `withDeleted()` строится из пар переходов `(источник, цель)` через `logPart` — пары берутся `distinct` по `(id, rev)`, иначе объект, ссылающийся на несколько объектов прошлого шага, удваивал `rows()`, `count()` и итоги (`lib/src/sql.ts`, ветка обратного перехода; пример `history/01`, шаг 6). `min`/`max` по листу `boolean` — `bool_and`/`bool_or`: у `boolean` в PostgreSQL нет `min` и `max`.
- Функции владельца (`find_*`, `version_paths`) идут без RLS и фильтруют сами: `row_visible(…)` с планом `acl_actor('READ')` — копия условия политик `entity_select` и `log_select` (`lib/sql/50-acl.sql`). Меняешь видимость — политики и `row_visible` вместе, здесь — колонки, которые подзапросы передают в `row_visible`. Расхождение ловят `find-ids-parity` (режим `direct` в `buildRead`) и `history` («…скрытая условием ACL…»).
- `find_ids` по классу, данным и концам берёт строки только арендатора сессии и System (`v_tenants`), свои членства в других арендаторах — ветками `member` по концу User: это повтор правила арендаторов из `row_visible`. Расширишь межарендаторную видимость там — поправь эти ветки, иначе строки пропадут молча (37bc6c4; `find-ids-parity`, `explain` — индекс `log_class_tenant_at`).
- Срез на момент: последняя версия id выбирается среди всех его версий, класс проверяется у неё — в `find_ids` (ветки по id и по классу), `log_refs_at`, режиме `direct` построителя и `trim_history` по классам (план 2.0, 7.1 №1). Фильтр класса до `distinct on`/`limit 1` после смены класса без смены id оставлял объект в прежнем классе; кандидатов по-прежнему ищет индекс по классу.
- Пути `log.changed` — сохранённые данные (null — не посчитано): `blame` берёт их через `version_paths` и смешивает с путями, которые для прочих пар досчитывает `row_changes`. Формат `change_paths` и досчёта обязан совпадать; записанное не пересчитывается — сменишь формат, и старые версии разойдутся с досчётом (`history` «1б: … blame одинаков с колонкой и с досчётом»).
- Порядок версий в истории — `(at, seq)`, а не `rev`: с `follow` и после переноса id идут версии разных id, равные `at` разводит `seq`.
- Надгробие — всегда `op = 'delete'`, у переноса id ещё и `moved` не null: по нему срезы и withDeleted узнают удалённый id, а `diff` и `blame` пропускают перенос.
- Помощники `jsonb_changes`, `row_changes`, `change_paths`, `row_leaves` — `begin atomic`: тело разбирается при установке, ссылаться можно только на уже созданное (файлы с меньшим номером, не `lib/sql/90-time.sql`).

**Что ещё менять вместе**
- Новая функция для приложения: права — `do $$` и `grant` в конце файла, белый список в `lib/test/roles.test.ts`; у функции владельца (`security definer`) — там же проверка «без сессии — пусто», у `find_*` — ещё режим `direct` в `buildRead`.
- Новый оператор фильтра: `lib/src/ops.ts`, `compileOp`, `chain-read` («18 операторов…»).
- Новый режим чтения: `ReadMode` и ветка в `buildRead` → терминал в `lib/src/chain.ts:makeChain`; в `lib/src/types.ts` — `CHAIN_METHODS` (из него же зарезервированные имена), `ChainMods`, `QueryEvent.mode`; чтение после глагола — `lib/src/write.ts:execPlan`. Образец — c199d09.
- Колонка журнала: `grant select (…) on log` в `lib/sql/10-core.sql` и `lib/src/sql.ts:LOG_COLS` — один список; `changed` в нём нет, поэтому `select *` и `l.*` по журналу от приложения падают.
- Новая служебная запись журнала (не версия, как `purge`, `trim`, `reset`): все исключения — grep `'purge', 'trim', 'reset'` по `lib/sql` и `lib/src`.

**Неимпортные связи**
- `change_paths` (→ `row_changes` → `jsonb_changes`) вызывают `lib/sql/60-write.sql:log_version` и `lib/sql/60-write.sql:trg_entity_au` на каждой записи версии: цена помощников — цена записи (`history` «row_changes без квадрата…»).
- Время в ответах — UTC: пояс ставит `lib/src/tx.ts:setupSql`; построитель и функции истории отдают `at` как есть.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `chain-read`, `find-ids-parity`, `explain`, `chain-api` (курсоры, keyset с null, кэш плана), `history`, `roles`, `engine-attacks` (№27).
- Скорость: `cd lib && BENCH_SCALE=0.1 npx tsx bench/chain-read.mjs` (широкий запрос — не медленнее владельца вдвое); `cd lib && npx tsx bench/history.bench.mjs` (порог плана — blame по 1000 версиям до 100 мс).

**Точки входа**
- `lib/sql/70-read.sql:find_ids` — поиск id шага
- `lib/sql/70-read.sql:find_hop` — обратный переход
- `lib/src/sql.ts:buildRead` — запрос цепочки во всех режимах
- `lib/src/sql.ts:resolveHop` — направление перехода
- `lib/sql/75-history.sql:diff_versions` — различия версий
- `lib/sql/75-history.sql:blame` — кто и почему менял поля

**Не здесь**
- политики и `row_visible` → M-ACCESS; запись журнала и `log.changed` → M-ENGINE; терминалы цепочки → M-API
