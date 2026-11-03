-- letopis 1.0 — время и эксплуатация (план, §2.11, этап 6, п. 2–4, 6–8).
--
-- Функции владельца проверяют всё сами, сами пишут журнал и сами посылают сигнал (§2.7):
--   restore()        — последний снимок удалённого объекта новой версией (вид restore), с проверкой
--                      по текущему описанию класса; id прежний;
--   purge()          — стирание истории удалённого объекта: на место версии 1 встаёт запись purge
--                      с числом стёртых версий;
--   rekey(), rekey_class() — новое значение ключа объекта или новый ключ класса: строка с новым id,
--                      перевод ссылок (move_row), журнал связывает id колонкой moved;
--   account_purge()  — удаление аккаунта с данными его арендатора (предохранители 0.21);
--   maintain()       — истёкшие сессии и коды, строки-замки удалённых семейств.
-- У id, у которого в журнале есть хоть одна запись, номер версии 1 всегда занят (этап 6, п. 3):
-- на нём держится режим existing: 'error' загрузчика.

-- Действующая роль сеанса, под которой вызывающий работает вне функций владельца: роль SET ROLE (и параметра запуска
-- role), иначе роль входа. Внутри функции владельца current_user — владелец, а session_user — роль входа, даже если
-- поверх неё поставлена роль приложения: привилегированный вход с ролью приложения выглядел бы администратором
-- (автоматическое ревью коммита 1734d21). Подменить её нельзя: SET ROLE проверяет членство.
create or replace function @SCHEMA@.session_role() returns name
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return coalesce(nullif(current_setting('role'), 'none'), session_user)::name;

-- Роль подключения — администраторская (суперпользователь или может стать владельцем): maintain доступен ей и без
-- сессии (CLI, обслуживание по расписанию).
create or replace function @SCHEMA@.admin_role() returns boolean
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return exists (select 1 from pg_roles where rolname = @SCHEMA@.session_role() and rolsuper)
    or pg_has_role(@SCHEMA@.session_role(), '@OWNER_NAME@', 'SET');

-- Право letopis.* актора сессии по правилам System или администраторская роль подключения.
create or replace function @SCHEMA@.letopis_allowed(p_endpoint text) returns boolean
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  if @SCHEMA@.admin_role() then
    return true;
  end if;
  select * into c from @SCHEMA@.ctx();
  return c.account is not null
     and coalesce((@SCHEMA@.acl_api_for(c.tenant, c.categories, c.roles, p_endpoint, true)->>'allow')::boolean, false);
end $$;

-- Срок действующей сессии (кэш результатов не отдаёт ответы истёкшей сессии); нет сессии — null.
create or replace function @SCHEMA@.session_expires() returns timestamptz
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  select * into c from @SCHEMA@.ctx();
  if c.session is null then
    return null;
  end if;
  return (select s.expires_at from @SCHEMA@.secret s where s.id = c.session);
end $$;

-- ========================= сигналы (план 1.1, §2.2) =========================

-- Режим сигналов установки — константа up({ signals }): class, tenant, opaque, none.
create or replace function @SCHEMA@.signal_mode() returns text
language sql immutable parallel safe
return '@SIGNALS@';

-- Ключ сигналов (hex) для сессии с правом letopis.signals по правилам System (сид выдаёт его сервисам) или
-- администраторского подключения: по нему процесс узнаёт в нагрузке токены классов и арендаторов.
-- Отдаётся производный ключ HMAC(ключ строки KEY, 'letopis:signals'), а не сам ключ: им подписаны пропуска прав.
create or replace function @SCHEMA@.signal_key() returns text
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  if not @SCHEMA@.letopis_allowed('letopis.signals') then
    perform @SCHEMA@.lt_fail('sql-time.signals_denied');
  end if;
  return (select encode(@PGCRYPTO@.hmac(convert_to('letopis:signals', 'UTF8'), s.material, 'sha256'), 'hex')
          from @SCHEMA@.secret s where s.id = '@SYSTEM@'::uuid and s.kind = 'KEY');
end $$;

-- Отпечаток описаний классов, видимых сессии (свои и System): в режиме сигналов none реестр библиотеки
-- сверяет его раз в 5 секунд вместо сигнала Class. Под RLS — тот же набор строк, что читает реестр.
create or replace function @SCHEMA@.class_stamp() returns text
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return (select encode(sha256(convert_to(coalesce(string_agg(e.id::text || ':' || e.rev::text, ',' order by e.id), ''), 'UTF8')), 'hex')
        from @SCHEMA@.entity e where e.class = 'Class' and e.tenant in (@SCHEMA@.ctx_tenant(), '@SYSTEM@'::uuid));

-- ========================= restore, purge =========================

