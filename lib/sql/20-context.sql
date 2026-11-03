-- letopis 1.0 — сессии и контекст запроса (план, §2.9, этап 1, п. 3, этап 5, п. 2–4).
-- Каждая операция библиотеки — транзакция, первые операторы которой выставляют letopis.token,
-- при имперсонации letopis.account и при выборе арендатора letopis.tenant через set_config(…, true).
-- Без настоящего токена настройки ничего не дают: сессия ищется по sha256 токена, а
-- letopis.account действует только для сессии с правом auth.impersonate (правила System).

-- Контекст запроса: актор (аккаунт, от имени которого идёт работа), рабочий арендатор, автор и агент
-- версии, категории актора и его роли в арендаторе, сессия и сервис (при имперсонации).
-- Только читает. Нет токена или сессии — пустой контекст; запрещённая имперсонация и арендатор без
-- членства — ошибка: молча работать в другом арендаторе или от другого имени нельзя.
create or replace function @SCHEMA@.ctx(out account uuid, out tenant uuid, out author uuid, out agent text,
  out categories text[], out roles text[], out session uuid, out service uuid)
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_variable
declare
  tok text := nullif(current_setting('letopis.token', true), '');
  imp text := nullif(current_setting('letopis.account', true), '');
  want text := nullif(current_setting('letopis.tenant', true), '');
  s record;
  a record;
  t record;
  m record;
  scats text[];
  sroles text[];
  stenant uuid;
begin
  if tok is null then
    return;
  end if;
  select x.id, x.account, x.meta into s
  from @SCHEMA@.secret x
  where x.kind = 'SESSION' and x.deleted_at is null
    and x.material = sha256(convert_to(tok, 'UTF8'))
    and (x.expires_at is null or x.expires_at > clock_timestamp());
  if s.id is null then
    return;
  end if;
  select e.id, e.data into a from @SCHEMA@.entity e
  where e.id = s.account and e.class = 'Account' and e.tenant = '@SYSTEM@'::uuid and coalesce((e.data->>'enabled')::boolean, true);
  if a.id is null then
    return;
  end if;
  session := s.id;
  account := s.account;
  tenant := coalesce((s.meta->>'tenant')::uuid, s.account);
  if imp is not null and imp is distinct from s.account::text then
    -- имперсонация (этап 5, п. 3): право сервиса — по правилам System, в его собственном арендаторе
    if not pg_input_is_valid(imp, 'uuid') then
      perform @SCHEMA@.lt_fail('sql-core.account_not_id');
    end if;
    scats := array(select jsonb_array_elements_text(coalesce(a.data->'categories', '[]'::jsonb)));
    stenant := tenant;
    sroles := case when stenant = s.account then array['owner'] else array(
      select jsonb_array_elements_text(coalesce(x.data->'roles', '[]'::jsonb)) from @SCHEMA@.entity x
      where x.id = @SCHEMA@.v5_id(stenant, 'member', array[s.account::text, stenant::text]) and x.class = 'member') end;
    if not coalesce((@SCHEMA@.acl_api_for(stenant, scats, sroles, 'auth.impersonate', true)->>'allow')::boolean, false) then
      perform @SCHEMA@.lt_fail('sql-core.no_impersonate_right');
    end if;
    select e.id, e.data into a from @SCHEMA@.entity e where e.id = imp::uuid and e.class = 'Account' and e.tenant = '@SYSTEM@'::uuid;
    -- от имени System, сервисов, системных администраторов и отключённых аккаунтов действовать нельзя
    if a.id is null or not coalesce((a.data->>'enabled')::boolean, true) or a.id = '@SYSTEM@'::uuid
       or coalesce(a.data->'categories' ?| array['System', 'Service'], false)
       or exists (select 1 from @SCHEMA@.entity x
                  where x.id = @SCHEMA@.v5_id('@SYSTEM@'::uuid, 'member', array[a.id::text, '@SYSTEM@']) and x.class = 'member') then
      perform @SCHEMA@.lt_fail('sql-core.impersonation_denied');
    end if;
    service := s.account;
    agent := s.account::text;
    account := a.id;
    tenant := a.id;
  end if;
  if want is not null then
    if not pg_input_is_valid(want, 'uuid') then
      perform @SCHEMA@.lt_fail('sql-core.tenant_not_id');
    end if;
    tenant := want::uuid;
  end if;
  if tenant = account then
    roles := array['owner'];
  else
    -- работа в чужом арендаторе — по членству; членство проверяется при каждом вызове
    select x.data into m from @SCHEMA@.entity x
    where x.id = @SCHEMA@.v5_id(tenant, 'member', array[account::text, tenant::text]) and x.class = 'member' and x.tenant = tenant;
    select e.id into t from @SCHEMA@.entity e
    where e.id = tenant and e.class = 'Account' and e.tenant = '@SYSTEM@'::uuid and coalesce((e.data->>'enabled')::boolean, true);
    if m is null or t.id is null then
      perform @SCHEMA@.lt_fail('sql-core.no_membership');
    end if;
    roles := array(select jsonb_array_elements_text(coalesce(m.data->'roles', '[]'::jsonb)));
  end if;
  categories := array(select jsonb_array_elements_text(coalesce(a.data->'categories', '[]'::jsonb)));
  author := account;
