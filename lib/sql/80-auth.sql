-- letopis — креды (ключи), вход, сессии, приглашения, квартиры.
-- Всё лежит в secret; приложение не видит ни одной строки и работает только через эти функции. Виды записей:
--   IDENT (контакт аккаунта — он же имя для входа: `<вид>:<адрес>`, один аккаунт на контакт во всём доме; квартира —
--   System; ключом не является),
--   PASSWORD (пароль квартиры: имя для входа — контакт аккаунта; хэш scrypt считает и проверяет консьерж в Node),
--   APIKEY (lts_…, в базе sha256), KEYSECRET (пара ключ + секрет, в базе sha256 секрета),
--   OTP (одноразовый код входа на контакт: sha256, срок, счётчик попыток; квартира — System), OTP_CONTACT (код смены
--   контакта), TOTP (RFC 6238, HMAC-SHA1 из pgcrypto),
--   внешний вход (GOOGLE, TELEGRAM, …: связка без материала, токен провайдера проверяет консьерж),
--   INVITE (приглашение в квартиру: sha256 токена, контакт, роли, кто позвал), SESSION.
-- Токены приглашений и коды функции отдают консьержу (библиотеке), а он — только почтальону приложения.
-- Пароль, ключ API, ключ с секретом и внешний вход открывают ровно одну квартиру (secret.tenant); код входа доказывает
-- контакт, квартиру выбирает вход. Одинаковые пароли аккаунта в разных квартирах запрещает консьерж (scrypt в Node).
-- Кто что делает:
--   консьерж (категория Service) — проверяет ключи и открывает сессии жильцов (вход), заводит квартиры, зовёт, удаляет
--   аккаунты жильцов;
--   жилец — сам управляет своими ключами в той квартире, куда вошёл, после недавнего интерактивного входа;
--   матрица — кто из жильцов может выдать роль (ресурс ROLE: приглашение, правка и снятие прописки) и удалить
--   квартиру (действие tenant.delete).

-- Недавний вход: способы входа и время — в meta сессии.
create or replace function @SCHEMA@.auth_recent() returns interval
language sql immutable parallel safe
return interval '10 minutes';

-- Вид креда с идентификатором: заглавные буквы, цифры, подчёркивание; служебные виды — нет.
create or replace function @SCHEMA@.auth_kind_ok(p_kind text) returns boolean
language sql immutable parallel safe
return p_kind ~ '^[A-Z][A-Z0-9_]{1,31}$'
   and p_kind not in ('SESSION', 'APIKEY', 'KEYSECRET', 'TOTP', 'KEY', 'LOCK', 'INVITE', 'CONCIERGE', 'IDENT')
   and p_kind !~ '^OTP';

-- Действующая сессия обязательна (иначе no_session).
create or replace function @SCHEMA@.auth_session_required(p_account uuid) returns void
language plpgsql immutable
as $$
begin
  if p_account is null then
    perform @SCHEMA@.lt_fail('sql-access.no_session');
  end if;
end $$;

-- Актор — консьерж (не от имени жильца), иначе отказ.
create or replace function @SCHEMA@.auth_service_required() returns void
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  -- сессии нет вовсе (пропуск сменён setup({ rotate }), сессия погашена) — no_session: подключение обменяет ключ заново
  -- или откажет понятно, а не «только консьерж»
  if @SCHEMA@.ctx_account() is null then
    perform @SCHEMA@.lt_fail('sql-access.no_session');
  end if;
  if not @SCHEMA@.ctx_is_service() then
    perform @SCHEMA@.lt_fail('sql-access.not_service');
  end if;
end $$;

-- Актор — жилец сам (не консьерж и не консьерж от его имени) в квартире своей сессии; p_recent — ещё и недавний
-- интерактивный вход (не ключом API, не парой ключ + секрет и не принятием приглашения аккаунтом, который уже был:
-- ссылку можно переслать), а при включённом TOTP в этой квартире — с TOTP.
create or replace function @SCHEMA@.auth_self(p_recent boolean, out account uuid, out tenant uuid, out session uuid)
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_variable
declare
  c record;
  login_at timestamptz;
  methods jsonb;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('sql-access.no_session');
  end if;
  if c.service is not null or coalesce('Service' = any (c.categories), false) or c.tenant is null then
    perform @SCHEMA@.lt_fail('sql-access.resident_only');
  end if;
  if p_recent then
    select (s.meta->>'login_at')::timestamptz, coalesce(s.meta->'methods', '[]'::jsonb) into login_at, methods
    from @SCHEMA@.secret s where s.id = c.session;
    if not (login_at > clock_timestamp() - @SCHEMA@.auth_recent()
            and exists (select 1 from jsonb_array_elements_text(methods) m where m not in ('APIKEY', 'KEYSECRET', 'INVITE'))
            and (methods ? 'TOTP' or not exists (select 1 from @SCHEMA@.secret t
                                                  where t.account = c.account and t.tenant = c.tenant and t.kind = 'TOTP'
                                                    and t.deleted_at is null and coalesce((t.meta->>'confirmed')::boolean, false)))) then
      perform @SCHEMA@.lt_fail('sql-access.bind_denied');
    end if;
  end if;
  account := c.account;
  tenant := c.tenant;
  session := c.session;
end $$;

-- Аккаунт включён.
create or replace function @SCHEMA@.auth_enabled(p_account uuid) returns boolean
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return exists (select 1 from @SCHEMA@.entity a
               where a.id = p_account and a.class = 'Account' and a.tenant = '@SYSTEM@'::uuid
                 and coalesce((a.data->>'enabled')::boolean, true));

-- Имя для входа (вид и идентификатор) свободно для аккаунта p_account (null — нового): живой кред этого вида и
-- идентификатора у другого аккаунта — identifier_taken. Одно имя для входа — один аккаунт на весь дом. Блокировка имени —
-- до конца транзакции: два принятия приглашения или две смены пароля с одним новым именем не проходят обе.
create or replace function @SCHEMA@.auth_ident_free(p_kind text, p_ident text, p_account uuid) returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('@SCHEMA_NAME@:ident:' || p_kind || ':' || casefold(coalesce(p_ident, '')), 0));
  if exists (select 1 from @SCHEMA@.secret s
             where s.kind = p_kind and s.deleted_at is null and s.account is distinct from p_account
               and casefold(s.ident) collate pg_unicode_fast = casefold(p_ident) collate pg_unicode_fast) then
    perform @SCHEMA@.lt_fail('sql-access.identifier_taken');
  end if;
end $$;

-- ========================= контакт аккаунта (помощники) =========================
-- Контакт — адрес, куда почтальон приложения доставляет письма: email, телефон, Telegram, …. У аккаунта он один и он же
-- имя для входа: строка secret вида IDENT (квартира — System), ident `<вид>:<адрес>`, вид и адрес — в meta. Контакт — у
-- одного аккаунта во всём доме (уникальный индекс secret_kind_ident). Заводит его принятие приглашения (invite_accept),
-- меняет сам жилец кодом на новый контакт (contact_change, contact_confirm); удаление аккаунта стирает его каскадом.

-- Контакт → ident `<вид>:<адрес>` или null: вид — строчные латинские буквы, цифры, подчёркивание; адрес — непустая строка
-- до 320 знаков (крайние пробелы отбрасываются).
create or replace function @SCHEMA@.contact_ident(p_kind text, p_address text) returns text
language sql immutable parallel safe
return case when p_kind ~ '^[a-z][a-z0-9_]{0,31}$' and length(btrim(coalesce(p_address, ''))) between 1 and 320
            then p_kind || ':' || btrim(p_address) end;

-- Замок контакта до конца транзакции: приглашение, принятие, смена контакта и сверка пароля одного контакта идут по
-- очереди (тот же ключ, что у auth_ident_free('IDENT', …)).
create or replace function @SCHEMA@.contact_lock(p_ident text) returns void
language sql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  select pg_advisory_xact_lock(hashtextextended('@SCHEMA_NAME@:ident:IDENT:' || casefold(coalesce(p_ident, '')), 0))
$$;

-- Аккаунт, чей контакт — этот ident (без учёта регистра), или null.
create or replace function @SCHEMA@.ident_owner(p_ident text) returns uuid
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return (select s.account from @SCHEMA@.secret s
        where s.kind = 'IDENT' and s.tenant = '@SYSTEM@'::uuid and s.deleted_at is null
          and casefold(s.ident) collate pg_unicode_fast = casefold(p_ident) collate pg_unicode_fast);

-- Контакт аккаунта: ident (имя для входа) и { kind, address }.
create or replace function @SCHEMA@.contact_of(p_account uuid, out ident text, out contact jsonb)
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  select s.ident, jsonb_build_object('kind', s.meta->>'kind', 'address', s.meta->>'address')
  from @SCHEMA@.secret s
  where s.account = p_account and s.kind = 'IDENT' and s.tenant = '@SYSTEM@'::uuid and s.deleted_at is null
$$;

-- Контакт аккаунта жильца для консьержа (db.contactOf(аккаунт)): { kind, address } или null — нет такого аккаунта или у
-- него нет контакта (квартира, консьерж). Жильцу не выдаётся: чужих контактов он не узнаёт.
create or replace function @SCHEMA@.contact_get(p_account uuid) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  perform @SCHEMA@.auth_service_required();
  return (select k.contact from @SCHEMA@.contact_of(p_account) k);
end $$;

-- Включённые квартиры, где аккаунт прописан: [{ id, name }] по имени (по возрастанию; равные по сортировке — по id).
create or replace function @SCHEMA@.account_tenants(p_account uuid) returns jsonb
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.data->>'name') order by t.data->>'name', t.id), '[]'::jsonb)
        from @SCHEMA@.entity m
        join @SCHEMA@.entity t on t.id = m.tenant and t.class = 'Account' and t.tenant = '@SYSTEM@'::uuid
          and t.data->>'kind' = 'tenant' and coalesce((t.data->>'enabled')::boolean, true)
        where m.class = 'member' and m.ends @> array[p_account] and m.links->>'User' = p_account::text);

-- Имя квартиры — для письма почтальону.
create or replace function @SCHEMA@.tenant_name_of(p_tenant uuid) returns text
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return (select a.data->>'name' from @SCHEMA@.entity a where a.id = p_tenant and a.class = 'Account');

