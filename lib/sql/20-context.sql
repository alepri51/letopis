-- letopis 1.0 — сессии и контекст запроса (план, §2.9, этап 1, п. 3).
-- Каждая операция библиотеки — транзакция, первые операторы которой выставляют
-- letopis.token (и при имперсонации letopis.account) через set_config(…, true).
-- Без настоящего токена настройки ничего не дают: сессия ищется по sha256 токена.
-- Имперсонация, членство и права — этап 5.

-- Контекст запроса: аккаунт сессии, арендатор, автор и агент версии.
create or replace function @SCHEMA@.ctx(out account uuid, out tenant uuid, out author uuid, out agent text, out categories text[])
language sql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  select s.account,
         coalesce((s.meta->>'tenant')::uuid, s.account),
         s.account,
         null::text,
         coalesce(array(select jsonb_array_elements_text(a.data->'categories')), '{}')
  from @SCHEMA@.secret s
  join @SCHEMA@.entity a on a.id = s.account and a.class = 'Account'
  where s.kind = 'SESSION'
    and s.deleted_at is null
    and (s.expires_at is null or s.expires_at > clock_timestamp())
    and s.material = sha256(convert_to(nullif(current_setting('letopis.token', true), ''), 'UTF8'))
    and coalesce((a.data->>'enabled')::boolean, true)
$$;

create or replace function @SCHEMA@.ctx_tenant() returns uuid
language sql stable parallel safe
return (select c.tenant from @SCHEMA@.ctx() c);

create or replace function @SCHEMA@.ctx_account() returns uuid
language sql stable parallel safe
return (select c.account from @SCHEMA@.ctx() c);

-- Новая сессия: 256 случайных бит, в базе — только sha256 токена.
create or replace function @SCHEMA@.new_session(p_account uuid, p_ttl interval, p_meta jsonb) returns text
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  tok text := encode(@PGCRYPTO@.gen_random_bytes(32), 'hex');
begin
  insert into @SCHEMA@.secret (account, kind, material, meta, expires_at)
  values (p_account, 'SESSION', sha256(convert_to(tok, 'UTF8')),
          coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('login_at', clock_timestamp()),
          clock_timestamp() + coalesce(p_ttl, interval '7 days'));
  return tok;
end $$;

-- Вход по API-ключу (APIKEY): префикс ищется в ident, ключ сверяется по sha256.
create or replace function @SCHEMA@.login_apikey(p_key text) returns text
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  acc uuid;
begin
  select s.account into acc
  from @SCHEMA@.secret s
  join @SCHEMA@.entity a on a.id = s.account and a.class = 'Account'
  where s.kind = 'APIKEY' and s.deleted_at is null
    and s.ident = left(p_key, 12)
    and s.material = sha256(convert_to(p_key, 'UTF8'))
    and (s.expires_at is null or s.expires_at > clock_timestamp())
    and coalesce((a.data->>'enabled')::boolean, true);
  if acc is null then
    raise exception using errcode = 'LT001', message = 'letopis: no_session: неверный ключ';
  end if;
  return @SCHEMA@.new_session(acc, interval '7 days', jsonb_build_object('methods', jsonb_build_array('APIKEY')));
end $$;

-- Выпуск сессии пользователя сервисом (этап 1: сервис — аккаунт с категорией Service).
create or replace function @SCHEMA@.issue_session(p_account uuid, p_ttl interval default interval '7 days') returns text
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    raise exception using errcode = 'LT001', message = 'letopis: no_session: нет действующей сессии';
  end if;
  if not ('Service' = any (c.categories)) then
    raise exception using errcode = 'LT006', message = 'letopis: acl_denied: выпускать сессии может только сервис';
  end if;
  if not exists (select 1 from @SCHEMA@.entity a where a.id = p_account and a.class = 'Account'
                 and coalesce((a.data->>'enabled')::boolean, true)) then
    raise exception using errcode = 'LT002', message = 'letopis: target_not_found: аккаунт не найден';
  end if;
  return @SCHEMA@.new_session(p_account, p_ttl, jsonb_build_object('methods', jsonb_build_array('SERVICE'), 'service', c.account));
end $$;

alter function @SCHEMA@.ctx() owner to @OWNER@;
alter function @SCHEMA@.ctx_tenant() owner to @OWNER@;
alter function @SCHEMA@.ctx_account() owner to @OWNER@;
alter function @SCHEMA@.new_session(uuid, interval, jsonb) owner to @OWNER@;
alter function @SCHEMA@.login_apikey(text) owner to @OWNER@;
alter function @SCHEMA@.issue_session(uuid, interval) owner to @OWNER@;
revoke all on function @SCHEMA@.ctx(), @SCHEMA@.ctx_tenant(), @SCHEMA@.ctx_account(),
  @SCHEMA@.new_session(uuid, interval, jsonb), @SCHEMA@.login_apikey(text), @SCHEMA@.issue_session(uuid, interval) from public;
grant execute on function @SCHEMA@.ctx(), @SCHEMA@.ctx_tenant(), @SCHEMA@.ctx_account(),
  @SCHEMA@.login_apikey(text), @SCHEMA@.issue_session(uuid, interval) to @APP@;
