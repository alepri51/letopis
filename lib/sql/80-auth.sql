-- letopis 1.0 — креды, вход, сессии (план, §2.9, этап 5, п. 1–3).
-- Всё лежит в secret; приложение не видит ни одной строки и работает только через эти функции.
-- Виды записей: PASSWORD (и другие «логин/пароль» — EMAIL и т. п.: хэш scrypt считает и проверяет
-- сервис в Node), APIKEY (lts_…, в базе sha256), KEYSECRET (пара ключ + секрет, в базе sha256
-- секрета), OTP (одноразовый код, sha256, срок, счётчик попыток), TOTP (RFC 6238, HMAC-SHA1 из
-- pgcrypto), внешние identity (TELEGRAM, GOOGLE, …: связка, токен проверяет сервис), SESSION.
-- Пара «вид, идентификатор» уникальна среди неудалённых записей без учёта регистра (индекс
-- secret_kind_ident). Права: auth.* — по правилам System (сервис, системный администратор);
-- свои креды аккаунт привязывает сам только после недавнего входа.

-- Недавний вход: способы входа и время — в meta сессии.
create or replace function @SCHEMA@.auth_recent() returns interval
language sql immutable parallel safe
return interval '10 minutes';

create or replace function @SCHEMA@.auth_kind_ok(p_kind text) returns boolean
language sql immutable parallel safe
return p_kind ~ '^[A-Z][A-Z0-9_]{1,31}$' and p_kind not in ('SESSION', 'APIKEY', 'KEYSECRET', 'OTP', 'TOTP', 'KEY');

-- Действующая сессия обязательна (иначе no_session).
create or replace function @SCHEMA@.auth_session_required(p_account uuid) returns void
language plpgsql immutable
as $$
begin
  if p_account is null then
    perform @SCHEMA@.lt_fail('no_session', 'нет действующей сессии');
  end if;
end $$;

-- Может ли актор менять креды аккаунта: сам аккаунт после недавнего входа (не через имперсонацию)
-- или обладатель права auth.credential (правила System). Отказ одинаков в любом случае.
create or replace function @SCHEMA@.auth_can_manage(p_account uuid) returns void
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  login_at timestamptz;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('no_session', 'нет действующей сессии');
  end if;
  if c.account = p_account and c.service is null then
    select (s.meta->>'login_at')::timestamptz into login_at from @SCHEMA@.secret s where s.id = c.session;
    if login_at > clock_timestamp() - @SCHEMA@.auth_recent() then
      return;
    end if;
  end if;
  if not coalesce((@SCHEMA@.acl_api_for(c.tenant, c.categories, c.roles, 'auth.credential', true)->>'allow')::boolean, false) then
    perform @SCHEMA@.lt_fail('acl_denied', 'привязка отклонена: нужен недавний вход или право auth.credential');
  end if;
end $$;

-- Аккаунт, для которого можно выпустить сессию: существует, включён, не System, не сервис и не
-- системный администратор (иначе сервис получил бы их права).
create or replace function @SCHEMA@.auth_target_ok(p_account uuid) returns boolean
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return exists (select 1 from @SCHEMA@.entity a
               where a.id = p_account and a.class = 'Account' and a.tenant = '@SYSTEM@'::uuid
                 and coalesce((a.data->>'enabled')::boolean, true) and a.id <> '@SYSTEM@'::uuid and not coalesce(a.data->'categories' ?| array['System', 'Service'], false))
   and not exists (select 1 from @SCHEMA@.entity x
                   where x.id = @SCHEMA@.v5_id('@SYSTEM@'::uuid, 'member', array[p_account::text, '@SYSTEM@']) and x.class = 'member');

-- Аккаунт включён (для входа по кредам: сервисы и администраторы тоже входят).
create or replace function @SCHEMA@.auth_enabled(p_account uuid) returns boolean
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return exists (select 1 from @SCHEMA@.entity a
               where a.id = p_account and a.class = 'Account' and a.tenant = '@SYSTEM@'::uuid
                 and coalesce((a.data->>'enabled')::boolean, true));

