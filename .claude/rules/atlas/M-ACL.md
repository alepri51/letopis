---
paths:
  - 'lib/src/acl.ts'
synced: 6c5460a
---
# M-ACL — Права Resource/Rule: матчинг, вес, row-предикаты, энфорсер на scope

**Инварианты и грабли**
- Fail-open матчеры: нестроковый `pattern.categories` (ACCOUNT) или `pattern.class` (READ/WRITE/DELETE) — например массив — совпадает со ВСЕМИ аккаунтами/классами; `pattern: null` — тоже «все». Маски — только строкой `"{A,B}"`. Нестроковый `endpoint` у API не совпадает ни с чем.
- `Rule.account` — alias Resource категории ACCOUNT (FK на `Resource.alias`), не id аккаунта; членство считается из `Account.categories` (README §9.2).
- Победитель: max weight (`null` = 0); равный вес — deny бьёт allow; при равных — меньший alias ресурса. Allow — только точная строка `'allow'`, всё прочее = deny (CHECK в DDL нет). PK `(account, resource)` — одно правило на пару.
- Ключи row-pattern кроме `class` идут в SQL: `data`/`links` (jsonb `@>`), `tags`, `owner`/`account` (uuid), `id`/`partition`; иной ключ бросает `acl pattern key "…" is not an Entity column` на КАЖДОМ запросе к классу — `resources.set` его не проверяет.
- WRITE: строковые `owner`/`account` предиката пришпиливают INSERT; цели update/delete ищутся только среди своих; create v5 по id чужой существующей строки → `[]` без ошибки (README §9.2). DELETE-право на классы каскада проверяется только при `confirm` (превью — нет); `purge` — только класс цели.
- READ полиморфен: решение по каждому классу семейства, запрещённые потомки выпадают, отказ — только если запрещено всё семейство (`513cfe3`, 0.20.0). `watch()` под enforceAcl отдаёт события только классов с безусловным allow — класс с предикатом молчит целиком.
- Снимки: словарь Resource/Rule (`aclDict`) — один на подключение (0.20.1, `3f38e76`), сбрасывает только `db.reloadSchema()`; категории субъекта и memo «класс+операция» — на каждый `db.as()`. `rules.set`/`resources.set` кэши не трогают: новые права видны новым `db.as()` только после `reloadSchema()`; правка `categories` — со следующего `db.as()`.
- Два разных reload: `db.acl.reload()` чистит лишь кэш фасада `db.acl` (check/checkData); `db.reloadSchema()` — реестр + `aclDict` + фасад. Фасад держит реестр, взятый при первом доступе: после `db.schema.define()` (зовёт `ctx.reload`, а не `reloadSchema`) `db.acl.checkData` нового класса бросает `unknown class`.
- Фасад `db.acl` свой у каждого хендла и не делит кэш с `aclDict`: на scope-per-request `t.acl` перечитывает словарь на каждый запрос.
- Ни энфорсер, ни `db.as()` не смотрят `Account.enabled` — выключенный аккаунт сохраняет права; без enforceAcl `db.as()` не проверяет даже существование аккаунта.
- `enforceAcl` по умолчанию `false`: deny-by-default без правил дал бы пустые выборки; вместо этого warn раз на процесс (0.20.0). Сид `lib/sql/seed.auth.sql` даёт только ACCOUNT/API — с `enforceAcl:true` без своих READ/WRITE/DELETE-ресурсов любая цепочка получит deny.

**Что ещё менять вместе**
- Новая категория-операция (`AclOp`): `lib/src/types.ts:AclOp` + `ACL_OPS` + место проверки (`lib/src/sql.ts` READ / `lib/src/write.ts:aclWrite`) + README §9.2/§11.10 + `lib/test/acl.test.ts`. Образец `ee1af06`.
- Новый ключ row-pattern: `lib/src/sql.ts:rowTemplateFrags` + `aclWrite` (если пришпиливает колонку) + README §9.2.
- Резолюция (вес, tie-break, маски): `lib/src/acl.ts` общий для фасада и энфорсера; вопрос — меняется ли исход сид-правил API (веса в `lib/sql/seed.auth.sql`)? + README §9.2/§11.10 + `lib/test/acl.test.ts`.
- Кэш/снимок: `lib/src/index.ts:connect` (`aclDict`, `compileAcl`) + `lib/src/chain.ts` (`case 'as'`, `case 'reloadSchema'`) + README §9.2/§11.10 + acl/up тесты. Образец `3f38e76`.

**Состояние и побочки**
- SELECT Resource + Rule(enabled) — раз на подключение и раз на каждый фасад `db.acl`; Account — на каждый `db.as()` под enforceAcl и на каждый `check`/`checkData`. Регэкспы масок — процессный `regexCache` без лимита.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/acl.test.ts` (тип B; единственный с `enforceAcl:true`, и тот с `enforceAccount:false`) · `lib/test/salon.test.ts` · сигналы: `letopis: acl denies READ on X — …`, `acl pins … writes to owner …`, warn `enforceAcl is off`.

**Точки входа**
- `lib/src/acl.ts:compileEnforcer` — memo-резолвер под субъекта scope
- `lib/src/acl.ts:makeAcl` — фасад `db.acl`
- `lib/src/index.ts:connect#«ctx.compileAcl = async»` — снимок словаря, компиляция на `db.as()`
- `lib/src/sql.ts:rowTemplateFrags` — pattern → WHERE
- `lib/src/write.ts:aclWrite` — WRITE/DELETE-гейт и пришпиливание

**Не здесь**
- CRUD Resource/Rule/Account → M-AUTH · изоляция `enforceAccount` → M-QUERY · `db.as`, `watch` → M-API · сид правил → M-SEEDS
