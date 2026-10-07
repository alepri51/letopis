> **Описывает 0.21 (тег `v0.21.0`).** В letopis 1.0 трасса переписывается в своём этапе плана `reports/PLAN-LETOPIS-1.0.md`; до этого она не описывает действующий код.

# F-BOOT — up() → накат схемы → connect
Процессы: [N] Node-приложение · [P] PostgreSQL + TimescaleDB · [D] docker CLI
Триггер: `const db = await up({ schema: 'booking', version: 1 })` (dsn по умолчанию — база `letopis` на localhost:15432)

## Проба
1. [N] `lib/src/up.ts:up` — имя без точки и версии, version — целое ≥ 1 → `v1.booking`; local = localhost/127.0.0.1/::1; дедлайн = вход + `waitTimeoutMs` (120 с, сборка образа тоже в нём).
2. [N] `lib/src/up.ts:pgPing` — `select 1` (connect_timeout 3 с): 3D000 → нет базы, 57P03 → стартует, 28P01/28000 → фатально, прочее → нет сервера.
3. [N] `lib/src/up.ts:up#«docker skipped»` — PG ответил: docker и проверка Redis пропускаются.
4. [P] `lib/src/up.ts:ensureDatabase` — нет базы: `CREATE DATABASE` через базу `postgres`.

## Docker (local-dsn и PG не ответил)
5. [D] `lib/src/up.ts:ensureContainer` — бежит → reuse; стоит → `docker start`; нет → `docker build` из `lib/docker` (TimescaleDB + Redis), если образа нет, и `docker run`.
6. [D] `lib/src/up.ts:dockerRunArgs` — порт/user/пароль/база из dsn, том `letopis-pgdata` (`dataDir`: путь → bind).
7. [N] `lib/src/up.ts:up#«for (;;)»` — pgPing раз в 500 мс до дедлайна, затем TCP Redis-порта.

## Накат
8. [P] `lib/src/up.ts:applySchema` — `fresh` → `DROP SCHEMA … CASCADE`; схема есть → пропуск.
9. [P] `lib/src/up.ts:applySchema#«if (upgrade)»` — `upgrade` на существующей схеме: только ddl (идемпотентен) + ANALYZE, сиды не трогаются.
10. [P] `lib/src/up.ts:applySchema#«readFile(f, 'utf8')»` — схемы нет: ddl + демо-сиды booking/auth (или `seeds`), `<SCHEMA-NAME>` → полное имя везде, и в канале pg_notify (F-WATCH); ddl штампует ревизию в `COMMENT ON SCHEMA`.
11. [P] `lib/src/up.ts:applySchema#«statistics collected»` — ANALYZE `Entity` для планировщика; после массовой заливки повторить вручную.

## Connect
12. [N] `lib/src/index.ts:connect` — пул postgres.js (`max` 10).
13. [P] `lib/src/schema.ts:loadRegistry` — классы из `Schema`; имя, занятое API цепочки (демо `link`), → warn.
14. [P] `lib/src/index.ts:connect#«'System' = ANY(categories)»` — System-аккаунт: fallback account записи без `db.as`.
15. [P] `lib/src/index.ts:checkDdlRevision` — метка ≠ `DDL_REVISION` → warn «движок схемы … отстал», не отказ.
16. [N] `lib/src/index.ts:connect#«enforceAcl is off»` — `enforceAccount` по умолчанию true (0.20.0); ACL лениво в `db.as` (F-ACCESS); без `enforceAcl` — warn.
17. [N] `lib/src/chain.ts:makeDb` — корневой Proxy без арендатора; `then` → undefined, иначе `await` развернул бы db. Дальше F-READ / F-WRITE.

Состояние: контейнер `letopis-timescale` и том `letopis-pgdata` переживают процесс; схема: нет → накатана | есть → не тронута | upgrade → ddl перекатан | fresh → заново. Warn connect — раз на процесс (на схему/класс).
Сбои: `letopis.up: bad schema name` / `bad version`; 3D000/57P03 — не сбой (база создаётся / ожидание); 28P01 — сырая ошибка PG без ретраев; `docker CLI not found`; `docker start|build|run … failed`; `postgres not ready in 120 s`; `redis not ready on 16379`; connect: `has no "Schema" table` (передано базовое имя), `has no classes`.
Логи: stdout `[letopis.up] …` на каждой развилке: `docker skipped`, `reused|started|created`, `postgres ready in N s`, `applied|already exists — apply skipped|upgraded|dropped (fresh)`, `connected`; warn connect — stderr `letopis: …`.
Варианты режима:
- Удалённый dsn — без docker: `waiting for remote postgres`, ожидание до дедлайна без проверки Redis.
- CLI `node db/apply.mjs --dsn --schema --version [--no-seed] [--upgrade]` (`db/apply.mjs:files`) — та же подстановка и ANALYZE; нет пробы, CREATE DATABASE и проверки «схема есть»: без `--upgrade` сиды перекатываются, их ON CONFLICT возвращает Schema демо-классов и Resource/Rule к сидовым. Нужен `npm ci` в `lib`.
- CI `.github/workflows/ci.yml` — сервисы timescaledb-pg17 (база `clockz`) и redis:7-alpine, накат apply.mjs; up() в тестах идёт пробой. Контур — F-RELEASE.
- `seeds: false` — connect падает «has no classes», схема остаётся: повторный up() её пропустит, нужен `fresh: true`. Свои `seeds` — пути от cwd; нужен ≥ 1 класс, а для записи без `db.as` — Account с категорией System.
- `quiet` глушит только `[letopis.up]`. Redis-клиент передаёт приложение (F-AUTH).
Проверка: `cd lib && npx tsx --test --test-force-exit test/up.test.ts` (ENTITY_DSN, по умолчанию база `clockz`). Docker-ветка — только юнит `dockerRunArgs`; `apply.mjs --upgrade` и «enforceAcl is off» не покрыты.
