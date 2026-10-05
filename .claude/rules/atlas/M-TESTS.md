---
paths:
  - 'lib/test/**'
synced: 99a28e0
---
# M-TESTS — Тестовый контур

**Инварианты и грабли**
- Все файлы ходят в одну БД (`ENTITY_DSN`, по умолчанию `postgres://postgres:test@localhost:15432/clockz`). Подготовка трёх типов:
  - A — api-full, auth, core, integration, real-life, resilience, tables, wave2, wave3: общая `v1.booking`, накатанная ЗАРАНЕЕ (`node db/apply.mjs --dsn=<dsn> --schema=booking --version=1`; в CI — отдельный шаг `.github/workflows/ci.yml`). api-full, core, integration, real-life, wave2, wave3 делают `TRUNCATE "v1.booking"."Entity"` в `before`;
  - B — acl, depth, idgen, no-history, parity, plan, salon, wave4: `DROP SCHEMA` + `db/apply.mjs` в свою `v1.<имя>` (no-history → `v1.nohistory`);
  - C — up, wave5: через `up()` (`v1.uptest`, `v1.uptest_seeded`, `v1.wave5`).
- `--test-concurrency=1` обязателен: файлы A делят `v1.booking`, и TRUNCATE в `before` одного стёр бы данные файла, идущего параллельно.
- TRUNCATE чистит только Entity (Schema — своя таблица, выживает). Account/Credential/Resource/Rule в `v1.booking` копятся между прогонами — идентичности в тестах A уникализировать (образец `uniq` в auth.test.ts).
- lib/README.md §16 «Тесты полностью автономны» неточно: A падают без заранее накатанной `v1.booking`.
- `lib/tsconfig.json` включает только `src`: `tsc --noEmit` (CI) тесты не типизирует, tsx типы стирает — ошибка типов в тесте не ловится нигде.
- B зовут apply.mjs с `stdio: 'ignore'`: при сбое наката видно лишь `Command failed` — повтори команду руками.
- System-аккаунт `2eba6d0a-1edd-4bb6-a85a-a703dab49035` захардкожен (`SYS`) — он из `lib/sql/seed.auth.sql`.
- Пробелы покрытия: `.deep()` и `watch()` проверяются только с `enforceAccount:false`; `enforceAcl:true` — только в acl.test.ts, и тоже с `enforceAccount:false`; `apply.mjs --upgrade` (up.test.ts проверяет лишь `up({upgrade:true})`) и предупреждение «enforceAcl is off» тестами не покрыты.

**Что ещё менять вместе**
- Новый или переименованный тест-файл → строка `# <имя> — …` в lib/README.md §16 (check-docs 3; имя только `[a-z0-9-]`) + «суммарно N тестов» в записи релиза lib/CHANGELOG.md. Новой фиче со своей схемой — тип B (образец `lib/test/no-history.test.ts`, 99a28e0).
- Сменился id System или классы seed.booking.sql → константы `SYS` и id-формулы в тестах (core.test.ts: `bookingId`).

**Состояние и побочки**
- Redis (`ENTITY_REDIS`, по умолчанию `redis://localhost:16379`, ioredis) нужен только auth и salon.
- Схемы B/C пересоздаются каждым прогоном; `v1.booking` — нет (чистится лишь Entity).

**Проверка**
- Всё: `cd lib && npm test` (tsx --test --test-concurrency=1 --test-force-exit). Один файл: `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`. В CI — тот же скрипт после наката booking.

**Точки входа**
- `lib/test/core.test.ts:before#«TRUNCATE "v1.booking"."Entity"»` — образец A
- `lib/test/acl.test.ts:SCHEMA#«DROP SCHEMA IF EXISTS»` — образец B
- `lib/test/wave5.test.ts:up#«fresh: true»` — образец C
- `lib/test/auth.test.ts:uniq` — уникальные идентичности в общей схеме

**Не здесь**
- CI, check-docs → M-RELEASE; полигоны и бенчи → M-BENCH; накат и `up()` → M-BOOTSTRAP; сиды → M-SEEDS.