-- Последняя запись журнала id под блокировкой, если она видна актору в его арендаторе: параллельные
-- restore, purge и воскрешение (trg_entity_bi берёт ту же блокировку) упорядочены.
create or replace function @SCHEMA@.last_version_visible(p_id uuid, p_tenant uuid, p_acl jsonb) returns @SCHEMA@.log
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  l @SCHEMA@.log;
begin
  -- арендатор id неизменен: блокируется только запись своего арендатора, чужую вызов не задерживает
  -- и по ожиданию не обнаружит (итоговое ревью безопасности)
  select x.* into l from @SCHEMA@.log x where x.id = p_id and x.tenant = p_tenant order by x.rev desc limit 1 for update;
  if l.id is null or l.tenant <> p_tenant or l.op = 'purge'
     or not @SCHEMA@.row_visible(l.tenant, l.class, l.id, l.owner, l.tags, l.data, l.links, p_tenant, (p_acl->>'account')::uuid, p_acl->'plan') then
    perform @SCHEMA@.lt_fail('sql-time.target_not_found');
  end if;
  return l;
end $$;

-- Восстановление удалённого объекта (этап 6, п. 2): последний снимок новой версией с видом restore.
-- Снимок перепроверяется по текущему описанию класса (данные, концы с видимостью целей, ключ), право
-- WRITE — на восстановленные значения. id прежний, в том числе у класса без ключа.
create or replace function @SCHEMA@.restore(p_id uuid) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  rd jsonb;
  l @SCHEMA@.log;
  cls @SCHEMA@.entity;
  res jsonb;
  d jsonb;
  bad jsonb;
  lk record;
  kid uuid;
  own uuid;
  ts timestamptz;
  n @SCHEMA@.entity;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('sql-time.no_session');
  end if;
  rd := @SCHEMA@.acl_actor('READ');
  l := @SCHEMA@.last_version_visible(p_id, c.tenant, rd);
  if l.op <> 'delete' or exists (select 1 from @SCHEMA@.entity e where e.id = p_id) then
    perform @SCHEMA@.lt_fail('sql-time.restore_not_deleted');
  end if;
  if l.class = 'Class' then
    perform @SCHEMA@.lt_fail('sql-time.restore_class_row');
  end if;
  cls := @SCHEMA@.class_row(l.class, l.tenant);
  if cls.id is null then
    perform @SCHEMA@.lt_fail('sql-time.class_not_found', jsonb_build_object('cls', l.class));
  end if;
  perform @SCHEMA@.family_lock(cls, false);
  cls := @SCHEMA@.class_row(l.class, l.tenant);
  if cls.id is null then
    perform @SCHEMA@.lt_fail('sql-time.class_deleted', jsonb_build_object('cls', l.class));
  end if;
  res := cls.data->'resolved';
  if coalesce((res->>'abstract')::boolean, false) then
    perform @SCHEMA@.lt_fail('sql-time.class_abstract', jsonb_build_object('cls', l.class));
  end if;
  d := @SCHEMA@.apply_defaults(res->'schema', l.data);
  bad := @SCHEMA@.validate_data(res->'rules', cls.validator, res->'vars', d);
  if bad <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('sql-time.invalid_data', jsonb_build_object('cls', l.class), jsonb_build_object('issues', bad));
  end if;
  select * into lk from @SCHEMA@.check_links(res, l.links, l.tenant, true, rd);
  if lk.key is not null then
    perform @SCHEMA@.lt_fail(lk.key, lk.params);
  end if;
  kid := @SCHEMA@.key_id(res, l.class, l.tenant, d, lk.links);
  if kid is not null and kid <> p_id then
    perform @SCHEMA@.lt_fail('sql-time.restore_key_changed', jsonb_build_object('cls', l.class), jsonb_build_object('expected', kid));
  end if;
  -- владелец — существующий аккаунт или арендатор
  own := l.owner;
  if own <> l.tenant and not exists (select 1 from @SCHEMA@.entity a where a.id = own and a.class = 'Account' and a.tenant = '@SYSTEM@'::uuid) then
    own := l.tenant;
  end if;
  if not @SCHEMA@.acl_row_ok(@SCHEMA@.acl_plan('WRITE'), l.class, p_id, own, l.tenant, l.tags, d, lk.links) then
    perform @SCHEMA@.lt_fail('sql-time.no_write_row', jsonb_build_object('cls', l.class));
  end if;
  ts := greatest(@SCHEMA@.now_ts(), l.at + interval '1 microsecond');
  insert into @SCHEMA@.entity (id, rev, class, cv, tenant, owner, links, data, tags, at, created_at, author, agent, op, reason, moved, validator)
  values (p_id, l.rev + 1, l.class, cls.rev, l.tenant, own, lk.links, d, l.tags, ts, ts, c.author, c.agent, 'restore',
          nullif(current_setting('letopis.reason', true), ''), null, null)
  returning * into n;
  perform @SCHEMA@.log_version(n);
  if l.class in ('rule', 'Resource', 'member', 'Account') then
    perform @SCHEMA@.acl_bump();
  end if;
  return p_id;