-- Погасить сессии аккаунта в квартире (null — во всех), кроме p_except; каждая погашенная — сигнал кэшу с началом хэша
-- токена.
create or replace function @SCHEMA@.auth_kill(p_account uuid, p_tenant uuid, p_except uuid) returns int
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  sig text[];
begin
  with k as (
    update @SCHEMA@.secret s set deleted_at = clock_timestamp()
    where s.account = p_account and s.kind = 'SESSION' and s.deleted_at is null and s.id is distinct from p_except
      and (p_tenant is null or s.tenant = p_tenant)
    returning s.material)
  select array_agg('session:' || left(encode(k.material, 'hex'), 16)) into sig from k;
  perform @SCHEMA@.signal_raw(sig);
  return coalesce(cardinality(sig), 0);
end $$;

-- Погасить сессии, открытые кредом p_cred (meta.cred), кроме p_except.
create or replace function @SCHEMA@.auth_kill_cred(p_account uuid, p_cred uuid, p_except uuid) returns int
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  sig text[];
begin
  with k as (
    update @SCHEMA@.secret s set deleted_at = clock_timestamp()
    where s.account = p_account and s.kind = 'SESSION' and s.deleted_at is null and s.id is distinct from p_except
      and s.meta->>'cred' = p_cred::text
    returning s.material)
  select array_agg('session:' || left(encode(k.material, 'hex'), 16)) into sig from k;
  perform @SCHEMA@.signal_raw(sig);
  return coalesce(cardinality(sig), 0);
end $$;

-- ========================= TOTP =========================

-- Код шага — HOTP(секрет, шаг) на HMAC-SHA1, 6 знаков, шаг 30 секунд.
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

-- Проверка кода TOTP аккаунта в квартире в окне ±1 шаг: повтор использованного шага отклоняется; первая удача включает
-- фактор; после пяти неудач подряд проверка закрыта на 5 минут. null — у аккаунта в этой квартире нет TOTP.
create or replace function @SCHEMA@.auth_totp_check(p_account uuid, p_tenant uuid, p_code text, p_confirmed_only boolean) returns boolean
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  s record;
  now_step bigint := floor(extract(epoch from clock_timestamp()) / 30)::bigint;
  st bigint;
begin
  select x.id, x.material, coalesce((x.meta->>'last_step')::bigint, 0) as last_step,
         coalesce((x.meta->>'fails')::int, 0) as fails, (x.meta->>'locked_until')::timestamptz as locked_until into s
  from @SCHEMA@.secret x
  where x.account = p_account and x.tenant = p_tenant and x.kind = 'TOTP' and x.deleted_at is null
    and (not p_confirmed_only or coalesce((x.meta->>'confirmed')::boolean, false))
  for update;
  if s.id is null then
    return null;
  end if;
  if s.locked_until > clock_timestamp() then
    return false;
  end if;
  for st in now_step - 1 .. now_step + 1 loop
    continue when st <= s.last_step;
    if @SCHEMA@.totp_code(s.material, st) = coalesce(p_code, '') then
      update @SCHEMA@.secret set meta = (meta - 'fails' - 'locked_until') || jsonb_build_object('last_step', st, 'confirmed', true) where id = s.id;
      return true;
    end if;
  end loop;
  update @SCHEMA@.secret set meta = meta || jsonb_build_object('fails', s.fails + 1)
    || case when s.fails + 1 >= 5 then jsonb_build_object('fails', 0, 'locked_until', clock_timestamp() + interval '5 minutes') else '{}'::jsonb end
  where id = s.id;
  return false;
end $$;

-- ========================= вход (только консьерж) =========================

-- Хэши паролей контакта (имя для входа — `<вид>:<адрес>`) во всех квартирах — для проверки консьержем (scrypt в Node):
-- пароль сам выбирает квартиру.
create or replace function @SCHEMA@.auth_password_get(p_kind text, p_address text)
returns table (cred uuid, account uuid, tenant uuid, hash text)
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_column
declare
  v_ident text := @SCHEMA@.contact_ident(p_kind, p_address);
begin
  perform @SCHEMA@.auth_service_required();
  if v_ident is null then
    return;
  end if;
  return query
    select s.id, s.account, s.tenant, convert_from(s.material, 'UTF8')
    from @SCHEMA@.secret s
    where s.kind = 'PASSWORD' and s.deleted_at is null and s.material is not null
      and casefold(s.ident) collate pg_unicode_fast = casefold(v_ident) collate pg_unicode_fast
      and coalesce((s.meta->>'enabled')::boolean, true)
      and @SCHEMA@.auth_enabled(s.account)
    order by s.created_at;
end $$;

-- Сессия по креду (пароль после проверки scrypt, внешний вход): кред жив, аккаунт включён и прописан в квартире креда.
-- Включённый в этой квартире TOTP требует верного кода; код без TOTP или неверный — null.
-- Сессия по креду: { token }; кред верен, а TOTP включён и код не передан — { totp: true } (вход повторяют с кодом);
-- неверный код TOTP, выключенный аккаунт, выписка — null.
create or replace function @SCHEMA@.auth_login_cred(p_cred uuid, p_ttl interval, p_totp text) returns jsonb
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  k record;
  t boolean;
  methods jsonb;
begin
  select s.id, s.account, s.tenant, s.kind into k from @SCHEMA@.secret s
  where s.id = p_cred and s.deleted_at is null and coalesce((s.meta->>'enabled')::boolean, true)
    and s.kind not in ('SESSION', 'INVITE', 'TOTP', 'KEY', 'LOCK', 'CONCIERGE', 'IDENT') and s.kind !~ '^OTP'
  for share;
  if k.id is null or not @SCHEMA@.auth_enabled(k.account) or @SCHEMA@.member_row(k.account, k.tenant) is null
     or not @SCHEMA@.tenant_ok(k.tenant) then
    return null;
  end if;
  methods := jsonb_build_array(k.kind);
  if p_totp is not null or @SCHEMA@.auth_totp_on(k.account, k.tenant) then
    if p_totp is null then
      return jsonb_build_object('totp', true);
    end if;
    t := @SCHEMA@.auth_totp_check(k.account, k.tenant, p_totp, true);
    if t is not true then
      return null;
    end if;
    methods := methods || '["TOTP"]'::jsonb;
  end if;
  return jsonb_build_object('token', @SCHEMA@.new_session(k.account, k.tenant, p_ttl, jsonb_build_object('methods', methods, 'cred', k.id)));
end $$;

-- Второй фактор включён у аккаунта в квартире: подтверждённый TOTP.
create or replace function @SCHEMA@.auth_totp_on(p_account uuid, p_tenant uuid) returns boolean
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return exists (select 1 from @SCHEMA@.secret x where x.account = p_account and x.tenant = p_tenant
               and x.kind = 'TOTP' and x.deleted_at is null and coalesce((x.meta->>'confirmed')::boolean, false));

-- Вход по паролю после проверки консьержем: кред, который он сверил scrypt. { account, tenant, token } или null.
create or replace function @SCHEMA@.login_cred(p_cred uuid, p_ttl interval default interval '7 days', p_totp text default null) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  r jsonb;
  k record;
begin
  perform @SCHEMA@.auth_service_required();
  select s.account, s.tenant into k from @SCHEMA@.secret s where s.id = p_cred and s.material is not null;
  if k.account is null then
    return null;
  end if;
  r := @SCHEMA@.auth_login_cred(p_cred, p_ttl, p_totp);
  if r is null or r ? 'totp' then
    return r;
  end if;
  return jsonb_build_object('account', k.account, 'tenant', k.tenant, 'token', r->>'token');
end $$;

-- Вход через внешний сервис (Google, Telegram, …): токен провайдера консьерж уже проверил. { account, tenant, token }
-- или null. Вид PASSWORD и служебные виды внешним входом не открываются: пароль без пароля не войдёт.
create or replace function @SCHEMA@.login_identity(p_kind text, p_ident text, p_ttl interval default interval '7 days',
  p_totp text default null) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  k record;
  r jsonb;
begin
  perform @SCHEMA@.auth_service_required();
  select s.id, s.account, s.tenant into k from @SCHEMA@.secret s
  where s.kind = p_kind and s.deleted_at is null and s.material is null and @SCHEMA@.auth_kind_ok(s.kind)
    and s.kind <> 'PASSWORD'
    and casefold(s.ident) collate pg_unicode_fast = casefold(p_ident) collate pg_unicode_fast;
  if k.id is null then
    return null;
  end if;
  r := @SCHEMA@.auth_login_cred(k.id, p_ttl, p_totp);
  if r is null or r ? 'totp' then
    return r;
  end if;
  return jsonb_build_object('account', k.account, 'tenant', k.tenant, 'token', r->>'token');
end $$;

-- Вход по паре ключ + секрет. { account, tenant, token } или null.
create or replace function @SCHEMA@.login_keysecret(p_key text, p_secret text, p_ttl interval default interval '7 days') returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  k record;
begin
  perform @SCHEMA@.auth_service_required();
  select s.id, s.account, s.tenant into k from @SCHEMA@.secret s
  where s.kind = 'KEYSECRET' and s.deleted_at is null
    and casefold(s.ident) collate pg_unicode_fast = casefold(coalesce(p_key, '')) collate pg_unicode_fast
    and s.material = sha256(convert_to(coalesce(p_secret, ''), 'UTF8'))
    and coalesce((s.meta->>'enabled')::boolean, true)
  -- строка ключа — под блокировкой до фиксации входа: отзыв ждёт её и гасит открытую здесь сессию
  for share of s;
  if k.id is null or not @SCHEMA@.auth_enabled(k.account) or @SCHEMA@.member_row(k.account, k.tenant) is null
     or not @SCHEMA@.tenant_ok(k.tenant) then
    return null;
  end if;
  return jsonb_build_object('account', k.account, 'tenant', k.tenant,
    'token', @SCHEMA@.new_session(k.account, k.tenant, p_ttl, jsonb_build_object('methods', jsonb_build_array('KEYSECRET'), 'cred', k.id)));
end $$;

-- Вход по ключу API жильца (у консьержа — login_apikey без сессии). { account, tenant, token } или null.
create or replace function @SCHEMA@.login_apikey_for(p_key text, p_ttl interval default interval '7 days') returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  tok text;
  k record;
begin
  perform @SCHEMA@.auth_service_required();
  tok := @SCHEMA@.login_apikey(p_key, p_ttl);
  if tok is null then
    return null;
  end if;
  select s.account, s.tenant into k from @SCHEMA@.secret s
  where s.kind = 'SESSION' and s.material = sha256(convert_to(tok, 'UTF8'));
  if k.tenant = '@SYSTEM@'::uuid then
    -- ключ консьержа жильцом не открывается
    update @SCHEMA@.secret set deleted_at = clock_timestamp() where kind = 'SESSION' and material = sha256(convert_to(tok, 'UTF8'));
    return null;
  end if;
  return jsonb_build_object('account', k.account, 'tenant', k.tenant, 'token', tok);
