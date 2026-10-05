---
paths:
  - 'lib/sql/seed.*.sql'
synced: 99a28e0
---
# M-SEEDS — сиды по умолчанию: booking и auth

**Инварианты и грабли**
- Сиды накатываются только при создании схемы. `up()` на существующей схеме их пропускает, `upgrade` перекатывает только `lib/sql/ddl.sql` (прогон 2026-09-24). Правка сида не дойдёт до живых схем, а тесты типа A ждут заранее накатанную `v1.booking`: переналивай вручную через `node db/apply.mjs` без `--upgrade` (он заново льёт ddl и оба сида).
- Повторный прогон не безвреден. `ON CONFLICT … DO UPDATE` затирает рантайм-правки 20 демо-классов (`schema.define`, `schema-sync`, `meta.history`) и 16 Resource / 12 Rule; System-аккаунт идёт через `DO NOTHING`. Всё, что убрано из сида, в схеме остаётся. Класс с данными из `Schema` не удалить (`entity_class_fk` RESTRICT).
- Один класс — один `INSERT INTO` с начала строки. check-docs считает `^INSERT INTO` и сверяет с «(N классов» в шапке `lib/sql/seed.booking.sql` (был дефект «19 классов при 20 INSERT»). В `lib/sql/seed.auth.sql` счётчика нет — проверка его пропускает.
- `partition` — `'entity'`: это партиция `connect()` по умолчанию. Если в ней нет классов, `connect()` падает с `has no classes`.
- Без аккаунта категории `System` запись без `.account()`/`db.as()` падает (`Entity.account` NOT NULL). Свой сид без `lib/sql/seed.auth.sql` должен добавить System сам (lib/README.md §1.1).
- Корней два: HUB-классы — от `Entity`, LINK — от `link`. Оба корня задают `id` v7 по умолчанию; его наследует каждый класс без своего правила. Концы LINK — объекты v2 (`class`/`classes`/`optional`). Шапка говорит про `text[]`, но колонка `jsonb` — шапка устарела.
- `ancestors` в INSERT избыточен: его (и `descendants`) пересчитывает триггер `schema_lineage`.
- Триггер `entity_check` проверяет концы только у LINK; HUB-концы и `cardinality` проверяет либа (M-WRITE).
- После массовой заливки поверх сида нужен `ANALYZE` (lib/README.md §14.1).

**Что ещё менять вместе**
- Новый класс booking: отдельный `INSERT … ON CONFLICT (partition, id) DO UPDATE`, шапка «(N классов: H HUB + L LINK)», lib/README.md §3 (grep `20 классов`, таблица «Все 20 классов»). Вопросы: имени нет в `RESERVED_CLASS_NAMES` (`lib/src/types.ts`)? У LINK `ancestor` = `link` и концы в формате v2? Своё id-правило (`generate:5` + `from`) или наследуемый v7? Меняются ли ожидания тестов типа A (списки классов, счётчики)? Образцы: `513cfe3`, `9eecd02`.
- Изменение класса (attributes/links/meta): тесты, которые пишут этот класс (grep id и русского алиаса в `lib/test`, `lib/bench`), примеры lib/README.md; живые схемы — только переналивкой.
- Изменение auth-сида: lib/README.md §9 («System + 16 Resource + 12 Rule»), тесты с алиасами (`acl`, `api-full`, `core`, `tables`, `wave4`, `wave5`). Синтаксис `pattern` — контракт `lib/src/acl.ts:matchesApi`.
- Удаление класса или ресурса: из уже созданных схем ничего не уйдёт (ON CONFLICT не удаляет); поправить счётчики в README и шапке.

**Неимпортные связи**
- `"<SCHEMA-NAME>"` ↔ `lib/src/up.ts:applySchema` и `db/apply.mjs` (порядок: ddl → booking → auth; `--no-seed` / `seeds:false` — без них).
- `Account.categories` с `System` ↔ `lib/src/index.ts:connect` (`systemAccount` — фолбэк арендатора записи).
- `Resource.pattern`: `categories` `{A,B}` / `!{A,B}`, `endpoint` — маска `lib/src/acl.ts:matchMask`; отсутствие pattern = матч всех. Правило `any:ACCOUNT → any:API deny 0` — запрет по умолчанию.
- Алиасы классов (`окно`, `Сущность`, …) — имена методов цепочки в тестах и lib/README.md.

**Проверка**
- `cd lib && npm run check:docs` (seed-counts).
- `node db/apply.mjs --dsn=… --schema=booking --version=1` на чистой БД, затем `cd lib && npm test`.
- `lib/test/up.test.ts`: «seeds: свои файлы с маркером», «seeds: false».

**Точки входа**
- `lib/src/up.ts:applySchema` — накат сидов (только новая схема)
- `lib/scripts/check-docs.mjs:checkSeedCounts` — сверка счётчика классов

**Не здесь**
- DDL и триггеры → M-ENGINE; накат и upgrade → M-BOOTSTRAP; реестр и наследование → M-SCHEMA; семантика Resource/Rule → M-ACL; CRUD служебных таблиц → M-AUTH
