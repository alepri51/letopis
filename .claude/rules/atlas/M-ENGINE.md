---
paths:
  - 'lib/sql/{10-core,15-errors,40-class,60-write,99-revision}.sql'
  - 'lib/sql/migrate/**'
synced: f20b1cf
---
# M-ENGINE — таблицы, триггеры записи, классы, журнал, хэши

**Инварианты и грабли**
- Триггеры движка — `when (current_user <> владелец)`; агрегатные `entity_total_*` (M-DERIVED) срабатывают и для владельца. Суперпользователь без `set role letopis_owner` — не владелец: мимо триггеров тесты пишут через `asOwner()` (`lib/test/_engine.ts`).
- Пустая правка (`trg_entity_bu`) возвращает OLD: строка затронута, а версии и сигнала нет — на этом стоит правило числа затронутых строк в M-WRITE.
- Блокировки семейства (`family_lock`). Писатель строк берёт разделяемую и перечитывает `class_row`: пока он ждал, класс могли удалить или ужесточить. Строка `Class` с `parent` — разделяемая семейства родителя. Исключительная — ужесточение (старое и новое семейство), `rekey_class`, удаление класса, пометка `derivedBy`. Новый путь записи — так же, иначе остаются строки без класса или запись мимо ужесточения (`854c50e`).
- Класс по имени — как в `class_row`: свой класс арендатора, иначе System. Класс System может появиться позже одноимённого класса арендатора, поэтому строки, потомки и история класса System — это все арендаторы, кроме тех, у кого свой класс с этим именем (`class_has_history`, `class_orphan_history`, `class_admit`, `trg_entity_ad`; атаки №48, №54, №55). Новая проверка «по всем строкам класса» — с тем же исключением.
- Правка строки `Class` требует прав без условий на все строки класса и его потомков (`class_rows_admit`): смена `parent`, `alias`, `derivedBy` — READ, WRITE и DELETE (правила находят строки по именам класса, предков и алиасов — `acl_plan_for` в `50-acl.sql`), смена `history` — READ и DELETE (по ней `maintain()` прореживает журнал), ужесточение — READ (иначе оракул по невидимым строкам). Атаки №36, №41, №43.
- По тем же именам правила находят и старые версии. Поэтому класс с историей строк не удаляется, а заново создаётся только с `parent`, `alias`, `derivedBy` и `history` из надгробия своей строки `Class`; алиас предка не меняется, пока удалённые потомки хранят историю (атаки №40, №49).
- Текст отказа называет класс, роль или id строки, которую актор не адресовал (каскад, ссылка, помеха), только если он её видит: `visible_class`, `visible_detail`, `row_visible` (атаки №47, №51).
- `derivedBy`: строки производного класса пишет только проектор (`derived_apply` в `88-derived.sql`, от владельца). Триггеры и `move_row` отказывают `derived_class`, ссылку на такую строку не пропускает `targets_bad`. Описание с пометкой и предка производного класса правят только с правом `letopis.projector` (атаки №33, №38, №50).
- Права на агрегаты проверяются в `class_admit` до записи, а в `trg_entity_ai`, `trg_entity_au` и `class_evolve` — после (`agg_source_admit`, `agg_author_admit`): новый класс план прав видит только после вставки. Источник описывают раньше агрегата; класс-источник не удаляется, пока его называет агрегат того же арендатора (атаки №52, №53, №57).
- Ошибки — `lt_fail(имя)` по `error_catalog()`; функции, которые исполняет приложение (`inc`, `links_patch`), бросают `raise` сами: `lt_raise` ему не выдан.
- Сигнал — только через `signal()` или `signal_raw()`; `pg_notify` напрямую не зовут ни функции, ни загрузчик, ни импорт.

**Что ещё менять вместе**
- Колонка или ограничение существующей таблицы (`create table if not exists` их не добавит) → миграция в `lib/sql/migrate/` (номер файла — новая ревизия), `ddl_revision` в `99-revision.sql`, `DDL_REVISION` в `lib/src/types.ts` (сверяет `check-docs`), тест `upgrade`. Индексы и функции догоняет повторный накат.
- Колонка снимка версии → `snapshot()`, обе таблицы и все вставки в журнал: триггеры, `log_version`, `88-derived.sql`, `90-time.sql`, `95-seed.system.sql`, `lib/src/load.ts`. Колонка журнала → грант на `log` по колонкам и тест «права по каталогу» (`roles`).
- Проверки смены класса — в `trg_entity_bu` (без ключа) и в `reclass`; уровни каскада — в `trg_entity_ad` и `delete_preview` (общее правило `ref_action`).
- Новый код ошибки → `error_catalog()`, таблица в `lib/sql/README.md`, `cd lib && npm run api:contract`.
- Новая функция → список `owner`/`revoke` в конце её файла; `security definer` — негативный тест `roles` №4; выданная приложению — белый список `roles`. Новый триггер `entity` → `roles` №7 и атака №19.
- Сигнатура или текст `trg_entity_ai`, `targets_bad`, `signal_raw`, `family_lock` → бенчи, которые их подменяют (M-BENCH).
- Новый служебный вид строки `secret` (как `LOCK`) → исключить его в функциях кредов `80-auth.sql`.

**Неимпортные связи**
- RLS (`50-acl.sql`) отсекает чужие строки до триггеров правки и удаления, вставку первым проверяет триггер (`tenant_denied`).
- `99-revision.sql`: `@ENGINE_VERSION@` и `@ENGINE_SQL@` подставляет `lib/src/up.ts:engineStamp`; формат комментария схемы разбирают `lib/src/up.ts` (`schemaRevision`, `stampDrift`) и `connect()`. `@RESERVED_NAMES@` — из `RESERVED_CLASS_NAMES` (`lib/src/types.ts`).
- Строки-замки: семейств заводят заранее `class_admit` (`family_rows`) и `seed_system`; `lock_try` берут `maintain` (`90-time.sql`) и проектор (`lib/src/project.ts`).

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `engine-attacks` (атаки №…), `engine-races`, `engine-write`, `engine-class`, `write-races`, `security-final`, `hash`, `roles`, `upgrade`, `aggregate`, `projector`.

**Точки входа**
- `lib/sql/60-write.sql:trg_entity_bi` — вставка, сверка надгробия класса
- `lib/sql/60-write.sql:trg_entity_bu` — правка, ужесточение, смена класса
- `lib/sql/60-write.sql:trg_entity_ad` — каскад, удаление класса
- `lib/sql/60-write.sql:class_admit` — проверки строки `Class`
- `lib/sql/60-write.sql:family_lock` — блокировки семейства

**Не здесь**
- `verify`, `restore`, `purge`, `rekey_class` → M-TIME; агрегаты и проекторы → M-DERIVED; накат и миграции → M-BOOTSTRAP.