end $$;

-- ========================= одноразовые коды =========================

-- Проверка одноразового кода вида p_kind (OTP, OTP_CONTACT) с идентификатором p_ident: атомарна (строки кодов
-- блокируются), учитывает срок и счётчик попыток. Совпал — id строки кода и аккаунт (код при этом не гаснет: его гасит
-- тот, кто довёл дело до конца); не совпал — попытка засчитана, исчерпанные попытки и истёкший срок гасят код.
-- Счётчик транзакционный: коды проверяют только функции входа и смены контакта, отказ они отдают ответом, а не ошибкой.
create or replace function @SCHEMA@.code_check(p_kind text, p_ident text, p_code text, out id uuid, out account uuid)
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_variable
declare
  s record;
begin
  for s in select x.id, x.account, x.material, x.expires_at, coalesce((x.meta->>'attempts')::int, 0) as attempts,
                  coalesce((x.meta->>'max_attempts')::int, 5) as max_attempts
           from @SCHEMA@.secret x
           where x.kind = p_kind and x.tenant = '@SYSTEM@'::uuid and x.deleted_at is null
             and casefold(x.ident) collate pg_unicode_fast = casefold(p_ident) collate pg_unicode_fast
           order by x.id
           for update loop
    if s.expires_at <= clock_timestamp() then
      update @SCHEMA@.secret x set deleted_at = clock_timestamp() where x.id = s.id;
    elsif s.material = sha256(convert_to(coalesce(p_code, ''), 'UTF8')) and id is null then
      id := s.id;
      account := s.account;
    elsif s.attempts + 1 >= s.max_attempts then
      update @SCHEMA@.secret x set deleted_at = clock_timestamp() where x.id = s.id;
    else
      update @SCHEMA@.secret x set meta = x.meta || jsonb_build_object('attempts', s.attempts + 1) where x.id = s.id;
    end if;
  end loop;
end $$;

-- Случайный код из p_digits цифр.
create or replace function @SCHEMA@.code_new(p_digits int) returns text
language sql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
return lpad((('x' || encode(@PGCRYPTO@.gen_random_bytes(7), 'hex'))::bit(56)::bigint % (10::bigint ^ p_digits)::bigint)::text, p_digits, '0');

-- Код входа на контакт (db.requestCode): выдаёт консьерж, письмо доставляет почтальон приложения (код библиотека отдаёт
-- только ему). Код доказывает контакт, а не открывает одну квартиру: квартиру выбирает вход (login_code). Повторный
-- выпуск заменяет код: действует только последний. Контакта нет в доме, аккаунт выключен или нигде не прописан — тот же
-- ответ без кода, { expiresAt }: по ответу не узнать, есть ли такой жилец. Иначе — { code, expiresAt, to }.
create or replace function @SCHEMA@.code_issue(p_kind text, p_address text,
  p_ttl interval default interval '10 minutes', p_digits int default 6, p_max_attempts int default 5) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  code text;
  v_ident text := @SCHEMA@.contact_ident(p_kind, p_address);
  acc uuid;
  exp timestamptz := clock_timestamp() + coalesce(p_ttl, interval '10 minutes');
begin
  perform @SCHEMA@.auth_service_required();
  if v_ident is null then
    perform @SCHEMA@.lt_fail('sql-access.contact_args');
  end if;
  if p_digits is null or p_digits not between 4 and 10 or p_max_attempts is null or p_max_attempts not between 1 and 10 then
    perform @SCHEMA@.lt_fail('sql-access.otp_args');
  end if;
  acc := @SCHEMA@.ident_owner(v_ident);
  if acc is null or not @SCHEMA@.auth_enabled(acc) or @SCHEMA@.account_tenants(acc) = '[]'::jsonb then
    return jsonb_build_object('expiresAt', exp);
  end if;
  code := @SCHEMA@.code_new(p_digits);
  update @SCHEMA@.secret s set deleted_at = clock_timestamp()
  where s.kind = 'OTP' and s.tenant = '@SYSTEM@'::uuid and s.deleted_at is null
    and casefold(s.ident) collate pg_unicode_fast = casefold(v_ident) collate pg_unicode_fast;
  insert into @SCHEMA@.secret (account, tenant, kind, ident, material, meta, expires_at)
  values (acc, '@SYSTEM@'::uuid, 'OTP', v_ident, sha256(convert_to(code, 'UTF8')),
          jsonb_build_object('attempts', 0, 'max_attempts', p_max_attempts), exp);
  return jsonb_build_object('code', code, 'expiresAt', exp, 'to', jsonb_build_object('kind', p_kind, 'address', btrim(p_address)));
end $$;

-- Квартиры контакта по коду входа (db.tenantsOf): [{ id, name }]; код не гаснет. Неверный код — null (попытка
-- засчитана).
create or replace function @SCHEMA@.code_tenants(p_kind text, p_address text, p_code text) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  h record;
begin
  perform @SCHEMA@.auth_service_required();
  select * into h from @SCHEMA@.code_check('OTP', @SCHEMA@.contact_ident(p_kind, p_address), p_code);
  if h.id is null or not @SCHEMA@.auth_enabled(h.account) then
    return null;
  end if;
  return @SCHEMA@.account_tenants(h.account);
end $$;

-- Вход по коду на контакт: код верен (code_check) — квартира p_tenant, а без неё — единственная квартира аккаунта.
-- Квартир несколько, а p_tenant не задан — { tenants: [{ id, name }] } (код не гаснет: вход повторяют с квартирой).
-- Включённый в квартире TOTP требует кода приложения: без него — { totp: true } (код письма не гаснет). Успех гасит
-- код. { account, tenant, token } или null — код не подошёл, аккаунт выключен, в квартире p_tenant он не прописан.
create or replace function @SCHEMA@.login_code(p_kind text, p_address text, p_code text, p_tenant uuid default null,
  p_ttl interval default interval '7 days', p_totp text default null) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  h record;
  ts jsonb;
  t uuid;
  methods jsonb := '["OTP"]'::jsonb;
begin
  perform @SCHEMA@.auth_service_required();
  select * into h from @SCHEMA@.code_check('OTP', @SCHEMA@.contact_ident(p_kind, p_address), p_code);
  if h.id is null then
    return null;
  end if;
  ts := @SCHEMA@.account_tenants(h.account);
  if not @SCHEMA@.auth_enabled(h.account) or ts = '[]'::jsonb then
    update @SCHEMA@.secret set deleted_at = clock_timestamp() where id = h.id;
    return null;
  end if;
  if p_tenant is null then
    if jsonb_array_length(ts) > 1 then
      return jsonb_build_object('tenants', ts);
    end if;
    t := (ts->0->>'id')::uuid;
  elsif ts @> jsonb_build_array(jsonb_build_object('id', p_tenant)) then
    t := p_tenant;
  else
    return null;
  end if;
  -- второй фактор — как у входа по паролю
  if p_totp is not null or @SCHEMA@.auth_totp_on(h.account, t) then
    if p_totp is null then
      return jsonb_build_object('totp', true);
    end if;
    if @SCHEMA@.auth_totp_check(h.account, t, p_totp, true) is not true then
      return null;
    end if;
    methods := methods || '["TOTP"]'::jsonb;
  end if;
  update @SCHEMA@.secret set deleted_at = clock_timestamp() where id = h.id;
  return jsonb_build_object('account', h.account, 'tenant', t,
    'token', @SCHEMA@.new_session(h.account, t, p_ttl, jsonb_build_object('methods', methods)));
end $$;

-- Сессия корня квартиры жива — иначе no_session: погашенная сессия (выписка, выход, смена пароля) отвечает отказом, а
-- не пустым чтением под RLS. Библиотека зовёт её первым оператором каждой транзакции корня жильца.
create or replace function @SCHEMA@.session_required() returns void
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  tok text := nullif(current_setting('letopis.token', true), '');
begin
  if tok is null or not exists (select 1 from @SCHEMA@.secret x
                                where x.kind = 'SESSION' and x.deleted_at is null and x.material = sha256(convert_to(tok, 'UTF8'))
                                  and (x.expires_at is null or x.expires_at > clock_timestamp())) then
    perform @SCHEMA@.lt_fail('sql-access.no_session');
  end if;
end $$;

-- Кто вошёл по токену этой сессии: { account, tenant, tenantName, methods, expiresAt } или null — неверный, погашенный
-- или истёкший токен, аккаунт отключён, прописки уже нет. Исполняется под самим токеном (db.resume).
create or replace function @SCHEMA@.session_whoami() returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  s record;
begin
  begin
    select * into c from @SCHEMA@.ctx();
  exception when others then
    return null;
  end;
  if c.account is null then
    return null;
  end if;
  select x.meta, x.expires_at into s from @SCHEMA@.secret x where x.id = c.session;
  return jsonb_build_object('account', c.account, 'tenant', c.tenant,
    'tenantName', (select a.data->>'name' from @SCHEMA@.entity a where a.id = c.tenant and a.class = 'Account'),
    'service', coalesce('Service' = any (c.categories), false),
    'methods', coalesce(s.meta->'methods', '[]'::jsonb), 'expiresAt', s.expires_at, 'loginAt', s.meta->'login_at');
end $$;

-- ========================= квартиры (консьерж) =========================

-- Новая квартира: строка Account в System (kind = 'tenant') и её правила: консьержу — полный доступ (вес 1 000 000),
-- роли owner — полный доступ и право на любые роли (вес 100 000). Оба — с признаком concierge и владельцем-консьержем:
-- вес правила жильца — не больше 999, его запрет правило owner не перебьёт и жилец эти правила не снимет. Имя уникально
-- в доме без учёта регистра («Мир» и «мир» — одна квартира; держит индекс entity_tenant_name): занято — exists с именем
-- занявшей квартиры.
create or replace function @SCHEMA@.tenant_create(p_name text) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  t uuid;
  g_owner uuid;
  op text;
  o uuid;
  taken text;
