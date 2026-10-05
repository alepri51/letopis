---
paths:
  - 'lib/src/{write,tx,uuid}.ts'
synced: 99a28e0
---
# M-WRITE — план записи, id, батч, транзакции

**Инварианты и грабли**
- `update()` = прочитать latest → `deepMerge` → INSERT, без compare-and-set: при двух одновременных update один патч теряется (прогон 2026-09-24: 19 из 20). Защита — `tr.lock(…)` внутри `db.begin()` и перечитка под локом (README §7).
- `create()` с известным id (`Класс(id)` / `data.id` / v5) при enforceAccount ищет его под account вызывающего: чужая сущность «не найдена» → INSERT версии с account вызывающего. У владельца сущность пропадает, `.versions()` второго арендатора видит обе версии, его `delete({confirm})` каскадом задевает данные владельца (прогон 2026-09-24). Проба `lib/src/write.ts:createOp#«if (target.aclFilter) {»` снимает ACL-предикат, но не enforceAccount — от чужого арендатора не защищает. Чинить здесь; симптом — в чтении (M-QUERY).
- Класс записи берётся из шага (`target.cls`), не из `row.class`. README §3.3 обещает «каждую строку в её собственном классе», а по коду update/anonymize на полиморфном шаге валидируют и пишут версию потомка классом шага (abstract → ошибка, лишние поля → ValidationError), delete/purge ищут (класс шага, id) и потомков не трогают. Прогоном не проверено; обход — `.exact()` или шаг по листу.
- Операции идут только через `inTransaction` (`runPlan`, `executeBatch`) с `inTx: true`, поэтому ретрай 23505/transient в `insertOne` мёртв: transient повторяется целым планом, а 23505 (PK `(partition, class, id, updated)`) валит план. README §10.12 обещает иное (0.8.0 выключил ретрай внутри транзакций).
- Склейка батча (`isPureInsertPlan` → multi-VALUES) идёт мимо `createOp`: новая проверка create (право, пришпиливание, валидация, account) дублируется в `executeBatch`. v5, `data.id`, слоты — поштучно через runPlan (0.16.0).
- Новая строка: account = `.account()` → `db.as()` → System-аккаунт (`lib/sql/seed.auth.sql`); owner = `.owner()` → `db.as(…, { owner })` → account. update/anonymize сохраняют account/owner найденной строки.
- `updated` версии = `GREATEST(clock_timestamp(), prev + 1µs)` (`lib/src/sql.ts:insertSql`): без `prevUpdated` при отстающих часах новая версия не станет актуальной.
- v5-имя `«pgSchema:partition:класс:from…»` + `LETOPIS_NS` — контракт данных (шпаргалка #14): порядок `from`, имя схемы (v1→v2), партиция, id класса или namespace меняют все id — create теряет идемпотентность, id, вычисленные приложением заранее (README §7), расходятся.
- `db.begin()` держит зарезервированное соединение пула до commit/rollback: забытый tr — утечка (пул `max` 10). Внутри tr ничего не ретраится (aborted); 40P01/40001 получают подсказку `retry the whole db.begin() block`.
- delete-каскад (`closureSql` + триггер entity_delete) идёт по links без account; под enforceAcl DELETE-право проверяется на каждый класс замыкания.

**Что ещё менять вместе**
- Новый глагол записи: `PlanOp.kind` (`lib/src/types.ts`) + `*Op` и `opCall` + продолжение в `runPlan` (`start` после delete/purge) + Proxy-сторона (M-API: case, `ChainCore`, резерв имени, gen-types) + README §6, §11.5 + CHANGELOG. Условия: нужен серверный SQL (ddl.sql и ревизия DDL — M-ENGINE)? с каких строк продолжение? годится ли для батча? Образец 7b28a64 (purge).
- Новый способ генерации id: `lib/src/uuid.ts` + `genId`/`v5Id` + разбор `attributes.id` (M-SCHEMA) + `isPureInsertPlan` + README §3.2. Образец eb8da94 (0.16.0).
- Ретраи и транзакции: tx.ts + `inTransaction`/`insertOne` + `runQuery` (sql.ts) + README §10.12 + `resilience.test.ts`. Образец 5960a72.
- Текст `letopis:`-ошибки в write.ts/tx.ts → `cd lib && npm run api:contract`.

**Неимпортные связи**
- `lib/src/tx.ts:lock` ↔ `lib/sql/ddl.sql` (entity_delete, purge()): одна формула `hashtextextended(a|b|c, 0)` — `tr.lock(partition, class, id)` берёт тот же лок, что серверное удаление/purge этой сущности.
- `deleteSql`/`purgeCallSql` — только вызов: tombstone, каскад, двухфазность purge, `SET LOCAL letopis.purge` — в ddl.sql (M-ENGINE). no-history класс: после INSERT версии триггер entity_collapse удаляет прежние строки id (99a28e0).
- Каждый INSERT версии будит `pg_notify` (entity_notify) → подписчики `watch()`.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `plan` (звенья, fan-out, откат, батч), `idgen` (v4/v5/v7, гарды create/update, слоты), `parity` (валидация либа ↔ голый SQL), `core` (гонка двойной брони, tx/lock), `resilience` (40P01 встречных lock), `wave5` (purge), `acl` (пришпиливание owner), `no-history`. Lost update и чужой id тестами не покрыты.

**Точки входа**
- `lib/src/write.ts:runPlan` — сегменты, fan-out, хвост-чтение, одна транзакция
- `lib/src/write.ts:createOp` — явный/вычисленный id: версия или INSERT
- `lib/src/write.ts:executeBatch` — очередь батча, склейка multi-VALUES
- `lib/src/write.ts:inTransaction` — внутренняя транзакция + ретрай transient
- `lib/src/tx.ts:beginTx` — `db.begin()`: зарезервированное соединение

**Не здесь**
- SQL чтения целей, строители INSERT/DELETE → M-QUERY; Proxy, слоты `.Класс.set()`, терминалы → M-API; ACL-решения → M-ACL; валидатор и idGen из Schema → M-SCHEMA; триггеры → M-ENGINE.
