-- letopis 1.0 — системный сид (план, этап 1, п. 2; этап 5, п. 8).
-- System с постоянным id (как в 0.21), системные классы Class, Account, member, Resource, rule,
-- общие группы и системные права, сервисный аккаунт с ключом APIKEY. Сид пишет установщик от роли
-- владельца: триггеры для владельца не срабатывают, поэтому версию в журнал и служебные колонки сид
-- заполняет сам (§2.7). Ресурсы API конкретного продукта сюда не входят.

-- Запись первой версии строки от имени владельца: entity + журнал.
create or replace function @SCHEMA@.sys_create(p_id uuid, p_class text, p_tenant uuid, p_links jsonb, p_data jsonb)
returns uuid
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  now_ts timestamptz := clock_timestamp();
  d jsonb := coalesce(p_data, '{}');
  vld jsonpath;
begin
  if exists (select 1 from @SCHEMA@.entity where id = p_id) then
    return p_id;
  end if;
  if p_class = 'Class' then
    select c.data, c.validator into d, vld from @SCHEMA@.class_prepare(d, p_tenant) c;
  end if;
  insert into @SCHEMA@.entity (id, rev, class, tenant, owner, links, data, at, created_at, author, op, validator)
  values (p_id, 1, p_class, p_tenant, p_tenant, coalesce(p_links, '{}'), d, now_ts, now_ts, '@SYSTEM@', 'create', vld);
  insert into @SCHEMA@.log (id, rev, class, tenant, owner, links, data, tags, at, author, op)
  values (p_id, 1, p_class, p_tenant, p_tenant, coalesce(p_links, '{}'), d, '{}', now_ts, '@SYSTEM@', 'create');
  if p_class in ('rule', 'Resource', 'member', 'Account', 'Class') then
    perform @SCHEMA@.acl_bump();
  end if;
  return p_id;
end $$;
alter function @SCHEMA@.sys_create(uuid, text, uuid, jsonb, jsonb) owner to @OWNER@;
revoke all on function @SCHEMA@.sys_create(uuid, text, uuid, jsonb, jsonb) from public;

-- Ключ подписи пропуска прав и счётчик изменений прав (50-acl.sql: acl_token, acl_bump).
insert into @SCHEMA@.secret (id, account, kind, material, meta)
values ('@SYSTEM@'::uuid, '@SYSTEM@'::uuid, 'KEY', @PGCRYPTO@.gen_random_bytes(32), '{"v": 0}')
on conflict (id) do nothing;

select @SCHEMA@.sys_create('@SYSTEM@'::uuid, 'Account', '@SYSTEM@'::uuid, '{}',
  '{"name": "System", "categories": ["System"], "enabled": true}');

-- Строка Class, описывающая саму себя, и системные классы. Полная метасхема и развёрнутое
-- описание resolved — в 40-class.sql (этап 1, п. 6).
select @SCHEMA@.sys_create(@SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array['Class']), 'Class', '@SYSTEM@'::uuid, '{}',
  '{"name": "Class", "kind": "hub", "key": ["name"], "system": true,
    "fields": {"properties": {"name": {"type": "string"}}, "required": ["name"]}}');
select @SCHEMA@.sys_create(@SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array['Account']), 'Class', '@SYSTEM@'::uuid, '{}',
  '{"name": "Account", "kind": "hub", "key": [], "system": true,
    "fields": {"properties": {"name": {"type": "string"}, "categories": {"type": "array", "items": {"type": "string"}, "uniqueItems": true},
               "enabled": {"type": "boolean", "default": true}}, "required": ["name"]}}');