begin
  perform @SCHEMA@.auth_service_required();
  select * into c from @SCHEMA@.ctx();
  if p_name is null or btrim(p_name) = '' or p_name <> btrim(p_name) or char_length(p_name) > 200 then
    perform @SCHEMA@.lt_fail('sql-access.tenant_name', jsonb_build_object('name', coalesce(p_name, 'null')));
  end if;
  select a.data->>'name' into taken from @SCHEMA@.entity a
  where a.class = 'Account' and a.data->>'kind' = 'tenant'
    and casefold(a.data->>'name') collate pg_unicode_fast = casefold(p_name) collate pg_unicode_fast
  limit 1;
  if taken is not null then
    perform @SCHEMA@.lt_fail('sql-access.tenant_exists', jsonb_build_object('name', taken));
  end if;
  t := @SCHEMA@.uuid_v5('@SYSTEM@'::uuid, @SCHEMA@.v5_name('Account', array[gen_random_uuid()::text]));
  begin
    perform @SCHEMA@.sys_create(t, 'Account', '@SYSTEM@'::uuid, '{}',
      jsonb_build_object('name', p_name, 'categories', '[]'::jsonb, 'enabled', true, 'kind', 'tenant'));
  exception when unique_violation then
    perform @SCHEMA@.lt_fail('sql-access.tenant_exists', jsonb_build_object('name', p_name));
  end;
  g_owner := @SCHEMA@.sys_resource(t, 'role:owner:ACCOUNT', 'ACCOUNT', '{"roles": "{owner}"}');
  foreach op in array array['READ', 'WRITE', 'DELETE', 'API', 'ROLE'] loop
    o := @SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Resource', array[case when op = 'API' then 'any:API' else 'all:' || op end]);
    perform @SCHEMA@.sys_rule(t, @SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Resource', array['service:ACCOUNT']), o, 'allow', 1000000,
      '{"concierge": true}', c.account);
    perform @SCHEMA@.sys_rule(t, g_owner, o, 'allow', 100000, '{"concierge": true}', c.account);
  end loop;
  return jsonb_build_object('id', t, 'name', p_name);
end $$;

-- Квартиры дома: { id, name } по имени (по возрастанию; равные по сортировке — по id).
create or replace function @SCHEMA@.tenant_list() returns table (id uuid, name text)
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_column
begin
  perform @SCHEMA@.auth_service_required();
  return query select a.id, a.data->>'name' from @SCHEMA@.entity a
    where a.class = 'Account' and a.tenant = '@SYSTEM@'::uuid and a.data->>'kind' = 'tenant'
    order by a.data->>'name', a.id;
end $$;

-- Удаление квартиры, в которой работает актор: консьерж — всегда, жилец — по матрице (действие tenant.delete). Вещи и
-- журнал квартиры стираются физически, креды, сессии и приглашения её — тоже; аккаунты жильцов остаются. Строка квартиры
-- удаляется раньше её прописок: проверка last_owner (trg_member_owner) квартиру без строки не проверяет.
create or replace function @SCHEMA@.tenant_delete() returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  a @SCHEMA@.entity;
  t uuid;
  n_rows int;
  classes text[];
  sig text[];
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null or c.tenant is null then
    perform @SCHEMA@.lt_fail('sql-access.no_session');
  end if;
  t := c.tenant;
  if not (c.service is null and coalesce('Service' = any (c.categories), false))
     and not coalesce((@SCHEMA@.acl_api_for(t, c.categories, c.roles, 'tenant.delete', false)->>'allow')::boolean, false) then
    perform @SCHEMA@.lt_fail('sql-access.no_right', jsonb_build_object('endpoint', 'tenant.delete'));
  end if;
  select x.* into a from @SCHEMA@.entity x where x.id = t and x.class = 'Account' for update;
  select coalesce(array_agg(distinct x.class), '{}') into classes from @SCHEMA@.entity x where x.tenant = t;
  with k as (
    delete from @SCHEMA@.secret s where s.tenant = t and s.kind = 'SESSION' and s.deleted_at is null returning s.material)
  select array_agg('session:' || left(encode(k.material, 'hex'), 16)) into sig from k;
  delete from @SCHEMA@.secret s where s.tenant = t;
  delete from @SCHEMA@.entity x where x.id = t;
  with d as (delete from @SCHEMA@.entity x where x.tenant = t returning 1) select count(*)::int into n_rows from d;
  delete from @SCHEMA@.log x where x.tenant = t;
  perform @SCHEMA@.tombstone_by(a, c.author, c.agent);
  perform @SCHEMA@.signal_raw(sig);
  perform @SCHEMA@.signal(classes || array['Account', 'member'],
    array(select t from unnest(classes)) || array['@SYSTEM@'::uuid, '@SYSTEM@'::uuid]);
  perform @SCHEMA@.acl_bump();
  return jsonb_build_object('tenant', t, 'rows', n_rows);
end $$;

-- ========================= приглашения =========================
-- Приглашение — строка INVITE квартиры: ident — контакт, material — sha256 токена (сам токен знает только почтальон),
-- meta { contact, roles, by — кто позвал (у консьержа нет), attempts, status, reason }. Погашенное приглашение
-- (deleted_at; status: used — принято, revoked — отменено, заменено новым, звавший потерял право или исчерпаны
-- попытки) хранится до своего срока: его статус видит тот, у кого ссылка (invite_view); затем его убирает maintain().

-- Роли прописки: массив строк — имён, а не масок ('{a,b}', '!a', запятые, крайние пробелы — отказ).
create or replace function @SCHEMA@.auth_roles_ok(p_roles jsonb) returns boolean
language sql immutable parallel safe
return jsonb_typeof(p_roles) = 'array'
   and not exists (select 1 from jsonb_array_elements(p_roles) r
                   where jsonb_typeof(r) <> 'string' or r #>> '{}' = '' or r #>> '{}' <> btrim(r #>> '{}')
                      or r #>> '{}' ~ '[,{}]' or left(r #>> '{}', 1) = '!')
   and (select count(*) from jsonb_array_elements_text(p_roles)) = (select count(distinct x) from jsonb_array_elements_text(p_roles) x);

-- Может ли субъект выдать роли p_want (массив имён) в квартире: null — да; иначе первая роль, на которую права нет;
-- пустая строка — список ролей пуст, а права на все роли (правило на ROLE без имени роли) нет.
create or replace function @SCHEMA@.role_grant_denied(p_tenant uuid, p_cats text[], p_roles text[], p_want jsonb) returns text
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  r text;
begin
  if coalesce(jsonb_array_length(p_want), 0) = 0 then
    return case when coalesce((@SCHEMA@.acl_role_for(p_tenant, p_cats, p_roles, null)->>'allow')::boolean, false) then null else '' end;
  end if;
  for r in select x from jsonb_array_elements_text(p_want) x loop
    if not coalesce((@SCHEMA@.acl_role_for(p_tenant, p_cats, p_roles, r)->>'allow')::boolean, false) then
      return r;
    end if;
  end loop;
  return null;
end $$;

-- То же для аккаунта p_account по его нынешним категориям и ролям в квартире; не прописан, выключен, нет такого —
-- отказ (пустая строка).
create or replace function @SCHEMA@.role_grant_denied_by(p_tenant uuid, p_account uuid, p_want jsonb) returns text
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  a jsonb;
  m jsonb;
begin
  select e.data into a from @SCHEMA@.entity e
  where e.id = p_account and e.class = 'Account' and e.tenant = '@SYSTEM@'::uuid and coalesce((e.data->>'enabled')::boolean, true);
  m := @SCHEMA@.member_row(p_account, p_tenant);
  if a is null or m is null then
    return '';
  end if;
  return @SCHEMA@.role_grant_denied(p_tenant,
    array(select jsonb_array_elements_text(coalesce(a->'categories', '[]'::jsonb))),
    array(select jsonb_array_elements_text(coalesce(m->'roles', '[]'::jsonb))), p_want);
end $$;

-- Кто позвал — для письма и списков: { account, name }; консьерж (p_by null) — null.
create or replace function @SCHEMA@.invite_from(p_by uuid) returns jsonb
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return (select jsonb_build_object('account', a.id, 'name', a.data->>'name') from @SCHEMA@.entity a
        where a.id = p_by and a.class = 'Account' and a.tenant = '@SYSTEM@'::uuid);

-- Статус приглашения: active | expired | revoked | used.
create or replace function @SCHEMA@.invite_status(p_deleted timestamptz, p_expires timestamptz, p_meta jsonb, p_tenant uuid) returns text
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return case when p_deleted is not null then coalesce(p_meta->>'status', 'revoked')
            when p_expires <= clock_timestamp() then 'expired'
            when not @SCHEMA@.tenant_ok(p_tenant) then 'revoked'
            else 'active' end;

-- Позвать в квартиру актора по контакту (me.invite): консьерж — всегда; жилец (и консьерж от его имени) — если матрица
-- разрешает ему выдать каждую роль приглашения (ресурс ROLE; без ролей — право на все роли). Контакт уже прописан в
-- квартире — already_member. Прежнее живое приглашение этого контакта в квартиру гаснет. Токен — 24 случайных байта
-- (48 шестнадцатеричных знаков), в базе sha256. Ответ — письмо почтальону (токен библиотека отдаёт только ему):
-- { id, token, expiresAt, tenant, tenantName, roles, to, from? }.
create or replace function @SCHEMA@.invite_create(p_kind text, p_address text, p_roles jsonb, p_ttl interval default interval '7 days')
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  svc boolean;
  token text := encode(@PGCRYPTO@.gen_random_bytes(24), 'hex');
  v_ident text := @SCHEMA@.contact_ident(p_kind, p_address);
  v_roles jsonb := coalesce(p_roles, '[]'::jsonb);
  contact jsonb;
  acc uuid;
  bad text;
  iid uuid;
  exp timestamptz := clock_timestamp() + coalesce(p_ttl, interval '7 days');
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null or c.tenant is null then
    perform @SCHEMA@.lt_fail('sql-access.no_session');
  end if;
  if v_ident is null then
    perform @SCHEMA@.lt_fail('sql-access.contact_args');
  end if;
  if not @SCHEMA@.auth_roles_ok(v_roles) then
    perform @SCHEMA@.lt_fail('sql-access.roles_args');
  end if;
  svc := c.service is null and coalesce('Service' = any (c.categories), false);
  if not svc then
    bad := @SCHEMA@.role_grant_denied(c.tenant, c.categories, c.roles, v_roles);
    if bad = '' then
      perform @SCHEMA@.lt_fail('sql-access.invite_denied');
    elsif bad is not null then
      perform @SCHEMA@.lt_fail('sql-access.role_denied', jsonb_build_object('role', bad));
    end if;
  end if;
  perform @SCHEMA@.contact_lock(v_ident);
  acc := @SCHEMA@.ident_owner(v_ident);
  if acc is not null and @SCHEMA@.member_row(acc, c.tenant) is not null then
    perform @SCHEMA@.lt_fail('sql-access.already_member');
  end if;
  contact := jsonb_build_object('kind', p_kind, 'address', btrim(p_address));
  update @SCHEMA@.secret s
     set deleted_at = clock_timestamp(), meta = s.meta || '{"status": "revoked", "reason": "replaced"}'::jsonb
  where s.kind = 'INVITE' and s.tenant = c.tenant and s.deleted_at is null
    and casefold(s.ident) collate pg_unicode_fast = casefold(v_ident) collate pg_unicode_fast;
  insert into @SCHEMA@.secret (account, tenant, kind, ident, material, meta, expires_at)
  values (c.tenant, c.tenant, 'INVITE', v_ident, sha256(convert_to(token, 'UTF8')),
          jsonb_strip_nulls(jsonb_build_object('contact', contact, 'roles', v_roles, 'by', case when svc then null else c.account end,
                                               'attempts', 0)), exp)
  returning id into iid;
  return jsonb_strip_nulls(jsonb_build_object('id', iid, 'token', token, 'expiresAt', exp, 'tenant', c.tenant,
    'tenantName', @SCHEMA@.tenant_name_of(c.tenant), 'roles', v_roles, 'to', contact,
    'from', case when svc then null else @SCHEMA@.invite_from(c.account) end));
end $$;

-- Живые приглашения квартиры актора: [{ id, to, roles, from?, expiresAt }]. Консьерж видит все; жилец — свои и те,
-- чьи роли матрица разрешает ему выдать (приглашение без ролей — право на все роли). Токена в ответе нет.
create or replace function @SCHEMA@.invite_list() returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  svc boolean;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null or c.tenant is null then
    perform @SCHEMA@.lt_fail('sql-access.no_session');
  end if;
  svc := c.service is null and coalesce('Service' = any (c.categories), false);
  return (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', s.id, 'to', s.meta->'contact',
              'roles', coalesce(s.meta->'roles', '[]'::jsonb), 'from', @SCHEMA@.invite_from((s.meta->>'by')::uuid),
              'expiresAt', s.expires_at)) order by s.created_at, s.id), '[]'::jsonb)
          from @SCHEMA@.secret s
          where s.kind = 'INVITE' and s.tenant = c.tenant and s.deleted_at is null and s.expires_at > clock_timestamp()
            and (svc or s.meta->>'by' = c.account::text
                 or @SCHEMA@.role_grant_denied(c.tenant, c.categories, c.roles, coalesce(s.meta->'roles', '[]'::jsonb)) is null));
