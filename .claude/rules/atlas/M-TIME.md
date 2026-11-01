---
paths:
  - 'lib/sql/90-time.sql'
  - 'lib/src/{watch,admin,cache,signals}.ts'
synced: f20b1cf
---
# M-TIME — история, хранение, подписка, кэш, сигналы, сброс, обслуживание

**Инварианты и грабли**
- `maintain()` удаляет коды всех видов, которые выпускает `auth_issue_otp`: шаблон вида `^OTP(_[A-Z0-9]{1,27})?$` в `lib/sql/90-time.sql` и в `lib/sql/80-auth.sql` один — меняешь один, меняй оба.
- У id с записью в журнале номер 1 всегда занят: `purge()` и `trim_history()` кладут свою запись (вид `purge`/`trim`) под номер 1 — на уникальности `log_id_rev` держится `existing: 'error'` загрузчика. Записи `purge`, `trim`, `reset` — не версии объекта: чтения версий их отбрасывают, подписка отдаёт событиями.
- Последнюю запись журнала id берут `for update` все, кто продолжает или стирает цепочку: `last_version_visible` (restore, purge), `trim_history`, `trg_entity_bi` и `move_row` (`lib/sql/60-write.sql`), воскрешение проектором (`lib/sql/88-derived.sql`). Новая операция над историей id — под той же блокировкой.
- «Администратор» (`admin_role`) и «обход RLS» (`watch_leaving`) в функциях владельца определяются только по `session_role()` — роли SET ROLE, иначе роли входа. Там `current_user` — владелец, `session_user` — роль входа, и привилегированный вход с `SET ROLE` на роль приложения сошёл бы за администратора (ревью коммита 1734d21; тест `engine-attacks` «№56»).
- Сигнал — только подсказка: NOTIFY в канал схемы может послать любая роль базы, а данных он не несёт. По нему лишь будят подписку (`wakes`), сбрасывают кэш (`ResultCache.apply`) и пропуска прав, перечитывают ключ и реестр не чаще заданного (`throttle`, `bucket` в `lib/src/index.ts`); карты счётчиков кэша ограничены (`bump`) — ревью №1 точки А плана 1.1.
- `maintain()`: один исполнитель — строка-замок `lock_try('@SCHEMA_NAME@:maintain')` (`lib/sql/60-write.sql`) в транзакции пачки, а не advisory-блокировка: её ключ может занять посторонняя роль (ревью безопасности №3, №2). Каждая пачка — своя транзакция, поэтому работает и за PgBouncer в режиме транзакций. Замок занят — база отвечает `null`: до первой пачки `skipped`, между пачками `more: true`.
- `describe()` берёт `resolved.schema` реестра: наследование уже развернула база (`class_resolve`), предков не сливать.

**Что ещё менять вместе**
- Новая функция владельца: перечень `alter function … owner` в конце `lib/sql/90-time.sql` (и `grant execute`, если её зовёт приложение), `lib/test/roles.test.ts` («№4» — негативный тест, белый список функций приложения); образец a25b432.
- Формат нагрузки сигнала: `signal()`, `signal_raw()`, `signal_token()` (`lib/sql/60-write.sql`), `Signals.parse` и токены, `wakes`, `ResultCache.apply`, `onSignal` в `lib/src/index.ts`, тесты `signals` и `security-final`. `lib/src/signals.ts:NAME` = шаблон имени метасхемы Class (`lib/sql/40-class.sql`): на нём держится однозначный разбор `класс@токен`.
- Новый вид служебной записи журнала: grep `'purge', 'trim', 'reset'` по `lib/sql` и `lib/src`; особые виды в `thin_batch` и `SPECIAL` в `lib/test/retention.test.ts`.
- Политика строки журнала — как `class_row`: свой класс арендатора, иначе System; у арендатора со своим одноимённым классом политика System не действует (`thin_batch`, `verify`, срок курсора в `watch_read`; план 2.0, 7.3 №1 — иначе строки входили в отбор дважды и ярусы стирались). Стирание истории удалённого — по всем версиям id любого класса и по политике класса надгробия (7.3 №2); перед отбором `thin_batch` берёт последнюю запись каждого id пачки `for update` (7.3 №3). `maintain(p_now, p_limit, p_cleanup)`: сессии и коды — только при `p_cleanup`, библиотека передаёт его в первой пачке вызова (`admin.ts`), а на схеме без третьего аргумента (42883) повторяет прежний вызов.
- Ярус `all` — общая граница: `thin_batch` прореживает только старше него, `verify` считает законным разрыв после версии старше него, `watch_read` отказывает `cursor_expired`, проектор (`lib/src/project.ts`) проверяет свой курсор сам.
- Подписка: короткие повторы (до 40) — только после сигнала (`Subscription.burst`); тик таймера `pollMs` — один запрос (план 2.0, 7.4 №1). `from: 'start'`, пока не догнала журнал (`catchingUp`), шлёт в `watch_read` время курсора `null` — весь журнал без `cursor_expired` (7.4 №3); курсоры событий и `sub.cursor` время события хранят: продолжение с них после прореживания — `cursor_expired` (пример сайта `history/03`, шаг 6; `retention` «7.4 №3»). Живые подписки подключения — `Shared.subs` (`track`, `WatchCtx.onClose`): `close()` подключения закрывает их (7.4 №8).
- Окно, горизонт и снимок у `watch_read` и `watch_leaving` одни (`Subscription.fetch` зовёт обе одним оператором); `watch_read(…, p_leaving)` зовёт ещё `lib/src/project.ts`.
- Новое свойство класса в реестре → `ModelDescription`, `describe`, `describeText`, тест `telemetry`; образец f38fbd7.

**Состояние и побочки**
- Строка KEY (`secret`, id = System) — общая. `material` — секрет пропусков прав (`acl_token`), ключа сигналов (`signal_key`) и признака агрегатов (`agg_token`); `reset` уровня all его пересоздаёт. В `meta`: `v` (`acl_bump`), `signals` (сид), `thin` — курсор прореживания, `default_policy` — метка для `verify`; пишут только слиянием (`||`, `-`). `thin_batch` держит строку `for update` до фиксации пачки — `acl_bump` ждёт.

**Неимпортные связи**
- `lib/src/index.ts` зовёт по имени `signal_mode()`, `signal_key()` (`fetchKey`) и `class_stamp()` (режим none, раз в 5 с); по `*` процессы перечитывают ключ сигналов и реестр и чистят кэш.
- `projector_unread` (отказ `projector_pending` у `purge` и `trim_history`) разбирает чекпоинт проектора: строку `secret` вида `PROJECTOR`, `meta.cursor` «tx:seq~снимок» (`lib/src/project.ts:enc`) и `meta.from`; проектор ищет по `derivedBy` класса.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `time`, `rekey`, `reset`, `verify`, `retention`, `watch`, `cache`, `signals`, `maintain` («7.8.1 №11», «разбор в)»), `projector`, `roles`, `engine-attacks`, `telemetry`, `security-final`, `up`.
- Цена режимов сигналов: `cd lib && npx tsx bench/signals.bench.mjs`.

**Точки входа**
- `lib/sql/90-time.sql:thin_batch` — прореживание
- `lib/sql/90-time.sql:watch_leaving` — уход строки из классов подписки
- `lib/src/watch.ts:Subscription` — подписка
- `lib/src/cache.ts:ResultCache` — кэш результатов
- `lib/src/signals.ts:Signals` — разбор нагрузки сигнала и токены
- `lib/src/admin.ts:maintain` — обслуживание
