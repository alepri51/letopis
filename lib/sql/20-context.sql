-- letopis — сессии и контекст запроса.
-- Каждая операция библиотеки — транзакция, первые операторы которой выставляют letopis.token, у консьержа — ещё
-- letopis.tenant (квартира, в которой он работает: db.in) и letopis.account (жилец, от имени которого он работает:
-- db.as), через set_config(…, true). Без настоящего токена настройки ничего не дают: сессия ищется по sha256 токена.
--
-- Кто есть кто:
--   консьерж — аккаунт System с категорией Service; его сессия не привязана к квартире (tenant = System); он работает
--              в любой включённой квартире без прописки и может действовать от имени прописанного в ней жильца;
--   жилец    — аккаунт с kind = 'person'; его сессия привязана к квартире ключа, которым он вошёл (secret.tenant), и
--              работает только в ней, пока он там прописан;
--   квартира — аккаунт System с kind = 'tenant'.

-- Квартира включена.
create or replace function @SCHEMA@.tenant_ok(p_tenant uuid) returns boolean
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return exists (select 1 from @SCHEMA@.entity e
               where e.id = p_tenant and e.class = 'Account' and e.tenant = '@SYSTEM@'::uuid
                 and e.data->>'kind' = 'tenant' and coalesce((e.data->>'enabled')::boolean, true));

-- Прописка аккаунта в квартире: строка member или null.
-- plpgsql: v5_id появляется позже (30-validate.sql), тело на стандартном SQL разбиралось бы при создании.
create or replace function @SCHEMA@.member_row(p_account uuid, p_tenant uuid) returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  return (select x.data from @SCHEMA@.entity x
          where x.id = @SCHEMA@.v5_id(p_tenant, 'member', array[p_account::text, p_tenant::text])
            and x.class = 'member' and x.tenant = p_tenant);
end $$;

-- Контекст запроса: актор (аккаунт, от имени которого идёт работа), рабочая квартира, автор и агент версии, категории
-- актора и его метки (roles) в квартире, сессия и консьерж (при работе от имени жильца). Только читает. Нет токена или
-- сессии — пустой контекст; работа вне своей квартиры, без прописки и запрещённая подмена — ошибка: молча работать в
-- другой квартире или от другого имени нельзя.
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
  m jsonb;
  svc boolean;
begin
  if tok is null then
    return;
  end if;
  select x.id, x.account, x.tenant into s
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
  svc := coalesce(a.data->'categories' ? 'Service', false);
  if svc then
    -- консьерж: квартира — та, что выбрал db.in(); без неё — ни одной (вещей нет)
    if want is not null then
      if not pg_input_is_valid(want, 'uuid') then
        perform @SCHEMA@.lt_fail('sql-core.tenant_not_id');
      end if;
      -- System — общие классы дома (setup пишет модели консьержем)
      if want::uuid <> '@SYSTEM@'::uuid and not @SCHEMA@.tenant_ok(want::uuid) then
        perform @SCHEMA@.lt_fail('sql-core.no_membership');
      end if;
      tenant := want::uuid;
    end if;
    roles := '{}';
    if imp is not null and imp is distinct from s.account::text then
      -- от имени жильца (db.as): только в квартире и только прописанного в ней
      if not pg_input_is_valid(imp, 'uuid') then
        perform @SCHEMA@.lt_fail('sql-core.account_not_id');
      end if;
      if tenant is null then
        perform @SCHEMA@.lt_fail('sql-core.impersonation_denied');
      end if;
      select e.id, e.data into a from @SCHEMA@.entity e
      where e.id = imp::uuid and e.class = 'Account' and e.tenant = '@SYSTEM@'::uuid and e.data->>'kind' = 'person'
        and coalesce((e.data->>'enabled')::boolean, true);
      if a.id is null then
        perform @SCHEMA@.lt_fail('sql-core.impersonation_no_account', jsonb_build_object('id', imp));
      end if;
      m := @SCHEMA@.member_row(a.id, tenant);
      if m is null then
        perform @SCHEMA@.lt_fail('sql-core.impersonation_denied');
      end if;
      service := s.account;
      agent := s.account::text;
      account := a.id;
      roles := array(select jsonb_array_elements_text(coalesce(m->'roles', '[]'::jsonb)));
    end if;
  else
    -- жилец: только квартира ключа, по которому открыта сессия, и только пока он там прописан
    if imp is not null and imp is distinct from s.account::text then
      perform @SCHEMA@.lt_fail('sql-core.impersonation_denied');
    end if;
    if want is not null and want is distinct from s.tenant::text then
      perform @SCHEMA@.lt_fail('sql-core.tenant_locked');
    end if;
    tenant := s.tenant;
    m := @SCHEMA@.member_row(s.account, tenant);
    if m is null or not @SCHEMA@.tenant_ok(tenant) then
      perform @SCHEMA@.lt_fail('sql-core.no_membership');
    end if;
    roles := array(select jsonb_array_elements_text(coalesce(m->'roles', '[]'::jsonb)));
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