end $$;

-- Стирание истории удалённого объекта (этап 6, п. 3): без p_confirm — превью (число версий), с ним —
-- все версии удаляются, а на место версии 1 встаёт запись purge с числом стёртых версий. Право DELETE на класс по
-- последнему снимку. История системных классов — аудит прав и
-- схемы: её не стирают.
create or replace function @SCHEMA@.purge(p_id uuid, p_confirm boolean default false) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  l @SCHEMA@.log;
  n int;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('sql-time.no_session');
  end if;
  l := @SCHEMA@.last_version_visible(p_id, c.tenant, @SCHEMA@.acl_actor('READ'));
  if l.op <> 'delete' or exists (select 1 from @SCHEMA@.entity e where e.id = p_id) then
    perform @SCHEMA@.lt_fail('sql-time.purge_not_deleted');
  end if;
  if l.class in ('Class', 'Account', 'member', 'Resource', 'rule') then
    perform @SCHEMA@.lt_fail('sql-time.purge_system');
  end if;
  if not @SCHEMA@.acl_row_ok(@SCHEMA@.acl_plan('DELETE'), l.class, l.id, l.owner, l.tenant, l.tags, l.data, l.links) then
    perform @SCHEMA@.lt_fail('sql-time.no_delete_class', jsonb_build_object('cls', l.class));
  end if;
  select count(*)::int into n from @SCHEMA@.log x where x.id = p_id;
  if not coalesce(p_confirm, false) then
    return jsonb_build_object('id', p_id, 'class', l.class, 'versions', n, 'purged', false);
  end if;
  delete from @SCHEMA@.log x where x.id = p_id;
  insert into @SCHEMA@.log (id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason, moved)
  values (p_id, 1, l.class, l.cv, l.tenant, l.tenant, '{}', jsonb_build_object('$purged', n), '{}',
          greatest(@SCHEMA@.now_ts(), l.at + interval '1 microsecond'), coalesce(c.author, '@SYSTEM@'::uuid), c.agent, 'purge',
          nullif(current_setting('letopis.reason', true), ''), null);
  -- воскрешение, зафиксированное, пока purge ждал блокировку, — отказ (снимок нового оператора его видит)
  if exists (select 1 from @SCHEMA@.entity e where e.id = p_id) then
    perform @SCHEMA@.lt_fail('sql-time.purge_restored');
  end if;
  perform @SCHEMA@.signal(array[l.class], array[l.tenant]);
  return jsonb_build_object('id', p_id, 'class', l.class, 'versions', n, 'purged', true);
end $$;

-- ========================= смена ключа =========================

