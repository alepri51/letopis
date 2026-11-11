-- letopis — системный сид.
-- System с постоянным id, системные классы Class, Account, member, Resource, rule,
-- общие группы и системные права, аккаунт консьержа с ключом APIKEY. Сид пишет установщик от роли
-- владельца: триггеры для владельца не срабатывают, поэтому версию в журнал и служебные колонки сид
-- заполняет сам. Ресурсы API конкретного продукта сюда не входят.

-- Запись первой версии строки от имени владельца: entity + журнал.
create or replace function @SCHEMA@.sys_create(p_id uuid, p_class text, p_tenant uuid, p_links jsonb, p_data jsonb,
  p_owner uuid default null)
returns uuid
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  now_ts timestamptz := clock_timestamp();
  d jsonb := coalesce(p_data, '{}');
  vld jsonpath;
  r int;
begin
  if exists (select 1 from @SCHEMA@.entity where id = p_id) then
    return p_id;
  end if;
  -- id уже жил (прописка после выписки): номер версии продолжает журнал — номер 1 занят навсегда
  select coalesce(max(l.rev), 0) + 1 into r from @SCHEMA@.log l where l.id = p_id;
  if p_class = 'Class' then
    select c.data, c.validator into d, vld from @SCHEMA@.class_prepare(d, p_tenant) c;
  end if;
  insert into @SCHEMA@.log (id, rev, class, tenant, owner, links, data, tags, at, author, op)
  values (p_id, r, p_class, p_tenant, coalesce(p_owner, p_tenant), coalesce(p_links, '{}'), d, '{}', now_ts, '@SYSTEM@', 'create');
  insert into @SCHEMA@.entity (id, rev, class, tenant, owner, links, data, at, created_at, author, op, validator)
  values (p_id, r, p_class, p_tenant, coalesce(p_owner, p_tenant), coalesce(p_links, '{}'), d, now_ts, now_ts, '@SYSTEM@', 'create', vld);
  if p_class in ('rule', 'Resource', 'member', 'Account', 'Class') then
    perform @SCHEMA@.acl_bump();
  end if;
  return p_id;
end $$;
alter function @SCHEMA@.sys_create(uuid, text, uuid, jsonb, jsonb, uuid) owner to @OWNER@;
revoke all on function @SCHEMA@.sys_create(uuid, text, uuid, jsonb, jsonb, uuid) from public;

-- Новая версия строки от имени владельца с данными p_data (слияние): entity + журнал (правило по умолчанию, setup).
create or replace function @SCHEMA@.sys_set(p_id uuid, p_data jsonb) returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  n @SCHEMA@.entity;
begin
  update @SCHEMA@.entity x set data = x.data || p_data, rev = x.rev + 1,
         at = greatest(clock_timestamp(), x.at + interval '1 microsecond'), author = '@SYSTEM@', agent = null, op = 'update', reason = null
  where x.id = p_id and x.data || p_data <> x.data
  returning * into n;
  if n.id is not null then
    insert into @SCHEMA@.log (id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason)
    values (n.id, n.rev, n.class, n.cv, n.tenant, n.owner, n.links, n.data, n.tags, n.at, n.author, n.agent, n.op, n.reason);
    if n.class in ('rule', 'Resource', 'member', 'Account', 'Class') then
      perform @SCHEMA@.acl_bump();
    end if;
  end if;
end $$;
alter function @SCHEMA@.sys_set(uuid, jsonb) owner to @OWNER@;
revoke all on function @SCHEMA@.sys_set(uuid, jsonb) from public;

-- Ресурс и правило System от имени владельца (сид, тестовая обвязка).
create or replace function @SCHEMA@.sys_resource(p_tenant uuid, p_alias text, p_category text, p_pattern jsonb) returns uuid
language sql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
return @SCHEMA@.sys_create(@SCHEMA@.v5_id(p_tenant, 'Resource', array[p_alias]), 'Resource', p_tenant, '{}',
  jsonb_strip_nulls(jsonb_build_object('alias', p_alias, 'category', p_category, 'pattern', p_pattern)));

create or replace function @SCHEMA@.sys_rule(p_tenant uuid, p_group uuid, p_object uuid, p_permission text, p_weight int,
  p_extra jsonb default '{}', p_owner uuid default null) returns uuid
