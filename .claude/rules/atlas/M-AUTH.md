---
paths:
  - 'lib/src/{auth,sessions,tables}.ts'
synced: 6c5460a
---
# M-AUTH — Вход, сессии и CRUD служебных таблиц Account/Credential/Resource/Rule

**Инварианты и грабли**
- Однозначность входа держит БД: `credential_identity_udx` — один живой кред на `(category, identifier)` во всей схеме (0.7.0). `credentials.set` — upsert по `credential_unique (account, category, identifier)`, поэтому identifier, занятый ДРУГИМ аккаунтом, даёт сырой PG 23505; повторный set своего креда воскрешает его (`deleted = NULL`). `confirmed` по умолчанию `true` (и DDL, и `set`) — неподтверждённым кред делает только явный `false` (`enrollTotp`).
- Ворота `finalize` (жив, `confirmed`, `Account.enabled`) проходят все `verify*` и `lookup`, кроме `verifyTotp`/`totpEnabled`. `sessions.check` и `db.as()` на `enabled` не смотрят: бан `enabled:false` не гасит сессии — нужен `revokeAll`.
- scrypt N=2^15, r=8, p=1 (README §11.9) — ниже минимума OWASP (2^17), хотя комментарий говорит «OWASP-порядок». Параметры живут в хэше `scrypt$N$r$p$salt$hash` → старые хэши проверяются своими, перехэширования при входе нет; поднимая N, подними `maxmem` (нужно 128·N·r байт: при 2^17 это 128 MiB > 64 MiB). Не-scrypt хэш (bcrypt из дампа) → `false`.
- `dummyVerify` выравнивает время только для «нет креда / нет хэша» в `verifyPassword` (README §9.1).
- Секрет TOTP хранится открытым base32 в `meta.secret`; api-ключ, secret и код OTP — только sha256.
- Гонки без блокировок: счётчик `attempts` OTP — чтение-запись (параллельный перебор обходит `maxAttempts`); «сжигание» OTP — `credentials.delete` без проверки результата (два параллельных верных `verifyOtp` оба успешны); `lastStep` TOTP — тот же паттерн (replay в гонке).
- Сессии: `sess:<sha256>` с EX (default 7 сут), индекс `sess:acc:<id>` — SET без TTL (копит протухшие хэши, чистит только `revokeAll`). Префикс `sess:` один на весь Redis — схемы/приложения на общем Redis делят пространство. `check` не продлевает TTL; `expire` в `SessionStore` объявлен, но не используется.
- Служебные таблицы — обычный SQL: `enforceAccount`/`enforceAcl` к ним не применяются, любой хендл видит и пишет все Account/Credential/Resource/Rule.
- `accounts.purge` (0.19.0): только со scoped-хендла (0.20.0), не себя, вызывающий Owner/System (его `enabled` не проверяется); «последний enabled Owner» считается по всей схеме, System-цель не защищена. Зовёт `sql.begin()` — на хендле `db.begin()` (зарезервированное соединение без `begin`) упадёт TypeError.
- `accounts.delete` упирается в RESTRICT `entity_account_fk`/`entity_owner_fk`, если у аккаунта есть строки Entity — путь: `enabled:false` либо `purge` (README §2.3).

**Что ещё менять вместе**
- Новый тип креда/метод входа: `lib/src/auth.ts` (`AuthApi` + реализация; секреты — sha256, ворота — `finalize`) + README §9.1/§11.9 + CHANGELOG + `lib/test/auth.test.ts`; новый экспорт — `lib/src/index.ts` + `npm run api:contract`. Образец `906fcd0` (TOTP/OTP).
- Новая колонка/функция служебных таблиц: ddl.sql (+ `DDL_REVISION`) + `lib/src/types.ts` (Account/Credential/Resource/Rule) + `lib/src/tables.ts` + README §11.8 + `lib/test/tables.test.ts`/`lib/test/wave5.test.ts`. Образец `7b28a64` (purge_account).
- Умолчание (TTL сессии, digits/ttl OTP, scrypt, `confirmed`): константа в `lib/src/auth.ts`/`lib/src/sessions.ts` + цифры и примеры хэша в README §9.1/§11.9 + тесты. Вопрос: меняется ли формат хранимого значения — переживут ли его уже выданные креды и сессии?
- `SessionStore`: интерфейс ioredis-совместим — новый метод ломает чужие реализации store.

**Состояние и побочки**
- PG: `"<schema>"."Account|Credential|Resource|Rule|Schema"`, `purge_account()`. Redis — только через store приложения; в тестах `ENTITY_REDIS`.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/auth.test.ts` (тип A, нужен Redis) · `lib/test/tables.test.ts` · `lib/test/wave5.test.ts` (`accounts.purge`, тип C) · `lib/test/salon.test.ts`.

**Точки входа**
- `lib/src/auth.ts:makeAuth` — все способы входа и ворота
- `lib/src/auth.ts:makeAuth#«async verifyOtp(a)»` — OTP: TTL, попытки, сжигание
- `lib/src/sessions.ts:makeSessions` — ключи Redis
- `lib/src/tables.ts:makeTables#«async set(c)»` — upsert креда
- `lib/src/tables.ts:makeTables#«async purge(id)»` — офбординг тенанта

**Не здесь**
- резолюция прав, `db.acl` → M-ACL · `schema.define` → M-SCHEMA · DDL, `purge_account` → M-ENGINE · System/Resource/Rule сида → M-SEEDS · `db.as` → M-API