-- Новое значение ключа объекта (этап 6, п. 7): p_data сливается с данными, p_links заменяет концы
-- по ролям; новый id — v5 от нового ключа. Механизм — тот же, что у reclass(): строка с новым id,
-- перевод ссылок (рекурсивно для строк, в ключ которых входит конец), надгробие старого id со
-- ссылкой на новый. Ключ не изменился — обычная правка неключевых полей.
create or replace function @SCHEMA@.rekey(p_id uuid, p_data jsonb default null, p_links jsonb default null) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  rd jsonb;
  wplan jsonb;
  o @SCHEMA@.entity;
  cls @SCHEMA@.entity;
  res jsonb;
  d jsonb;
  bad jsonb;
  lk record;
  nid uuid;
  denied text;
  n_denied int;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('sql-time.no_session');
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    perform @SCHEMA@.lt_fail('sql-time.rekey_isolation');
  end if;
  rd := @SCHEMA@.acl_actor('READ');
  wplan := @SCHEMA@.acl_plan('WRITE');
  select x.* into o from @SCHEMA@.entity x where x.id = p_id and x.tenant = c.tenant for update;
  if o.id is null or not @SCHEMA@.row_visible(o.tenant, o.class, o.id, o.owner, o.tags, o.data, o.links, c.tenant, c.account, rd->'plan') then
    perform @SCHEMA@.lt_fail('sql-time.target_not_found');
  end if;
  if not @SCHEMA@.acl_row_ok(wplan, o.class, o.id, o.owner, o.tenant, o.tags, o.data, o.links) then
    perform @SCHEMA@.lt_fail('sql-time.no_write_row', jsonb_build_object('cls', o.class));
  end if;
  if o.class in ('Class', 'Account', 'member', 'Resource', 'rule') then
    perform @SCHEMA@.lt_fail('sql-time.rekey_system_row');
  end if;
  cls := @SCHEMA@.class_row(o.class, o.tenant);
  perform @SCHEMA@.family_lock(cls, false);
  cls := @SCHEMA@.class_row(o.class, o.tenant);
  if cls.id is null then
    perform @SCHEMA@.lt_fail('sql-time.class_deleted', jsonb_build_object('cls', o.class));
  end if;
  res := cls.data->'resolved';
  if jsonb_array_length(coalesce(res->'key', '[]'::jsonb)) = 0 then
    perform @SCHEMA@.lt_fail('sql-time.rekey_no_key', jsonb_build_object('cls', o.class));
  end if;
  d := @SCHEMA@.apply_defaults(res->'schema', @SCHEMA@.merge(o.data, coalesce(p_data, '{}'::jsonb)));
  bad := @SCHEMA@.validate_data(res->'rules', cls.validator, res->'vars', d);
  if bad <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('sql-time.invalid_data', jsonb_build_object('cls', o.class), jsonb_build_object('issues', bad));
  end if;
  select * into lk from @SCHEMA@.check_links(res, o.links || coalesce(p_links, '{}'::jsonb), o.tenant, true, rd);
  if lk.key is not null then
    perform @SCHEMA@.lt_fail(lk.key, lk.params);
  end if;
  nid := @SCHEMA@.key_id(res, o.class, o.tenant, d, lk.links);
  if not @SCHEMA@.acl_row_ok(wplan, o.class, nid, o.owner, o.tenant, o.tags, d, lk.links) then
    perform @SCHEMA@.lt_fail('sql-time.no_write_class', jsonb_build_object('cls', o.class));
  end if;
  if nid = o.id then
    if d is distinct from o.data or lk.links is distinct from o.links then
      perform @SCHEMA@.sys_update(o.id, d, lk.links, null, 'update');
    end if;
    return o.id;
  end if;
  -- перевод ссылок пишет ссылающиеся строки: на них тоже нужно право WRITE (глубже первого уровня — move_row); класс
  -- такой строки называется, только если актор её видит (доработки после точки Б)
  select min(x.class) filter (where @SCHEMA@.row_visible(x.tenant, x.class, x.id, x.owner, x.tags, x.data, x.links, c.tenant, c.account, rd->'plan')),
         count(*) into denied, n_denied from @SCHEMA@.entity x
  where x.ends @> array[o.id] and not @SCHEMA@.acl_row_ok(wplan, x.class, x.id, x.owner, x.tenant, x.tags, x.data, x.links);
  if n_denied > 0 then
    if denied is not null then
      perform @SCHEMA@.lt_fail('sql-time.refs_denied_class', jsonb_build_object('cls', denied));
    end if;
    perform @SCHEMA@.lt_fail('sql-time.refs_denied');
  end if;
  perform @SCHEMA@.move_row(o, nid, o.class, d, lk.links, 'rekey', wplan);
  return nid;
end $$;