language sql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
return @SCHEMA@.sys_create(@SCHEMA@.v5_id(p_tenant, 'rule', array[p_group::text, p_object::text]), 'rule', p_tenant,
  jsonb_build_object('Group', p_group, 'Object', p_object),
  jsonb_build_object('permission', p_permission, 'weight', p_weight, 'enabled', true) || coalesce(p_extra, '{}'), p_owner);

alter function @SCHEMA@.sys_resource(uuid, text, text, jsonb) owner to @OWNER@;
alter function @SCHEMA@.sys_rule(uuid, uuid, uuid, text, int, jsonb, uuid) owner to @OWNER@;
revoke all on function @SCHEMA@.sys_resource(uuid, text, text, jsonb), @SCHEMA@.sys_rule(uuid, uuid, uuid, text, int, jsonb, uuid) from public;

-- Системный сид целиком: ключ подписи и счётчик прав, System, системные классы, общие группы, правило по умолчанию
-- (все → *, deny) и право консьержа на ключ сигналов. Повторный вызов ничего не меняет.
create or replace function @SCHEMA@.seed_system() returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  sys uuid := '@SYSTEM@'::uuid;
  g_any uuid;
  g_svc uuid;
  o_api uuid;
  o_signals uuid;
  o_maintain uuid;
  op text;
