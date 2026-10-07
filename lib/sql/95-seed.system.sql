-- letopis 1.0 — минимальный системный сид (план, этап 1, п. 2; полный сид — этап 5).
-- System с постоянным id (как в 0.21), классы Class и Account, сервисный аккаунт с ключом APIKEY.
-- Сид пишет установщик от роли владельца: триггеры для владельца не срабатывают, поэтому
-- версию в журнал и служебные колонки сид заполняет сам (§2.7).

-- Запись первой версии строки от имени владельца: entity + журнал.
create or replace function @SCHEMA@.sys_create(p_id uuid, p_class text, p_tenant uuid, p_links jsonb, p_data jsonb)
returns uuid
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  now_ts timestamptz := clock_timestamp();
begin
  if exists (select 1 from @SCHEMA@.entity where id = p_id) then
    return p_id;
  end if;
  insert into @SCHEMA@.entity (id, rev, class, tenant, owner, links, data, at, created_at, author, op)
  values (p_id, 1, p_class, p_tenant, p_tenant, coalesce(p_links, '{}'), coalesce(p_data, '{}'), now_ts, now_ts, '@SYSTEM@', 'create');
  insert into @SCHEMA@.log (id, rev, class, tenant, owner, links, data, tags, at, author, op)
  values (p_id, 1, p_class, p_tenant, p_tenant, coalesce(p_links, '{}'), coalesce(p_data, '{}'), '{}', now_ts, '@SYSTEM@', 'create');
  return p_id;
end $$;
alter function @SCHEMA@.sys_create(uuid, text, uuid, jsonb, jsonb) owner to @OWNER@;
revoke all on function @SCHEMA@.sys_create(uuid, text, uuid, jsonb, jsonb) from public;

select @SCHEMA@.sys_create('@SYSTEM@'::uuid, 'Account', '@SYSTEM@'::uuid, '{}',
  '{"name": "System", "categories": ["System"], "enabled": true}');

-- Строка Class, описывающая саму себя, и класс Account. Полная метасхема и развёрнутое
-- описание resolved появляются в 40-class.sql (этап 1, п. 6).
select @SCHEMA@.sys_create(@SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array['Class']), 'Class', '@SYSTEM@'::uuid, '{}',
  '{"name": "Class", "kind": "hub", "key": ["name"], "system": true}');
select @SCHEMA@.sys_create(@SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array['Account']), 'Class', '@SYSTEM@'::uuid, '{}',
  '{"name": "Account", "kind": "hub", "key": [], "system": true}');

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