-- Новый ключ класса (этап 6, п. 7): описание класса и потомков, наследующих ключ, пересчитывается,
-- каждая строка семейства с другим id переносится на новый id (move_row). Исключительная
-- блокировка корня семейства приостанавливает запись в семейство до фиксации. Возвращает число
-- перенесённых строк класса (ссылающиеся строки с концом в ключе переносятся рекурсивно и не считаются).
create or replace function @SCHEMA@.rekey_class(p_class text, p_key jsonb) returns int
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  wplan jsonb;
  cr @SCHEMA@.entity;
  prep record;
  dsc @SCHEMA@.entity;
  classes text[];
  r @SCHEMA@.entity;
  res jsonb;
  nid uuid;
  n int := 0;
  conflicts jsonb;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('sql-time.no_session');
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    perform @SCHEMA@.lt_fail('sql-time.rekey_isolation');
  end if;
  wplan := @SCHEMA@.acl_plan('WRITE');
  cr := @SCHEMA@.class_row(p_class, c.tenant);
  if cr.id is null or cr.tenant <> c.tenant then
    perform @SCHEMA@.lt_fail('sql-time.rekey_class_not_found', jsonb_build_object('cls', p_class));
  end if;
  if coalesce((cr.data->>'system')::boolean, false) then
    perform @SCHEMA@.lt_fail('sql-time.rekey_system_class');
  end if;
  if not @SCHEMA@.acl_row_ok(wplan, 'Class', cr.id, cr.owner, cr.tenant, cr.tags, cr.data, cr.links) then
    perform @SCHEMA@.lt_fail('sql-time.rekey_class_denied');
  end if;
  -- смена ключа проверяет все строки семейства и отвечает числом нарушающих — как ужесточение, только с правом READ без
  -- условий на все строки класса и потомков (доработки после точки Б)
  perform @SCHEMA@.class_rows_admit(p_class, cr.tenant, array['READ'], 'rekey');
  perform @SCHEMA@.family_lock(cr, true);
  select x.* into cr from @SCHEMA@.entity x where x.id = cr.id for update;
  select p.data, p.validator into prep from @SCHEMA@.class_prepare(cr.data || jsonb_build_object('key', p_key), cr.tenant) p;
  perform @SCHEMA@.sys_update(cr.id, prep.data, cr.links, prep.validator, 'update');
  classes := array[p_class];
  -- потомки: описание пересчитывается (каждый пересчёт — версия класса в журнале)
  for dsc in select x.* from @SCHEMA@.entity x
             where x.class = 'Class' and x.tenant = cr.tenant and x.id <> cr.id
               and x.data->'resolved'->'ancestors' ? p_class
             order by jsonb_array_length(x.data->'resolved'->'ancestors'), x.id loop
    select p.data, p.validator into prep from @SCHEMA@.class_prepare(dsc.data, dsc.tenant) p;
    if prep.data is distinct from dsc.data or prep.validator::text is distinct from dsc.validator::text then
      perform @SCHEMA@.sys_update(dsc.id, prep.data, dsc.links, prep.validator, 'update');
    end if;
    classes := classes || (dsc.data->>'name');
  end loop;
  for r in select x.* from @SCHEMA@.entity x where x.class = any (classes) and x.tenant = cr.tenant order by x.id loop
    -- строку мог уже перенести перевод ссылок (конец в её ключе): берём свежую
    select x.* into r from @SCHEMA@.entity x where x.id = r.id for update;
    continue when r.id is null;
    if not @SCHEMA@.acl_row_ok(wplan, r.class, r.id, r.owner, r.tenant, r.tags, r.data, r.links) then
      perform @SCHEMA@.lt_fail('sql-time.no_write_row', jsonb_build_object('cls', r.class));
    end if;
    res := (@SCHEMA@.class_row(r.class, r.tenant)).data->'resolved';
    nid := coalesce(@SCHEMA@.key_id(res, r.class, r.tenant, r.data, r.links), r.id);
    if nid <> r.id then
      perform @SCHEMA@.move_row(r, nid, r.class, r.data, r.links, 'rekey', wplan);
      n := n + 1;
    end if;
  end loop;
  conflicts := @SCHEMA@.family_conflicts(classes, cr.tenant, false);
  if conflicts <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('sql-time.rekey_conflict',
      jsonb_build_object('cls', p_class), @SCHEMA@.visible_detail(conflicts, c.tenant));
  end if;
  perform @SCHEMA@.acl_bump();
  return n;
end $$;

-- ========================= удаление аккаунта =========================