end $$;

-- Отменить приглашение: тот, кто позвал, консьерж или жилец, которому матрица разрешает выдать его роли. Нет такого
-- живого приглашения (или оно чужое) — false.
create or replace function @SCHEMA@.invite_revoke(p_id uuid) returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  svc boolean;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null or c.tenant is null then
    perform @SCHEMA@.lt_fail('sql-access.no_session');
  end if;
  svc := c.service is null and coalesce('Service' = any (c.categories), false);
  update @SCHEMA@.secret s
     set deleted_at = clock_timestamp(), meta = s.meta || '{"status": "revoked", "reason": "revoked"}'::jsonb
  where s.id = p_id and s.kind = 'INVITE' and s.tenant = c.tenant and s.deleted_at is null and s.expires_at > clock_timestamp()
    and (svc or s.meta->>'by' = c.account::text
         or @SCHEMA@.role_grant_denied(c.tenant, c.categories, c.roles, coalesce(s.meta->'roles', '[]'::jsonb)) is null);
  return found;
end $$;

-- Приглашение глазами того, у кого ссылка (db.invitation; вызывает консьерж): только смотрит. { tenant, tenantName, to,
-- roles, from?, expiresAt, status, hasAccount }; токена нет в базе — null. Адрес контакта библиотека отдаёт под маской.
create or replace function @SCHEMA@.invite_view(p_token text) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  inv record;
begin
  perform @SCHEMA@.auth_service_required();
  select s.tenant, s.ident, s.meta, s.expires_at, s.deleted_at into inv from @SCHEMA@.secret s
  where s.kind = 'INVITE' and s.material = sha256(convert_to(coalesce(p_token, ''), 'UTF8'));
  if inv.tenant is null then
    return null;
  end if;
  return jsonb_strip_nulls(jsonb_build_object('tenant', inv.tenant, 'tenantName', @SCHEMA@.tenant_name_of(inv.tenant),
    'to', inv.meta->'contact', 'roles', coalesce(inv.meta->'roles', '[]'::jsonb),
    'from', @SCHEMA@.invite_from((inv.meta->>'by')::uuid), 'expiresAt', inv.expires_at,
    'status', @SCHEMA@.invite_status(inv.deleted_at, inv.expires_at, inv.meta, inv.tenant),
    'hasAccount', @SCHEMA@.ident_owner(inv.ident) is not null));
end $$;

-- Первый шаг принятия (db.accept; вызывает консьерж, в одной транзакции с invite_accept): приглашение и контакт — под
-- замком до конца транзакции. Токена нет — null. Статус не active — { status }. Матрица заново: звавший (meta.by) ещё
-- прописан, включён и вправе выдать роли приглашения — иначе приглашение гаснет и ответ { status: 'revoked', lost: true }
-- (консьержу можно всегда). Иначе { status: 'active', account — аккаунт контакта или null, hashes — хэши паролей этого
-- аккаунта в других квартирах: консьерж сверяет (scrypt в Node), что новый пароль их не повторяет }.
create or replace function @SCHEMA@.invite_open(p_token text) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  inv record;
  st text;
  acc uuid;
begin
  perform @SCHEMA@.auth_service_required();
  select s.id, s.tenant, s.ident, s.meta, s.expires_at, s.deleted_at into inv from @SCHEMA@.secret s
  where s.kind = 'INVITE' and s.material = sha256(convert_to(coalesce(p_token, ''), 'UTF8'))
  for update;
  if inv.id is null then
    return null;
  end if;
  st := @SCHEMA@.invite_status(inv.deleted_at, inv.expires_at, inv.meta, inv.tenant);
  if st <> 'active' then
    return jsonb_build_object('status', st);
  end if;
  perform @SCHEMA@.contact_lock(inv.ident);
  if inv.meta->>'by' is not null
     and @SCHEMA@.role_grant_denied_by(inv.tenant, (inv.meta->>'by')::uuid, coalesce(inv.meta->'roles', '[]'::jsonb)) is not null then
    update @SCHEMA@.secret s
       set deleted_at = clock_timestamp(), meta = s.meta || '{"status": "revoked", "reason": "inviter"}'::jsonb
    where s.id = inv.id;
    return jsonb_build_object('status', 'revoked', 'lost', true);
  end if;
  acc := @SCHEMA@.ident_owner(inv.ident);
  if acc is not null and not @SCHEMA@.auth_enabled(acc) then
    return null;
  end if;
  return jsonb_build_object('status', 'active', 'account', acc,
    'hashes', (select coalesce(jsonb_agg(convert_from(s.material, 'UTF8')), '[]'::jsonb) from @SCHEMA@.secret s
               where s.account = acc and s.kind = 'PASSWORD' and s.deleted_at is null and s.material is not null
                 and s.tenant <> inv.tenant));
end $$;

-- Неудачная попытка принять приглашение (пароль повторил пароль другой квартиры): счётчик; пятая гасит приглашение —
-- true. Иначе перебор паролей чужого аккаунта по пересланной ссылке был бы безграничным.
create or replace function @SCHEMA@.invite_strike(p_token text) returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  inv record;
begin
  perform @SCHEMA@.auth_service_required();
  select s.id, coalesce((s.meta->>'attempts')::int, 0) + 1 as n into inv from @SCHEMA@.secret s
  where s.kind = 'INVITE' and s.deleted_at is null and s.material = sha256(convert_to(coalesce(p_token, ''), 'UTF8'))
  for update;
  if inv.id is null then
    return true;
  end if;
  if inv.n >= 5 then
    update @SCHEMA@.secret s
       set deleted_at = clock_timestamp(), meta = s.meta || jsonb_build_object('attempts', inv.n, 'status', 'revoked', 'reason', 'attempts')
    where s.id = inv.id;
    return true;
  end if;
  update @SCHEMA@.secret s set meta = s.meta || jsonb_build_object('attempts', inv.n) where s.id = inv.id;
  return false;
end $$;

-- Принять приглашение (вызывает консьерж после invite_open в той же транзакции). Аккаунт — по контакту приглашения: есть
-- — он, нет — новый с этим контактом (p_name — его имя; не задано — пустая строка: адрес контакта именем не становится,
-- имя видят соседи по квартире — member_people). Уже прописан — already_member.
-- Прописка с ролями приглашения; p_hash (scrypt) — пароль этой квартиры с именем для входа — контактом; сессия;
-- приглашение — used. Сессия аккаунта, который уже был, — способ INVITE (недавним входом не считается: auth_self);
-- нового — ещё и FIRST. { account, tenant, created, token } или null — приглашение не действует.
create or replace function @SCHEMA@.invite_accept(p_token text, p_hash text, p_name text,
  p_ttl interval default interval '7 days') returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  inv record;
  acc uuid;
  created boolean := false;
  cid uuid;
  mid uuid;
