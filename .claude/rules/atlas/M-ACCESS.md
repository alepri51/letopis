---
paths:
  - 'lib/sql/{20-context,50-acl,80-auth}.sql'
  - 'lib/src/{auth,acl}.ts'
synced: f20b1cf
---
# M-ACCESS — контекст, сессии, ACL и RLS, креды и вход (этапы 1, 5)

**Инварианты и грабли**
- `ctx()` — только читает: сессия по `sha256(letopis.token)`; аккаунт включён и лежит в System; `letopis.account` действует лишь при праве `auth.impersonate` по правилам System, цель — не System, не сервис, не член System (системный администратор), включена; рабочий арендатор (`letopis.tenant` ?? `meta.tenant` ?? аккаунт) чужой — только по членству, проверка при каждом вызове. Отказ — ошибка (`acl_denied`, `tenant_denied`), а не пустой контекст.
- Аккаунты (с категориями) — только в System (триггер вставки, загрузчик); все поиски аккаунта в функциях входа и `ctx` — с `tenant = System`. На этом держится: категории (группы ACL, право сервиса) правит только системный администратор.
- Правила арендатора — на его строки, правила System — везде; группа по ролям совпадает только в правилах рабочего арендатора (`acl_group_ok(…, p_same)`), поэтому роль, выданная арендатором, не даёт прав System. Права `auth.*` и `letopis.*` — только правила System (`acl_require`, `acl_api_for(…, true)`). Вес правила арендатора — не больше 999: от 1000 — административный слой System.
- Решение (`acl_plan_for`): вес ↓, запрет первым, alias объекта, id — как `decide` 0.21 (`acl-parity`, 1000 наборов). Классы плана — по одному на имя, как в `class_row` (M-ENGINE): свой класс арендатора, иначе System. Одноимённый класс System, заведённый позже, своими предками и алиасом давал бы права на строки класса арендатора (`engine-attacks` №54).
- Маски `Resource` (`categories`, `roles`, `endpoint`, `class`) — только строки: иное отклоняет описание класса (M-SEEDS). Маска не строкой, записанная в обход проверки, — «неизвестно»: разрешение по ней не действует, запрет — на всех (в 0.21 — совпадение со всеми); `endpoint` не строкой — ни один эндпоинт. Тесты — `acl`.
- Политики: `acl_ok(acl_all, acl_plan, …)` — встраиваемая (каждый параметр один раз; объект строки собирается только для классов с условием); в функциях владельца — `acl_row_ok` и `row_visible` (план в переменной).
- Пропуск прав `letopis.acl` (`acl_token`): HMAC ключом строки `secret` id = System, привязка к актору, арендатору и счётчику `acl_bump`; неверный пропуск — план заново (на права не влияет). `meta` строки ключа общая с M-TIME (`meta.thin`, `default_policy`): `acl_bump` её сливает, а не затирает.
- Креды: `secret`, идентификатор без учёта регистра; хэш пароля — только `auth.password` и видов «логин/пароль»; свои креды — после недавнего интерактивного входа (10 мин; не APIKEY, KEYSECRET, SERVICE; при включённом TOTP — с TOTP), без самоподтверждения; привилегированные цели — `auth_guard` (сам или системный администратор, `letopis.credential`). Служебные виды `secret` (`SESSION`, `KEY`, `PROJECTOR`, `LOCK`) — не креды: `auth_kind_ok` их не принимает, функции кредов отсекают (`kind not in (…)`). Счётчики попыток OTP/TOTP транзакционные (откат к точке сохранения их снимает) — поэтому `login_otp` и `auth_verify_totp` только сервису с правом. Гашение сессий — `auth_kill` (ключи — `auth_kill_cred`) с сигналом `session:<16 hex>` (`signal_raw`).
- Вход с `totp` (`auth.ts:makeAuthCore`) проверяет код той же `auth_verify_totp`, что `verifyTotp` (счётчик неудач и блокировка общие; секрет из базы не выходит); неудача и аккаунт без TOTP — null. Без `totp` код не проверяется — у сессии нет отметки `TOTP`.
- Ключи сервиса: свои `APIKEY`/`KEYSECRET` сервис выпускает и отзывает сам (`auth_service_self`), прочие свои креды и чужие ключи — `auth_can_manage`. Вход по ключу пишет id ключа в `meta.cred` (`login_apikey`, `auth_login_apikey`, `login_keysecret`) — по нему отзыв ключа гасит его сессии, а не все сессии аккаунта (`auth_kill_cred`). Последний действующий ключ сервиса не отзывается никем (`acl_denied`).
- Ключ сигналов: `signal_key()` (`90-time.sql`) отдаёт HMAC(ключ строки KEY, `'letopis:signals'`), а не сам ключ строки: им подписаны пропуска прав. Право — `letopis.signals` (`letopis_allowed`: правило System «сервисам» из сида или `admin_role` — администратор по действующей роли сеанса, SET ROLE). Тесты — `roles` №4, `engine-attacks` №31.

**Что ещё менять вместе**
- Новая функция владельца (security definer): негативный тест и белый список в `roles.test.ts` №4.
- Смена правил видимости: `row_visible()`, политики `entity_*`/`log_select`, таблица §2.2 плана, `find-ids-parity`, `acl`.
- Новый класс прав или изменение того, что входит в план: список классов `acl_bump` в триггерах, `sys_create`, `ACL_CLASS_NAMES` (`types.ts`).

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `acl`, `acl-parity`, `auth`, `impersonation`, `member`, `system-classes`, `access-rest`, `engine-attacks`, `roles`, `context`.
- Цена прав: `cd lib && npx tsx bench/acl-cost.mjs`.

**Точки входа**
- `lib/sql/20-context.sql:ctx` — контекст запроса
- `lib/sql/50-acl.sql:acl_plan_for` — план прав
- `lib/sql/50-acl.sql:acl_plan_cached` — пропуск прав
- `lib/sql/50-acl.sql:entity_select` — политики RLS
- `lib/sql/80-auth.sql:auth_set_password` — креды
- `lib/sql/80-auth.sql:auth_revoke_credential` — отзыв креда, ключи сервиса
- `lib/src/auth.ts:makeAuth` — db.auth
- `lib/src/acl.ts:makeAcl` — db.acl