-- Удаление аккаунта (этап 6, п. 3; accounts.purge 0.21): вызывающий — системный администратор или
-- владелец арендатора-цели (член с ролью owner); удалить себя нельзя; нельзя оставить арендатора без
-- последнего включённого владельца. Данные и журнал арендатора-цели стираются физически; в чужих
-- арендаторах членства снимаются (надгробия), владение строками переходит арендаторам (§2.10);
-- остались ссылки на аккаунт — delete_restricted. Строка Account удаляется с надгробием (история
-- аккаунтов — аудит), сессии гаснут с сигналом, строки secret аккаунта стирает каскад внешнего ключа.
create or replace function @SCHEMA@.account_purge(p_account uuid) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  a @SCHEMA@.entity;
  t record;
  m @SCHEMA@.entity;
  n_rows int;
  n_log int;
  n_mem int := 0;
  n_own int := 0;
  classes text[];
  blockers jsonb;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('sql-time.no_session');
  end if;
  if p_account = c.account then
    perform @SCHEMA@.lt_fail('sql-time.purge_self');
  end if;
  -- право — до поиска и блокировки цели: без права ответ один (acl_denied), есть ли такой аккаунт,
  -- не видно, и чужую строку Account вызов не блокирует (итоговое ревью безопасности)
  if not (@SCHEMA@.auth_is_sysadmin() or exists (
      select 1 from @SCHEMA@.entity x
      where x.id = @SCHEMA@.v5_id(p_account, 'member', array[c.account::text, p_account::text]) and x.class = 'member'
        and x.tenant = p_account and coalesce(x.data->'roles' ? 'owner', false))) then
    perform @SCHEMA@.lt_fail('sql-time.account_purge_denied');
  end if;
  select x.* into a from @SCHEMA@.entity x where x.id = p_account and x.class = 'Account' and x.tenant = '@SYSTEM@'::uuid for update;
  if a.id is null or p_account = '@SYSTEM@'::uuid then
    perform @SCHEMA@.lt_fail('sql-time.account_not_found');
  end if;
  -- владелец стирает арендатора, в котором работает: его членство уйдёт вместе с данными, а надгробия и
  -- передача владения ниже перечитывают ctx() — остаток операции идёт в личном арендаторе вызывающего,
  -- и его сессия больше не указывает на стёртого арендатора (иначе tenant_denied и откат всего вызова)
  if c.tenant = p_account then
    perform set_config('letopis.tenant', c.account::text, true);
    update @SCHEMA@.secret s set meta = s.meta - 'tenant'
    where s.id = c.session and s.kind = 'SESSION' and s.meta->>'tenant' = p_account::text;
  end if;
  -- последний владелец: в каждом чужом арендаторе, где цель — владелец, должен остаться другой
  for t in select x.tenant from @SCHEMA@.entity x
           where x.class = 'member' and x.links->>'User' = p_account::text and x.tenant <> p_account
             and coalesce(x.data->'roles' ? 'owner', false) loop
    if not exists (select 1 from @SCHEMA@.entity x
                   join @SCHEMA@.entity u on u.id = (x.links->>'User')::uuid and u.class = 'Account' and u.tenant = '@SYSTEM@'::uuid
                   where x.class = 'member' and x.tenant = t.tenant and x.links->>'User' <> p_account::text
                     and coalesce(x.data->'roles' ? 'owner', false) and coalesce((u.data->>'enabled')::boolean, true)) then
      perform @SCHEMA@.lt_fail('sql-time.last_owner', jsonb_build_object('tenant', t.tenant), jsonb_build_object('tenant', t.tenant));
    end if;
  end loop;
  -- данные арендатора-цели — физически, вместе с журналом
  select coalesce(array_agg(distinct x.class), '{}') into classes from @SCHEMA@.entity x where x.tenant = p_account;
  with d as (delete from @SCHEMA@.entity x where x.tenant = p_account returning 1) select count(*)::int into n_rows from d;
  with d as (delete from @SCHEMA@.log x where x.tenant = p_account returning 1) select count(*)::int into n_log from d;
  -- членства в чужих арендаторах: надгробия; владение строками — арендаторам
  for m in select x.* from @SCHEMA@.entity x where x.class = 'member' and x.links->>'User' = p_account::text order by x.id for update loop
    delete from @SCHEMA@.entity x where x.id = m.id;
    perform @SCHEMA@.tombstone(m);
    n_mem := n_mem + 1;
  end loop;
  for t in select distinct x.tenant from @SCHEMA@.entity x where x.owner = p_account and x.owner <> x.tenant order by x.tenant loop
    n_own := n_own + @SCHEMA@.owner_to_tenant(t.tenant, p_account);
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'class', x.class, 'tenant', x.tenant)), '[]'::jsonb) into blockers
  from (select x.id, x.class, x.tenant from @SCHEMA@.entity x where x.ends @> array[p_account] order by x.id limit 1000) x;
  if blockers <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('sql-time.account_referenced', '{}'::jsonb, @SCHEMA@.visible_detail(blockers, c.tenant));
  end if;
  -- сессии аккаунта гасит с сигналом триггер до удаления (trg_entity_bd_account, срабатывает и для владельца), а его
  -- строки secret — сессии и креды — стирает каскад внешнего ключа secret.account (ревизия 7)
  delete from @SCHEMA@.entity x where x.id = p_account;
  perform @SCHEMA@.tombstone(a);
  -- данные арендатора-цели — его парами; Account и member — классы прав, их сигнал сбрасывает всё
  perform @SCHEMA@.signal(classes || array['Account', 'member'],
    array(select p_account from unnest(classes)) || array['@SYSTEM@'::uuid, '@SYSTEM@'::uuid]);
  perform @SCHEMA@.acl_bump();
  return jsonb_build_object('account', p_account, 'rows', n_rows, 'versions', n_log, 'memberships', n_mem, 'owned', n_own);
end $$;

-- ========================= обслуживание =========================

-- Обслуживание (этап 6, п. 8): истёкшие и погашенные сессии и одноразовые коды, строки-замки удалённых семейств,
-- заполнение очереди сигналов. Вызывает системный администратор, роль с правом letopis.maintain или администраторское
-- подключение. Один исполнитель: обслуживание идёт одной транзакцией под строкой-замком; занята — null.
create or replace function @SCHEMA@.maintain() returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  s int;
  o int;
  fam text := '@SCHEMA_NAME@:family:';
