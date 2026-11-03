# F-ACCESS — Контекст, права ACL и RLS (letopis 1.0, этап 5)
Процессы: [N] Node-процесс приложения · [P] PostgreSQL
Триггер: `svc = await connect({ apiKey })` → `u = await svc.as(account, { tenant })` → `u.Booking().rows()` · `.create({…}).rows()` · сырой SQL под той же сессией.

## Контекст
1. [N] `lib/src/tx.ts:runTx` (в db.begin() — `ExplicitTx.open`) — `begin read committed`, `set_config` токена, `letopis.account`, `letopis.tenant`, пропуска `letopis.acl` (`AclPasses`), `letopis.notify`, `letopis.reason`; пропуска нет — `acl_token()` в той же транзакции (в пуле — тем же конвейером), пропуск кэшируется.
2. [P] `lib/sql/20-context.sql:ctx` — сессия по `sha256(token)`, аккаунт включён и лежит в System; `letopis.account` ≠ свой — право `auth.impersonate` по правилам System (`acl_api_for(…, true)`), цель не System, не сервис, не член System, включена (иначе `acl_denied`); арендатор: `letopis.tenant` ?? `meta.tenant` сессии ?? аккаунт; чужой — членство `member` по v5-id и включённый аккаунт арендатора при каждом вызове (`tenant_denied`); роли: свой арендатор — `owner`, иначе `member.roles`.

## План прав
3. [P] `lib/sql/50-acl.sql:acl_rules` — правила System и рабочего арендатора, включённые, с группой ACCOUNT по `acl_group_ok` (категории; роли — только в правилах рабочего арендатора); вес правила арендатора — не больше 999 (правила System с весом от 1000 он не перевесит). Маски — только строки (описание `Resource` отклоняет иное при записи); маска группы не строкой в строке, записанной в обход проверки: `acl_set_ok` → null, и `coalesce(…, permission <> 'allow')` — разрешение по такой группе не действует, запрет — на всех.
4. [P] `lib/sql/50-acl.sql:acl_plan_for` — на каждый класс System и арендатора (имена — класс, предки, алиасы) одно правило: вес ↓, запрет первым, alias, id; разрешение → условие `acl_cond` (шаблон без `class`, `$actor`/`$tenant`), `{}` — без условия. Маска `class` не строкой (`bad`): разрешение отбрасывается, запрет совпадает со всеми классами; так же отвечает `acl_class_ok` (null).
5. [P] `lib/sql/50-acl.sql:acl_plan_cached` — пропуск `letopis.acl` верен (HMAC ключом из `secret`, тот же актор и арендатор, счётчик `acl_bump` не изменился) → план из пропуска; иначе — `acl_plan_for`.

## Строки
6. [P] `lib/sql/50-acl.sql:entity_select` — свой арендатор и (`Class` или `acl_ok(acl_all, acl_plan)`), строки `Class` System, свой `Account`, свои `member`; insert/update/delete — свой арендатор и `acl_ok` с планом `WRITE`/`DELETE` (update — на прежние и новые значения); `log_select` — условие чтения для журнала.
7. [P] `lib/sql/70-read.sql:find_ids` — то же условие `row_visible(…, acl_actor('READ'))` без RLS; `delete_preview`, `visible_detail` — так же.
8. [P] `lib/sql/60-write.sql:targets_bad` — цели концов видны актору (кроме `Account`; у роли сеанса без RLS — суперпользователь, `BYPASSRLS`, член владельца — видимость не проверяется, роль — `session_role()`); `trg_entity_ad` — `DELETE` на каждую строку каскада, `WRITE` на снятие конца.
9. [N] `lib/src/errors.ts:fromDbError` — нарушение условия на новых значениях (`ExecWithCheckOptions`, 42501) → `acl_denied`.
10. [N] `lib/src/load.ts:load` с `{ as }` — мимо RLS, поэтому сам: `acl_subject` (арендатор, планы READ/WRITE), условия на новые (в `update` — и прежние) значения запросом на пачку (`acl_row_ok`), видимость целей — запросом в конце (`row_visible`); при любой загрузке строк прав — `acl_bump()`.
11. [P] `lib/sql/90-time.sql:signal_key` (план 1.1, этап 2) — ключ сигналов только сессии с правом `letopis.signals` по правилам System (системный сид выдаёт его группе `service:ACCOUNT`) или администраторскому подключению (`letopis_allowed`), иначе `acl_denied`; отдаёт HMAC ключа строки KEY по `'letopis:signals'`, а не сам ключ (им подписаны пропуска прав). Процесс без ключа сбрасывает кэш грубее (F-WATCH).

Сбои: `no_session`, `acl_denied`, `tenant_denied`, `target_not_found` (невидимая цель).
Состояние: пропуска — в памяти процесса (60 с, сброс по сигналу классов прав); счётчик, ключ подписи (из него же выводится ключ сигналов) и режим сигналов — строка `secret` с id System.