end $$;

create or replace function @SCHEMA@.ctx_tenant() returns uuid
language sql stable
return (select c.tenant from @SCHEMA@.ctx() c);

create or replace function @SCHEMA@.ctx_account() returns uuid
language sql stable
return (select c.account from @SCHEMA@.ctx() c);

-- Новая сессия: 256 случайных бит, в базе — только sha256 токена. В meta — время и способы входа
-- (без них не проверить «недавний вход»), рабочий арендатор после auth.switch, выпустивший сервис.
create or replace function @SCHEMA@.new_session(p_account uuid, p_ttl interval, p_meta jsonb) returns text
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  tok text := encode(@PGCRYPTO@.gen_random_bytes(32), 'hex');
begin
  insert into @SCHEMA@.secret (account, kind, material, meta, expires_at)
  values (p_account, 'SESSION', sha256(convert_to(tok, 'UTF8')),
          coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('login_at', clock_timestamp(), 'ttl', coalesce(p_ttl, interval '7 days')::text),
          clock_timestamp() + coalesce(p_ttl, interval '7 days'));
  return tok;
end $$;

-- Вход по API-ключу (APIKEY): префикс ищется в ident, ключ сверяется по sha256. Сессия помнит ключ
-- (meta.cred): отзыв ключа гасит только его сессии.
create or replace function @SCHEMA@.login_apikey(p_key text) returns text
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  k record;
begin
  select s.id, s.account into k
  from @SCHEMA@.secret s
  join @SCHEMA@.entity a on a.id = s.account and a.class = 'Account' and a.tenant = '@SYSTEM@'::uuid
  where s.kind = 'APIKEY' and s.deleted_at is null
    and casefold(s.ident) collate pg_unicode_fast = casefold(left(p_key, 12)) collate pg_unicode_fast
    and s.material = sha256(convert_to(p_key, 'UTF8'))
    and (s.expires_at is null or s.expires_at > clock_timestamp())
    and coalesce((s.meta->>'enabled')::boolean, true)
    and coalesce((a.data->>'enabled')::boolean, true);
  if k.account is null then
    -- DETAIL не было и до каталога (raise без detail): p_detail => 'null' (15-errors.sql)
    perform @SCHEMA@.lt_fail('sql-core.bad_api_key', p_detail => 'null');
  end if;
  return @SCHEMA@.new_session(k.account, interval '7 days', jsonb_build_object('methods', jsonb_build_array('APIKEY'), 'cred', k.id));
end $$;

alter function @SCHEMA@.ctx() owner to @OWNER@;
alter function @SCHEMA@.ctx_tenant() owner to @OWNER@;
alter function @SCHEMA@.ctx_account() owner to @OWNER@;
alter function @SCHEMA@.new_session(uuid, interval, jsonb) owner to @OWNER@;
alter function @SCHEMA@.login_apikey(text) owner to @OWNER@;
revoke all on function @SCHEMA@.ctx(), @SCHEMA@.ctx_tenant(), @SCHEMA@.ctx_account(),
  @SCHEMA@.new_session(uuid, interval, jsonb), @SCHEMA@.login_apikey(text) from public;
grant execute on function @SCHEMA@.ctx(), @SCHEMA@.ctx_tenant(), @SCHEMA@.ctx_account(),
  @SCHEMA@.login_apikey(text) to @APP@;