begin
  if not @SCHEMA@.letopis_allowed('letopis.maintain') then
    perform @SCHEMA@.lt_fail('sql-time.maintain_denied');
  end if;
  -- один исполнитель: строка-замок до конца транзакции (lock_try) — посторонняя роль её не займёт (ревью
  -- безопасности №3, №2); занята — null, обслуживание продолжит держатель
  if not @SCHEMA@.lock_try('@SCHEMA_NAME@:maintain') then
    return null;
  end if;
  with d as (delete from @SCHEMA@.secret x where x.kind = 'SESSION'
             and (x.deleted_at is not null or x.expires_at <= clock_timestamp()) returning 1)
  select count(*)::int into s from d;
  -- коды всех видов, которые выпускает auth_issue_otp: OTP и OTP_<имя> (тот же шаблон вида), — использованные,
  -- заменённые, исчерпавшие попытки (deleted_at) и истёкшие
  with d as (delete from @SCHEMA@.secret x where x.kind ~ '^OTP(_[A-Z0-9]{1,27})?$'
             and (x.deleted_at is not null or x.expires_at <= clock_timestamp()) returning 1)
  select count(*)::int into o from d;
  -- строки-замки семейств, чьего корня больше нет — удалён класс или его арендатор (план 2.0, 7.7 №8, долгий
  -- прогон): их заранее заводит запись строки Class (family_rows), а сами они не уходили — заведение и удаление
  -- классов копило их без предела. Корень жив — строка Class с этим именем у арендатора семейства (family_name;
  -- в имени класса двоеточия нет). Занятую строку не трогаем (skip locked), а строку-замок семейства — только вместе
  -- с её шлюзом или без шлюза: исключительная блокировка берёт шлюз первым, и строка-замок, до которой она ещё не
  -- дошла, у неё не пропадёт. Пропавшую строку lock_row и family_lock заводят заново, если класс с этим именем
  -- появится снова.
  with stale as (
    select l.id, l.meta->>'name' as n
    from @SCHEMA@.secret l
    where l.kind = 'LOCK' and l.account = '@SYSTEM@'::uuid and l.deleted_at is null
      and left(l.meta->>'name', length(fam)) = fam
      and not exists (
        select 1 from @SCHEMA@.entity c
        where c.class = 'Class'
          and c.data->>'name' = split_part(substr(l.meta->>'name', length(fam) + 1), ':', 2)
          and c.tenant::text = split_part(substr(l.meta->>'name', length(fam) + 1), ':', 1))
    for update of l skip locked)
  delete from @SCHEMA@.secret x using stale st
  where x.id = st.id
    and (st.n like '%:gate'
         or exists (select 1 from stale g where g.n = st.n || ':gate')
         or not exists (select 1 from @SCHEMA@.secret y where y.id = @SCHEMA@.lock_id(st.n || ':gate')));
  return jsonb_build_object('sessions', s, 'codes', o, 'queue', pg_notification_queue_usage());
end $$;

-- ========================= подписка =========================

-- Пачка событий подписки (этап 6, п. 5): версии журнала после курсора (tx, seq) ниже горизонта
-- завершённых транзакций (pg_snapshot_xmin) — их уже ничто не обгонит, поэтому без потерь и повторов.
-- Выполняется с правами вызывающего: RLS журнала показывает только своё. p_classes null — все классы. p_snap — снимок
-- момента подписки «now»: транзакции, видимые в нём (зафиксированные до подписки), не отдаются. Уход строки из классов
-- подписки сменой класса без смены id отдаёт watch_leaving.
create or replace function @SCHEMA@.watch_read(p_tx xid8, p_seq bigint, p_classes text[], p_limit int,
  p_snap pg_snapshot default null)
returns setof @SCHEMA@.log
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  horizon xid8 := pg_snapshot_xmin(pg_current_snapshot());
begin
  return query select l.*
    from @SCHEMA@.log l
    where (l.tx, l.seq) > (p_tx, p_seq) and l.tx < horizon
      and (p_classes is null or l.class = any (p_classes))
      and (p_snap is null or not pg_visible_in_snapshot(l.tx, p_snap))
    order by l.tx, l.seq limit p_limit;
end $$;

-- Уход строки из классов подписки сменой класса без смены id (хвост ревью безопасности №3): версия пишется уже с новым
-- классом, и подписка по классам её не видит. Здесь — те же окно, горизонт и снимок, что у watch_read (и верхняя граница
-- окна p_upto — последняя строка полной пачки watch_read), а строки — синтетические надгробия прежней версии: класс,
-- концы и данные прежние; номер, время, автор, tx и seq — версии смены класса; вид delete; агента и причины нет. Только
-- если нового класса нет в p_classes, а прежнюю версию актор видит (row_visible с его планом READ): о строке, которой он
-- не читал, подписчик не узнает. Функция владельца: версию с новым классом актору видеть не нужно. Подключение в обход
-- RLS (суперпользователь, BYPASSRLS, член роли-владельца с наследованием — connect() пускает его только с
-- allowBypassRls) видит в watch_read журнал всех арендаторов, поэтому и события ухода получает все, с автором (хвост
-- ревью доработок после 1.2.0). Роль — действующая роль сеанса (session_role): та, к которой watch_read применяет RLS.
create or replace function @SCHEMA@.watch_leaving(p_tx xid8, p_seq bigint, p_classes text[], p_limit int,
  p_snap pg_snapshot default null, p_upto_tx xid8 default null, p_upto_seq bigint default null)
