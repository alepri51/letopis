---
paths:
  - 'lib/sql/ddl.sql'
  - 'db/policies.mjs'
synced: 99a28e0
---
# M-ENGINE — движок в PostgreSQL

**Инварианты и грабли**
- Append-only держится на триггере, а не на правах: GUC `letopis.purge='on'` (WHEN у `entity_delete`) может выставить любая роль, и тогда `DELETE` сносит строки физически, без tombstone и каскада (по коду). Новый физический DELETE делай только под этим флагом и с save+restore прежнего значения, как в `entity_collapse` (0.21.0).
- `entity_check` проверяет только одно: ключ `links` — класс схемы, значение — строка. Существование цели, принадлежность id арендатору, HUB-концы (`Staff → Org`) и `cardinality` триггер не проверяет — это делает либа (M-WRITE, M-ACL). Голый SQL пишет висячие ссылки (по коду).
- Уникальность id в БД не гарантирована: в PK входит `updated` (требование hypertable), так что две вставки одного id — это две версии. Advisory-lock `partition|class|id` берут только `entity_delete`, `entity_collapse` (no-history) и `purge`.
- Retention (`db/policies.mjs --retain`) дропает чанки по `updated`. Сущность, у которой единственная версия старше горизонта, исчезает целиком вместе с актуальным состоянием (прогон 2026-09-24). У класса с `meta.history:false` (одна строка на id) так пропадает всё, что не менялось дольше горизонта. Ссылки на исчезнувшее остаются висячими: FK на `links` нет.
- Таблицы создаются через `CREATE TABLE IF NOT EXISTS`, поэтому правка колонки или CHECK в теле таблицы не дойдёт до существующих схем даже при upgrade. Нужен отдельный идемпотентный `ALTER … IF NOT EXISTS` или новая `version` схемы (lib/README.md §10.8a). Если убрать функцию или триггер из файла, в живой схеме они останутся — нужен явный `DROP … IF EXISTS` (так снят `entity_no_update`).
- Повторный накат дорогой: `DROP`+`ADD` `entity_account_fk`/`entity_owner_fk` дважды проверяет всю историю под `AccessExclusiveLock` на `Entity`, каждом чанке и `Account`. Это ~0.6–0.8 с на 1 млн строк, рост линейный (BACKLOG.md «Цена повторного наката ddl.sql»).
- Штамп `COMMENT ON SCHEMA` — последнее выражение файла (check-docs; ниже допустимы только комментарии). Новые операторы ставь выше штампа.
- `db/policies.mjs` с `--schema` принимает полное имя (`v1.booking`), а `db/apply.mjs` — базовое имя и `--version`.

**Что ещё менять вместе**
- Новая функция, триггер или индекс (аддитивно): `lib/sql/ddl.sql` в идемпотентной форме + ревизия в трёх местах: `-- DDL_REVISION: N`, штамп, `DDL_REVISION` в `lib/src/types.ts` (check-docs п.7). Плюс `lib/CHANGELOG.md` + version в `lib/package.json`, lib/README.md §2.2/§10.8a. Вопросы: зовёт ли её либа SQL-строкой (`lib/src/sql.ts`, `lib/src/tables.ts`)? Новый AFTER INSERT на `Entity` встанет по алфавиту до или после `entity_notify`? Удаляет физически — под флагом? Изменился публичный API — тогда `npm run api:contract`. Образцы: `99a28e0`, `7b28a64`.
- Изменение сигнатуры или семантики серверной функции: поправить строки вызова (`lib/src/sql.ts:purgeCallSql`, `purge_account` в `lib/src/tables.ts`), тесты `core`/`wave5`/`no-history`, поднять ревизию — иначе `connect()` не предупредит старые схемы.
- Структура таблицы: см. грабли. Образец `9eecd02` (Schema.links → jsonb: ddl.sql, seed.booking.sql, schema.ts, schema-sync.mjs, тесты).
- Удаление: `DROP … IF EXISTS` в ddl.sql, строки вызова в `lib/src` (grep имени) и ревизия.

**Состояние и побочки**
- Каждая вставка в `Entity` (включая tombstone и каскад) → `pg_notify`. Каскад `entity_delete` рекурсивный и выполняется в той же транзакции.
- `db/policies.mjs` переустанавливает job'ы Timescale (`remove_*` + `add_*`); `--retain` необратим. Скрипт импортирует `postgres` из lib/node_modules (нужен `npm ci` в `lib`); в npm-пакет не входит.

**Неимпортные связи**
- `entity_notify` ↔ `lib/src/chain.ts:makeDb#«.listen(ctx.pgSchema»`: канал — литерал полного имени схемы (на чанке `TG_TABLE_SCHEMA` = `_timescaledb_internal`), payload без `data`.
- Штамп `letopis ddl_revision=N` ↔ `lib/src/types.ts:parseDdlRevision` ↔ `lib/src/index.ts:checkDdlRevision` (warn раз на схему за процесс) ↔ `lib/scripts/check-docs.mjs`.
- Ключ `hashtextextended('partition|class|id', 0)` ↔ `lib/src/tx.ts:lock`: `lock(partition, class, id)` даёт тот же ключ, что у триггеров.
- `meta->>'abstract'` и `meta->>'history'` читаются текстом ↔ реестр `lib/src/schema.ts` (ClassDef.history).
- `"<SCHEMA-NAME>"` подставляют `lib/src/up.ts:applySchema` и `db/apply.mjs` (M-BOOTSTRAP).

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `core` (UPDATE = версия, DELETE = tombstone + каскад), `no-history`, `wave5` (purge), `wave3` (watch), `wave4` (сжатие через policies.mjs), `up` (ревизия/upgrade). Тестами не покрыты retention, обход через GUC и висячие `links`.
- `cd lib && npm run check:docs` (ddl-revision). Сигналы: `obj_description` схемы, warn «движок схемы … отстал», сырые `ENTITY_CHECK: …` (либа их не маппит).

**Точки входа**
- `lib/sql/ddl.sql:entity_check` — валидация INSERT
- `lib/sql/ddl.sql:entity_delete` — tombstone + каскад
- `lib/sql/ddl.sql:entity_collapse` — no-history
- `lib/sql/ddl.sql:purge` — двухфазный hard-erase

**Не здесь**
- id, слоты, валидация data → M-WRITE; накат/upgrade/ANALYZE → M-BOOTSTRAP; демо-классы → M-SEEDS; CRUD Account/Credential/Resource/Rule → M-AUTH; чтение актуального → M-QUERY