begin
  perform @SCHEMA@.auth_service_required();
  select s.id, s.tenant, s.ident, s.meta into inv from @SCHEMA@.secret s
  where s.kind = 'INVITE' and s.deleted_at is null and s.expires_at > clock_timestamp()
    and s.material = sha256(convert_to(coalesce(p_token, ''), 'UTF8'))
  for update;
  if inv.id is null or not @SCHEMA@.tenant_ok(inv.tenant) then
    return null;
  end if;
  if p_hash is not null and p_hash !~ '^scrypt\$' then
    perform @SCHEMA@.lt_fail('sql-access.password_args');
  end if;
  perform @SCHEMA@.contact_lock(inv.ident);
  acc := @SCHEMA@.ident_owner(inv.ident);
  if acc is null then
    acc := @SCHEMA@.uuid_v5('@SYSTEM@'::uuid, @SCHEMA@.v5_name('Account', array[gen_random_uuid()::text]));
    perform @SCHEMA@.sys_create(acc, 'Account', '@SYSTEM@'::uuid, '{}',
      jsonb_build_object('name', coalesce(btrim(p_name), ''), 'categories', '["User"]'::jsonb,
                         'enabled', true, 'kind', 'person'));
    created := true;
    begin
      insert into @SCHEMA@.secret (account, tenant, kind, ident, meta)
      values (acc, '@SYSTEM@'::uuid, 'IDENT', inv.ident, inv.meta->'contact');
    exception when unique_violation then
      perform @SCHEMA@.lt_fail('sql-access.identifier_taken');
    end;
  elsif not @SCHEMA@.auth_enabled(acc) then
    return null;
  end if;
  if @SCHEMA@.member_row(acc, inv.tenant) is not null then
    perform @SCHEMA@.lt_fail('sql-access.already_member');
  end if;
  mid := @SCHEMA@.v5_id(inv.tenant, 'member', array[acc::text, inv.tenant::text]);
  perform @SCHEMA@.sys_create(mid, 'member', inv.tenant, jsonb_build_object('User', acc, 'Tenant', inv.tenant),
    jsonb_build_object('roles', coalesce(inv.meta->'roles', '[]'::jsonb)));
  perform @SCHEMA@.signal(array['member'], array[inv.tenant]);
  if p_hash is not null then
    begin
      insert into @SCHEMA@.secret (account, tenant, kind, ident, material, meta)
      values (acc, inv.tenant, 'PASSWORD', inv.ident, convert_to(p_hash, 'UTF8'), '{}')
      returning id into cid;
    exception when unique_violation then
      perform @SCHEMA@.lt_fail('sql-access.identifier_taken');
    end;
  end if;
  update @SCHEMA@.secret s set deleted_at = clock_timestamp(), meta = s.meta || '{"status": "used"}'::jsonb where s.id = inv.id;
  return jsonb_build_object('account', acc, 'tenant', inv.tenant, 'created', created,
    'token', @SCHEMA@.new_session(acc, inv.tenant, p_ttl, jsonb_strip_nulls(jsonb_build_object(
      'methods', case when created then '["INVITE", "FIRST"]'::jsonb else '["INVITE"]'::jsonb end, 'cred', cid))));
end $$;

-- ========================= прописка =========================

-- В квартире остался owner — прописка с ролью owner у включённого аккаунта; иначе last_owner с именем квартиры.
-- Квартиры уже нет (tenant_delete удаляет её строку раньше прописок) — проверять нечего. Строка квартиры — замок (no key
-- update: вставке прописки со ссылкой на квартиру не мешает): два одновременных снятия роли owner (выписки двух
-- последних owner) идут по очереди, и второе видит итог первого — volatile, каждый запрос со свежим снимком.
create or replace function @SCHEMA@.member_owner_check(p_tenant uuid) returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  v_name text;
begin
  select a.data->>'name' into v_name from @SCHEMA@.entity a where a.id = p_tenant and a.class = 'Account' for no key update;
  if not found then
    return;
  end if;
  if not exists (select 1 from @SCHEMA@.entity x
                 join @SCHEMA@.entity u on u.id = (x.links->>'User')::uuid and u.class = 'Account' and u.tenant = '@SYSTEM@'::uuid
                 where x.class = 'member' and x.tenant = p_tenant
                   and coalesce(x.data->'roles' ? 'owner', false) and coalesce((u.data->>'enabled')::boolean, true)) then
    perform @SCHEMA@.lt_fail('sql-access.last_owner', jsonb_build_object('name', coalesce(v_name, p_tenant::text)),
      jsonb_build_object('tenant', p_tenant, 'name', v_name));
  end if;
end $$;

-- Прописка потеряла роль owner — правкой ролей (в том числе me.acl.roles), переносом на другой аккаунт или
-- удалением (выписка, me.acl.roles(аккаунт, null), удаление прописки цепочкой, удаление аккаунта); кто бы ни правил:
-- жилец, консьерж, функция владельца. Квартира осталась без owner — отказ last_owner (member_owner_check).
-- Срабатывает для всех ролей: функции владельца (member_leave, account_remove) тоже удаляют прописки.
create or replace function @SCHEMA@.trg_member_owner() returns trigger
language plpgsql security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  if not coalesce(OLD.data->'roles' ? 'owner', false)
     or (TG_OP = 'UPDATE' and coalesce(NEW.data->'roles' ? 'owner', false)
         and NEW.links->>'User' is not distinct from OLD.links->>'User' and NEW.tenant = OLD.tenant) then
    return null;
  end if;
  perform @SCHEMA@.member_owner_check(OLD.tenant);
  return null;
end $$;

create or replace trigger entity_member_owner after update or delete on @SCHEMA@.entity
  for each row when (OLD.class = 'member') execute function @SCHEMA@.trg_member_owner();
alter table @SCHEMA@.entity enable always trigger entity_member_owner;

-- Люди квартиры актора (me.acl.people()): [{ account, name, roles }] по имени, затем по id аккаунта. Только те, чью
-- прописку (member) в этой квартире актор видит по матрице, — то же условие, что у чтения member под RLS (row_visible):
-- хозяин и консьерж в квартире — всех, жилец без правила на чтение member — только себя, с правилом — тех, кого оно
-- открывает. Имя берётся из строки Account: она лежит вне квартиры, и цепочкой чужую не прочитать, — поэтому функция
-- владельца. Людей других квартир так не узнать: прописки берутся только из квартиры сессии. Контактов в ответе нет.
create or replace function @SCHEMA@.member_people() returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  plan jsonb;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null or c.tenant is null then
    perform @SCHEMA@.lt_fail('sql-access.no_session');
  end if;
  plan := @SCHEMA@.acl_plan_cached(c.account, c.tenant, c.categories, c.roles, 'READ');
  return (select coalesce(jsonb_agg(jsonb_build_object('account', a.id, 'name', coalesce(a.data->>'name', ''),
                   'roles', case when jsonb_typeof(m.data->'roles') = 'array' then m.data->'roles' else '[]'::jsonb end)
                   order by a.data->>'name', a.id), '[]'::jsonb)
          from @SCHEMA@.entity m
          join @SCHEMA@.entity a on a.class = 'Account' and a.tenant = '@SYSTEM@'::uuid
            and a.id = case when pg_input_is_valid(m.links->>'User', 'uuid') then (m.links->>'User')::uuid end
          where m.class = 'member' and m.tenant = c.tenant
            and @SCHEMA@.row_visible(m.tenant, m.class, m.id, m.owner, m.tags, m.data, m.links, c.tenant, c.account, plan));
end $$;

-- Выписаться самому из квартиры своей сессии: последний owner — нельзя (trg_member_owner). Строки жильца в квартире
-- переходят ей, его креды и сессии в ней гаснут (trg_member_ad).
create or replace function @SCHEMA@.member_leave() returns void
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  m @SCHEMA@.entity;
begin
  select * into c from @SCHEMA@.auth_self(false);
  select x.* into m from @SCHEMA@.entity x
  where x.id = @SCHEMA@.v5_id(c.tenant, 'member', array[c.account::text, c.tenant::text]) and x.class = 'member' for update;
  if m.id is null then
    perform @SCHEMA@.lt_fail('sql-core.no_membership');
  end if;
  perform @SCHEMA@.owner_to_tenant(c.tenant, c.account);
  delete from @SCHEMA@.entity x where x.id = m.id;
  perform @SCHEMA@.tombstone_by(m, c.account, null);
  perform @SCHEMA@.signal(array['member'], array[c.tenant]);
  perform @SCHEMA@.acl_bump();
end $$;

-- Прописка удалена (выписка, удаление квартиры или аккаунта) — креды, коды и сессии аккаунта в этой квартире гаснут.
-- Срабатывает для всех ролей, в том числе владельца схемы.
create or replace function @SCHEMA@.trg_member_ad() returns trigger
language plpgsql security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  acc uuid;
  sig text[];
begin
  if OLD.class <> 'member' or not pg_input_is_valid(OLD.links->>'User', 'uuid') then
    return OLD;
  end if;
  acc := (OLD.links->>'User')::uuid;
  with k as (
    delete from @SCHEMA@.secret s where s.account = acc and s.tenant = OLD.tenant and s.kind = 'SESSION' and s.deleted_at is null
    returning s.material)
  select array_agg('session:' || left(encode(k.material, 'hex'), 16)) into sig from k;
  delete from @SCHEMA@.secret s where s.account = acc and s.tenant = OLD.tenant and s.kind not in ('KEY', 'LOCK', 'CONCIERGE', 'INVITE', 'IDENT');
  perform @SCHEMA@.signal_raw(sig);
  return OLD;
end $$;

create or replace trigger entity_member_ad after delete on @SCHEMA@.entity
  for each row when (OLD.class = 'member') execute function @SCHEMA@.trg_member_ad();
alter table @SCHEMA@.entity enable always trigger entity_member_ad;

-- Удалить свой аккаунт целиком: все прописки (последний owner где-то — нельзя), ключи и сессии; строки жильца переходят
-- квартирам. Нужен недавний интерактивный вход.
create or replace function @SCHEMA@.account_delete_self() returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  select * into c from @SCHEMA@.auth_self(true);
  return @SCHEMA@.account_remove(c.account);
end $$;

-- Удалить аккаунт жильца — консьерж (db.deleteAccount): аккаунт один на весь дом, а консьерж в квартире (in, as)
-- работает в одной. Всё как у account_delete_self: прописки (последний owner где-то — last_owner), ключи, контакт и
-- сессии; строки жильца переходят квартирам. Не аккаунт жильца (квартира, консьерж, нет такого) — account_not_found.
create or replace function @SCHEMA@.account_delete(p_account uuid) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  perform @SCHEMA@.auth_service_required();
  return @SCHEMA@.account_remove(p_account);
end $$;

-- ========================= ключи жильца (сам, в квартире своей сессии) =========================

