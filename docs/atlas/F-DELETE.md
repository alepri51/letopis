> **Описывает 0.21 (тег `v0.21.0`).** В letopis 1.0 трасса переписывается в своём этапе плана `reports/PLAN-LETOPIS-1.0.md`; до этого она не описывает действующий код.

# F-DELETE — Удаление, каскад и физическое стирание
Процессы: [N] приложение · [P] PostgreSQL
Триггер: `t.Org(id).delete().rows()` (превью) → `.delete({ confirm: true })` → `.purge({ confirm: true })`; `(await db.as(caller)).accounts.purge(id)`.

## Удаление
1. [N] `lib/src/chain.ts:makeChain#«case 'delete':»` — op на последний шаг; терминал при op → `runPlan`.
2. [N] `lib/src/write.ts:runPlan` — план одной транзакцией; вне `db.begin()` повтор на 40P01/40001.
3. [N] `lib/src/write.ts:aclWrite` — enforceAcl: DELETE на класс цели; row-предикат сужает поиск целей.
4. [N] `lib/src/write.ts:readRows` — цели обычным чтением (арендатор, READ-ACL, полиморфно). Пусто → `[]`.
5. [P] `lib/src/sql.ts:closureSql` — цели + живые зависимые (актуальная версия с `links @> {класс: id}`); фильтр только `partition` — арендатор не учитывается. Цели по `class = $2` (класс шага): потомки из шага 4 выпадают.
6. [N] `lib/src/write.ts:delOp#«if (!confirm) return closure»` — превью: замыкание как есть (и чужие строки), ACL каскада не проверяется.
7. [N] `lib/src/write.ts:delOp#«в каскаде от»` — DELETE-allow на каждый класс замыкания, deny → откат плана; row-предикат к каскаду не применяется.
8. [P] `lib/src/sql.ts:deleteSql` — один `DELETE` по целям.
9. [P] `lib/sql/ddl.sql:entity_delete` — BEFORE DELETE, если `letopis.purge` ≠ `on`; advisory-lock `partition|class|id` (тот же ключ у `purge()`, `entity_collapse`, `lib/src/tx.ts:lock`); не актуальная версия или tombstone → игнор.
10. [P] `lib/sql/ddl.sql:entity_delete#«-- tombstone-версия»` — INSERT tombstone → `entity_collapse` (no-history: прежние версии стёрты), `entity_notify` ⟿ F-WATCH.
11. [P] `lib/sql/ddl.sql:entity_delete#«каскад: живые зависимые»` — DELETE живых с `links @> {OLD.class: OLD.id}` в partition, без `account` → рекурсия; `RETURN NULL` — физически не удаляет.
12. [N] `lib/src/write.ts:delOp#«return closure.map((r) => ({»` — результат = замыкание шага 5 с `$deleted: true`; продолжение плана — от строк класса цели.

## Стирание
13. [N] `lib/src/write.ts:purgeOp` — `aclWrite` только на класс цели; цели `withDeleted: true`; `lib/src/sql.ts:purgeCallSql` на каждую, `dry = !confirm`.
14. [P] `lib/sql/ddl.sql:purge#«двухфазность: hard-purge»` — тот же lock; корень не tombstone → 0 строк: `.purge()` живой даёт `[]` без ошибки.
15. [P] `lib/sql/ddl.sql:purge_closure` — по `links` всех версий, без `deleted` и `account`: попадает и живая сущность, ссылавшаяся на корень в любой версии.
16. [P] `lib/sql/ddl.sql:purge#«IF p_dry THEN»` — dry: актуальные версии замыкания; иначе `SET LOCAL letopis.purge='on'` → DELETE всех версий мимо триггера, флаг сброшен.

## Офбординг
17. [N] `lib/src/tables.ts:makeTables#«async purge(id)»` — не себя; вызывающий Owner/System; последний enabled Owner (по всей схеме) — отказ. Мимо `runQuery` и ACL.
18. [P] `lib/sql/ddl.sql:purge_account` — под флагом DELETE Entity `account|owner = id` во всех partition, без каскада по links (чужие ссылки повисают); Account, Credential — FK-каскадом.

Состояние: живая → +версия-tombstone (история цела; повтор → `[]`; `create()` с тем же id воскрешает; no-history — одна строка). Purge: ни одной версии корня и замыкания.
Сбои: `letopis: acl denies DELETE on <класс>[ (в каскаде от <класс>)]`; `enforceAccount is on — call db.as(account)…`; `accounts.purge` — `…authenticated caller`, `…itself`, `…Owner/System accounts`, `…last enabled Owner`; схема до 0.19.0 — `function … purge(...) does not exist` (ревизия DDL — F-BOOT).
Логи: `onQuery` — `rows` (цели), `delete` (замыкание — и у превью, DELETE, purge на цель); без `onQuery` при `slowMs` — `letopis: slow query Nms — delete <класс>`. `accounts.purge` событий не даёт; стирание без NOTIFY.
Варианты режима: `enforceAcl` выкл. (по умолчанию) — шаги 3, 7 пусты; в `db.begin()` повтора нет — подсказка «retry the whole db.begin() block»; голый SQL `DELETE` и `SELECT * FROM "<схема>".purge(partition, class, id[, dry])` — шаги 9–11 и 14–16 без ACL.
Проверка: `cd lib && npx tsx --test --test-force-exit test/wave5.test.ts` (purge, accounts.purge); `lib/test/core.test.ts` (нужна `v1.booking`), `lib/test/plan.test.ts` (превью), `lib/test/acl.test.ts` (deny в каскаде). Не покрыты: межарендаторный каскад, row-предикат в каскаде, purge перепривязанной сущности.