-- Актор — консьерж (категория Service), не от имени жильца.
create or replace function @SCHEMA@.ctx_is_service() returns boolean
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  select * into c from @SCHEMA@.ctx();
  return c.account is not null and c.service is null and coalesce('Service' = any (c.categories), false);
end $$;

-- Новая сессия: 256 случайных бит, в базе — только sha256 токена. tenant — квартира ключа (у консьержа — System). В
-- meta — время и способы входа (без них не проверить «недавний вход»), кред, которым вошли.
create or replace function @SCHEMA@.new_session(p_account uuid, p_tenant uuid, p_ttl interval, p_meta jsonb) returns text
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  tok text := encode(@PGCRYPTO@.gen_random_bytes(32), 'hex');
begin
  insert into @SCHEMA@.secret (account, tenant, kind, material, meta, expires_at)
  values (p_account, coalesce(p_tenant, '@SYSTEM@'::uuid), 'SESSION', sha256(convert_to(tok, 'UTF8')),
          coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('login_at', clock_timestamp(), 'ttl', coalesce(p_ttl, interval '7 days')::text),
          clock_timestamp() + coalesce(p_ttl, interval '7 days'));
  return tok;
end $$;

-- Вход по ключу API (APIKEY): префикс ищется в ident, ключ сверяется по sha256. Ключ консьержа открывает дом (сессия
-- без квартиры), ключ жильца — свою квартиру, если он там прописан. Сессия помнит ключ (meta.cred): отзыв ключа гасит
-- только его сессии. Вход и отзыв синхронизированы по строке ключа (for share). Нет такого ключа — null.
create or replace function @SCHEMA@.login_apikey(p_key text, p_ttl interval default interval '7 days') returns text
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  k record;
begin
  select s.id, s.account, s.tenant, coalesce(a.data->'categories' ? 'Service', false) as svc into k
  from @SCHEMA@.secret s
  join @SCHEMA@.entity a on a.id = s.account and a.class = 'Account' and a.tenant = '@SYSTEM@'::uuid
  where s.kind = 'APIKEY' and s.deleted_at is null
    and casefold(s.ident) collate pg_unicode_fast = casefold(left(coalesce(p_key, ''), 12)) collate pg_unicode_fast
    and s.material = sha256(convert_to(coalesce(p_key, ''), 'UTF8'))
    and (s.expires_at is null or s.expires_at > clock_timestamp())
    and coalesce((s.meta->>'enabled')::boolean, true)
    and coalesce((a.data->>'enabled')::boolean, true)
  -- строка ключа — под блокировкой до конца транзакции входа: отзыв (key_revoke) ждёт её фиксации и гасит
  -- открытую здесь сессию, а вход после отзыва ключа не находит
  for share of s;
  if k.account is null then
    return null;
  end if;
  if not k.svc and (@SCHEMA@.member_row(k.account, k.tenant) is null or not @SCHEMA@.tenant_ok(k.tenant)) then
    return null;
  end if;
  return @SCHEMA@.new_session(k.account, case when k.svc then '@SYSTEM@'::uuid else k.tenant end, p_ttl,
    jsonb_build_object('methods', jsonb_build_array('APIKEY'), 'cred', k.id));
end $$;

alter function @SCHEMA@.tenant_ok(uuid) owner to @OWNER@;
alter function @SCHEMA@.member_row(uuid, uuid) owner to @OWNER@;
alter function @SCHEMA@.ctx() owner to @OWNER@;
alter function @SCHEMA@.ctx_tenant() owner to @OWNER@;
alter function @SCHEMA@.ctx_account() owner to @OWNER@;
alter function @SCHEMA@.ctx_is_service() owner to @OWNER@;
alter function @SCHEMA@.new_session(uuid, uuid, interval, jsonb) owner to @OWNER@;
alter function @SCHEMA@.login_apikey(text, interval) owner to @OWNER@;
revoke all on function @SCHEMA@.tenant_ok(uuid), @SCHEMA@.member_row(uuid, uuid), @SCHEMA@.ctx(), @SCHEMA@.ctx_tenant(),
  @SCHEMA@.ctx_account(), @SCHEMA@.ctx_is_service(), @SCHEMA@.new_session(uuid, uuid, interval, jsonb),
  @SCHEMA@.login_apikey(text, interval) from public;
grant execute on function @SCHEMA@.ctx(), @SCHEMA@.ctx_tenant(), @SCHEMA@.ctx_account(),
  @SCHEMA@.login_apikey(text, interval) to @APP@;
