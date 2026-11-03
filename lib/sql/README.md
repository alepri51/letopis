# SQL ядра letopis 1.0

Файлы накатываются установщиком (`lib/src/up.ts`, функция `install`) по возрастанию номера; каждый можно применить повторно.
Спецификация — `reports/PLAN-LETOPIS-1.0.md`, §2 и этап 1.

## Подстановки при накате

| Маркер | Что подставляется |
|---|---|
| `@SCHEMA@` | имя схемы в кавычках, например `"v2.salon"` |
| `@SCHEMA_NAME@` | имя схемы как строковый литерал без кавычек идентификатора, например `v2.salon` |
| `@OWNER@` | роль-владелец, по умолчанию `letopis_owner` |
| `@APP@` | роль приложения, по умолчанию `letopis_app` |
| `@PGCRYPTO@` | схема, где установлен pgcrypto (`pg_extension.extnamespace`) |
| `@SYSTEM@` | id системного арендатора System: `2eba6d0a-1edd-4bb6-a85a-a703dab49035` (как в 0.21) |
| `@RESERVED_NAMES@` | методы цепочки — `RESERVED_CLASS_NAMES` из `lib/src/types.ts`, литералами через запятую |
| `@MESSAGES@` | каталог сообщений базы — разделы `sql-*` каталога `lib/src/messages` (план 2.0, этап 3, п. 3): литерал JSON «ключ → `{ name, ru }`» для `message_catalog()` в `15-errors.sql` |
| `@SIGNALS@` | режим сигналов `class`, `tenant`, `opaque` или `none` (план 1.1, §2.2): опция `up({ signals })`, иначе сохранённый в `meta.signals` строки ключа `secret`, иначе `class` — константа установки |
| `@ENGINE_VERSION@` | версия пакета (`lib/package.json`) — штамп движка в комментарии схемы (`99-revision.sql`) |
| `@ENGINE_SQL@` | 16 знаков sha256 исходного текста файлов `NN-*.sql` до подстановок (переводы строк — LF) и разделов `sql-*` каталога сообщений: `connect()` сверяет его с файлами своего пакета |

## Колонки версии

Одинаковы в `entity` и `log` (§2.2): `id`, `rev`, `class`, `cv`, `tenant`, `owner`, `links`, `data`, `tags`, `at` (время
версии), `author`, `agent`, `op`, `reason`, `moved`. У `entity` ещё `ends` (генерируемая: все цели концов),
`created_at` и `validator` (у строк `Class`), у `log` — `seq` и `tx` (курсор подписки). Хэшей версий нет с 2.0.0.

## Коды ошибок

Собственный класс SQLSTATE `LT`; текст — `letopis: <имя>: <сообщение>`, детали — JSON в `DETAIL`.
Источник истины — функция `error_catalog()` в `15-errors.sql`.

Тексты — по ключам каталога сообщений (план 2.0, этап 3, п. 3): `lt_fail(ключ, параметры jsonb, detail jsonb)` берёт имя
ошибки и русский шаблон из `message_catalog()` (`{имя}` — параметр, подставляет `lt_text()`), а в `DETAIL` кладёт поля
`detail` и ещё `key`, `params` — библиотека переносит их в `err.key` и `err.params`; текст тот же, что видит сырой SQL.
`LetopisError.detail` — прежний: без `detail` — `{}` (так всегда делала `lt_raise`); `p_detail => 'null'` — у места
`DETAIL` не было и до каталога (`raise` без `detail`): в `DETAIL` признак `nodetail`, у ошибки `detail` нет.
Свой SQLSTATE — `lt_raise(код, ключ, параметры, detail)`. Функции, которые исполняет приложение (`inc`, `links_patch`),
бросают `raise` сами: текст — `lt_text(ключ, параметры)`, она и `message_catalog()` выданы приложению; `DETAIL` без своих
полей — с `'nodetail', true`. Все места переведены на ключи: у прежней перегрузки `lt_fail(имя, текст, detail)` вызовов
нет, а `lt_raise(код, имя, текст, detail)` — механизм новых перегрузок (единственный `raise`). Внутренняя ошибка —
`lt_raise('XX000', ключ, …)` с кодом `internal`; строки отказа ужесточения и нарушения данных несут `key` и `params`, а
текст `problem` и `message` собирает `lt_text`. Литеральный текст в `raise` и в `problem` ловит `check:docs`
(`literals`).

| Код | Имя | Когда |
|---|---|---|
| LT001 | `no_session` | нет действующей сессии |
| LT002 | `target_not_found` | цель конца не найдена (одинаково для несуществующей и чужой) |
| LT003 | `invalid_data` | данные не проходят описание класса; в деталях `issues` — путь, ключевое слово, сообщение |
| LT004 | `undeclared_end` | конец не объявлен в классе |
| LT005 | `tenant_denied` | запись в чужого арендатора |
| LT006 | `acl_denied` | отказ по правилам доступа |
| LT007 | `id_mismatch` | id не равен v5 от ключа; в деталях `expected` |
| LT008 | `id_from_db` | id класса без ключа выдаёт база |
| LT009 | `immutable_key` | ключевое поле, id, арендатор, владелец менять нельзя |
| LT010 | `invalid_class` | описание класса отклонено, класс не найден или абстрактный |
| LT011 | `use_reclass` | класс с ключом меняется функцией `reclass()` |
| LT012 | `reclass_denied` | роли ссылающихся строк не принимают новый класс; в деталях `rows`, `others` |
| LT013 | `tightening_conflict` | ужесточению мешают строки; в деталях `rows`, `others` |
| LT014 | `isolation_level` | удаление и смена класса — только в `read committed` |
| LT015 | `recreated_in_statement` | id удалён и создан заново одним оператором |
| LT017 | `delete_restricted` | удалению мешают ссылающиеся строки (`onDelete: restrict`); в деталях `rows`, `others` |
| LT018 | `not_deleted` | `restore` и `purge` — только для удалённых объектов (этап 6) |

## Порядок файлов

`10-core` → `15-errors` → `20-context` → `30-validate` → `40-class` → `50-acl` → `60-write` → `70-read` → `80-auth` → `90-time` → `95-seed.system` → `99-revision`. Миграции между ревизиями 2.x — `migrate/NNNN-*.sql` (номер — ревизия, к которой ведёт; правило — `migrate/README.md`), их применяет `up({ upgrade: true })` до повторного наката. У 2.0 (ревизия 8) миграций нет: схему letopis 1.x 2.0 не обновляет, а ставит заново (`up({ fresh: true })`).

Файлы описывают только нынешнюю ревизию: `drop … if exists` в них — лишь там, где без него не пройдёт повторный накат
той же ревизии (политики RLS в `50-acl.sql`: у `create policy` нет `or replace`). Смена сигнатуры функции в пределах
ревизии — `drop function if exists` прежней в том же файле, иначе повторный накат оставит лишнюю перегрузку.