-- Членство (этап 5, п. 4): пользователь в арендаторе с ролями; одно членство на пару. Строка лежит
-- в арендаторе, в которого вступают (конец Tenant равен арендатору строки).
select @SCHEMA@.sys_create(@SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array['member']), 'Class', '@SYSTEM@'::uuid, '{}',
  '{"name": "member", "kind": "link", "key": ["User", "Tenant"], "system": true,
    "ends": {"User": {"class": "Account", "required": true, "onDelete": "cascade"},
             "Tenant": {"class": "Account", "required": true, "onDelete": "cascade"}},
    "fields": {"properties": {"roles": {"type": "array", "items": {"type": "string"}, "uniqueItems": true, "default": []}}}}');
-- Ресурс ACL (этап 5, п. 5): группа, эндпоинт или объект строк — см. 50-acl.sql.
select @SCHEMA@.sys_create(@SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array['Resource']), 'Class', '@SYSTEM@'::uuid, '{}',
  '{"name": "Resource", "kind": "hub", "key": ["alias"], "system": true,
    "fields": {"properties": {"alias": {"type": "string", "minLength": 1},
                              "category": {"type": "string", "enum": ["ACCOUNT", "API", "READ", "WRITE", "DELETE"]},
                              "pattern": {"type": "object"}, "description": {"type": "string"}},
               "required": ["alias", "category"]}}');
-- Правило ACL: группа → объект, allow | deny, вес; одно правило на пару.
select @SCHEMA@.sys_create(@SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array['rule']), 'Class', '@SYSTEM@'::uuid, '{}',
  '{"name": "rule", "kind": "link", "key": ["Group", "Object"], "system": true,
    "ends": {"Group": {"class": "Resource", "required": true, "onDelete": "cascade"},
             "Object": {"class": "Resource", "required": true, "onDelete": "cascade"}},
    "fields": {"properties": {"permission": {"type": "string", "enum": ["allow", "deny"]},
                              "weight": {"type": "integer", "default": 0}, "enabled": {"type": "boolean", "default": true},
                              "code": {"type": "integer"}, "message": {"type": "string"}, "description": {"type": "string"}},
               "required": ["permission"]}}');

-- Ресурс и правило System от имени владельца (сид, тестовая обвязка).
create or replace function @SCHEMA@.sys_resource(p_tenant uuid, p_alias text, p_category text, p_pattern jsonb) returns uuid
language sql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
return @SCHEMA@.sys_create(@SCHEMA@.v5_id(p_tenant, 'Resource', array[p_alias]), 'Resource', p_tenant, '{}',
  jsonb_strip_nulls(jsonb_build_object('alias', p_alias, 'category', p_category, 'pattern', p_pattern)));

create or replace function @SCHEMA@.sys_rule(p_tenant uuid, p_group uuid, p_object uuid, p_permission text, p_weight int,
  p_extra jsonb default '{}') returns uuid
language sql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
return @SCHEMA@.sys_create(@SCHEMA@.v5_id(p_tenant, 'rule', array[p_group::text, p_object::text]), 'rule', p_tenant,
  jsonb_build_object('Group', p_group, 'Object', p_object),
  jsonb_build_object('permission', p_permission, 'weight', p_weight, 'enabled', true) || coalesce(p_extra, '{}'));

alter function @SCHEMA@.sys_resource(uuid, text, text, jsonb) owner to @OWNER@;
alter function @SCHEMA@.sys_rule(uuid, uuid, uuid, text, int, jsonb) owner to @OWNER@;
revoke all on function @SCHEMA@.sys_resource(uuid, text, text, jsonb), @SCHEMA@.sys_rule(uuid, uuid, uuid, text, int, jsonb) from public;

-- Общие группы и системные права (этап 5, п. 8). Роль admin — роль членства в System: системные
-- администраторы работают в арендаторе System. Права auth.* — сервису (имперсонация, выпуск
-- сессий, креды), letopis.* (verify, reset, maintain) — только системному администратору.
do $$
declare
  sys uuid := '@SYSTEM@'::uuid;
  g_any uuid;
  g_svc uuid;
  g_admin uuid;
  o_api uuid;
  o_auth uuid;
  o_letopis uuid;
  op text;
