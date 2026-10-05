---
paths:
  - 'lib/src/up.ts'
  - 'lib/docker/**'
  - 'db/apply.mjs'
synced: 6c5460a
---
# M-BOOTSTRAP — dev-окружение и накат схемы

**Инварианты и грабли**
- Подстановка `"<SCHEMA-NAME>"` → `vN.<schema>` реализована дважды: `lib/src/up.ts:applySchema` и `db/apply.mjs`, плюс копия в `lib/bench/dimensions.bench.mjs`. Если поправить одну, CI (apply.mjs) и `up()` разойдутся. Замена тотальная (`replaceAll`) и покрывает и идентификаторы, и литерал канала `pg_notify`.
- На существующей схеме реализации ведут себя по-разному. `up()` пропускает накат; с `upgrade` — только ddl.sql; с `fresh` — DROP CASCADE. `db/apply.mjs` без `--upgrade` снова льёт ddl и оба сида, и `ON CONFLICT DO UPDATE` затирает рантайм-правки демо-классов и Resource/Rule. На несуществующей схеме `db/apply.mjs --upgrade` кладёт только ddl.sql, и `connect()` падает с `has no classes`; `up({upgrade:true})` там делает обычный первый накат с сидами.
- Сиды накатываются только при создании схемы (по коду). ANALYZE делают оба пути, но после массовой заливки его нужно повторить (lib/README.md §14.1; `bed24f0`: 57 с → 3 с на 980k строк).
- `--schema` у `db/apply.mjs` — базовое имя плюс `--version`; у `db/policies.mjs` — полное имя (`v1.booking`).
- Docker трогается, только если dsn локальный (`localhost`/`127.0.0.1`/`::1`) и PG не отвечает. Если PG жив (или нет только базы — 3D000 → CREATE DATABASE), docker пропускается целиком, и Redis тогда не проверяется. `28P01`/`28000` фатальны, без ретраев.
- Существующий контейнер (даже остановленный) и образ переиспользуются как есть. `POSTGRES_*` из dsn попадают только в `docker run` нового контейнера. Правка `lib/docker/**` доедет после `docker rm -f letopis-timescale` + `docker rmi letopis-db`. Данные лежат в volume `letopis-pgdata` и переживают пересоздание контейнера.
- DSN по умолчанию у `up()` ведёт на базу `letopis`, а тесты и CI работают с `clockz` (`ENTITY_DSN`).
- Redis в образе без пароля и без персиста (`lib/docker/start.sh`): только для dev, сессии эфемерны.
- Свои `seeds` резолвятся от cwd процесса. `seeds:false` даёт схему без классов, и `connect()` упадёт.

**Что ещё менять вместе**
- Новая опция или умолчание `up()`: `UpOpts`, lib/README.md §11 «`up(opts: UpOpts)`» (таблица опций) и §1.1, `lib/test/up.test.ts`. Вопросы: затрагивает ли накат (тогда тот же флаг в `db/apply.mjs` и README §10.8a)? Новое сообщение или экспорт — нужен ли `npm run api:contract`? Образцы: `9f93a9b` (upgrade: ddl.sql, types.ts, index.ts, up.ts, db/apply.mjs, check-docs.mjs, README, AGENT-CHEATSHEET, api-contract.json, up.test.ts), `bed24f0` (ANALYZE: apply.mjs, up.ts, README, CHANGELOG, AGENT-CHEATSHEET).
- Новый шаг наката (файл, ANALYZE, проверка): вносить в обе реализации и в `lib/bench/dimensions.bench.mjs`.
- Порт, имя контейнера, образа или volume: умолчания в `lib/src/up.ts`, `dockerRunArgs` (юнит в up.test.ts), шапка `lib/docker/Dockerfile`, README §1. CI-сервис (`.github/workflows/ci.yml`, M-RELEASE) и DSN тестов (M-TESTS) меняются отдельно.

**Состояние и побочки**
- Запускает `docker` CLI (inspect/start/build/run). Первая сборка образа из пакованного `lib/docker` занимает минуты (pull timescaledb).
- Создаёт базу (через подключение к базе postgres) и схему; `fresh` дропает схему вместе с данными.
- Порты хоста: PG из dsn (15432) → 5432, `redisPort` (16379) → 6379; volume `letopis-pgdata` или bind `dataDir`.
- Пишет в console строки `[letopis.up] …` (`quiet` их глушит). `db/apply.mjs` импортирует `postgres` из lib/node_modules (нужен `npm ci` в `lib`) и читает `lib/sql`; в npm-пакет `db/` не входит.

**Неимпортные связи**
- Пути к SQL-шаблонам и Docker-контексту (`pkgPath`) считаются от модуля: lib/src под tsx, lib/dist в пакете — оба соседи `lib/sql` и `lib/docker`; `sql` и `docker` перечислены в `files` `lib/package.json`.
- `ENTRYPOINT` → `lib/docker/start.sh` (redis фоном) → docker-entrypoint.sh штатного образа timescaledb.
- CI готовит `v1.booking` через `db/apply.mjs` (`.github/workflows/ci.yml`). Тесты типа B идут через apply.mjs, типа C — через `up()`.
- Имя схемы с точкой (`v1.booking`): в SQL только в кавычках, `::regnamespace` не годится (`lib/src/index.ts:checkDdlRevision`).

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/up.test.ts`: идемпотентность, `fresh`, ANALYZE, отставший движок + upgrade, `seeds` свои и `false`, CREATE DATABASE, валидация имени. Docker-ветка покрыта только юнитом `dockerRunArgs`, `apply.mjs --upgrade` не покрыт.
- Сигналы: `[letopis.up] … docker skipped`, `… already exists — apply skipped`, `… upgraded (ddl re-applied, data intact)`; у apply.mjs — `applied <файл> → schema "vN.x"`.

**Точки входа**
- `lib/src/up.ts:up` — оркестрация: ping → docker → накат → connect
- `lib/src/up.ts:applySchema` — fresh/upgrade/skip/первый накат
- `lib/src/up.ts:ensureContainer` — reuse/start/build/run
- `lib/src/up.ts:pgPing` — классификация ошибок подключения

**Не здесь**
- Содержимое ddl.sql и policies.mjs → M-ENGINE; сиды → M-SEEDS; `connect()` и предупреждение о ревизии → M-API; CI → M-RELEASE; подготовка тестовых схем → M-TESTS
