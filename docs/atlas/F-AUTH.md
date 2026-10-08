# F-AUTH — Креды, вход и сессии (letopis 1.0, этап 5)
Процессы: [N] Node-процесс сервиса · [P] PostgreSQL (`secret`, `entity`)
Триггер: `svc.auth.setPassword({ account, identifier, password })` → `r = await svc.auth.verifyPassword({ identifier, password })` → `connect({ token: r.token })` → `db.auth.revoke()` / `revokeAll()`.

## Пароль и вход
1. [N] `lib/src/auth.ts:hashPassword` — scrypt в Node (`scrypt$N$r$p$соль$хэш`).
2. [P] `lib/sql/80-auth.sql:auth_set_password` — `auth_can_manage`: сам аккаунт своей сессией (не через сервис) после недавнего интерактивного входа (10 мин, `meta.login_at`; APIKEY, KEYSECRET, SERVICE не в счёт; при включённом TOTP — пройденный TOTP) или право `auth.credential` (креды System, сервисов и системных администраторов — только системный администратор); идентификатор без учёта регистра (`secret_kind_ident`); занят другим — тот же `acl_denied`; замена хэша гасит остальные сессии (`auth_kill`).
3. [P] `lib/sql/80-auth.sql:auth_password_get` — хэш только с правом `auth.password` (правила System).
4. [N] `lib/src/auth.ts:makeAuthCore#«verifyPassword»` — нет креда — холостой scrypt; неподтверждённый — `null` (если не `requireConfirmed: false`); верен — `issue_session(account, ttl, ['PASSWORD'])` (право `auth.session`, цель не System, не сервис, не член System).

## Прочие креды
5. [P] `lib/sql/80-auth.sql:auth_issue_apikey` — `lts_` + 48 hex, в базе sha256, префикс в ident; вход — `login_apikey` (connect) или `auth_login_apikey`.
6. [P] `lib/sql/80-auth.sql:login_otp` — только сервис с правом `auth.otp` (счётчик транзакционный); строка кода под блокировкой: срок, лимит попыток из выпуска, успех и перебор сжигают код.
7. [P] `lib/sql/80-auth.sql:auth_verify_totp` — только сервис с правом `auth.totp`; `totp_code` (HMAC-SHA1 pgcrypto, шаг 30 с, окно не шире ±1), повтор шага отклоняется, пять неудач — блокировка на 5 минут, первая удача включает фактор; удача по своей сессии добавляет ей способ `TOTP` и обновляет `login_at`.
8. [P] `lib/sql/80-auth.sql:auth_lookup` — identity (`TELEGRAM`, …) по праву `auth.identity`.

## Сессии
9. [P] `lib/sql/20-context.sql:new_session` — 256 бит `gen_random_bytes(32)`, в базе sha256; `meta`: время входа `login_at` и срок `ttl`, плюс от вызывающего — способы и выпустивший сервис; арендатор (`meta.tenant`) пишет `auth_switch`.
10. [P] `lib/sql/80-auth.sql:auth_switch` — не при имперсонации (`invalid_query`); сессия по токену напрямую (прежний арендатор мог стать недоступным), членство и включённый аккаунт арендатора, `meta.tenant` (свой арендатор — ключ снимается).
11. [P] `lib/sql/80-auth.sql:auth_kill` — гашение сессий аккаунта (кроме переданной: текущей при `keepCurrent`), сигнал `session:<16 hex sha256>`; вызывают смена пароля (`auth_set_password`), удаление креда (`auth_revoke_credential`), `revokeAll` (`auth_logout_all` — все сессии), отключение аккаунта (`trg_entity_au`), удаление аккаунта (`trg_entity_ad`, там же удаление кредов). `revoke()` — `auth_logout`, только текущая сессия.
12. [N] `lib/src/index.ts:connect#«const touch»` — `auth_refresh()` не чаще раза в минуту после успешных операций; срок продлевается не дальше `meta.ttl`, выданного при входе.

Сбои: `no_session`, `acl_denied` (одинаковый для «нет права» и «идентификатор занят»), `tenant_denied`, `invalid_query` (`auth_switch` при имперсонации).