returns setof @SCHEMA@.log
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  horizon xid8 := pg_snapshot_xmin(pg_current_snapshot());
  a jsonb;
  bypass boolean;
begin
  if p_classes is null then
    return;
  end if;
  bypass := exists (select 1 from pg_roles r where r.rolname = @SCHEMA@.session_role() and (r.rolsuper or r.rolbypassrls))
            or pg_has_role(@SCHEMA@.session_role(), '@OWNER_NAME@', 'USAGE');
  a := case when not bypass then @SCHEMA@.acl_actor('READ') end;
  if a is null and not bypass then
    return;
  end if;
  -- новую версию актор не видит — надгробие при любом p_classes и без автора: перебором классов подписки он узнал бы её
  -- класс (автоматическое ревью доработок после 1.2.0)
  return query select l.seq, l.tx, p.id, l.rev, p.class, p.cv, p.tenant, p.owner, p.links, p.data, p.tags, l.at,
      case when v.seen then l.author end, null::text, 'delete'::text, null::text, null::uuid
    from @SCHEMA@.log l
    cross join lateral (select x.* from @SCHEMA@.log x where x.id = l.id and x.rev < l.rev and x.op <> 'purge'
                        order by x.rev desc limit 1) p
    cross join lateral (select bypass or @SCHEMA@.row_visible(l.tenant, l.class, l.id, l.owner, l.tags, l.data, l.links,
                               (a->>'tenant')::uuid, (a->>'account')::uuid, a->'plan') as seen) v
    where (l.tx, l.seq) > (p_tx, p_seq) and l.tx < horizon
      and (p_upto_tx is null or (l.tx, l.seq) <= (p_upto_tx, p_upto_seq))
      and l.op = 'reclass' and l.moved is null and (not (l.class = any (p_classes)) or not v.seen)
      and p.class = any (p_classes) and p.op <> 'delete'
      and (p_snap is null or not pg_visible_in_snapshot(l.tx, p_snap))
      and (bypass or @SCHEMA@.row_visible(p.tenant, p.class, p.id, p.owner, p.tags, p.data, p.links,
                                          (a->>'tenant')::uuid, (a->>'account')::uuid, a->'plan'))
    order by l.tx, l.seq limit p_limit;
end $$;

-- Точка подписки «с этого момента»: курсор — горизонт завершённых транзакций, снимок — чтобы не
-- отдавать транзакции, зафиксированные до подписки, но ещё не ушедшие за горизонт.
create or replace function @SCHEMA@.watch_head(out tx xid8, out seq bigint, out snap pg_snapshot)
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  select pg_snapshot_xmin(s), 0::bigint, s from pg_current_snapshot() s
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'session_role()', 'admin_role()', 'letopis_allowed(text)', 'session_expires()', 'signal_mode()', 'signal_key()', 'class_stamp()',
    'last_version_visible(uuid, uuid, jsonb)', 'restore(uuid)', 'purge(uuid, boolean)',
    'rekey(uuid, jsonb, jsonb)', 'rekey_class(text, jsonb)', 'account_purge(uuid)', 'maintain()',
    'watch_read(xid8, bigint, text[], int, pg_snapshot)', 'watch_leaving(xid8, bigint, text[], int, pg_snapshot, xid8, bigint)', 'watch_head()'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
-- приложению: функции владельца этапа 6 (проверяют права сами) и подписка (под RLS)
grant execute on function @SCHEMA@.restore(uuid), @SCHEMA@.purge(uuid, boolean),
  @SCHEMA@.rekey(uuid, jsonb, jsonb), @SCHEMA@.rekey_class(text, jsonb), @SCHEMA@.account_purge(uuid), @SCHEMA@.maintain(),
  @SCHEMA@.session_expires(), @SCHEMA@.watch_read(xid8, bigint, text[], int, pg_snapshot),
  @SCHEMA@.watch_leaving(xid8, bigint, text[], int, pg_snapshot, xid8, bigint), @SCHEMA@.watch_head(),
  @SCHEMA@.signal_mode(), @SCHEMA@.signal_key(), @SCHEMA@.class_stamp() to @APP@;
