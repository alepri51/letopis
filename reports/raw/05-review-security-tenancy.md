# 05 — Безопасность, мультитенантность, соответствие — критический обзор `letopis` 0.21.0

> Промежуточный отчёт. Дата: 2026-09-24. Пакет: `letopis` 0.21.0 (ветка `dev`, HEAD `99a28e0`).
> Метод: критическое read-only ревью кода субагентом на основной модели (без model-override), статический анализ без прогона (отдельные утверждения помечены «не подтверждено прогоном»). Статус: **источник для `reports/ASSESSMENT.md`**, текст агента сохранён как получен (исправлены только HTML-сущности).

## (A) Threat model

**Активы.** Строки `Entity` всех арендаторов в одной таблице одной PG-схемы (`vN.name`); история версий (audit trail); `Credential` (scrypt-хэши, sha256 ключей, **plaintext TOTP-секрет**); словарь `Resource`/`Rule`; таблица `Schema` (компилируется в JS-код валидатора, `lib/src/schema.ts:255`); сессии в Redis.

**Кто вызывающий.** Библиотека не различает «пользователя» и «приложение»: субъект — то, что приложение передало в `db.as(account)` (`lib/src/chain.ts:866-880`). Никакой верификации того, что приложение имеет право назвать этого субъекта, нет и быть не может. Доверенная граница — процесс приложения; всё, что ниже (`db.sql`, `db.accounts/rules/credentials/schema`), — admin-плоскость без авторизации.

**Модель изоляции.** `account` = арендатор вызова, `owner` = необязательный под-владелец (`db.as(account,{owner})`, `lib/src/sql.ts:67-70`). Изоляция — единственный предикат `t.account = $n` в `buildRead` (`sql.ts:681-695`) плюс пришпиливание при INSERT (`lib/src/write.ts:256-268`). PostgreSQL RLS не используется; идентичность сущности — `(partition, class, id)` без `account` (`lib/sql/ddl.sql:137`). Отсюда blast radius: один пропущенный/неверно размещённый предикат = межтенантная утечка. Такие места найдены (ниже). Альтернатива «схема на арендатора» структурно возможна (`up({schema, version})` на каждого), но auth/ACL-таблицы тогда тоже per-schema.

**Границы доверия:** приложение → letopis (доверие полное) → PostgreSQL (append-only — advisory, см. SEC-06) → Redis (без auth в dev).

## (B) Findings