begin
  -- аккаунт System — раньше строки ключа: служебные строки secret (KEY, LOCK) принадлежат ему, а внешний
  -- ключ secret.account требует строку аккаунта в entity. Счётчик прав sys_create повышает, только когда
  -- строка ключа уже есть, — на свежей установке ей неоткуда взяться, и начальный v — 0
  perform @SCHEMA@.sys_create('@SYSTEM@'::uuid, 'Account', '@SYSTEM@'::uuid, '{}',
    '{"name": "System", "categories": ["System"], "enabled": true, "kind": "system"}');

  -- Ключ подписи пропуска прав и счётчик изменений прав (50-acl.sql: acl_token, acl_bump); от ключа же
  -- выводится ключ сигналов. Режим сигналов (setup({ signals })) хранится в meta этой строки: установщик
  -- читает его перед накатом, поэтому повторный setup() без опции режим не меняет.
  insert into @SCHEMA@.secret as k (id, account, kind, material, meta)
  values ('@SYSTEM@'::uuid, '@SYSTEM@'::uuid, 'KEY', @PGCRYPTO@.gen_random_bytes(32), '{"v": 0, "signals": "@SIGNALS@"}')
  on conflict (id) do update set meta = k.meta || '{"signals": "@SIGNALS@"}'
  where k.meta->>'signals' is distinct from '@SIGNALS@';

  -- Строка Class, описывающая саму себя, и системные классы. Полная метасхема и развёрнутое
  -- описание resolved — в 40-class.sql.
  perform @SCHEMA@.sys_create(@SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array['Class']), 'Class', '@SYSTEM@'::uuid, '{}',
    '{"name": "Class", "kind": "hub", "key": ["name"], "system": true,
      "fields": {"properties": {"name": {"type": "string"}}, "required": ["name"]}}');
  perform @SCHEMA@.sys_create(@SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array['Account']), 'Class', '@SYSTEM@'::uuid, '{}',
    '{"name": "Account", "kind": "hub", "key": [], "system": true,
      "fields": {"properties": {"name": {"type": "string"}, "categories": {"type": "array", "items": {"type": "string"}, "uniqueItems": true},
                 "enabled": {"type": "boolean", "default": true},
                 "kind": {"type": "string", "enum": ["system", "service", "tenant", "person"]}}, "required": ["name"]}}');
  -- Прописка: аккаунт в квартире с метками (roles); одна прописка на пару. Строка лежит
  -- в квартире, где прописан аккаунт (конец Tenant равен квартире строки).
  perform @SCHEMA@.sys_create(@SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array['member']), 'Class', '@SYSTEM@'::uuid, '{}',
    '{"name": "member", "kind": "link", "key": ["User", "Tenant"], "system": true,
      "ends": {"User": {"class": "Account", "required": true, "onDelete": "cascade"},
               "Tenant": {"class": "Account", "required": true, "onDelete": "cascade"}},
      "fields": {"properties": {"roles": {"type": "array", "items": {"type": "string"}, "uniqueItems": true, "default": []}}}}');
  -- Ресурс ACL: группа, эндпоинт, объект строк или роль прописки — см. 50-acl.sql. Маски шаблона —
  -- только строки: маска не строкой совпадала бы со всеми (группа {"roles": ["staff"]} — с любым аккаунтом).
  perform @SCHEMA@.sys_create(@SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array['Resource']), 'Class', '@SYSTEM@'::uuid, '{}',
    '{"name": "Resource", "kind": "hub", "key": ["alias"], "system": true,
      "fields": {"properties": {"alias": {"type": "string", "minLength": 1},
                                "category": {"type": "string", "enum": ["ACCOUNT", "API", "READ", "WRITE", "DELETE", "ROLE"]},
                                "pattern": {"type": "object",
                                            "properties": {"categories": {"type": "string"}, "roles": {"type": "string"},
                                                           "endpoint": {"type": "string"}, "class": {"type": "string"},
                                                           "role": {"type": "string"}}},
                                "description": {"type": "string"}},
                 "required": ["alias", "category"]}}');
  -- Правило ACL: группа → объект, allow | deny, вес; одно правило на пару.
  perform @SCHEMA@.sys_create(@SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array['rule']), 'Class', '@SYSTEM@'::uuid, '{}',
    '{"name": "rule", "kind": "link", "key": ["Group", "Object"], "system": true,
      "ends": {"Group": {"class": "Resource", "required": true, "onDelete": "cascade"},
               "Object": {"class": "Resource", "required": true, "onDelete": "cascade"}},
      "fields": {"properties": {"permission": {"type": "string", "enum": ["allow", "deny"]},
                                "weight": {"type": "integer", "default": 0}, "enabled": {"type": "boolean", "default": true},
                                "code": {"type": "integer"}, "message": {"type": "string"}, "description": {"type": "string"},
                                "default": {"type": "boolean"}, "concierge": {"type": "boolean"}},
                 "required": ["permission"]}}');

  -- все жильцы: аккаунты людей (категория User — её ставит принятие приглашения)
  perform @SCHEMA@.sys_resource(sys, 'authenticated:ACCOUNT', 'ACCOUNT', '{"categories": "{User}"}');
  g_any := @SCHEMA@.sys_resource(sys, 'any:ACCOUNT', 'ACCOUNT', null);
  g_svc := @SCHEMA@.sys_resource(sys, 'service:ACCOUNT', 'ACCOUNT', '{"categories": "{Service}"}');
  o_api := @SCHEMA@.sys_resource(sys, 'any:API', 'API', null);
  o_signals := @SCHEMA@.sys_resource(sys, 'signals:API', 'API', '{"endpoint": "letopis.signals"}');
  o_maintain := @SCHEMA@.sys_resource(sys, 'maintain:API', 'API', '{"endpoint": "letopis.maintain"}');
  -- все роли прописки (ЧТО категории ROLE без имени роли): на него ссылаются правила консьержа и роли owner квартир
  perform @SCHEMA@.sys_resource(sys, 'all:ROLE', 'ROLE', null);
  -- правило по умолчанию (все → *): есть всегда, решает, когда других кандидатов нет; deny на свежем доме,
  -- переключает только setup({ defaultRule }) — acl_set_default
  perform @SCHEMA@.sys_rule(sys, g_any, o_api, 'deny', 0, '{"default": true, "code": 403}');
  foreach op in array array['READ', 'WRITE', 'DELETE'] loop
    perform @SCHEMA@.sys_rule(sys, g_any, @SCHEMA@.sys_resource(sys, 'all:' || op, op, null), 'deny', 0, '{"default": true}');
  end loop;
  -- ключ сигналов (signal_key()): консьерж узнаёт токены классов и квартир в нагрузке
  perform @SCHEMA@.sys_rule(sys, g_svc, o_signals, 'allow', 100);
  -- обслуживание (maintain()): консьерж чистит истёкшие сессии, коды и приглашения — db.maintain()
  perform @SCHEMA@.sys_rule(sys, g_svc, o_maintain, 'allow', 100);
  -- консьерж пишет общие классы дома (модели setup) в System; в квартирах ему полный доступ дают их правила консьержа
  foreach op in array array['READ', 'WRITE', 'DELETE'] loop
    perform @SCHEMA@.sys_rule(sys, g_svc, @SCHEMA@.v5_id(sys, 'Resource', array['all:' || op]), 'allow', 1000000, '{"concierge": true}');
  end loop;
  -- строки-замки (60-write.sql: lock_row) семейств всех классов — системных, из сидов (sys_create их не заводит) и
  -- квартир — и обслуживания — заранее: первое обращение под нагрузкой их не вставляет
  perform @SCHEMA@.family_rows(c.tenant, c.data) from @SCHEMA@.entity c where c.class = 'Class';
  perform @SCHEMA@.lock_row('@SCHEMA_NAME@:maintain');
