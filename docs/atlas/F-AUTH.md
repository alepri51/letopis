# F-AUTH — Креды, вход и сессии (letopis 1.0, этап 5)
Процессы: [N] Node-процесс сервиса · [P] PostgreSQL (`secret`, `entity`)
Триггер: `svc.auth.setPassword({ account, identifier, password })` → `r = await svc.auth.verifyPassword({ identifier, password })` → `connect({ token: r.token })` → `db.auth.revoke()` / `revokeAll()`.

## Пароль и вход
1. [N] `lib/src/auth.ts:hashPassword` — scrypt в Node (`scrypt$N$r$p$соль$хэш`).
2. [P] `lib/sql/80-auth.sql:auth_set_password` — `auth_can_manage`: сам аккаунт после недавнего входа (10 мин, `meta.login_at` сессии) или право `auth.credential`; идентификатор без учёта регистра (`secret_kind_ident`); занят другим — тот же `acl_denied`; замена хэша гасит остальные сессии (`auth_kill`).
3. [P] `lib/sql/80-auth.sql:auth_password_get` — хэш только с правом `auth.password` (правила System).
4. [N] `lib/src/auth.ts:makeAuth#«verifyPassword»` — нет креда — холостой scrypt; верен — `issue_session(account, ttl, ['PASSWORD'])` (право `auth.session`, цель не System, не сервис, не член System).

## Прочие креды
5. [P] `lib/sql/80-auth.sql:auth_issue_apikey` — `lts_` + 48 hex, в базе sha256, префикс в ident; вход — `login_apikey` (connect) или `auth_login_apikey`.
6. [P] `lib/sql/80-auth.sql:login_otp` — строка кода под блокировкой: срок, счётчик попыток, успех и перебор сжигают код.
7. [P] `lib/sql/80-auth.sql:auth_verify_totp` — `totp_code` (HMAC-SHA1 pgcrypto, шаг 30 с, окно ±1), повтор шага отклоняется, первая удача включает фактор и дописывает `TOTP` в способы входа сессии.
8. [P] `lib/sql/80-auth.sql:auth_lookup` — identity (`TELEGRAM`, …) по праву `auth.identity`.

## Сессии
9. [P] `lib/sql/20-context.sql:new_session` — 256 бит `gen_random_bytes(32)`, в базе sha256, `meta`: способы, время входа, сервис, арендатор.
10. [P] `lib/sql/80-auth.sql:auth_switch` — сессия по токену напрямую (прежний арендатор мог стать недоступным), членство, `meta.tenant`.
11. [P] `lib/sql/80-auth.sql:auth_kill` — гашение сессий аккаунта (кроме текущей), сигнал `session:<16 hex sha256>`; вызывают смена пароля, удаление креда, `revokeAll`, отключение аккаунта (`trg_entity_au`), удаление аккаунта (`trg_entity_ad`, там же удаление кредов).
12. [N] `lib/src/index.ts:connect#«const touch»` — `auth_refresh()` не чаще раза в минуту после успешных операций.

Сбои: `no_session`, `acl_denied` (одинаковый для «нет права» и «идентификатор занят»), `tenant_denied`.
