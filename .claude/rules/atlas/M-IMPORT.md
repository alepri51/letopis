---
paths:
  - 'lib/src/import.ts'
  - 'lib/test/fixtures/gen-v021.mjs'
synced: 3033e57
---
# M-IMPORT — импорт из letopis 0.21 (этап 7)

**Инварианты и грабли**
- Источник — таблицы 0.21 (`Schema`, `Entity`, `Account`, `Credential`, `Resource`, `Rule`) любой базы: PostgreSQL 17 с TimescaleDB или дамп обычных таблиц; приёмник — установленная схема 1.0, подключения администраторские (загрузчик и `sys_create`/`secret` под `set local role` владельца).
- Всё, что останавливает импорт, проверяется до первой записи: два объекта 0.21 → один id 1.0 (`duplicate`, подсказка `--keyless`), ключ, менявшийся между версиями, ключ со ссылкой на отсутствующий объект. Висячие ссылки живых строк ловит загрузчик (`target_not_found`); строки его ошибки переводятся в объекты 0.21 (`class`, `id`, `rev`). `detail` ошибки шага данных (`import021`, `catch` вокруг загрузки арендатора): `{ ...detail загрузчика, rows: объекты 0.21 с code и message, notes }` — `total`, `truncated`, `limit`, `complete` отчёта загрузчика доходят как есть; текст — `import: арендатор <id>: …`.
- Ресурсы 0.21 пишет загрузчик (шаг прав), поэтому маску шаблона не строкой отклоняет описание класса `Resource` (`invalid_data`, M-SEEDS; схема с новым описанием — свежая или после `reset({ all })`) — импорт останавливается на шаге прав; ошибка — загрузчика как есть, без перевода строк.
- Классы — строки `Class` арендатора System: роль конца = имя класса цели; союз всех конкретных потомков класса — полиморфный конец этого класса, иначе роль `A_B` со списком классов; `onDelete: cascade` (так удаляла 0.21); корни без своих полей и концов (`Entity`, `link`) опускаются; ссылка в данных на необъявленный класс — необязательный конец (в `notes`). Имена методов 1.0 и системных классов — `rename` или имя + `_`.
- fastest-validator → JSON Schema (`conv`): `optional` пропускает null (`type: [T, 'null']` или `anyOf`), `default` — необязательное поле, `$$strict`/`strict` → `additionalProperties: false`, `record` → `propertyNames` + `additionalProperties`; непереводимое — в `notes`, поле без проверки. Поля на `$` отбрасываются (`droppedFields`).
- id: класс с ключом — v5 от ключа (из правила `generate: 5, from`), без ключа и `keyless` — v5 от старого id (`$ext`); пространство — арендатор; аккаунт — `v5(System, 'Account', [старый id])`, аккаунты с категорией System → System; данные System — в арендатора `tenant` (`v5(System, 'Account', ['tenant:<имя>'])`).
- Версии: надгробие — `op delete`, следующая за ним — `create`; теги — `$tags`, владелец (если не арендатор и аккаунт найден) — `$owner`; загрузка — режим истории с `existing: 'skip'`, `update` — второй проход без истории с `existing: 'update'` по последним живым версиям.
- Креды → `secret` как есть: scrypt (`meta.password`), APIKEY (sha256 hex → bytes, `ident` = префикс), KEYSECRET, TOTP (base32 → bytes); OTP не переносится; совпадение `kind`+идентификатор без учёта регистра — первым подтверждённый, остальные в `conflicts`. Шаблон ресурса: `account` → `tenant`.
- Шаги — отдельные транзакции (классы, аккаунты, креды, права, данные каждого арендатора); повтор дописывает и дублей не создаёт.
- `--initial` (план 1.1, этап 3): шаги 1–5 (`steps(x)`) — в одной `initialSession`: операторы владельца — на её соединении (`x.begin`), загрузки — `x.load` без `existing` (только `'error'`); аккаунты, ресурсы и правила, чьи id уже в схеме (`x.taken`, системный сид), пропускаются и считаются в `skipped`. С `update` и `commitEvery` — отказ до подключения. `verify()` и счётчики — после фиксации.

**Что ещё менять вместе**
- Новый `$`-ключ загрузчика, который нужен импорту: `load.ts` (`check`, `writeBatch`, `historyWrite`) и карточка M-WRITE.
- Фикстура (`test/fixtures/v021.sql`) пересобирается `node test/fixtures/gen-v021.mjs` (нужен контейнер 0.21); числа классов — `EXPECTED` в `import.test.ts`.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/import.test.ts`; полный полигон — `npm run test:import-salon` (контейнеры 0.21 и 1.0; импорт держит весь источник в памяти).

**Точки входа**
- `lib/src/import.ts:import021` — импорт
- `lib/src/import.ts:buildClasses` — схема 0.21 → классы 1.0
- `lib/src/import.ts:conv` — правило fastest-validator → JSON Schema
- `lib/src/cli.ts:main` — `letopis import`