-- Погасить сессии аккаунта, кроме p_except; каждая погашенная — сигнал кэшу с началом хэша токена.
create or replace function @SCHEMA@.auth_kill(p_account uuid, p_except uuid) returns int
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  sig text[];
begin
  with k as (
    update @SCHEMA@.secret s set deleted_at = clock_timestamp()
    where s.account = p_account and s.kind = 'SESSION' and s.deleted_at is null and s.id is distinct from p_except
    returning s.material)
  select array_agg('session:' || left(encode(k.material, 'hex'), 16)) into sig from k;
  perform @SCHEMA@.signal(sig);
  return coalesce(cardinality(sig), 0);
end $$;

-- Сессия сервисом для пользователя (db.auth.sessionFor, вход по паролю и identity): право
-- auth.session, способы входа — в meta.
create or replace function @SCHEMA@.issue_session(p_account uuid, p_ttl interval default interval '7 days',
  p_methods text[] default array['SERVICE']) returns text
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  select * into c from @SCHEMA@.ctx();
  perform @SCHEMA@.auth_session_required(c.account);
  perform @SCHEMA@.acl_require('auth.session');
  if not @SCHEMA@.auth_target_ok(p_account) then
    perform @SCHEMA@.lt_fail('acl_denied', 'сессии для этого аккаунта не выпускаются');
  end if;
  return @SCHEMA@.new_session(p_account, p_ttl, jsonb_build_object('methods', to_jsonb(p_methods), 'service', c.account));
end $$;

-- Хэш пароля для проверки сервисом (scrypt — в Node): только с правом auth.password.
create or replace function @SCHEMA@.auth_password_get(p_ident text, p_kind text default 'PASSWORD')
returns table (cred uuid, account uuid, hash text, confirmed boolean)
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_column
begin
  perform @SCHEMA@.acl_require('auth.password');
  return query
    select s.id, s.account, convert_from(s.material, 'UTF8'), coalesce((s.meta->>'confirmed')::boolean, false)
    from @SCHEMA@.secret s
    where s.kind = p_kind and s.deleted_at is null
      and casefold(s.ident) collate pg_unicode_fast = casefold(p_ident) collate pg_unicode_fast
      and coalesce((s.meta->>'enabled')::boolean, true)
      and @SCHEMA@.auth_enabled(s.account);
end $$;

-- Пароль (и любой «логин/пароль»): хэш приходит готовым (scrypt в Node). Новый идентификатор —
-- новая запись; свой — замена хэша. Смена пароля гасит остальные сессии аккаунта (текущую — если
-- p_keep_current = false). Занятый чужим аккаунтом идентификатор — тот же отказ, что без права.
create or replace function @SCHEMA@.auth_set_password(p_account uuid, p_ident text, p_hash text,
  p_kind text default 'PASSWORD', p_confirmed boolean default null, p_keep_current boolean default true) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  cur record;
  cid uuid;
begin
  perform @SCHEMA@.auth_can_manage(p_account);
  select * into c from @SCHEMA@.ctx();
  if not @SCHEMA@.auth_kind_ok(p_kind) or coalesce(p_ident, '') = '' or p_hash !~ '^scrypt\$' then
    perform @SCHEMA@.lt_fail('invalid_data', 'пароль: вид, идентификатор и хэш scrypt$… обязательны');
  end if;
  select s.id, s.account into cur from @SCHEMA@.secret s
  where s.kind = p_kind and s.deleted_at is null
    and casefold(s.ident) collate pg_unicode_fast = casefold(p_ident) collate pg_unicode_fast
  for update;
  if cur.id is not null and cur.account <> p_account then
    perform @SCHEMA@.lt_fail('acl_denied', 'привязка отклонена: нужен недавний вход или право auth.credential');
  end if;
  if cur.id is not null then
    update @SCHEMA@.secret s
       set material = convert_to(p_hash, 'UTF8'),
           meta = case when p_confirmed is null then s.meta else s.meta || jsonb_build_object('confirmed', p_confirmed) end
     where s.id = cur.id;
    cid := cur.id;
    perform @SCHEMA@.auth_kill(p_account, case when p_keep_current then c.session end);
  else
    begin
      insert into @SCHEMA@.secret (account, kind, ident, material, meta)
      values (p_account, p_kind, p_ident, convert_to(p_hash, 'UTF8'), jsonb_build_object('confirmed', coalesce(p_confirmed, false)))
      returning id into cid;
    exception when unique_violation then
      perform @SCHEMA@.lt_fail('acl_denied', 'привязка отклонена: нужен недавний вход или право auth.credential');
    end;
  end if;
  return cid;
