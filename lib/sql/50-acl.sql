-- letopis 1.0 — политики RLS (план, §2.2, §2.8, этап 1, п. 3).
-- На этапе 1 строки видны и правимы только в своём арендаторе; строки Class видит любой,
-- у кого есть сессия; строку Account — сам аккаунт. ACL добавит этап 5.
-- Подзапрос (select …) PostgreSQL выполняет один раз на упоминание таблицы, а не на строку.
-- Строки Account, member, Resource и rule несут права (категории, роли, правила): приложение их
-- не пишет вовсе, пока правила ACL этапа 5 не определят, кто может их менять.

drop policy if exists entity_select on @SCHEMA@.entity;
create policy entity_select on @SCHEMA@.entity for select to @APP@
  using (
    tenant = (select @SCHEMA@.ctx_tenant())
    or (class = 'Class' and (select @SCHEMA@.ctx_account()) is not null)
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
    or (class = 'Class' and (select @SCHEMA@.ctx_account()) is not null)
    or (class = 'Account' and id = (select @SCHEMA@.ctx_account()))
  );