-- Ключи аккаунта в квартире сессии — без секретного материала.
create or replace function @SCHEMA@.key_list()
returns table (id uuid, kind text, ident text, enabled boolean, meta jsonb, created_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_column
declare
  c record;
begin
  select * into c from @SCHEMA@.auth_self(false);
  return query
    select s.id, s.kind, case when s.kind = 'TOTP' then null else s.ident end, coalesce((s.meta->>'enabled')::boolean, true),
           s.meta - 'enabled' - 'attempts' - 'last_step' - 'fails' - 'locked_until', s.created_at, s.expires_at
    from @SCHEMA@.secret s
    where s.account = c.account and s.tenant = c.tenant and s.kind not in ('SESSION', 'KEY', 'LOCK', 'INVITE', 'CONCIERGE', 'IDENT')
      and s.kind !~ '^OTP' and s.deleted_at is null and (s.expires_at is null or s.expires_at > clock_timestamp())
    order by s.created_at, s.id;
end $$;

-- Хэши своих паролей в других квартирах — перед сменой пароля (keys.setPassword): библиотека сверяет (scrypt в Node),
-- что новый пароль их не повторяет, и в той же транзакции пишет ключ (key_set_password). Контакт — под замком до конца
-- транзакции: две смены пароля и принятие приглашения одного аккаунта идут по очереди. Нужен недавний вход.
create or replace function @SCHEMA@.key_password_own() returns table (hash text)
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_column
declare
  c record;
begin
  select * into c from @SCHEMA@.auth_self(true);
  perform @SCHEMA@.contact_lock((select k.ident from @SCHEMA@.contact_of(c.account) k));
  return query
    select convert_from(s.material, 'UTF8')
    from @SCHEMA@.secret s
    where s.account = c.account and s.kind = 'PASSWORD' and s.deleted_at is null and s.material is not null
      and s.tenant <> c.tenant
    order by s.created_at;
end $$;

-- Пароль квартиры сессии: хэш приходит готовым (scrypt в Node; одинаковые пароли аккаунта в разных квартирах библиотека
-- уже отклонила — key_password_own в той же транзакции). Имя для входа — контакт аккаунта. Пароль уже есть — замена
-- хэша, нет — новая запись. Смена гасит остальные сессии жильца в этой квартире (текущую — если p_keep_current = false).
create or replace function @SCHEMA@.key_set_password(p_hash text, p_keep_current boolean default true) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  v_ident text;
  cid uuid;
begin
  select * into c from @SCHEMA@.auth_self(true);
  select k.ident into v_ident from @SCHEMA@.contact_of(c.account) k;
  if v_ident is null or p_hash is null or p_hash !~ '^scrypt\$' then
    perform @SCHEMA@.lt_fail('sql-access.password_args');
  end if;
  select s.id into cid from @SCHEMA@.secret s
  where s.kind = 'PASSWORD' and s.tenant = c.tenant and s.account = c.account and s.deleted_at is null
  for update;
  if cid is not null then
    update @SCHEMA@.secret s set material = convert_to(p_hash, 'UTF8'), ident = v_ident where s.id = cid;
  else
    begin
      insert into @SCHEMA@.secret (account, tenant, kind, ident, material)
      values (c.account, c.tenant, 'PASSWORD', v_ident, convert_to(p_hash, 'UTF8'))
      returning id into cid;
    exception when unique_violation then
      perform @SCHEMA@.lt_fail('sql-access.identifier_taken');
    end;
  end if;
  perform @SCHEMA@.auth_kill(c.account, c.tenant, case when p_keep_current then c.session end);
  return cid;
end $$;

-- Ключ API: lts_ и 48 шестнадцатеричных знаков; отдаётся один раз, в базе — sha256, в ident — префикс. Открывает
-- квартиру сессии.
create or replace function @SCHEMA@.key_issue_apikey(p_name text default null, p_ttl interval default null)
returns table (key text, id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_variable
declare
  c record;
  k text;
  cid uuid;
  i int;
begin
  select * into c from @SCHEMA@.auth_self(true);
  for i in 1 .. 5 loop
    k := 'lts_' || encode(@PGCRYPTO@.gen_random_bytes(24), 'hex');
    begin
      insert into @SCHEMA@.secret as x (account, tenant, kind, ident, material, meta, expires_at)
      values (c.account, c.tenant, 'APIKEY', left(k, 12), sha256(convert_to(k, 'UTF8')),
              jsonb_strip_nulls(jsonb_build_object('name', p_name)), clock_timestamp() + p_ttl)
      returning x.id into cid;
      key := k;
      id := cid;
      return next;
      return;
    exception when unique_violation then
      null; -- совпал префикс: новый ключ
    end;
  end loop;
  perform @SCHEMA@.lt_raise('40001', 'sql-access.apikey_prefix_conflict', '{}'::jsonb);
end $$;

-- Пара ключ + секрет: ключ — открытый идентификатор, секрет отдаётся один раз, в базе — sha256.
create or replace function @SCHEMA@.key_issue_keysecret(p_name text default null)
returns table (key text, secret text, id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_variable
declare
  c record;
  k text := encode(@PGCRYPTO@.gen_random_bytes(8), 'hex');
  s text := encode(@PGCRYPTO@.gen_random_bytes(24), 'hex');
begin
  select * into c from @SCHEMA@.auth_self(true);
  insert into @SCHEMA@.secret as x (account, tenant, kind, ident, material, meta)
  values (c.account, c.tenant, 'KEYSECRET', k, sha256(convert_to(s, 'UTF8')), jsonb_strip_nulls(jsonb_build_object('name', p_name)))
  returning x.id into id;
  key := k;
  secret := s;
  return next;
end $$;

-- TOTP в квартире сессии: новый секрет (20 случайных байт) отдаётся один раз; фактор включает первая верная проверка.
-- Повторное подключение заменяет секрет.
create or replace function @SCHEMA@.key_enroll_totp() returns bytea
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  sec bytea := @PGCRYPTO@.gen_random_bytes(20);
begin
  select * into c from @SCHEMA@.auth_self(true);
  update @SCHEMA@.secret s set deleted_at = clock_timestamp()
  where s.account = c.account and s.tenant = c.tenant and s.kind = 'TOTP' and s.deleted_at is null;
  insert into @SCHEMA@.secret (account, tenant, kind, ident, material, meta)
  values (c.account, c.tenant, 'TOTP', c.account::text, sec, jsonb_build_object('confirmed', false, 'last_step', 0));
  return sec;
end $$;

-- Проверка кода TOTP жильцом: верный код включает фактор и отмечает TOTP в текущей сессии.
create or replace function @SCHEMA@.key_verify_totp(p_code text) returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  select * into c from @SCHEMA@.auth_self(false);
  if coalesce(@SCHEMA@.auth_totp_check(c.account, c.tenant, p_code, false), false) then
    update @SCHEMA@.secret x
       set meta = x.meta || jsonb_build_object('methods', coalesce(x.meta->'methods', '[]'::jsonb) || '["TOTP"]'::jsonb,
                                               'login_at', clock_timestamp())
     where x.id = c.session;
    return true;
  end if;
  return false;
end $$;

-- Внешний вход (GOOGLE, TELEGRAM, SSO): связка без материала, токен провайдера проверяет консьерж. Внешний id другого
-- аккаунта — identifier_taken; один внешний id — одна квартира на весь дом: уже открывает другую — key_bound_elsewhere.
create or replace function @SCHEMA@.key_link(p_kind text, p_ident text, p_meta jsonb default '{}') returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  cid uuid;
begin
  select * into c from @SCHEMA@.auth_self(true);
  if not @SCHEMA@.auth_kind_ok(p_kind) or p_kind = 'PASSWORD' or coalesce(p_ident, '') = '' then
    perform @SCHEMA@.lt_fail('sql-access.identity_args');
  end if;
  perform @SCHEMA@.auth_ident_free(p_kind, p_ident, c.account);
  begin
    insert into @SCHEMA@.secret (account, tenant, kind, ident, meta)
    values (c.account, c.tenant, p_kind, p_ident, coalesce(p_meta, '{}'::jsonb) - 'enabled')
    returning id into cid;
  exception when unique_violation then
    perform @SCHEMA@.lt_fail('sql-access.key_bound_elsewhere');
  end;
  return cid;
end $$;

-- Отозвать свой ключ в квартире сессии. Ключ API и пара ключ + секрет гасят только свои сессии, прочие креды —
-- остальные сессии жильца в квартире; текущую — если p_keep_current = false. Нет такого ключа — false.
create or replace function @SCHEMA@.key_revoke(p_id uuid, p_keep_current boolean default true) returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  cr record;
begin
  select * into c from @SCHEMA@.auth_self(true);
  select s.kind into cr from @SCHEMA@.secret s
  where s.id = p_id and s.account = c.account and s.tenant = c.tenant
    and s.kind not in ('SESSION', 'KEY', 'LOCK', 'INVITE', 'CONCIERGE', 'IDENT') and s.deleted_at is null
  -- строка креда — под блокировкой: вход по этому ключу, начатый раньше, отзыв дожидается (его сессию гасит
  -- auth_kill_cred ниже), начатый позже — ждёт отзыва и ключа уже не находит
  for update;
  if cr.kind is null then
    return false;
  end if;
  update @SCHEMA@.secret s set deleted_at = clock_timestamp() where s.id = p_id;
  if cr.kind in ('APIKEY', 'KEYSECRET') then
    perform @SCHEMA@.auth_kill_cred(c.account, p_id, case when p_keep_current then c.session end);
  else
    perform @SCHEMA@.auth_kill(c.account, c.tenant, case when p_keep_current then c.session end);
  end if;
  return true;
end $$;

-- ========================= смена контакта (сам жилец, на весь дом) =========================

-- Начать смену контакта (me.changeContact(новый)): код — как у входа (6 знаков, 10 минут, 5 попыток); письмо с ним
-- библиотека отдаёт почтальону только на новый контакт: код доказывает владение именно им. Прежний код смены этого
-- аккаунта заменяется. Занят ли новый контакт, ответ не сообщает (это скажет contact_confirm). Нужен недавний вход.
-- { code, expiresAt, to }.
create or replace function @SCHEMA@.contact_change(p_kind text, p_address text) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  v_ident text := @SCHEMA@.contact_ident(p_kind, p_address);
  contact jsonb;
  code text := @SCHEMA@.code_new(6);
  exp timestamptz := clock_timestamp() + interval '10 minutes';
begin
  select * into c from @SCHEMA@.auth_self(true);
  if v_ident is null then
    perform @SCHEMA@.lt_fail('sql-access.contact_args');
  end if;
  contact := jsonb_build_object('kind', p_kind, 'address', btrim(p_address));
  update @SCHEMA@.secret s set deleted_at = clock_timestamp()
  where s.account = c.account and s.kind = 'OTP_CONTACT' and s.deleted_at is null;
  -- ident кода — аккаунт: один и тот же новый контакт могут ждать два аккаунта, занятость выяснит подтверждение
  insert into @SCHEMA@.secret (account, tenant, kind, ident, material, meta, expires_at)
  values (c.account, '@SYSTEM@'::uuid, 'OTP_CONTACT', c.account::text, sha256(convert_to(code, 'UTF8')),
          jsonb_build_object('attempts', 0, 'max_attempts', 5, 'contact', contact, 'ident', v_ident), exp);
  return jsonb_build_object('code', code, 'expiresAt', exp, 'to', contact);
end $$;

-- Подтвердить смену контакта кодом (me.changeContact(новый + code)): код верен и выдан на этот контакт — контакт
-- аккаунта и имя для входа его паролей во всех квартирах меняются; коды входа прежнего контакта гаснут. Новый контакт
-- занят другим аккаунтом — identifier_taken. Неверный код — null (попытка засчитана). Нужен недавний вход.
-- { contact }.
create or replace function @SCHEMA@.contact_confirm(p_kind text, p_address text, p_code text) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  v_ident text := @SCHEMA@.contact_ident(p_kind, p_address);
  h record;
  row_meta jsonb;
  old_ident text;
begin
  select * into c from @SCHEMA@.auth_self(true);
  if v_ident is null then
    perform @SCHEMA@.lt_fail('sql-access.contact_args');
  end if;
  select * into h from @SCHEMA@.code_check('OTP_CONTACT', c.account::text, p_code);
  if h.id is null then
    return null;
  end if;
  select s.meta into row_meta from @SCHEMA@.secret s where s.id = h.id;
  if casefold(row_meta->>'ident') collate pg_unicode_fast <> casefold(v_ident) collate pg_unicode_fast then
    return null;
  end if;
  perform @SCHEMA@.auth_ident_free('IDENT', v_ident, c.account);
  select k.ident into old_ident from @SCHEMA@.contact_of(c.account) k;
  begin
    update @SCHEMA@.secret s set ident = v_ident, meta = row_meta->'contact'
    where s.account = c.account and s.kind = 'IDENT' and s.tenant = '@SYSTEM@'::uuid and s.deleted_at is null;
    update @SCHEMA@.secret s set ident = v_ident
    where s.account = c.account and s.kind = 'PASSWORD' and s.deleted_at is null;
  exception when unique_violation then
    perform @SCHEMA@.lt_fail('sql-access.identifier_taken');
  end;
  update @SCHEMA@.secret s set deleted_at = clock_timestamp()
  where (s.id = h.id or (s.kind = 'OTP' and s.tenant = '@SYSTEM@'::uuid
                         and casefold(s.ident) collate pg_unicode_fast = casefold(old_ident) collate pg_unicode_fast))
    and s.deleted_at is null;
  return jsonb_build_object('contact', row_meta->'contact');
end $$;

-- ========================= имя аккаунта (на весь дом) =========================

-- Сменить имя аккаунта актора (me.changeName(имя)): аккаунт один на дом — новое имя сразу видно во всех квартирах
-- человека (member_people, invite_from, его строка Account). Имя — от 1 до 200 знаков, пробельные знаки по краям
-- отбрасываются; иначе name_args. Кто может: сам жилец со своей сессии после недавнего входа (auth_self(true)) и
-- консьерж от имени жильца (db.as: за человека ручается приложение, недавний вход не нужен); консьерж сам по себе —
-- resident_only. Меняется только имя аккаунта актора: чужое имя этой функцией не сменить. Строка Account лежит вне
-- квартиры, цепочкой её не править (RLS), — поэтому функция владельца; правка — обычная новая версия строки (автор —
-- человек, агент — консьерж, если правил он) с записью в журнал и сигналом. То же имя — без новой версии. { name }.
create or replace function @SCHEMA@.account_rename(p_name text) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  v_name text := regexp_replace(coalesce(p_name, ''), '^\s+|\s+$', '', 'g');
  e @SCHEMA@.entity;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('sql-access.no_session');
  end if;
  if c.service is null then
    -- сам жилец: своя сессия и недавний вход; консьерж без жильца — resident_only
    perform @SCHEMA@.auth_self(true);
  end if;
  if v_name = '' or char_length(v_name) > 200 then
    perform @SCHEMA@.lt_fail('sql-access.name_args');
  end if;
  update @SCHEMA@.entity x
     set data = x.data || jsonb_build_object('name', v_name),
         rev = x.rev + 1,
         at = greatest(@SCHEMA@.now_ts(), x.at + interval '1 microsecond'),
         author = c.account, agent = c.agent, op = 'update',
         reason = nullif(current_setting('letopis.reason', true), ''),
         cv = coalesce((@SCHEMA@.class_row(x.class, x.tenant)).rev, x.cv)
   where x.id = c.account and x.class = 'Account' and x.tenant = '@SYSTEM@'::uuid and x.data->>'kind' = 'person'
     and x.data->>'name' is distinct from v_name
  returning x.* into e;
  if e.id is not null then
    perform @SCHEMA@.log_version(e);
  end if;
  return jsonb_build_object('name', v_name);
end $$;

-- ========================= сессия =========================

-- Продление текущей сессии (библиотека — не чаще раза в минуту). Новый срок — от сейчас, но не дольше срока, выданного
-- при входе (meta.ttl): продление не делает сессию вечной.
create or replace function @SCHEMA@.session_refresh(p_ttl interval default interval '7 days') returns timestamptz
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  e timestamptz;
begin
  select * into c from @SCHEMA@.ctx();
  perform @SCHEMA@.auth_session_required(c.account);
  update @SCHEMA@.secret s
     set expires_at = greatest(s.expires_at, clock_timestamp()
           + least(coalesce(p_ttl, interval '7 days'), coalesce((s.meta->>'ttl')::interval, interval '7 days')))
  where s.id = c.session returning s.expires_at into e;
  return e;
end $$;

-- Выход: гасит текущую сессию.
create or replace function @SCHEMA@.session_logout() returns boolean
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
  perform @SCHEMA@.signal_raw(array['session:' || left(encode(m, 'hex'), 16)]);
  return m is not null;
end $$;

-- Выход везде в этой квартире: все сессии жильца в квартире сессии.
create or replace function @SCHEMA@.session_logout_all() returns int
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  select * into c from @SCHEMA@.auth_self(false);
  return @SCHEMA@.auth_kill(c.account, c.tenant, null);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'auth_recent()', 'auth_kind_ok(text)', 'auth_session_required(uuid)', 'auth_service_required()', 'auth_self(boolean)',
    'auth_enabled(uuid)', 'auth_ident_free(text, text, uuid)', 'contact_ident(text, text)', 'contact_lock(text)',
    'ident_owner(text)', 'contact_of(uuid)', 'contact_get(uuid)', 'account_tenants(uuid)', 'tenant_name_of(uuid)',
    'auth_kill(uuid, uuid, uuid)', 'auth_kill_cred(uuid, uuid, uuid)',
    'totp_code(bytea, bigint)', 'auth_totp_check(uuid, uuid, text, boolean)', 'auth_password_get(text, text)',
    'auth_login_cred(uuid, interval, text)', 'login_cred(uuid, interval, text)', 'login_identity(text, text, interval, text)',
    'login_keysecret(text, text, interval)', 'login_apikey_for(text, interval)',
    'code_check(text, text, text)', 'code_new(int)', 'code_issue(text, text, interval, int, int)', 'code_tenants(text, text, text)',
    'login_code(text, text, text, uuid, interval, text)', 'session_required()',
    'auth_totp_on(uuid, uuid)', 'session_whoami()', 'tenant_create(text)', 'tenant_list()', 'tenant_delete()',
    'auth_roles_ok(jsonb)', 'role_grant_denied(uuid, text[], text[], jsonb)', 'role_grant_denied_by(uuid, uuid, jsonb)',
    'invite_from(uuid)', 'invite_status(timestamptz, timestamptz, jsonb, uuid)',
    'invite_create(text, text, jsonb, interval)', 'invite_list()', 'invite_revoke(uuid)', 'invite_view(text)',
    'invite_open(text)', 'invite_strike(text)', 'invite_accept(text, text, text, interval)',
    'member_owner_check(uuid)', 'trg_member_owner()', 'member_people()',
    'member_leave()', 'trg_member_ad()', 'account_delete_self()', 'account_delete(uuid)',
    'key_list()', 'key_password_own()', 'key_set_password(text, boolean)', 'key_issue_apikey(text, interval)',
    'key_issue_keysecret(text)',
    'key_enroll_totp()', 'key_verify_totp(text)', 'key_link(text, text, jsonb)', 'key_revoke(uuid, boolean)',
    'contact_change(text, text)', 'contact_confirm(text, text, text)', 'account_rename(text)',
    'session_refresh(interval)', 'session_logout()', 'session_logout_all()'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
grant execute on function
  @SCHEMA@.auth_password_get(text, text), @SCHEMA@.contact_get(uuid),
  @SCHEMA@.login_cred(uuid, interval, text), @SCHEMA@.login_identity(text, text, interval, text),
  @SCHEMA@.login_keysecret(text, text, interval), @SCHEMA@.login_apikey_for(text, interval),
  @SCHEMA@.code_issue(text, text, interval, int, int), @SCHEMA@.code_tenants(text, text, text),
  @SCHEMA@.login_code(text, text, text, uuid, interval, text), @SCHEMA@.session_required(),
  @SCHEMA@.session_whoami(), @SCHEMA@.tenant_create(text), @SCHEMA@.tenant_list(), @SCHEMA@.tenant_delete(),
  @SCHEMA@.invite_create(text, text, jsonb, interval), @SCHEMA@.invite_list(), @SCHEMA@.invite_revoke(uuid),
  @SCHEMA@.invite_view(text), @SCHEMA@.invite_open(text), @SCHEMA@.invite_strike(text),
  @SCHEMA@.invite_accept(text, text, text, interval), @SCHEMA@.member_people(), @SCHEMA@.member_leave(),
  @SCHEMA@.account_delete_self(),
  @SCHEMA@.account_delete(uuid),
  @SCHEMA@.key_list(), @SCHEMA@.key_password_own(), @SCHEMA@.key_set_password(text, boolean),
  @SCHEMA@.key_issue_apikey(text, interval),
  @SCHEMA@.key_issue_keysecret(text), @SCHEMA@.key_enroll_totp(), @SCHEMA@.key_verify_totp(text),
  @SCHEMA@.key_link(text, text, jsonb), @SCHEMA@.key_revoke(uuid, boolean),
  @SCHEMA@.contact_change(text, text), @SCHEMA@.contact_confirm(text, text, text), @SCHEMA@.account_rename(text),
  @SCHEMA@.session_refresh(interval), @SCHEMA@.session_logout(), @SCHEMA@.session_logout_all() to @APP@;
