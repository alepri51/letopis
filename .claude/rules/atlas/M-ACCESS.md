---
paths:
  - 'lib/sql/{20-context,50-acl,80-auth}.sql'
  - 'lib/src/{auth,acl}.ts'
synced: HEAD
---
# M-ACCESS — контекст, сессии, ACL и RLS, креды и вход (этапы 1, 5)

**Инварианты и грабли**
- `ctx()` — только читает: сессия по `sha256(letopis.token)`; аккаунт включён и лежит в System; `letopis.account` действует лишь при праве `auth.impersonate` по правилам System, цель — не System, не сервис, не член System (системный администратор), включена; рабочий арендатор (`letopis.tenant` ?? `meta.tenant` ?? аккаунт) чужой — только по членству, проверка при каждом вызове. Отказ — ошибка (`acl_denied`, `tenant_denied`), а не пустой контекст.
- Аккаунты (с категориями) — только в System (триггер вставки, загрузчик); все поиски аккаунта в функциях входа и `ctx` — с `tenant = System`. На этом держится: категории (группы ACL, право сервиса) правит только системный администратор.
- Правила арендатора — на его строки, правила System — везде; группа по ролям совпадает только в правилах рабочего арендатора (`acl_group_ok(…, p_same)`), поэтому роль, выданная арендатором, не даёт прав System. Права `auth.*` и `letopis.*` — только правила System (`acl_require`, `acl_api_for(…, true)`).
- Решение (`acl_plan_for`): вес ↓, запрет первым, alias объекта, id — как `decide` 0.21; маска: простое имя — сравнение, с `{…}`/`*` — регулярное выражение один раз на правило. Совпадение с 0.21 — `acl-parity` (1000 наборов).
- Политики: `acl_ok(acl_all, acl_plan, …)` — встраиваемая (каждый параметр один раз; объект строки собирается только для классов с условием); в функциях владельца — `acl_row_ok` и `row_visible` (план в переменной). Видимость в политиках и в `row_visible()` — одно условие: менять вместе (`find-ids-parity`).
- Пропуск прав `letopis.acl` (`acl_token`): HMAC ключом строки `secret` id = System, привязка к актору, арендатору и счётчику `acl_bump`; счётчик повышают триггеры после оператора, `sys_create` и загрузчик при записи `rule`, `Resource`, `member`, `Account`, `Class`. Неверный пропуск — план заново (на права не влияет).
- Креды: `secret`, идентификатор без учёта регистра; хэш пароля — только `auth.password`; свои креды — после недавнего входа (10 мин); отказ привязки одинаков для «нет права» и «занято». Гашение сессий — `auth_kill` с сигналом `session:<16 hex>`.

**Что ещё менять вместе**
- Новая функция владельца (security definer): негативный тест и белый список в `roles.test.ts` №4.
- Смена правил видимости: `row_visible()`, политики `entity_*`/`log_select`, таблица §2.2 плана, `find-ids-parity`, `acl`.
- Новый класс прав или изменение того, что входит в план: список классов `acl_bump` в триггерах, `sys_create`, `load.ts` (`ACL_CLASSES`), `index.ts` (`ACL_CLASSES`).

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `acl`, `acl-parity`, `auth`, `impersonation`, `member`, `system-classes`, `access-rest`, `engine-attacks`, `roles`, `context`.
- Цена прав: `cd lib && npx tsx bench/acl-cost.mjs`.

**Точки входа**
- `lib/sql/20-context.sql:ctx` — контекст запроса
- `lib/sql/50-acl.sql:acl_plan_for` — план прав
- `lib/sql/50-acl.sql:acl_plan_cached` — пропуск прав
- `lib/sql/50-acl.sql:entity_select` — политики RLS
- `lib/sql/80-auth.sql:auth_set_password` — креды
- `lib/src/auth.ts:makeAuth` — db.auth
- `lib/src/acl.ts:makeAcl` — db.acl