end $$;
alter function @SCHEMA@.seed_system() owner to @OWNER@;
revoke all on function @SCHEMA@.seed_system() from public;

select @SCHEMA@.seed_system();

-- Аккаунт консьержа (категория Service) и его ключ APIKEY: вызывает setup(), ключ генерирует он же.
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
      '{"name": "concierge", "categories": ["Service"], "enabled": true, "kind": "service"}');
  end if;
  insert into @SCHEMA@.secret (account, kind, ident, material)
  values (svc, 'APIKEY', left(p_key, 12), sha256(convert_to(p_key, 'UTF8')));
  return svc;
end $$;
alter function @SCHEMA@.bootstrap_service(text) owner to @OWNER@;
revoke all on function @SCHEMA@.bootstrap_service(text) from public;

-- Пропуск консьержа (строка подключения его роли с ключом): хранится открытым текстом в строке CONCIERGE (видит только
-- владелец схемы), чтобы повторный setup отдал тот же. p_pass null — прочитать; иначе записать (rotate: прежние ключи
-- консьержа отзываются, их сессии гаснут).
create or replace function @SCHEMA@.concierge_pass(p_pass text default null, p_key text default null) returns text
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  cur text;
  svc uuid;
begin
  select convert_from(s.material, 'UTF8') into cur from @SCHEMA@.secret s where s.kind = 'CONCIERGE' and s.deleted_at is null;
  if p_pass is null then
    return cur;
  end if;
  select id into svc from @SCHEMA@.entity where class = 'Account' and tenant = '@SYSTEM@' and data->'categories' ? 'Service' limit 1;
  if p_key is not null then
    update @SCHEMA@.secret s set deleted_at = clock_timestamp()
    where s.account = svc and s.kind in ('APIKEY', 'SESSION') and s.deleted_at is null
      and s.material is distinct from sha256(convert_to(p_key, 'UTF8'));
  end if;
  delete from @SCHEMA@.secret s where s.kind = 'CONCIERGE';
  insert into @SCHEMA@.secret (account, kind, material) values ('@SYSTEM@'::uuid, 'CONCIERGE', convert_to(p_pass, 'UTF8'));
  return p_pass;
end $$;
alter function @SCHEMA@.concierge_pass(text, text) owner to @OWNER@;
revoke all on function @SCHEMA@.concierge_pass(text, text) from public;

-- Правило по умолчанию allow | deny (setup({ defaultRule })): строки правил по умолчанию System — новой версией.
create or replace function @SCHEMA@.acl_set_default(p_permission text) returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  r record;
begin
  if p_permission not in ('allow', 'deny') then
    perform @SCHEMA@.lt_fail('sql-access.acl_bad_op', jsonb_build_object('op', p_permission));
  end if;
  for r in select x.id from @SCHEMA@.entity x
           where x.class = 'rule' and x.tenant = '@SYSTEM@'::uuid and coalesce((x.data->>'default')::boolean, false) loop
    perform @SCHEMA@.sys_set(r.id, jsonb_build_object('permission', p_permission));
  end loop;
end $$;
alter function @SCHEMA@.acl_set_default(text) owner to @OWNER@;
revoke all on function @SCHEMA@.acl_set_default(text) from public;
