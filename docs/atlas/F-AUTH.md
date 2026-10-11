# F-AUTH — Креды, вход и сессии (letopis 1.0, этап 5)
Процессы: [N] Node-процесс сервиса · [P] PostgreSQL (`secret`, `entity`)
Триггер: `svc.auth.setPassword({ account, identifier, password })` → `r = await svc.auth.verifyPassword({ identifier, password, totp? })` → `connect({ token: r.token })` → `db.auth.revoke()` / `revokeAll()`.

## Пароль и вход
1. [N] `lib/src/auth.ts:hashPassword` — scrypt в Node (`scrypt$N$r$p$соль$хэш`).
2. [P] `lib/sql/80-auth.sql:auth_set_password` — `auth_can_manage`: сам аккаунт своей сессией (не через сервис) после недавнего интерактивного входа (10 мин, `meta.login_at`; APIKEY, KEYSECRET, SERVICE не в счёт; при включённом TOTP — пройденный TOTP) или право `auth.credential` (креды System, сервисов и системных администраторов — только системный администратор); идентификатор без учёта регистра (`secret_kind_ident`); занят другим — тот же `acl_denied`; замена хэша гасит остальные сессии (`auth_kill`).
3. [P] `lib/sql/80-auth.sql:auth_password_get` — хэш только с правом `auth.password` (правила System).
4. [N] `lib/src/auth.ts:makeAuthCore#«verifyPassword»` — нет креда — холостой scrypt; неподтверждённый — `null` (если не `requireConfirmed: false`); верен — `login`: `issue_session(account, ttl, ['PASSWORD'])` (право `auth.session`, цель не System, не сервис, не член System).
5. [N] `lib/src/auth.ts:makeAuthCore#«const login»` — с `totp` (`verifyPassword`, `lookup`) до выпуска сессии: `auth_verify_totp(account, code, 1)` (шаг 9: право `auth.totp`, общий счётчик и блокировка, удача включает неподтверждённый фактор); неудача и аккаунт без TOTP — `null`, удача — способы `[вид, 'TOTP']`: по такой сессии пользователь с TOTP меняет свои креды сам (шаг 2). Без `totp` код не проверяется.

## Прочие креды
6. [P] `lib/sql/80-auth.sql:auth_issue_apikey` — `lts_` + 48 hex, в базе sha256, префикс в ident; право — `auth_service_self` (свой ключ сервиса, шаг 11) или `auth_can_manage`. Вход — `login_apikey` (connect) или `auth_login_apikey`; пара — `auth_issue_keysecret` и `login_keysecret`. Сессия по ключу — способ `APIKEY`/`KEYSECRET` и id ключа в `meta.cred`.
7. [P] `lib/sql/80-auth.sql:login_otp` — только сервис с правом `auth.otp` (счётчик транзакционный); строка кода под блокировкой: срок, лимит попыток из выпуска, успех и перебор сжигают код.
8. [P] `lib/sql/80-auth.sql:auth_lookup` — identity (`TELEGRAM`, …) по праву `auth.identity`; дальше — `login` (шаг 5).
9. [P] `lib/sql/80-auth.sql:auth_verify_totp` — только сервис с правом `auth.totp`; `totp_code` (HMAC-SHA1 pgcrypto, шаг 30 с, окно не шире ±1), повтор шага отклоняется, пять неудач — блокировка на 5 минут, первая удача включает фактор; удача по своей сессии добавляет ей способ `TOTP` и обновляет `login_at`.

## Ключи сервиса
10. [P] `lib/sql/80-auth.sql:auth_is_service` — аккаунт категории `Service` в System.
11. [P] `lib/sql/80-auth.sql:auth_service_self` — актор — сам сервис (не имперсонация), сессия открыта ключом (`methods` ∋ `APIKEY`|`KEYSECRET`): свои ключи он выпускает (шаг 6) и отзывает (шаг 12) без `auth_can_manage`; прочие свои креды и ключи других сервисов, System и системных администраторов — по-прежнему системный администратор.
12. [P] `lib/sql/80-auth.sql:auth_revoke_credential` — `auth_can_manage`, для своего ключа сервиса — `auth_service_self`; живой ключ сервиса отзывается, только если остаётся другой действующий (ключи аккаунта — под `for update`), иначе `acl_denied` «последний действующий ключ сервиса не отзывается: сначала выпустите новый». Ключ гасит только свои сессии (`auth_kill_cred`, шаг 15), прочие креды — остальные сессии аккаунта (`auth_kill`, шаг 16); текущая — по `keepCurrent`. Ротация без простоя: новый ключ → процессы на него → отзыв старого.

## Сессии
13. [P] `lib/sql/20-context.sql:new_session` — 256 бит `gen_random_bytes(32)`, в базе sha256; `meta`: время входа `login_at` и срок `ttl`, плюс от вызывающего — способы, выпустивший сервис, у входа по ключу — `cred`; арендатор (`meta.tenant`) пишет `auth_switch`.
14. [P] `lib/sql/80-auth.sql:auth_switch` — не при имперсонации (`invalid_query`); сессия по токену напрямую (прежний арендатор мог стать недоступным), членство и включённый аккаунт арендатора, `meta.tenant` (свой арендатор — ключ снимается).
15. [P] `lib/sql/80-auth.sql:auth_kill_cred` — гашение сессий ключа: `meta.cred` = id ключа и старые сессии того же вида без `cred` (чей ключ, не узнать), кроме переданной; сигнал тот же, что у `auth_kill`.
16. [P] `lib/sql/80-auth.sql:auth_kill` — гашение сессий аккаунта (кроме переданной: текущей при `keepCurrent`), сигнал `session:<16 hex sha256>` (`signal_raw`; в режиме сигналов none — нет); вызывают смена пароля (`auth_set_password`), удаление креда, кроме ключей (`auth_revoke_credential`), `revokeAll` (`auth_logout_all` — все сессии), отключение аккаунта (`trg_entity_au`), удаление аккаунта (`trg_entity_ad`, там же удаление кредов). `revoke()` — `auth_logout`, только текущая сессия.
17. [N] `lib/src/index.ts:connect#«const touch»` — `auth_refresh()` не чаще раза в минуту после успешных операций; срок продлевается не дальше `meta.ttl`, выданного при входе.

Сбои: `no_session`, `acl_denied` (одинаковый для «нет права» и «идентификатор занят»; последний действующий ключ сервиса), `tenant_denied`, `invalid_query` (`auth_switch` при имперсонации); неверный или повторный код TOTP при входе — `null`, не ошибка.
