# F-AUTH — Вход по паролю и сессия
Процессы: [N] Node-приложение · [P] PostgreSQL (`Credential`, `Account` схемы) · [R] Redis (клиент даёт приложение)
Триггер: `db.auth.setPassword({ account, identifier: 'ann@x.io', password })` → `r = await db.auth.verifyPassword({ identifier, password })` → `s = db.auth.sessions(redis)` → `token = await s.start(r.account)` (строка, не `{ token }`) → `s.check(token)` → `s.revokeAll(r.account)`

## Пароль и вход
1. [N] `lib/src/chain.ts:makeDb#«auth ??= makeAuth(tables)»` — фасад на ctx хендла (корень, `db.as()`, транзакция — её соединение); `guardScoped` и ACL не участвуют: вход работает на корне и при `enforceAccount: true`.
2. [N] `lib/src/auth.ts:hashPassword` — scrypt N=32768 r=8 p=1, соль 16 байт → `scrypt$N$r$p$<соль>$<хэш>`; параметры в строке, смена `SCRYPT` старые хэши не ломает.
3. [P] `lib/src/tables.ts:makeTables#«ON CONFLICT (account, category, identifier) DO UPDATE»` — upsert (`category` 'PASSWORD'): `meta` и `confirmed` (`?? true`) перезаписываются, `deleted = NULL`, id прежний. Identifier, живой у другого аккаунта → 23505 по `lib/sql/ddl.sql:credential_identity_udx` (ON CONFLICT его не ловит).
4. [P] `lib/src/auth.ts:findLive` — `SELECT` по (category, identifier) и `deleted IS NULL` (`lib/src/tables.ts:makeTables#«if (!f.withDeleted)»`); частичный индекс даёт ≤ 1 строку.
5. [N] `lib/src/auth.ts:dummyVerify` — промах (нет креда, `meta.password` не строка): scrypt на нулевой соли и `null` — «нет identifier» по времени как «неверный пароль».
6. [N] `lib/src/auth.ts:verifyHash` — не `scrypt` (bcrypt из дампа) → `false` без scrypt; иначе scrypt с N/r/p из строки и `timingSafeEqual`.
7. [P] `lib/src/auth.ts:finalize` — после пароля: `confirmed` (снимается `requireConfirmed: false`), `Account` по id (`lib/src/tables.ts:makeTables#«async get(id)»`), `enabled`; категории не смотрит → `{ account, credential }` | `null`.

## Сессия
8. [R] `lib/src/sessions.ts:makeSessions#«'EX', ttl»` — `start`: токен 32 байта (64 hex) — вызывающему, в Redis `SET sess:<sha256> {account, meta, created} EX ttl` (`DEFAULT_TTL` 7 суток).
9. [R] `lib/src/sessions.ts:makeSessions#«store.sadd(kAcc(id), h)»` — `SADD sess:acc:<id>`: индекс без TTL, отдельной командой (не MULTI).
10. [R] `lib/src/sessions.ts:makeSessions#«store.get(kTok(sha256(token)))»` — `check`: `GET` + `JSON.parse`; TTL не продлевается (`expire` не вызывается), `Account.enabled` не перепроверяется.
11. [R] `lib/src/sessions.ts:makeSessions#«store.srem(kAcc(account), h)»` — `revoke`: `GET` → `DEL` → `SREM`; нет ключа → `false`.
12. [R] `lib/src/sessions.ts:makeSessions#«store.del(...hs.map(kTok))»` — `revokeAll`: `SMEMBERS` → один `DEL` всех `sess:<h>` → `DEL` индекса; вернёт размер индекса вместе с протухшими.

Дальше — вызов от имени аккаунта, `db.as(r.account)`: F-ACCESS.

Состояние: кред живой ⇄ мягко удалён (`db.credentials.delete`), повторный set воскрешает; ротация без `confirmed: false` подтверждает кред. `sess:<h>` живёт ttl от `start`; `sess:acc:<id>` копит хэши до `revokeAll`.
Сбои: отказ verify — `null` без причины. Исключения без ретраев: 23505 (identifier занят), 23503 (нет Account), ошибки Redis-клиента. Выключение или `accounts.purge` аккаунта сессии не гасят — нужен `revokeAll`; сбой между SET и SADD оставляет сессию вне индекса до TTL.
Логи: нет — auth/sessions/tables в console не пишут, их SQL идёт мимо `lib/src/sql.ts:runQuery` (ни `onQuery`, ни `slowMs`).
Варианты режима:
- api-key `lib/src/auth.ts:issueApiKey` — `lts_<48hex>`, identifier = sha256, `meta.prefix` — 12 символов; verify без dummyVerify.
- key+secret `lib/src/auth.ts:verifyKeySecret` — key открыт, secret — sha256 в meta, сравнение `eqHex`.
- TOTP `lib/src/auth.ts:enrollTotp` — секрет base32 открытым текстом в `meta.secret`, один на аккаунт, `confirmed: false`; `lib/src/auth.ts:verifyTotp#«if (s <= lastStep) continue»` — окно ±1 шаг по 30 с, replay отбит `meta.lastStep`, успех подтверждает. Мимо finalize (`enabled` не смотрит); read-modify-write без блокировки.
- OTP `lib/src/auth.ts:verifyOtp` — в meta sha256 кода, `expires`, `attempts`; успех, просрочка и 5 неудач мягко удаляют кред; новый `issueOtp` перезаписывает код.
- identity `lib/src/auth.ts:link` / `lib/src/auth.ts:lookup` — связка без секрета, токен провайдера проверяет приложение.
- rate-limit, lockout, OAuth — на приложении (`lib/README.md` §9.1).

Проверка: `cd lib && npx tsx --test --test-force-exit test/auth.test.ts` (накатанная `v1.booking` + Redis `ENTITY_REDIS`); путь — кейсы «пароль: set → verify…», «ворота verify…», «глобальная идентичность…», «сессии в Redis…», варианты — остальные пять. Не покрыты: выравнивание времени, bcrypt-формат, гонки, вход при `enforceAccount: true` (тест — `false`).
