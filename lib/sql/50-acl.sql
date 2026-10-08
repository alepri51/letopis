-- letopis 1.0 — политики RLS (план, §2.2, §2.8, этап 1, п. 3).
-- На этапе 1 строки видны и правимы только в своём арендаторе; системные строки Class видит любой,
-- у кого есть сессия; строку Account — сам аккаунт. ACL добавит этап 5.
-- Условие видимости продублировано в row_visible(): по нему функции поиска find_* (70-read.sql)
-- отбирают строки без RLS. Менять оба места вместе; совпадение проверяет тест find-ids-parity.
-- Подзапрос (select …) PostgreSQL выполняет один раз на упоминание таблицы, а не на строку.
-- Строки Account, member, Resource и rule несут права (категории, роли, правила): приложение их
-- не пишет вовсе, пока правила ACL этапа 5 не определят, кто может их менять.

drop policy if exists entity_select on @SCHEMA@.entity;
create policy entity_select on @SCHEMA@.entity for select to @APP@
  using (
    tenant = (select @SCHEMA@.ctx_tenant())
    or (class = 'Class' and tenant = '@SYSTEM@'::uuid and (select @SCHEMA@.ctx_account()) is not null)
    or (class = 'Account' and id = (select @SCHEMA@.ctx_account()))
  );

drop policy if exists entity_insert on @SCHEMA@.entity;
create policy entity_insert on @SCHEMA@.entity for insert to @APP@
  with check (tenant = (select @SCHEMA@.ctx_tenant()) and class not in ('Account', 'member', 'Resource', 'rule'));

drop policy if exists entity_update on @SCHEMA@.entity;
create policy entity_update on @SCHEMA@.entity for update to @APP@
  using (tenant = (select @SCHEMA@.ctx_tenant()) and class not in ('Account', 'member', 'Resource', 'rule'))
  with check (tenant = (select @SCHEMA@.ctx_tenant()) and class not in ('Account', 'member', 'Resource', 'rule'));

drop policy if exists entity_delete on @SCHEMA@.entity;
create policy entity_delete on @SCHEMA@.entity for delete to @APP@
  using (tenant = (select @SCHEMA@.ctx_tenant()) and class not in ('Account', 'member', 'Resource', 'rule'));

drop policy if exists log_select on @SCHEMA@.log;
create policy log_select on @SCHEMA@.log for select to @APP@
  using (
    tenant = (select @SCHEMA@.ctx_tenant())
    or (class = 'Class' and tenant = '@SYSTEM@'::uuid and (select @SCHEMA@.ctx_account()) is not null)
    or (class = 'Account' and id = (select @SCHEMA@.ctx_account()))
  );

-- Видимость строки для чтения — то же условие, что using политик entity_select и log_select.
-- Отдельная функция, а не выражение политики: аргументы-подзапросы, использованные в теле больше
-- одного раза, не дают PostgreSQL встроить функцию, и политика потеряла бы индексы.
create or replace function @SCHEMA@.row_visible(p_tenant uuid, p_class text, p_id uuid, c_tenant uuid, c_account uuid)
returns boolean
language sql immutable parallel safe
return p_tenant = c_tenant
    or (p_class = 'Class' and p_tenant = '@SYSTEM@'::uuid and c_account is not null)
    or (p_class = 'Account' and p_id = c_account);

alter function @SCHEMA@.row_visible(uuid, text, uuid, uuid, uuid) owner to @OWNER@;
revoke all on function @SCHEMA@.row_visible(uuid, text, uuid, uuid, uuid) from public;
