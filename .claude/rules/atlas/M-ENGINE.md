---
paths:
  - 'lib/sql/{10-core,15-errors,40-class,60-write,99-revision}.sql'
synced: 9f59434
---
# M-ENGINE — таблицы, триггеры записи, классы, журнал, хэши, verify

**Инварианты и грабли**
- Ровно три таблицы: `entity`, `log`, `secret` (`10-core.sql`). Колонки `ends` и `hash` генерируемые; `hash = sha256(prev_hash || snapshot(...))`. Генерируемые колонки вычисляются с правами пишущей роли — у `letopis_app` есть EXECUTE на `link_ids`, `snapshot`, `version_hash`; без него любая вставка приложения падает 42501.
- Триггеры `entity` — `when (current_user <> '<владелец>')` и `enable always`. Триггерные функции — `security definer`, поэтому всё, что они пишут сами (каскад, пересчёт потомков, `sys_update`, `move_row`), триггеры не перепроверяют: эти функции обязаны сами писать журнал (`log_version`) и NOTIFY.
- Тест и сид пишут мимо триггеров только под `set role letopis_owner` (`asOwner()` в `_engine.ts`); суперпользователь без `set role` — тоже «не владелец», триггеры для него срабатывают.
- Пустая правка (`trg_entity_bu`) возвращает OLD, а не NULL: строка считается затронутой, версии и сигнала нет (AFTER-триггер сравнивает `rev`). На этом держится разбор `{ rev }` и правило числа затронутых строк этапа 4.
- Удаление — триггер ПОСЛЕ оператора с `old table as gone`; каскад по уровням (`delete … returning` в порядке id, затем поиск ссылок), `restrict` — один запрос по итогу (`delete_restricted`, LT017). Только `read committed` (статементный BEFORE-триггер).
- Блокировки семейства: `family_lock(корень, exclusive)` — форма advisory с двумя int4 (19540, hashtext), отдельное от пользовательского `lock()` (bigint) пространство. Писатели — разделяемая, ужесточение класса — исключительная; описание класса перечитывается после взятия блокировки.
- Строка `Class`: `class_admit` (system только у установки, имя не совпадает с системным, связь не называется методом цепочки, конец однозначен во всей схеме) + `class_prepare` (метасхема, ключ, unset, политика хранения). Поиск класса — `class_row(имя, арендатор)` по v5-id. Пересчёт потомков и проверка строк семейства — `class_evolve` в AFTER-триггере; «безопасность» изменения решает `class_change_safe`.
- Воскрешение: номер версии и `prev_hash` продолжаются от последней записи журнала; параллельные удаление и создание одного id сталкиваются на `log_id_rev` (23505) — повтор проходит.
- Смена класса: сырой `update set class` — только классы без ключа (иначе `use_reclass`); `reclass()` переносит строку на новый id через `move_row` (рекурсивно для ссылающихся строк, если конец входит в их ключ), журнал связывает id колонкой `moved`: первая версия нового id — вид `reclass`/`rekey` и `moved` = старый id, надгробие старого — всегда вид `delete` и `moved` = новый id (по `op = 'delete'` срез asOf и withDeleted отличают удалённый id).
- `reserved_names()` — текст функции с маркером `@RESERVED_NAMES@`: список подставляет установщик из `RESERVED_CLASS_NAMES` (`lib/src/types.ts`).
- Коды ошибок — только через `lt_fail(имя, …)` по `error_catalog()` (`15-errors.sql`); `merge` и `inc` выполняются от приложения и бросают ошибку напрямую (lt_raise приложению не выдан).

**Что ещё менять вместе**
- Новая колонка снимка: `snapshot()` и обе таблицы и `log_version`, `move_row`, `sys_create` (95) — формула хэша неизменна в пределах схемы `v<N>`.
- Новый код ошибки: строка в `error_catalog()`, таблица в `lib/sql/README.md`, `cd lib && npm run api:contract`.
- Новая функция владельца (security definer): негативный тест в `roles.test.ts` №4 — иначе тест падает.
- Структурная правка: `99-revision.sql` (`ddl_revision=N`) и `DDL_REVISION` в `lib/src/types.ts` — сверяет `check-docs`.

**Неимпортные связи**
- RLS (`50-acl.sql`, M-ACCESS) отсекает чужие строки до триггеров правки и удаления; на вставку первым отвечает триггер (`tenant_denied`).
- Контекст `ctx()` (`20-context.sql`) — источник автора и арендатора версии.
- Проверка данных — `validate_data`/`compile_validator` (`30-validate.sql`, M-VALIDATE).

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `engine-write`, `engine-class`, `engine-attacks`, `engine-races`, `hash`, `roles`.

**Точки входа**
- `lib/sql/60-write.sql:trg_entity_bi` — вставка
- `lib/sql/60-write.sql:trg_entity_bu` — правка, смена класса без ключа
- `lib/sql/60-write.sql:trg_entity_ad` — каскад удаления
- `lib/sql/60-write.sql:reclass` — смена класса с ключом
- `lib/sql/60-write.sql:verify` — цепочки хэшей и якорь
