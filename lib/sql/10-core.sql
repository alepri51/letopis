-- letopis 1.0 — хранение и права (план, §2.2, этап 1, п. 1).
-- Ровно три таблицы: entity (текущее состояние), log (журнал версий), secret (креды и сессии).
-- Повторный накат ничего не меняет: всё создаётся с проверкой существования.

-- Схему создаёт установщик (create schema … authorization владелец): у владельца нет права CREATE в базе.
revoke all on schema @SCHEMA@ from public;
grant usage on schema @SCHEMA@ to @APP@;

-- Все цели концов плоским списком: {роль: id} или {роль: [id, …]}.
create or replace function @SCHEMA@.link_ids(links jsonb) returns uuid[]
language sql immutable parallel safe
return (
  -- lax $.*[*]: значения концов, массивы разворачиваются, одиночная строка остаётся собой
  select coalesce(array_agg(distinct (v #>> '{}')::uuid order by (v #>> '{}')::uuid), '{}'::uuid[])
  from jsonb_path_query(coalesce(links, '{}'::jsonb), 'lax $.*[*]') as v
);

-- Снимок версии для хэша (§2.2). Не зависит от настроек сеанса: время — числом микросекунд,
-- остальное — через текстовый вид jsonb, который от настроек не зависит.
create or replace function @SCHEMA@.snapshot(
  id uuid, rev int, class text, tenant uuid, owner uuid, links jsonb, data jsonb, tags text[],
  at timestamptz, author uuid, agent text, op text, reason text, moved uuid
) returns bytea
language sql immutable parallel safe
return convert_to(
  jsonb_build_array(
    id, rev, class, tenant, owner, links, data, to_jsonb(tags),
    (extract(epoch from at) * 1000000)::bigint, author, agent, op, reason, moved
  )::text,
  'UTF8'
);

create or replace function @SCHEMA@.version_hash(prev_hash bytea, snap bytea) returns bytea
language sql immutable parallel safe
return sha256(coalesce(prev_hash, ''::bytea) || snap);

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
  moved      uuid,
  prev_hash  bytea,
  hash       bytea generated always as (@SCHEMA@.version_hash(prev_hash,
               @SCHEMA@.snapshot(id, rev, class, tenant, owner, links, data, tags, at, author, agent, op, reason, moved))) stored,
  validator  jsonpath
);
create index if not exists entity_class_tenant on @SCHEMA@.entity (class, tenant);
create index if not exists entity_ends on @SCHEMA@.entity using gin (ends) with (fastupdate = off);
create index if not exists entity_data on @SCHEMA@.entity using gin (data jsonb_path_ops);
-- описание класса по имени (class_row): без вычисления v5 на каждый поиск
create index if not exists entity_class_name on @SCHEMA@.entity ((data->>'name'), tenant) where class = 'Class';

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
  moved      uuid,
  prev_hash  bytea,
  hash       bytea generated always as (@SCHEMA@.version_hash(prev_hash,
               @SCHEMA@.snapshot(id, rev, class, tenant, owner, links, data, tags, at, author, agent, op, reason, moved))) stored,
  constraint log_id_rev unique (id, rev)
);
create index if not exists log_class_at on @SCHEMA@.log (class, at);
create index if not exists log_tx_seq on @SCHEMA@.log (tx, seq);
-- журнал часто прореживается (§2.11): чаще чистим
alter table @SCHEMA@.log set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);

create table if not exists @SCHEMA@.secret (
  id          uuid primary key default gen_random_uuid(),
  account     uuid not null,
  kind        text not null,       -- PASSWORD, APIKEY, KEYSECRET, OTP, TOTP, IDENTITY, SESSION
  ident       text,                -- email, телефон, префикс ключа, внешний id
  material    bytea,               -- хэш пароля, ключа, кода или токена; секрет TOTP
  meta        jsonb not null default '{}'::jsonb,
  expires_at  timestamptz,
  created_at  timestamptz not null default clock_timestamp(),
  deleted_at  timestamptz
);
create unique index if not exists secret_kind_ident on @SCHEMA@.secret (kind, casefold(ident) collate pg_unicode_fast)
  where deleted_at is null and ident is not null;
create index if not exists secret_material on @SCHEMA@.secret (material) where kind = 'SESSION' and deleted_at is null;

alter table @SCHEMA@.entity owner to @OWNER@;
alter table @SCHEMA@.log owner to @OWNER@;
alter table @SCHEMA@.secret owner to @OWNER@;
alter function @SCHEMA@.link_ids(jsonb) owner to @OWNER@;
alter function @SCHEMA@.snapshot(uuid, int, text, uuid, uuid, jsonb, jsonb, text[], timestamptz, uuid, text, text, text, uuid) owner to @OWNER@;
alter function @SCHEMA@.version_hash(bytea, bytea) owner to @OWNER@;

-- Права приложения (§2.7, этап 1, п. 1): только пользовательские колонки.
revoke all on @SCHEMA@.entity, @SCHEMA@.log, @SCHEMA@.secret from public, @APP@;
grant select, delete on @SCHEMA@.entity to @APP@;
grant insert (id, tenant, class, links, data, tags, owner) on @SCHEMA@.entity to @APP@;
grant update (class, links, data, tags) on @SCHEMA@.entity to @APP@;
grant select on @SCHEMA@.log to @APP@;
alter table @SCHEMA@.entity enable row level security;
alter table @SCHEMA@.log enable row level security;
alter table @SCHEMA@.secret enable row level security;
revoke all on all functions in schema @SCHEMA@ from public;
-- генерируемые колонки ends и hash вычисляются с правами пишущей роли: функции чистые, без побочных эффектов
grant execute on function @SCHEMA@.link_ids(jsonb),
  @SCHEMA@.snapshot(uuid, int, text, uuid, uuid, jsonb, jsonb, text[], timestamptz, uuid, text, text, text, uuid),
  @SCHEMA@.version_hash(bytea, bytea) to @APP@;