end $$;

-- Ключ API: lts_ и 48 шестнадцатеричных знаков; отдаётся один раз, в базе — sha256, в ident — префикс.
-- У аккаунта может быть несколько ключей: ротация — новый ключ и отзыв старого без простоя.
create or replace function @SCHEMA@.auth_issue_apikey(p_account uuid, p_name text default null, p_ttl interval default null)
returns table (key text, id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_variable
declare
  k text;
  cid uuid;
  i int;
begin
  perform @SCHEMA@.auth_can_manage(p_account);
  for i in 1 .. 5 loop
    k := 'lts_' || encode(@PGCRYPTO@.gen_random_bytes(24), 'hex');
    begin
      insert into @SCHEMA@.secret as x (account, kind, ident, material, meta, expires_at)
      values (p_account, 'APIKEY', left(k, 12), sha256(convert_to(k, 'UTF8')),
              jsonb_strip_nulls(jsonb_build_object('name', p_name, 'confirmed', true)), clock_timestamp() + p_ttl)
      returning x.id into cid;
      key := k;
      id := cid;
      return next;
      return;
    exception when unique_violation then
      null; -- совпал префикс: новый ключ
    end;
  end loop;
  perform @SCHEMA@.lt_raise('40001', 'conflict', 'не удалось выпустить ключ с уникальным префиксом');
end $$;

-- Вход по ключу API для db.auth.verifyApiKey: { account, token } или null (login_apikey — для
-- connect(), бросает no_session).
create or replace function @SCHEMA@.auth_login_apikey(p_key text) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  acc uuid;
begin
  select s.account into acc from @SCHEMA@.secret s
  where s.kind = 'APIKEY' and s.deleted_at is null
    and casefold(s.ident) collate pg_unicode_fast = casefold(left(coalesce(p_key, ''), 12)) collate pg_unicode_fast
    and s.material = sha256(convert_to(coalesce(p_key, ''), 'UTF8'))
    and (s.expires_at is null or s.expires_at > clock_timestamp())
    and coalesce((s.meta->>'enabled')::boolean, true)
    and @SCHEMA@.auth_enabled(s.account);
  if acc is null then
    return null;
  end if;
  return jsonb_build_object('account', acc,
    'token', @SCHEMA@.new_session(acc, interval '7 days', jsonb_build_object('methods', jsonb_build_array('APIKEY'))));
end $$;

-- Пара ключ + секрет: ключ — открытый идентификатор, секрет отдаётся один раз, в базе — sha256.
create or replace function @SCHEMA@.auth_issue_keysecret(p_account uuid, p_name text default null)
returns table (key text, secret text, id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_variable
declare
  k text := encode(@PGCRYPTO@.gen_random_bytes(8), 'hex');
  s text := encode(@PGCRYPTO@.gen_random_bytes(24), 'hex');
begin
  perform @SCHEMA@.auth_can_manage(p_account);
  insert into @SCHEMA@.secret as x (account, kind, ident, material, meta)
  values (p_account, 'KEYSECRET', k, sha256(convert_to(s, 'UTF8')), jsonb_strip_nulls(jsonb_build_object('name', p_name, 'confirmed', true)))
  returning x.id into id;
  key := k;
  secret := s;
  return next;
end $$;

-- Вход по паре ключ + секрет: { account, token } или null.
create or replace function @SCHEMA@.login_keysecret(p_key text, p_secret text) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  acc uuid;
begin
  select s.account into acc from @SCHEMA@.secret s
  where s.kind = 'KEYSECRET' and s.deleted_at is null
    and casefold(s.ident) collate pg_unicode_fast = casefold(p_key) collate pg_unicode_fast
    and s.material = sha256(convert_to(coalesce(p_secret, ''), 'UTF8'))
    and coalesce((s.meta->>'enabled')::boolean, true)
    and @SCHEMA@.auth_enabled(s.account);
  if acc is null then
    return null;
  end if;
  return jsonb_build_object('account', acc,
    'token', @SCHEMA@.new_session(acc, interval '7 days', jsonb_build_object('methods', jsonb_build_array('KEYSECRET'))));
end $$;

-- Одноразовый код для доставки сервисом (почта, SMS, сброс пароля): только с правом auth.otp.
-- Повторный выпуск на тот же идентификатор заменяет код: действует только последний.
create or replace function @SCHEMA@.auth_issue_otp(p_account uuid, p_ident text, p_kind text default 'OTP',
  p_ttl interval default interval '10 minutes', p_digits int default 6) returns text
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  code text;
begin
  perform @SCHEMA@.acl_require('auth.otp');
  if p_kind !~ '^OTP(_[A-Z0-9]{1,27})?$' or coalesce(p_ident, '') = '' or p_digits not between 4 and 10 then
    perform @SCHEMA@.lt_fail('invalid_data', 'код: вид OTP или OTP_<имя>, идентификатор, 4–10 знаков');
  end if;
  if not @SCHEMA@.auth_enabled(p_account) then
    perform @SCHEMA@.lt_fail('target_not_found', 'аккаунт не найден');
  end if;
  code := lpad((('x' || encode(@PGCRYPTO@.gen_random_bytes(7), 'hex'))::bit(56)::bigint % (10::bigint ^ p_digits)::bigint)::text, p_digits, '0');
  update @SCHEMA@.secret s set deleted_at = clock_timestamp()
  where s.kind = p_kind and s.deleted_at is null
    and casefold(s.ident) collate pg_unicode_fast = casefold(p_ident) collate pg_unicode_fast;
  insert into @SCHEMA@.secret (account, kind, ident, material, meta, expires_at)
  values (p_account, p_kind, p_ident, sha256(convert_to(code, 'UTF8')), jsonb_build_object('attempts', 0, 'confirmed', true),
          clock_timestamp() + p_ttl);
  return code;
end $$;

-- Вход по одноразовому коду: проверка атомарна (строка кода блокируется), учитывает срок и счётчик
-- попыток; успех сжигает код, перебор после p_max_attempts — тоже. { account, token } или null.
create or replace function @SCHEMA@.login_otp(p_ident text, p_code text, p_kind text default 'OTP', p_max_attempts int default 5)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  s record;
  n int;
begin
  select x.id, x.account, x.material, x.expires_at, coalesce((x.meta->>'attempts')::int, 0) as attempts into s
  from @SCHEMA@.secret x
  where x.kind = p_kind and x.kind ~ '^OTP' and x.deleted_at is null
    and casefold(x.ident) collate pg_unicode_fast = casefold(p_ident) collate pg_unicode_fast
  for update;
  if s.id is null then
    return null;
  end if;
  if s.expires_at <= clock_timestamp() then
    update @SCHEMA@.secret set deleted_at = clock_timestamp() where id = s.id;
    return null;
  end if;
  if s.material <> sha256(convert_to(coalesce(p_code, ''), 'UTF8')) then
    n := s.attempts + 1;
    if n >= coalesce(p_max_attempts, 5) then
      update @SCHEMA@.secret set deleted_at = clock_timestamp() where id = s.id;
    else
      update @SCHEMA@.secret set meta = meta || jsonb_build_object('attempts', n) where id = s.id;
    end if;
    return null;
  end if;
  update @SCHEMA@.secret set deleted_at = clock_timestamp() where id = s.id;
  if not @SCHEMA@.auth_enabled(s.account) then
    return null;
  end if;
  return jsonb_build_object('account', s.account,
    'token', @SCHEMA@.new_session(s.account, interval '7 days', jsonb_build_object('methods', jsonb_build_array(p_kind))));
end $$;

-- TOTP (RFC 6238): код шага — HOTP(секрет, шаг) на HMAC-SHA1, 6 знаков, шаг 30 секунд.
create or replace function @SCHEMA@.totp_code(p_secret bytea, p_step bigint) returns text
language plpgsql immutable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  h bytea := @PGCRYPTO@.hmac(int8send(p_step), p_secret, 'sha1');
  o int := get_byte(h, 19) & 15;
begin
  return lpad(((((get_byte(h, o) & 127)::bigint << 24) | (get_byte(h, o + 1)::bigint << 16)
                | (get_byte(h, o + 2)::bigint << 8) | get_byte(h, o + 3)::bigint) % 1000000)::text, 6, '0');
end $$;

-- Подключение TOTP: новый секрет (20 случайных байт) отдаётся один раз; фактор активирует первая
-- успешная проверка. Повторное подключение заменяет секрет и сбрасывает подтверждение.
create or replace function @SCHEMA@.auth_enroll_totp(p_account uuid) returns bytea
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  sec bytea := @PGCRYPTO@.gen_random_bytes(20);
begin
  perform @SCHEMA@.auth_can_manage(p_account);
  update @SCHEMA@.secret s set deleted_at = clock_timestamp()
  where s.account = p_account and s.kind = 'TOTP' and s.deleted_at is null;
  insert into @SCHEMA@.secret (account, kind, ident, material, meta)
  values (p_account, 'TOTP', p_account::text, sec, jsonb_build_object('confirmed', false, 'last_step', 0));
  return sec;
end $$;

-- Проверка кода TOTP в окне ±p_window шагов: повтор использованного шага отклоняется; первая удача
-- включает фактор. Проверяет сам аккаунт (тогда способ TOTP добавляется к текущей сессии) или
-- обладатель права auth.totp.
create or replace function @SCHEMA@.auth_verify_totp(p_account uuid, p_code text, p_window int default 1) returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  s record;
  now_step bigint := floor(extract(epoch from clock_timestamp()) / 30)::bigint;
  st bigint;
begin
  select * into c from @SCHEMA@.ctx();
  perform @SCHEMA@.auth_session_required(c.account);
  if not (c.account = p_account and c.service is null) then
    perform @SCHEMA@.acl_require('auth.totp');
  end if;
  select x.id, x.material, coalesce((x.meta->>'last_step')::bigint, 0) as last_step into s
  from @SCHEMA@.secret x
  where x.account = p_account and x.kind = 'TOTP' and x.deleted_at is null
  for update;
  if s.id is null then
    return false;
  end if;
  for st in now_step - greatest(coalesce(p_window, 1), 0) .. now_step + greatest(coalesce(p_window, 1), 0) loop
    continue when st <= s.last_step;
    if @SCHEMA@.totp_code(s.material, st) = coalesce(p_code, '') then
      update @SCHEMA@.secret set meta = meta || jsonb_build_object('last_step', st, 'confirmed', true) where id = s.id;
      if c.account = p_account and c.service is null then
        update @SCHEMA@.secret x
           set meta = x.meta || jsonb_build_object('methods', coalesce(x.meta->'methods', '[]'::jsonb) || '["TOTP"]'::jsonb,
                                                   'login_at', clock_timestamp())
         where x.id = c.session;
      end if;
      return true;
    end if;
  end loop;
  return false;
end $$;

create or replace function @SCHEMA@.auth_totp_enabled(p_account uuid) returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  select * into c from @SCHEMA@.ctx();
  perform @SCHEMA@.auth_session_required(c.account);
  if c.account <> p_account then
    perform @SCHEMA@.acl_require('auth.totp');
  end if;
  return exists (select 1 from @SCHEMA@.secret s where s.account = p_account and s.kind = 'TOTP' and s.deleted_at is null
                 and coalesce((s.meta->>'confirmed')::boolean, false));
end $$;

-- Внешняя identity (TELEGRAM, GOOGLE, SSO-провайдер): токен проверяет сервис, здесь — связка.
create or replace function @SCHEMA@.auth_link(p_account uuid, p_kind text, p_ident text, p_meta jsonb default '{}',
  p_confirmed boolean default false) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  cid uuid;
begin
  perform @SCHEMA@.auth_can_manage(p_account);
  if not @SCHEMA@.auth_kind_ok(p_kind) or p_kind = 'PASSWORD' or coalesce(p_ident, '') = '' then
    perform @SCHEMA@.lt_fail('invalid_data', 'identity: вид (TELEGRAM, GOOGLE, …) и идентификатор обязательны');
  end if;
  begin
    insert into @SCHEMA@.secret (account, kind, ident, meta)
    values (p_account, p_kind, p_ident, coalesce(p_meta, '{}'::jsonb) - 'confirmed' - 'enabled'
                                          || jsonb_build_object('confirmed', coalesce(p_confirmed, false)))
    returning id into cid;
  exception when unique_violation then
    perform @SCHEMA@.lt_fail('acl_denied', 'привязка отклонена: нужен недавний вход или право auth.credential');
  end;
  return cid;
end $$;

-- Поиск аккаунта по identity: только с правом auth.identity; неподтверждённая связка — только при
-- p_require_confirmed = false.
create or replace function @SCHEMA@.auth_lookup(p_kind text, p_ident text, p_require_confirmed boolean default true) returns uuid
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  acc uuid;
begin
  perform @SCHEMA@.acl_require('auth.identity');
  select s.account into acc from @SCHEMA@.secret s
  where s.kind = p_kind and s.deleted_at is null and @SCHEMA@.auth_kind_ok(s.kind)
    and casefold(s.ident) collate pg_unicode_fast = casefold(p_ident) collate pg_unicode_fast
    and coalesce((s.meta->>'enabled')::boolean, true)
    and (not coalesce(p_require_confirmed, true) or coalesce((s.meta->>'confirmed')::boolean, false))
    and @SCHEMA@.auth_enabled(s.account);
  return acc;
end $$;

-- Креды аккаунта без секретного материала: сам аккаунт или право auth.credential.
create or replace function @SCHEMA@.auth_credentials(p_account uuid)
returns table (id uuid, kind text, ident text, confirmed boolean, enabled boolean, meta jsonb, created_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_column
declare
  c record;
begin
  select * into c from @SCHEMA@.ctx();
  perform @SCHEMA@.auth_session_required(c.account);
  if c.account <> p_account then
    perform @SCHEMA@.acl_require('auth.credential');
  end if;
  return query
    select s.id, s.kind, case when s.kind = 'TOTP' then null else s.ident end,
           coalesce((s.meta->>'confirmed')::boolean, false), coalesce((s.meta->>'enabled')::boolean, true),
           s.meta - 'confirmed' - 'enabled' - 'attempts' - 'last_step', s.created_at, s.expires_at
    from @SCHEMA@.secret s
    where s.account = p_account and s.kind <> 'SESSION' and s.deleted_at is null
      and (s.expires_at is null or s.expires_at > clock_timestamp())
    order by s.created_at, s.id;
end $$;

-- Удаление креда: гасит остальные сессии аккаунта (текущую — если p_keep_current = false).
create or replace function @SCHEMA@.auth_revoke_credential(p_id uuid, p_keep_current boolean default true) returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  acc uuid;
begin
  select * into c from @SCHEMA@.ctx();
  perform @SCHEMA@.auth_session_required(c.account);
  select s.account into acc from @SCHEMA@.secret s where s.id = p_id and s.kind <> 'SESSION' and s.deleted_at is null;
  if acc is null then
    return false;
  end if;
  perform @SCHEMA@.auth_can_manage(acc);
  update @SCHEMA@.secret set deleted_at = clock_timestamp() where id = p_id;
  perform @SCHEMA@.auth_kill(acc, case when p_keep_current then c.session end);
  return true;
end $$;

-- Признаки confirmed и enabled креда: только с правом auth.credential.
create or replace function @SCHEMA@.auth_set_flags(p_id uuid, p_confirmed boolean default null, p_enabled boolean default null) returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  perform @SCHEMA@.acl_require('auth.credential');
  update @SCHEMA@.secret s
     set meta = s.meta || jsonb_strip_nulls(jsonb_build_object('confirmed', p_confirmed, 'enabled', p_enabled))
   where s.id = p_id and s.kind <> 'SESSION' and s.deleted_at is null;
  return found;
end $$;

-- Продление текущей сессии (библиотека — не чаще раза в минуту, §2.9). Новый срок — от сейчас.
create or replace function @SCHEMA@.auth_refresh(p_ttl interval default interval '7 days') returns timestamptz
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  e timestamptz;
begin
  select * into c from @SCHEMA@.ctx();
  perform @SCHEMA@.auth_session_required(c.account);
  update @SCHEMA@.secret s set expires_at = greatest(s.expires_at, clock_timestamp() + p_ttl)
  where s.id = c.session returning s.expires_at into e;
  return e;
end $$;

-- Выход: гасит текущую сессию.
create or replace function @SCHEMA@.auth_logout() returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  m bytea;
begin
  select * into c from @SCHEMA@.ctx();
  perform @SCHEMA@.auth_session_required(c.account);
  update @SCHEMA@.secret s set deleted_at = clock_timestamp() where s.id = c.session and s.deleted_at is null returning s.material into m;
  perform @SCHEMA@.signal(array['session:' || left(encode(m, 'hex'), 16)]);
  return m is not null;
end $$;

-- Выход везде: все сессии аккаунта (своего — сам; чужого — с правом auth.session).
create or replace function @SCHEMA@.auth_logout_all(p_account uuid default null) returns int
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  acc uuid;
begin
  select * into c from @SCHEMA@.ctx();
  perform @SCHEMA@.auth_session_required(c.account);
  acc := coalesce(p_account, c.account);
  if acc <> c.account or c.service is not null then
    perform @SCHEMA@.acl_require('auth.session');
  end if;
  return @SCHEMA@.auth_kill(acc, null);
end $$;

-- Переключение арендатора сессии (auth.switch): свой или по членству. Сессия ищется по токену
-- напрямую: прежний арендатор мог стать недоступным (выход из членства), и ctx() отказал бы.
create or replace function @SCHEMA@.auth_switch(p_tenant uuid) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  tok text := nullif(current_setting('letopis.token', true), '');
  s record;
begin
  if nullif(current_setting('letopis.account', true), '') is not null then
    perform @SCHEMA@.lt_fail('invalid_query', 'auth.switch — для собственной сессии, не при имперсонации');
  end if;
  select x.id, x.account into s from @SCHEMA@.secret x
  where x.kind = 'SESSION' and x.deleted_at is null and x.material = sha256(convert_to(coalesce(tok, ''), 'UTF8'))
    and (x.expires_at is null or x.expires_at > clock_timestamp())
  for update;
  if s.id is null or not @SCHEMA@.auth_enabled(s.account) then
    perform @SCHEMA@.lt_fail('no_session', 'нет действующей сессии');
  end if;
  if p_tenant <> s.account and not (
       exists (select 1 from @SCHEMA@.entity x
               where x.id = @SCHEMA@.v5_id(p_tenant, 'member', array[s.account::text, p_tenant::text]) and x.class = 'member' and x.tenant = p_tenant)
       and @SCHEMA@.auth_enabled(p_tenant)) then
    perform @SCHEMA@.lt_fail('tenant_denied', 'нет членства в арендаторе');
  end if;
  update @SCHEMA@.secret x
     set meta = case when p_tenant = s.account then x.meta - 'tenant' else x.meta || jsonb_build_object('tenant', p_tenant) end
   where x.id = s.id;
  return p_tenant;
end $$;

-- Арендаторы, доступные аккаунту сессии: собственный и по членству (с ролями).
create or replace function @SCHEMA@.auth_tenants() returns table (tenant uuid, roles jsonb)
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_column
declare
  c record;
begin
  select * into c from @SCHEMA@.ctx();
  perform @SCHEMA@.auth_session_required(c.account);
  return query
    select c.account, '["owner"]'::jsonb
    union all
    select m.tenant, coalesce(m.data->'roles', '[]'::jsonb)
    from @SCHEMA@.entity m
    where m.class = 'member' and m.links->>'User' = c.account::text and @SCHEMA@.auth_enabled(m.tenant);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'auth_recent()', 'auth_kind_ok(text)', 'auth_session_required(uuid)', 'auth_can_manage(uuid)', 'auth_target_ok(uuid)', 'auth_enabled(uuid)',
    'auth_kill(uuid, uuid)', 'issue_session(uuid, interval, text[])', 'auth_password_get(text, text)',
    'auth_set_password(uuid, text, text, text, boolean, boolean)', 'auth_issue_apikey(uuid, text, interval)',
    'auth_issue_keysecret(uuid, text)', 'auth_login_apikey(text)', 'login_keysecret(text, text)', 'auth_issue_otp(uuid, text, text, interval, int)',
    'login_otp(text, text, text, int)', 'totp_code(bytea, bigint)', 'auth_enroll_totp(uuid)', 'auth_verify_totp(uuid, text, int)',
    'auth_totp_enabled(uuid)', 'auth_link(uuid, text, text, jsonb, boolean)', 'auth_lookup(text, text, boolean)',
    'auth_credentials(uuid)', 'auth_revoke_credential(uuid, boolean)', 'auth_set_flags(uuid, boolean, boolean)',
    'auth_refresh(interval)', 'auth_logout()', 'auth_logout_all(uuid)', 'auth_switch(uuid)', 'auth_tenants()'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
-- до этапа 5 выпуск сессии сервисом принимал два аргумента
drop function if exists @SCHEMA@.issue_session(uuid, interval);
grant execute on function
  @SCHEMA@.issue_session(uuid, interval, text[]), @SCHEMA@.auth_password_get(text, text),
  @SCHEMA@.auth_set_password(uuid, text, text, text, boolean, boolean), @SCHEMA@.auth_issue_apikey(uuid, text, interval),
  @SCHEMA@.auth_issue_keysecret(uuid, text), @SCHEMA@.auth_login_apikey(text), @SCHEMA@.login_keysecret(text, text), @SCHEMA@.auth_issue_otp(uuid, text, text, interval, int),
  @SCHEMA@.login_otp(text, text, text, int), @SCHEMA@.auth_enroll_totp(uuid), @SCHEMA@.auth_verify_totp(uuid, text, int),
  @SCHEMA@.auth_totp_enabled(uuid), @SCHEMA@.auth_link(uuid, text, text, jsonb, boolean), @SCHEMA@.auth_lookup(text, text, boolean),
  @SCHEMA@.auth_credentials(uuid), @SCHEMA@.auth_revoke_credential(uuid, boolean), @SCHEMA@.auth_set_flags(uuid, boolean, boolean),
  @SCHEMA@.auth_refresh(interval), @SCHEMA@.auth_logout(), @SCHEMA@.auth_logout_all(uuid), @SCHEMA@.auth_switch(uuid),
  @SCHEMA@.auth_tenants() to @APP@;
