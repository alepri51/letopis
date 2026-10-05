---
paths:
  - 'lib/bench/**'
synced: 6c5460a
---
# M-BENCH — Полигоны, бенчи и демо (источник цифр lib/README.md §11, §14)

**Инварианты и грабли**
- Ответы и тайминги lib/README.md §11 — прогон `lib/bench/api-reference-demo.mjs`; §14 — он же, `lib/bench/salon-article-demo.mjs` и бенчи; таблицы §9.2 — `lib/bench/acl.bench.mjs`, §10.6 — `lib/bench/isolation.bench.mjs`. Цифры переносятся руками и привязаны к размеру полигона: сменился полигон или план запроса → перемерить (строка «≈6 с» прожила до реальных ≈30 с, §14).
- Полигон `v1.salondemo` (~980k строк) создаёт `lib/bench/salon-seed.mjs`: DROP + `db/apply.mjs` (его ANALYZE проходит ДО заливки) + bulk-INSERT. Своего ANALYZE в сиде нет → после засева вручную `ANALYZE "v1.salondemo"."Entity"`, иначе запросы с предикатом медленнее на порядок (§14.1).
- `v1.tenants` (`lib/bench/tenants-seed.mjs`, 10 арендаторов 50 %…0.3 %, ANALYZE в конце сам) нужен только для цены изоляции: в salondemo System владеет всем классом, предикат account ничего не отсекает.
- salon-seed пишет в Entity при включённых триггерах (валидация по Schema.links v2 из seed.booking.sql, «схема 0.17»); tenants-seed — при `session_replication_role = replica`; демо так же вычищают свой мусор прошлого прогона (по префиксам id/alias) — DSN нужен суперпользовательский.
- Файлы с импортом из ../src/index.js запускаются только через `npx tsx`: под `node` — ERR_MODULE_NOT_FOUND (в src только .ts). Команды `node bench/…` в шапках dimensions/history/salon-article-demo и в README §14 рабочие лишь для сидов (они импортируют только `postgres`).
- tenants-seed запускает `main()`, сравнивая `import.meta.url` с `file:///` + argv[1]: на Linux/macOS получается `file:////…` — засев молча не стартует. Guard нужен, потому что isolation.bench импортирует из сида `TENANTS`.
- Захардкожено: DSN в acl.bench (без `ENTITY_DSN`); System `2eba6d0a-1edd-4bb6-a85a-a703dab49035` (из `lib/sql/seed.auth.sql`) — в сидах, бенчах и демо. Redis (`ENTITY_REDIS`) нужен api-reference-demo и salon-article-demo; article-demo без него пропускает сцену.
- `lib/bench/dimensions.bench.mjs` сам повторяет логику apply.mjs (ddl + seed.booking + seed.auth, замена `<SCHEMA-NAME>`, `add_dimension` после `create_hypertable`) в схемах `bench_time`/`bench_class`/`bench_pc` и ПЕРЕЗАПИСЫВАЕТ `lib/bench/dimensions.results.json` только прогнанными вариантами. Сейчас там один `bench_pc` на 40 646 строк — не источник цифр 1.1M строк из lib/README.md §2.1. Пометка «← текущий ddl» у bench_pc в шапке устарела: ddl time-only.

**Что ещё менять вместе**
- Классы/концы seed.booking.sql → генераторы salon-seed и dimensions.bench, id в демо → пересев, ANALYZE, перемер README §11/§14.
- Экспорт index.ts переименован/удалён → импорты бенчей (check-docs 8 видит только `import {…}` из src/index.js или letopis; `uuidv5` из ../src/uuid.js в salon-article-demo не проверяется). Образец b6e28a6 (6 бенчей).
- Упоминание ИМЯ.md или ссылка в шапке bench → файл обязан существовать (check-docs 2).
- Форма `create_hypertable` в ddl.sql или новый сид по умолчанию → `ddlFor` и список файлов в dimensions.bench.

**Состояние и побочки**
- Всё в БД `clockz`: `v1.salondemo`, `v1.tenants` (пересоздаются; `--keep` — досев), `v1.bench` (history, дропается в конце), `bench_*` (dimensions).
- На диск пишет только dimensions.bench (dimensions.results.json).

**Проверка**
- `cd lib && npm run check:docs` (проверки 2 и 8, без БД; в CI бенчи не гоняются).
- Полигоны: `cd lib && node bench/salon-seed.mjs` + ANALYZE; `cd lib && node bench/tenants-seed.mjs && npx tsx bench/isolation.bench.mjs`; `cd lib && npm run bench` (history, ~100k строк).

**Точки входа**
- `lib/bench/salon-seed.mjs:makeRows` — генератор полигона salondemo
- `lib/bench/tenants-seed.mjs:TENANTS` — арендаторы, общие с isolation.bench
- `lib/bench/dimensions.bench.mjs:ddlFor` — копия логики apply.mjs
- `lib/bench/acl.bench.mjs:DSN` — захардкоженный DSN

**Не здесь**
- ANALYZE при накате, `db/apply.mjs` → M-BOOTSTRAP; сиды по умолчанию → M-SEEDS; гейты check-docs → M-RELEASE; тесты → M-TESTS.