begin
  perform @SCHEMA@.sys_resource(sys, 'anonymous:ACCOUNT', 'ACCOUNT', '{"categories": "{Anonymous,Shadow}"}');
  perform @SCHEMA@.sys_resource(sys, 'authenticated:ACCOUNT', 'ACCOUNT', '{"categories": "!{Anonymous,Shadow}"}');
  g_any := @SCHEMA@.sys_resource(sys, 'any:ACCOUNT', 'ACCOUNT', null);
  g_svc := @SCHEMA@.sys_resource(sys, 'service:ACCOUNT', 'ACCOUNT', '{"categories": "{Service}"}');
  g_admin := @SCHEMA@.sys_resource(sys, 'admin:ACCOUNT', 'ACCOUNT', '{"roles": "{admin}"}');
  o_api := @SCHEMA@.sys_resource(sys, 'any:API', 'API', null);
  o_auth := @SCHEMA@.sys_resource(sys, 'auth:API', 'API', '{"endpoint": "auth.*"}');
  o_letopis := @SCHEMA@.sys_resource(sys, 'letopis:API', 'API', '{"endpoint": "letopis.*"}');
  perform @SCHEMA@.sys_rule(sys, g_any, o_api, 'deny', 0, '{"code": 403, "message": "Доступ запрещён по умолчанию"}');
  perform @SCHEMA@.sys_rule(sys, g_svc, o_auth, 'allow', 100);
  perform @SCHEMA@.sys_rule(sys, g_admin, o_auth, 'allow', 100);
  perform @SCHEMA@.sys_rule(sys, g_admin, o_letopis, 'allow', 100);
  foreach op in array array['READ', 'WRITE', 'DELETE'] loop
    perform @SCHEMA@.sys_rule(sys, g_admin, @SCHEMA@.sys_resource(sys, 'all:' || op, op, null), 'allow', 100);
  end loop;
end $$;

-- Правило «аутентифицированным можно всё» в арендаторе (тестовая обвязка, бенчи, первичная настройка
-- арендатора): группа authenticated и объекты all:READ, all:WRITE, all:DELETE из System, правило —
-- в самом арендаторе, поэтому действует только на его строки.
create or replace function @SCHEMA@.sys_grant_all(p_tenant uuid) returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  op text;
begin
  foreach op in array array['READ', 'WRITE', 'DELETE'] loop
    perform @SCHEMA@.sys_rule(p_tenant, @SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Resource', array['authenticated:ACCOUNT']),
      @SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Resource', array['all:' || op]), 'allow', 10);
  end loop;
end $$;
alter function @SCHEMA@.sys_grant_all(uuid) owner to @OWNER@;
revoke all on function @SCHEMA@.sys_grant_all(uuid) from public;

-- Сервисный аккаунт и его ключ: вызывает установщик, ключ генерирует и возвращает он же.
create or replace function @SCHEMA@.bootstrap_service(p_key text) returns uuid
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  svc uuid;
begin
  select id into svc from @SCHEMA@.entity
  where class = 'Account' and tenant = '@SYSTEM@' and data->'categories' ? 'Service' limit 1;
  if svc is null then
    svc := @SCHEMA@.uuid_v5('@SYSTEM@'::uuid, @SCHEMA@.v5_name('Account', array[gen_random_uuid()::text]));
    perform @SCHEMA@.sys_create(svc, 'Account', '@SYSTEM@'::uuid, '{}',
      '{"name": "service", "categories": ["Service"], "enabled": true}');
  end if;
  insert into @SCHEMA@.secret (account, kind, ident, material)
  values (svc, 'APIKEY', left(p_key, 12), sha256(convert_to(p_key, 'UTF8')));
  return svc;
end $$;
alter function @SCHEMA@.bootstrap_service(text) owner to @OWNER@;
revoke all on function @SCHEMA@.bootstrap_service(text) from public;
