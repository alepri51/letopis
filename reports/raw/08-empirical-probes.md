# 08 — Эмпирические пробы: подтверждение критических находок прогоном

> Промежуточный отчёт. Дата: 2026-09-24. Пакет: `letopis` 0.21.0 (ветка `dev`, HEAD `99a28e0`), исходники `lib/src/*.ts` запущены через `tsx` напрямую.
> Метод: одноразовая схема `v1.auditprobe` в dev-контейнере `letopis-timescale` (образ `letopis-db`, TimescaleDB pg17), `up({fresh:true})` с дефолтными сидами (booking + auth), дефолтные опции подключения (`enforceAccount: true`, `enforceAcl: false`). После прогона схема удалена (`DROP SCHEMA … CASCADE`). Статус: **источник для `reports/ASSESSMENT.md`**.

## Что проверялось

| Проба | Находка (id в ASSESSMENT) | Гипотеза из статического анализа |
|---|---|---|
| P1 | R1 (SEC-01/F2) + SEC-02 | Арендатор B через `Класс(idA).create()` «перехватывает» сущность A; A перестаёт её видеть; B читает историю A через `.versions()`; каскад `delete` от B тумбстоунит данные A |
| P2 | R4 (SEC-13) | `.deep()` под дефолтным `enforceAccount:true` падает ошибкой PG (неиспользуемый плейсхолдер account) |
| P3 | R3 (F3) | Два конкурентных `update()` от одной версии → один патч теряется (нет compare-and-set) |
| P4 | R2 (F1) | `drop_chunks` (механика retention-политики) удаляет единственную строку давно не менявшейся сущности → потеря актуального состояния |

## Результат — все четыре гипотезы подтверждены

```
setup: schema v1.auditprobe, enforceAccount default (true), enforceAcl off; A=f2efde63-… B=bff0067d-…

=== P1: cross-tenant shadowing через create() с чужим id ===
P1: A created Org 01a0d3c5-6588-7ce9-a911-beaed783a855 (account=A) + Folder 01a0d3c5-65b3-…
P1: B sees A's Org before attack: 0 rows
P1: B .Org(idA).create() → 1 row(s), account=B, name=hijacked-by-B
P1: A now sees own Org by id: 0 rows  ← СУЩНОСТЬ ИСЧЕЗЛА ДЛЯ A
P1: A sees own Folder via Org chain: 0 rows
P1: B sees Org by id: 1 rows, name=hijacked-by-B
P1: B .versions() on that id: 2 rows, accounts=[A,B] names=[org-A,hijacked-by-B]  ← B ЧИТАЕТ ИСТОРИЮ A
P1: B delete() preview closure: 2 rows, of A: 1
P1: B delete({confirm}) → 2 rows tombstoned, of A: 1
P1: A's Folder alive after B's cascade: 0 rows; withDeleted: 1  ← ДАННЫЕ A ЗАТОМБСТОУНЕНЫ АРЕНДАТОРОМ B

=== P2: .deep() под enforceAccount:true (дефолт) ===
P2: deep() with enforceAccount THREW: could not determine data type of parameter $5
P2 control (enforceAccount:false): 3 rows: a@1, a1@2, b@1

=== P3: два конкурентных update() от одной версии ===
P3[0]: latest address=a1 phone=p1 versions=3 OK
P3[1]: latest address=a1 phone=p0 versions=3 ← LOST UPDATE
P3[2]: latest address=a1 phone=p0 versions=3 ← LOST UPDATE
… (полный список в probes.out.txt)
P3: lost updates 19/20; avg versions per entity 3.00 (expected 3 = create + 2 updates)

=== P4: drop_chunks и неизменявшаяся сущность ===
P4: inserted Org 4ba4a3cd-… with updated = now()-3y (единственная версия, живая)
P4: visible before drop_chunks: 1 rows
P4: chunks before=2; drop_chunks(older_than 2y) dropped: _timescaledb_internal._hyper_1004_2202_chunk
P4: visible after drop_chunks: 0 rows  ← АКТУАЛЬНОЕ СОСТОЯНИЕ ПОТЕРЯНО
P4: physical rows left for that id: 0

cleanup: DROP SCHEMA "v1.auditprobe" CASCADE — done
```

## Интерпретация

