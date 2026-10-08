# F-ACCESS — Контекст, права ACL и RLS (letopis 1.0, этап 5)
Процессы: [N] Node-процесс приложения · [P] PostgreSQL
Триггер: `svc = await connect({ apiKey })` → `u = await svc.as(account, { tenant })` → `u.Booking().rows()` · `.create({…}).rows()` · сырой SQL под той же сессией.

## Контекст
1. [N] `lib/src/tx.ts:runTx` — `begin read committed`, `set_config` токена, `letopis.account`, `letopis.tenant`, пропуска `letopis.acl` (`AclPasses`); пропуска нет — `acl_token()` тем же конвейером.
2. [P] `lib/sql/20-context.sql:ctx` — сессия по `sha256(token)`, аккаунт включён и лежит в System; `letopis.account` ≠ свой — право `auth.impersonate` по правилам System (`acl_api_for(…, true)`), цель не System, не сервис, не член System, включена (иначе `acl_denied`); арендатор: `letopis.tenant` ?? `meta.tenant` сессии ?? аккаунт; чужой — членство `member` по v5-id при каждом вызове (`tenant_denied`); роли: свой арендатор — `owner`, иначе `member.roles`.

## План прав
3. [P] `lib/sql/50-acl.sql:acl_rules` — правила System и рабочего арендатора, включённые, с группой ACCOUNT по `acl_group_ok` (категории; роли — только в правилах рабочего арендатора).
4. [P] `lib/sql/50-acl.sql:acl_plan_for` — на каждый класс System и арендатора (имена — класс, предки, алиасы) одно правило: вес ↓, запрет первым, alias, id; разрешение → условие `acl_cond` (шаблон без `class`, `$actor`/`$tenant`), `{}` — без условия.
5. [P] `lib/sql/50-acl.sql:acl_plan_cached` — пропуск `letopis.acl` верен (HMAC ключом из `secret`, тот же актор и арендатор, счётчик `acl_bump` не изменился) → план из пропуска; иначе — `acl_plan_for`.

## Строки
6. [P] `lib/sql/50-acl.sql:entity_select` — свой арендатор и (`Class` или `acl_ok(acl_all, acl_plan)`), строки `Class` System, свой `Account`, свои `member`; insert/update/delete — свой арендатор и `acl_ok` с планом `WRITE`/`DELETE` (update — на прежние и новые значения).
7. [P] `lib/sql/70-read.sql:find_ids` — то же условие `row_visible(…, acl_actor('READ'))` без RLS; `delete_preview`, `visible_detail` — так же.
8. [P] `lib/sql/60-write.sql:targets_bad` — цели концов видны актору (кроме `Account`); `trg_entity_ad` — `DELETE` на каждую строку каскада, `WRITE` на снятие конца; `reclass` — видимость и `WRITE` на старую, новую и ссылающиеся строки.
9. [N] `lib/src/errors.ts:fromDbError` — нарушение условия на новых значениях (`ExecWithCheckOptions`, 42501) → `acl_denied`.

Сбои: `no_session`, `acl_denied`, `tenant_denied`, `target_not_found` (невидимая цель).
Состояние: пропуска — в памяти процесса (60 с, сброс по сигналу классов прав); счётчик и ключ подписи — строка `secret` с id System.