| ID | Severity | Tier | Title | Evidence | Impact |
|---|---|---|---|---|---|
| SEC-01 | **Critical** | T2 | Перехват (shadowing) чужой сущности через `create` с известным id | `write.ts:503-527` (probe только при `aclFilter`, `:512`), probe сам под account-фильтром `sql.ts:683-688`; latest-dedupe без account `sql.ts:787-792`; PK без account `ddl.sql:137` | Жертва «теряет» сущность; `versions()` отдаёт её историю атакующему (`sql.ts:878-887`); удаление атакующим каскадом тумбстоунит поддерево жертвы |
| SEC-02 | **High** | T2 | Каскад/замыкание/purge не знают арендатора | `sql.ts:976-1001` (closureSql), `ddl.sql:357-360` (entity_delete), `ddl.sql:395-406` (purge_closure); ACL DELETE — только по классу `write.ts:647-652`; links на чужой id без проверки `write.ts:307-308, 345-346`, `ddl.sql:218-229` | Данные чужих строк возвращаются вызывающему (превью/результат delete); чужие строки тумбстоунятся/стираются |
| SEC-03 | **High** | T2 | `watch()` без фильтра арендатора | `chain.ts:923-938`; payload без `account` `ddl.sql:563-565`; README 1798 умалчивает | Поток id/class/updated всех арендаторов; id — ключ к SEC-01 |
| SEC-04 | **High** | T2 | ACL fail-open на некорректном pattern | `acl.ts:62-64` (`categories` не строка → match всех), `:168-169` (`class` не строка → все классы); `tables.ts:305-313` без валидации | `{"categories":["Admin"]}` (естественный JSON) = субъект «все аккаунты» → silent widening |
| SEC-05 | **High** | T2/T4 | Отзыв прав не распространяется: снимок Resource/Rule на подключение, без инвалидации между процессами | `index.ts:137-148, 172-175`; `rules.set` не сбрасывает `tables.ts:338-347`; `db.as` не проверяет `enabled` `index.ts:153-155`; `sessions.check` тоже `sessions.ts:105-108` | Deny/дизейбл аккаунта действует только после `reloadSchema()`/рестарта каждого процесса; сессия живёт до 7 дней после блокировки |
| SEC-06 | **High** | T4 | Append-only и audit — advisory: bypass через GUC, нет актора, нет цепочки хэшей | `ddl.sql:369-372, 384` («привилегий не требует»), `compact`/`entity_collapse` `ddl.sql:593-657`; версия копирует `account/owner` оригинала `write.ts:437-441, 592-596`, `ddl.sql:350-354`; `.owner(любой FK-uuid)` `chain.ts:769-771` | Любая роль с DELETE стирает физически; «кто изменил» не фиксируется; авторство спуфится приложением |
| SEC-07 | Medium | T2 | Admin-фасады на scoped-хендле без авторизации; `Schema` — граница исполнения кода | `chain.ts:845-858`; `tables.ts` (нет гардов); `schema.ts:255` (fastest-validator codegen) | Утечка admin-операций в tenant-контекст — на дисциплине приложения; запись в Schema = запись кода |
| SEC-08 | Medium | T2 | scrypt N=2¹⁵,r=8,p=1 (32 MiB, p=1) ниже OWASP-строки (2¹⁷/8/1 или 2¹⁵/8/**3**); нет rehash-on-login, pepper, password policy | `auth.ts:44-45`; комментарий «OWASP-порядок» завышен | Слабее рекомендуемого; параметры хранятся в строке — апгрейд возможен |
| SEC-09 | Medium | T2/T4 | TOTP-секрет plaintext; OTP `attempts` read-modify-write race; TOTP `lastStep` TOCTOU; OTP sha256 6 цифр брутится оффлайн | `auth.ts:382-388`, `:468-476`, `:399-421`, `:445` | Дамп БД = все TOTP; параллельные попытки обходят `maxAttempts` |
| SEC-10 | Medium | T2/T3 | Сессии: `sess:acc:*` без TTL растёт бесконечно; `expire` объявлен, не используется; нет ротации/sliding | `sessions.ts:41, 74-75, 93` | Утечка памяти Redis при `start` per-request; нет rotate при смене привилегий |
| SEC-11 | Medium | T4 | GDPR: `anonymize` не стирает историю и только top-level string; забвение = purge поддерева (потеря бизнес-данных) или retention, который дропает и **актуальные** версии нетронутых сущностей | `write.ts:576-600`, `:580-583`; README 1308-1312, 1327-1328; `ddl.sql:683-684` («старые версии» — неверно: чанки по `updated`); `db/policies.mjs` | Право на забвение либо неполное, либо разрушительное; retention = data loss живых записей, не задокументировано явно |
| SEC-12 | Low | T2 | Ключи jsonb-пути интерполируются литералом через `escLit` (только `''`) | `sql.ts:233, 291, 298, 372-375` | Безопасно при `standard_conforming_strings=on` (default); лучше параметризовать |
| SEC-13 | Medium (функц., fail-closed) | T1/T2 | `.deep()` отбрасывает фильтр/tags/account-предикат шага; под `enforceAccount` параметр account пушится (`sql.ts:689-691`), но в текст deep-блока не попадает (`:795-822`) | Все deep-тесты с `enforceAccount:false` (`wave3.test.ts:58`, `api-full.test.ts:180`, `salon.test.ts:141`) | Ожидаемо ошибка PG (indeterminate parameter) — **не подтверждено прогоном** |
| SEC-14 | Low | T1/T2 | Ops/dev: Redis `bind 0.0.0.0 --protected-mode no` без пароля (`docker/start.sh`), `POSTGRES_HOST_AUTH_METHOD=trust` без пароля (`up.ts:124`), образ `latest-pg17` (Dockerfile, ci.yml), нет `npm audit`/provenance, нет `.env.example`; System-аккаунт `LIMIT 1` без ORDER BY (`index.ts:99-101`); `purge_account` по `owner` стирает чужие строки с подставленным owner (`ddl.sql:541`) | — | Dev-only, но `up()` публикует порты на хосте |

Уточнение известных фактов: git-cliff **уже убран** (`.github/workflows/tag.yml`, комментарий), `.env` в корне репозитория gitignored и не tracked (содержит прод-секреты приложения — вне периметра библиотеки, но лежит в рабочей копии).

## (C) Детали Critical/High

**SEC-01.** Сценарий под дефолтом (`enforceAccount:true`, без ACL-предиката): арендатор B знает id сущности E арендатора A (IDOR из URL, `watch()`, v5-формула). `tB.Org(E).create({...})`: `createOp` → `readRows` под фильтром `account=B` не находит E → `target.aclFilter` пуст → probe пропущен → `insertOne` вставляет версию `(class,E)` с `account=B` (PK допускает, `ddl.sql:137`; `entity_check` не проверяет). Далее для A: `innerWhere` содержит `id`-условие и подзапрос кандидатов с `c.account=A` (id проходит — у A есть старые версии), `DISTINCT ON (id) ORDER BY updated DESC` берёт версию B, внешняя перепроверка `t.account=A` её отбрасывает → A получает `[]`: сущность и все цепочки от неё «исчезли». `versions()` у B делает `JOIN Entity v ON class,id` без account (`sql.ts:885`) — вся история A читаема. `tB.Org(E).delete({confirm:true})`: `deleteSql` бьёт все физические строки `(class,E)`, триггер тумбстоунит latest (версию B) и каскадом `DELETE … WHERE links @> {Org:E}` — все Staff/Customer/booking арендатора A под этим Org (`ddl.sql:357-360`); `closure` с данными A возвращается B. Под `enforceAcl` с предикатом `{account:"$account"}` shadowing чтения нейтрализуется (ACL-предикат идёт в `innerWhere` через `classCond`, `sql.ts:727-741`, до DISTINCT ON), но probe (`write.ts:513`) остаётся под account-фильтром (`bare` наследует `enforceAccount`), т.е. запись всё равно проходит, и каскад/versions остаются. Асимметрия «ACL-предикат до DISTINCT ON, account-предикат после» — сама по себе дефект. Тестов на чужой id под `enforceAccount` нет (`wave2.test.ts:69-115`, `api-full.test.ts:486-500` проверяют только видимость/пришпиливание). **Fix:** account в `innerWhere` до DISTINCT ON; DB-инвариант «account неизменен для (partition,class,id)» (триггер в `entity_check`); probe без account-фильтра; `versions`-join по account.

**SEC-02.** Замыкание (`closureSql`), триггер каскада и `purge_closure` идут по `links @> {class,id}` по всей partition. Ссылки на чужие id создаются без чтения (`resolvePathEnds`: строковый фильтр «как есть», `write.ts:307`; слот `.Класс.set('<id>')`, `:345`; `entity_check` проверяет только что ключ — класс). ACL при каскаде проверяет DELETE по классу, но row-предикат (`owner=$account`) к каскадным строкам не применяется. Это фундамент разрушительной части SEC-01 и самостоятельный дефект целостности. **Fix:** валидировать цели links в границах арендатора; фильтр `account` в CTE и в триггере (или запрет cross-account links на уровне БД).

**SEC-03.** Слушатель фильтрует partition, class и (под ACL) безусловный allow; `account` в payload отсутствует, поэтому фильтровать нечем. **Fix:** добавить `account` в `entity_notify` и отбрасывать чужие события; под ACL с предикатом — дочитывать строку.

**SEC-04.** `typeof spec !== 'string' → return true` — fail-open в самой чувствительной точке (субъекты). `matchesApi` при этом fail-closed (`acl.ts:161`) — непоследовательно. `resources.set` принимает любой jsonb. **Fix:** валидация pattern при `set` и при компиляции; неизвестный формат = deny.

**SEC-05.** Кэш словаря сбрасывается только `reloadSchema()`; `rules.set`/`resources.set` его не трогают (только `schema.define`, `tables.ts:386`); механизма межпроцессной инвалидации (LISTEN на Rule) нет. Тест `acl.test.ts:164-192` фиксирует это как *ожидаемое* поведение. Для T2 это означает: отзыв прав/бан пользователя не имеет SLA. Плюс `db.as()` не проверяет `Account.enabled` (`index.ts:153-155`), `sessions.check` — тоже: заблокированный аккаунт работает до `revokeAll`/истечения TTL.

**SEC-06.** «Append-only» обеспечивается триггером с `WHEN (current_setting('letopis.purge'))`; `set_config` доступен любой роли — сама документация признаёт «привилегий не требует». Ни SECURITY DEFINER-обёрток, ни рекомендаций по DB-ролям (REVOKE DELETE у роли приложения) нет. Актор изменения не фиксируется: новая версия и tombstone копируют `account/owner` оригинала, отдельной колонки нет; `owner` при create — любой существующий Account без проверки. Криптографической связки версий нет. Для SOC2-подобного контура «who/when/what» неполный (нет «who»), а «immutable» — не более чем «по умолчанию».

## (D) Compliance readiness

| Область | Вердикт | Обоснование |
|---|---|---|
| Tenant isolation (T2) | **Не готово** | SEC-01/02/03/13; изоляция одной WHERE-колонкой без RLS и без DB-инварианта |
| GDPR erasure | Частично | `anonymize` — только top-level string, история с PII; полное стирание = `purge` поддерева (теряет бизнес-записи) или retention (теряет и живые строки); нет surgical-redaction истории |
| Audit trail immutability | Advisory | Bypass через GUC, `compact`, DROP TRIGGER; нет актора, нет hash-chain, нет WORM-экспорта |
| Least privilege | Слабо | Admin-фасады на любом хендле; ACL opt-in; fail-open pattern; нет ролевой модели БД |
| Secrets handling | Хорошо/средне | Пароли scrypt (параметры ниже OWASP), ключи sha256, токены сессий sha256, секреты не логируются (проверено: `console.*` только служебные сообщения, `onQuery` без SQL/параметров); TOTP plaintext |
| Session management | Средне | Хэшированные токены, TTL, revokeAll; нет ротации/sliding, индекс без TTL, нет связи с `enabled` |
| Encryption at rest/in transit | Вне scope | В `ConnectOpts` нет `ssl` (`index.ts:90-93`) — только через DSN; at-rest — на инфраструктуре |
| DR/backup | Отсутствует в документации | Retention необратим; purge необратим; PITR/бэкапы не описаны |

## (E) Что сделано хорошо

- Параметризация SQL почти тотальная: значения фильтров, `like/ilike`, tags, limit/offset, курсоры, ACL-предикаты (`rowTemplateFrags` с whitelist колонок и throw на неизвестный ключ, `sql.ts:242-262`); `escId` корректен; имена схем валидируются в `up()`/`apply.mjs`.
- Дефолт `enforceAccount:true` с шумным отказом на корневом хендле (`guardScoped`) — правильный принцип (ResolvedQuestions-3).
- ACL: deny-by-default, ровно один победитель, tie → deny, предикат до сортировки/лимита (честные `count`/keyset), полиморфизм по классу (deny на потомке не обходится), DELETE-проверка по всему замыканию с откатом транзакции, memo per-scope (тест на утечку между scope есть).
- Auth: `timingSafeEqual`, `dummyVerify`, ключи/секреты только хэшем, api-key 192 бит, `credential_identity_udx` (глобальная уникальность живого identifier — блокирует takeover через повторную регистрацию), корректная реализация HOTP/base32, replay-защита `lastStep`, три ворот `deleted/confirmed/enabled`.
- Сессии: только sha256 в Redis, Redis-сбой = исключение (fail-closed).
- Честные предупреждения: `enforceAcl` off один раз на процесс, ревизия DDL, no-history классы; ясно задокументированные границы (rate-limit/lockout/OAuth на приложении).
- Всего 2 runtime-зависимости; секреты только через env; `.env` в gitignore.

## (F) Предлагаемая структура раздела «Безопасность, мультитенантность, соответствие»

1. Модель доверия: приложение как единственный субъект; `db.as()` как заявление, а не проверка.
2. Изоляция арендатора: как реализована (один предикат, без RLS), где рвётся (SEC-01/02/03/13), сравнение с RLS и schema-per-tenant, рекомендованные инварианты в БД.
3. ACL-движок: семантика веса и деление «широкий allow побеждает узкий deny», fail-open patterns, жизненный цикл снимка и отзыв прав.
4. Аутентификация: криптопараметры vs OWASP, TOTP/OTP гонки, что делегировано приложению.
5. Сессии: хранение, жизненный цикл, пробелы (ротация, индекс, enabled).
6. Аудит и неизменяемость: триггерная модель, GUC-bypass, отсутствие актора, рекомендации (роли БД, actor-колонка, hash-chain/WORM-экспорт).
7. GDPR: три уровня забвения и их цена; retention как data loss; нужна редакция истории.
8. Supply chain/ops: зависимости, CI без audit/provenance, dev-контейнер.
9. Вердикт по тирам: T1 — да; T2 — нет до закрытия SEC-01…05; T3 — сессии/`watch` fan-out; T4 — нет (SEC-06/11 + отсутствие DR-документации).

### Critical Files for Implementation
- C:\projects\letopis\lib\src\sql.ts — `buildRead` (account-предикат vs `innerWhere`, `versions`-join, `.deep()`, `closureSql`)
- C:\projects\letopis\lib\src\write.ts — `createOp` probe, `resolvePathEnds`/`resolveSlots`, `delOp` каскад
- C:\projects\letopis\lib\sql\ddl.sql — PK/инвариант account, `entity_delete`, `purge_closure`, `entity_notify` payload, GUC-bypass
- C:\projects\letopis\lib\src\acl.ts — fail-open `matchCategories`/`matchesRow`, валидация pattern
- C:\projects\letopis\lib\src\chain.ts — `watch()` фильтр арендатора, admin-фасады на scoped-хендле, `db.as()` проверки
