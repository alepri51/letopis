# F-ACCESS — Изоляция арендатора и ACL
Процессы: [N] Node-приложение · [P] PostgreSQL
Триггер: `connect({ dsn, schema, enforceAcl: true })` → `db.as(accountId, { owner })` → `t.Booking().rows()` · `.create({…}).rows()` · `t.X(id).delete({ confirm: true }).rows()`

## Субъект
1. [N] `lib/src/index.ts:connect#«enforceAccount: opts.enforceAccount ?? true»` — изоляция по умолчанию (0.20.0); без `enforceAcl` — warn «enforceAcl is off» раз на процесс.
2. [N] `lib/src/chain.ts:makeDb#«case 'as'»` — клон ctx `{ account, owner, aclDecide: undefined }` на том же пуле, без батчей → `ctx.compileAcl`.
3. [N→P] `lib/src/index.ts:connect#«ctx.compileAcl = async»` — SELECT своего Account (нет → ошибка, `enabled` не смотрится) + `aclDict` — снимок Resource/Rule на подключение для всех scope (0.20.1), провал не кэшируется.
4. [N] `lib/src/acl.ts:compileEnforcer` — субъекты — ACCOUNT-ресурсы по `categories`; memo по `"class op"` без аккаунта ⇒ энфорсер на scope. **Дыра (по коду):** нестроковые `categories`/`class` (`lib/src/acl.ts:matchCategories`, `lib/src/acl.ts:matchesRow`) совпадают со всеми.
5. [N] `lib/src/acl.ts:decide` — max weight, при равенстве deny бьёт allow, равные allow — меньший alias; нет правил → deny.
6. [N] `lib/src/acl.ts:toDecision` — остаток pattern allow-правила без `class` → `filter`, `"$account"` → id субъекта (`rowFilter`).

## Чтение
7. [N] `lib/src/chain.ts:makeChain#«case 'rows'»` → `lib/src/sql.ts:buildRead`; первым `lib/src/sql.ts:guardScoped` — корень при `enforceAccount` → ошибка.
8. [N] `lib/src/sql.ts:buildRead#«accFilter = ctx.account»` — `account` на каждом шаге в кандидаты и перепроверку, не во внутренний DISTINCT ON; `.account(чужой)` → ошибка.
9. [N] `lib/src/sql.ts:buildRead#«if (ctx.aclDecide)»` — READ на каждый класс семейства: запрещённые выпадают, ни одного → `aclDenied`; `filter` → `lib/src/sql.ts:rowTemplateFrags`.
10. [N] `lib/src/sql.ts:buildRead#«const classCond»` — «класс AND предикат» во внутренний WHERE, кандидаты и перепроверку, до сортировки и лимита.

## Запись
11. [N] `lib/src/write.ts:aclWrite` — WRITE: deny → ошибка; `filter` → `step.aclFilter`, строковые `owner`/`account` пришпиливают INSERT.
12. [N→P] `lib/src/write.ts:createOp#«if (found.length) return versionRows»` — явный id ищется среди своих; найден → версия с его account/owner.
13. [N→P] `lib/src/write.ts:createOp#«if (target.aclFilter)»` — не найден: probe существования лишь при предикате и тоже под своим account. **Дыра (прогон):** create с чужим id перехватывает сущность — владелец её теряет, `.versions()` отдаёт его историю.
14. [N] `lib/src/write.ts:resolveAccount` — account = модификатор ?? scope ?? System, owner = модификатор ?? `{ owner }` ?? account; батч — `lib/src/write.ts:executeBatch#«aclWrite(c, s, 'WRITE')»`.

## Удаление
15. [N→P] `lib/src/write.ts:delOp` — DELETE на класс цели, цели — `readRows`; замыкание `lib/src/sql.ts:closureSql` — без account; без `confirm` — превью.
16. [N] `lib/src/write.ts:delOp#«c.aclDecide(c.registry.resolve(cn), 'DELETE')»` — DELETE на каждый класс замыкания, только `allow` (предикат не смотрится); deny откатывает всё.
17. [P] `lib/sql/ddl.sql:entity_delete` — tombstone + каскад по `links`. **Дыра (прогон):** каскад без арендатора гасит чужие строки.

## Watch и перечитывание
18. [N] `lib/src/chain.ts:makeDb#«case 'watch'»` — без `guardScoped` и account; под ACL — только безусловный allow. **Дыра (по коду):** payload `lib/sql/ddl.sql:entity_notify` без account — события всех арендаторов.
19. [N] `lib/src/chain.ts:makeDb#«case 'reloadSchema'»` → `ctx.reload`: сброс `aclDict` и реестра, свой энфорсер перекомпилируется, `db.acl` пересоздаётся; прочие scope — со старым.
20. [N] `lib/src/acl.ts:makeAcl` — `db.acl.check/checkData` в любом режиме: свой кэш Resource/Rule (`reload()` — только его), категории — SELECT на вызов.

Состояние: ACL в БД не пишет; снимки в памяти — `aclDict`, memo, кэш `db.acl`. `rules.set`/`resources.set` их не сбрасывают, `schema.define` — через `ctx.reload`.
Сбои: «enforceAccount is on — call db.as(account)…», «reads/writes are pinned to account …», «account "…" not found», «acl denies OP on X — <meta.message>», «acl pins X writes to …», «acl pattern key "k" is not an Entity column». Цель вне предиката у update/delete и занятый id у create — тихо `[]`.
Логи: только warn «enforceAcl is off»; решения ACL не логируются.
Варианты режима: `enforceAccount: false` — корень видит всё (account = System), scope сужает чтение лишь предикатом; `enforceAcl` выкл — `aclDecide` нет; `enforceAcl` + `enforceAccount: false` — корень без ACL (энфорсер только в `db.as`).
Проверка: `cd lib && npx tsx --test --test-force-exit test/acl.test.ts` (ACL-шаги, но с `enforceAccount: false`), `lib/test/wave2.test.ts` («enforceAccount: чужое невидимо…», «db.as: арендатор — свойство ВЫЗОВА…»). Дыры и warn не покрыты.
