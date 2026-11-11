-- letopis — хранение и права.
-- Ровно три таблицы: entity (текущее состояние), log (журнал версий), secret (креды, сессии, приглашения).
-- Повторный накат ничего не меняет: всё создаётся с проверкой существования.

-- Схему создаёт установщик (create schema … authorization владелец): у владельца нет права CREATE в базе.
revoke all on schema @SCHEMA@ from public;
grant usage on schema @SCHEMA@ to @APP@;

-- Все цели концов плоским списком: {роль: id} или {роль: [id, …]}. Тело — SQL-стандарта (return): имена связываются
-- при создании и от search_path сеанса не зависят, а колонку ends вычисляет служебная роль дома (letopis_a_<имя>). Вариант на
-- plpgsql быстрее на 17 % (бенч gencols), но его имена разрешались бы при исполнении
create or replace function @SCHEMA@.link_ids(links jsonb) returns uuid[]
language sql immutable parallel safe
return (
  -- lax $.*[*]: значения концов, массивы разворачиваются, одиночная строка остаётся собой
  select coalesce(array_agg(distinct (v #>> '{}')::uuid order by (v #>> '{}')::uuid), '{}'::uuid[])
  from jsonb_path_query(coalesce(links, '{}'::jsonb), 'lax $.*[*]') as v
);

create table if not exists @SCHEMA@.entity (
  id         uuid primary key,
  rev        int not null,
  class      text not null,
  cv         int not null default 0,
  tenant     uuid not null,
  owner      uuid not null,
  links      jsonb not null default '{}'::jsonb,
  ends       uuid[] generated always as (@SCHEMA@.link_ids(links)) stored,
  data       jsonb not null default '{}'::jsonb,
  tags       text[] not null default '{}',
  at         timestamptz not null,
  created_at timestamptz not null,
  author     uuid not null,
  agent      text,
  op         text not null,
  reason     text,
  validator  jsonpath
);
create index if not exists entity_class_tenant on @SCHEMA@.entity (class, tenant);
create index if not exists entity_ends on @SCHEMA@.entity using gin (ends) with (fastupdate = off);
create index if not exists entity_data on @SCHEMA@.entity using gin (data jsonb_path_ops);
-- описание класса по имени (class_row): без вычисления v5 на каждый поиск
create index if not exists entity_class_name on @SCHEMA@.entity ((data->>'name'), tenant) where class = 'Class';
-- строки с владельцем-пользователем: переход владения квартире при выписке
create index if not exists entity_owner on @SCHEMA@.entity (owner, tenant) where owner <> tenant;
-- квартиры — строки Account в System с kind = 'tenant': имя квартиры уникально в доме без учёта регистра («Мир» и «мир»
-- — одно имя), как идентификаторы кредов
create unique index if not exists entity_tenant_name on @SCHEMA@.entity (casefold(data->>'name') collate pg_unicode_fast)
  where class = 'Account' and data->>'kind' = 'tenant';

create table if not exists @SCHEMA@.log (
  seq        bigint generated always as identity,
  tx         xid8 not null default pg_current_xact_id(),
  id         uuid not null,
  rev        int not null,
  class      text not null,
  cv         int not null default 0,
  tenant     uuid not null,
  owner      uuid not null,
  links      jsonb,
  data       jsonb,
  tags       text[],
  at         timestamptz not null,
  author     uuid not null,
  agent      text,
  op         text not null,
  reason     text,
  constraint log_id_rev unique (id, rev)
);
-- срез журнала по классу (asOf, withDeleted) — по квартире: цена запроса не растёт с журналом других квартир с тем же
-- именем класса
create index if not exists log_class_tenant_at on @SCHEMA@.log (class, tenant, at);
create index if not exists log_tx_seq on @SCHEMA@.log (tx, seq);
-- срез asOf и withDeleted по переходу и deep: версии, ссылавшиеся на id, — как entity_ends у текущего состояния; без
-- него поиск в журнале перебирал бы все версии класса
create index if not exists log_ends on @SCHEMA@.log using gin (@SCHEMA@.link_ids(links));

-- account — строка entity (аккаунт; у служебных строк KEY, LOCK и CONCIERGE — System): удалённый аккаунт уносит свои
-- строки каскадом внешнего ключа — сессии, хэши паролей и ключей, секреты TOTP, внешние учётные записи. Строка Account у
-- System не удаляется (trg_entity_bd_account, 60-write.sql).
-- tenant — квартира, которую открывает кред (ключ), в которой работает сессия, в которую зовёт приглашение; у служебных
-- строк и сессии консьержа — System. Кред аккаунта открывает ровно одну квартиру.
create table if not exists @SCHEMA@.secret (
  id          uuid primary key default gen_random_uuid(),
  account     uuid not null constraint secret_account_fkey references @SCHEMA@.entity (id) on delete cascade,
  tenant      uuid not null default '@SYSTEM@'::uuid,
  kind        text not null,       -- IDENT, PASSWORD, APIKEY, KEYSECRET, OTP, TOTP, внешний вход (GOOGLE…), INVITE, SESSION
  ident       text,                -- контакт `<вид>:<адрес>`, префикс ключа, внешний id
  material    bytea,               -- хэш пароля, ключа, кода, токена или приглашения; секрет TOTP; у внешнего входа — null
  meta        jsonb not null default '{}'::jsonb,
  expires_at  timestamptz,
  created_at  timestamptz not null default clock_timestamp(),
  deleted_at  timestamptz
);
-- кред с идентификатором — один на вид, квартиру и идентификатор (без учёта регистра)
create unique index if not exists secret_kind_ident on @SCHEMA@.secret (kind, tenant, casefold(ident) collate pg_unicode_fast)
  where deleted_at is null and ident is not null;
-- внешний вход (material is null) — один на весь дом: один внешний id открывает одну квартиру
create unique index if not exists secret_identity on @SCHEMA@.secret (kind, casefold(ident) collate pg_unicode_fast)
  where deleted_at is null and ident is not null and material is null;
create index if not exists secret_material on @SCHEMA@.secret (material) where kind in ('SESSION', 'INVITE') and deleted_at is null;
-- приглашение по токену, в том числе погашенное (его статус видит тот, у кого ссылка)
create index if not exists secret_invite on @SCHEMA@.secret (material) where kind = 'INVITE';
-- строки аккаунта: каскад внешнего ключа при удалении аккаунта и гашение его сессий (auth_kill) — без перебора таблицы
create index if not exists secret_account on @SCHEMA@.secret (account, tenant);
-- креды и сессии квартиры: удаление квартиры и выписка
create index if not exists secret_tenant on @SCHEMA@.secret (tenant);

alter table @SCHEMA@.entity owner to @OWNER@;
alter table @SCHEMA@.log owner to @OWNER@;
alter table @SCHEMA@.secret owner to @OWNER@;
alter function @SCHEMA@.link_ids(jsonb) owner to @OWNER@;

-- Права служебной роли дома (letopis_a_<имя>, в неё входит роль консьержа): только пользовательские колонки.
revoke all on @SCHEMA@.entity, @SCHEMA@.log, @SCHEMA@.secret from public, @APP@;
grant select, delete on @SCHEMA@.entity to @APP@;
grant insert (id, tenant, class, links, data, tags, owner) on @SCHEMA@.entity to @APP@;
grant update (class, links, data, tags) on @SCHEMA@.entity to @APP@;
grant select (seq, tx, id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason)
  on @SCHEMA@.log to @APP@;
alter table @SCHEMA@.entity enable row level security;
alter table @SCHEMA@.log enable row level security;
alter table @SCHEMA@.secret enable row level security;
revoke all on all functions in schema @SCHEMA@ from public;
-- генерируемая колонка ends вычисляется с правами пишущей роли: функция чистая, без побочных эффектов
grant execute on function @SCHEMA@.link_ids(jsonb) to @APP@;
