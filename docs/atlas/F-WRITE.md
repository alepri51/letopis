# F-WRITE — План записи
Процессы: [N] Node-процесс приложения · [P] PostgreSQL + TimescaleDB
Триггер: `await t.Org(orgId).Folder().create({ name: 'a' }).rows()`; `await t.Folder(id).update({ name: 'b' }).rows()`
synced: 99a28e0

## Сборка (синхронно, без БД)
1. [N] `lib/src/chain.ts:classProp` — вызов класса = шаг; переход `Org→Folder` проверяется сразу (`resolveHop`).
2. [N] `lib/src/chain.ts:makeChain#«case 'create':»` — create на pivot или с фильтром-объектом — ошибка; `withOp` вешает op на последний шаг.
3. [N] `lib/src/chain.ts:makeChain#«case 'rows':»` — есть op → `runPlan`; каждый терминал исполняет план заново (повторный `.rows()` — ещё запись).

## Транзакция
4. [N] `lib/src/write.ts:inTransaction` — `ctx.sql.begin` с `inTx: true`; 40P01/40001 → повтор всего плана, до 3 попыток; иное — ROLLBACK и наружу.
5. [N] `lib/src/write.ts:runPlan#«if (i === 0)»` — `splitPlan`: сегменты и хвост; сегмент 0 → `opCall`, следующие — от каждой строки результата.

## create (`createOp`)
6. [N] `lib/src/write.ts:aclWrite` — при enforceAcl: deny — ошибка, предикат пришпиливает owner/account (F-ACCESS).
7. [N] `lib/src/write.ts:resolveSlots` — слоты: id как есть, план — в этой транзакции, ровно одна сущность; конец-союз снимается целиком.
8. [N] `lib/src/write.ts:resolvePathEnds` — предок-конец даёт links: `Org(orgId)` → `{Org: orgId}` без запроса, фильтр-объект — чтение ровно одной сущности; слоты перекрывают путь.
9. [N] `lib/src/write.ts:createOp#«cls.idGen.version === 5»` — v5: id считает `v5Id`, явный — ошибка; иначе `Класс(id)` или `data.id`.
10. [N] `lib/src/write.ts:createOp#«if (found.length) return versionRows»` — явный id найден путём → новая версия (шаг 19); при ACL-предикате probe без него: id занят недоступной строкой → тихий `[]`. Без id — `genId` (v7/v4).
11. [N] `lib/src/write.ts:resolveAccount` — account: `.account()` → `db.as()` → System; owner: `.owner()` → scope → account.
12. [N] `lib/src/write.ts:validate` — fastest-validator `$$strict` (лишнее поле — `ValidationError`), abstract, концы LINK.
13. [N] `lib/src/write.ts:insertOne` → `lib/src/sql.ts:insertSql` — updated = `clock_timestamp()` или `GREATEST(clock_timestamp(), prev + 1µs)`.

## БД (тот же INSERT)
14. [P] `lib/sql/ddl.sql:entity_check` — BEFORE: класс в Schema и не abstract, ключи links — классы, концы LINK.
15. [P] `lib/sql/ddl.sql:entity_collapse` — AFTER, только `meta.history:false`: advisory-xact-lock на id, DELETE старших версий без tombstone и каскада.
16. [P] `lib/sql/ddl.sql:entity_notify` — AFTER, после collapse: `pg_notify`, доставка после COMMIT ⟿ F-WATCH.
17. [N] `lib/src/write.ts:runPlan#«if (tail.length)»` — хвост читается в той же транзакции от id результата (F-READ), иначе `rows` = RETURNING; выход из `begin` — COMMIT.

## update (`updateOp`)
18. [N] `lib/src/write.ts:updateOp` — `aclWrite` + слоты; цели — путь (F-READ), `data.id` — цель при шаге без фильтра; не найдено → `[]`.
19. [N] `lib/src/write.ts:versionRows` — на строку: `deepMerge` листьев, links − снятые + слоты, `validate`, `insertOne` с `prevUpdated`; account/owner — от строки. Далее 14–17.

Состояние: append-only — create = первая строка id, update = новая, актуальна max(updated); no-history — одна строка на id; до COMMIT не видно никому.
Сбои: построение — синхронно; план — `letopis: …` (acl denies, exactly one entity, Entity.account is NOT NULL, validation failed); БД — `ENTITY_CHECK: …`; любая — ROLLBACK всего плана. 23505 (совпал `updated`) уходит наружу: ретрай `insertOne` под `!ctx.inTx`, а план всегда в транзакции (`lib/README.md` §10.12 обещает ретрай).
Логи: своих нет; `lib/src/sql.ts:runQuery` → `onQuery` (`mode` insert/rows), без хука при `slowMs` — `console.warn('letopis: slow query …')`.
Варианты режима:
- update без compare-and-set: параллельные update мерджат патч в одну прочитанную версию, поздний `updated` побеждает, другой патч теряется (проверено прогоном; лок collapse — после merge). Сериализация — `db.begin()` + `tr.lock()` + перечитка (`lib/README.md` §7).
- `db.batch()`: терминал на плане — ошибка; `lib/src/write.ts:executeBatch` — одна транзакция, подряд «чистые» create одного класса (`isPureInsertPlan`) — один multi-VALUES мимо `insertOne`, прочее — `runPlan`; `run()` опустошает очередь до исполнения — откат планы не вернёт.
- `db.begin()` (`lib/src/tx.ts:beginTx`): своё соединение, без ретрая; 40P01/40001 — с хвостом `retry the whole db.begin() block`.
- Слоты `.Класс.set()`, `.unset()` (`lib/src/chain.ts:slotValue`): только сразу после create/update; класс — конец владельца; обязательный конец не снять.
Проверка: `lib/test/plan.test.ts`, `lib/test/core.test.ts`, `lib/test/idgen.test.ts`, `lib/test/no-history.test.ts`, `lib/test/acl.test.ts` (probe), `lib/test/api-full.test.ts` (tx, батч). Потеря патча и 23505 не покрыты.