**P1 — изоляция арендаторов нарушается штатным API.** Под дефолтом (`enforceAccount:true`, ACL выключен) арендатор B, зная id сущности A, одним вызовом `create()` вставил версию с `account=B`. Дальше: A видит `[]` по своему id и по цепочке; B видит «свою» сущность; `.versions()` у B возвращает обе версии, включая строку с `account=A` и её данными (`name=org-A`); превью и подтверждённый `delete()` у B вернули строку A (Folder) в замыкании; после каскада `tA.Folder(id).rows()` → 0, а `.withDeleted().rows()` → 1 — последняя версия Folder арендатора A стала tombstone по инициативе B. Механика ровно та, что описана статически: предикат `account` не участвует во внутреннем `DISTINCT ON` (`lib/src/sql.ts:689-695, 787-792`), probe существования делается только при ACL-предикате (`lib/src/write.ts:512-524`), `versions`-join без account (`sql.ts:885`), каскад в триггере `entity_delete` без account (`lib/sql/ddl.sql:357-360`).

Замечание о предусловии: B должен знать id. Для v4/v7-id это IDOR/утечка через `watch()` (payload без account, `ddl.sql:563-565`); для v5-id из пользовательских полей без tenant-scoped конца id вычислим из данных (namespace без account, `write.ts:417`).

**P2 — `.deep()` не работает под дефолтной конфигурацией.** Ошибка PostgreSQL `could not determine data type of parameter $5`: плейсхолдер account аллоцируется (`sql.ts:689-691`), но deep-блок строит SQL без `innerWhere`/`finalFrags` (`sql.ts:795-821`). Контрольный прогон с `enforceAccount:false` отдаёт корректные 3 строки с `$depth`. Все тесты `deep` в репозитории идут с `enforceAccount:false`, поэтому регрессия с 0.20.0 (дефолт `enforceAccount:true`) не поймана. Fail-closed (ошибка, не утечка), но функция недоступна тем, кто следует документации.

**P3 — lost update воспроизводится в 19 из 20 попыток.** Каждая пара конкурентных `update()` вставляет по версии (3 версии на сущность — обе записи «успешны»), но итоговая latest содержит только один из двух патчей: `versionRows` читает latest, делает `deepMerge`, вставляет (`write.ts:421-445`); `prevUpdated` используется только для монотонности `updated` (`sql.ts:922-932`), проверки «latest не изменился» нет. История честно показывает обе версии, но актуальное состояние — с молчаливой потерей.

**P4 — retention уничтожает актуальное состояние.** Единственная живая строка сущности с `updated = now()-3y` ушла вместе с chunk'ом при `drop_chunks(older_than 2 years)` — это ровно то, что делает `add_retention_policy` из `db/policies.mjs`. Физических строк по id не осталось, чтение возвращает пустоту. Документация (README §10.8, `policies.mjs:71`) говорит о потере «истории», а не текущего состояния неизменявшихся сущностей.

## Воспроизведение

Скрипт (сохранён в scratchpad сессии как `probes.mts`; в репозиторий не добавлялся): `up({dsn, schema:'auditprobe', version:1, fresh:true})` → два аккаунта через `sys.accounts.set()` → `db.as(A)`/`db.as(B)` → сценарии P1–P4 на классах `Org`/`Folder` демо-домена → `DROP SCHEMA`. Запуск: `cd lib && node_modules/.bin/tsx <путь>/probes.mts`. Требуется Docker (контейнер `letopis-timescale` поднимается `up()`).

Ключевые вызовы:

```ts
// P1
const [orgA] = await tA.Org().create({ name: 'org-A' }).rows();
await tB.Org(orgA.id).create({ name: 'hijacked-by-B' }).rows();   // проходит
await tA.Org(orgA.id).rows();                                      // []
await tB.Org(orgA.id).versions();                                  // версии A и B
await tB.Org(orgA.id).delete({ confirm: true }).rows();            // каскад по данным A
// P2
await tA.Folder(root.id).Folder().deep().rows();                   // PG: could not determine data type of parameter $5
// P3
await Promise.all([tA.Org(x.id).update({ address: 'a1' }).rows(), tA.Org(x.id).update({ phone: 'p1' }).rows()]);
// P4
INSERT INTO "v1.auditprobe"."Entity"(…, updated, …) VALUES (…, now() - interval '3 years', …);
SELECT drop_chunks('"v1.auditprobe"."Entity"', INTERVAL '2 years');
```
