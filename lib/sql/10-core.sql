-- letopis 1.0 — хранение и права (план, §2.2, этап 1, п. 1).
-- Ровно три таблицы: entity (текущее состояние), log (журнал версий), secret (креды и сессии).
-- Повторный накат ничего не меняет: всё создаётся с проверкой существования.

-- Схему создаёт установщик (create schema … authorization владелец): у владельца нет права CREATE в базе.
revoke all on schema @SCHEMA@ from public;
grant usage on schema @SCHEMA@ to @APP@;

-- Все цели концов плоским списком: {роль: id} или {роль: [id, …]}. Тело — SQL-стандарта (return): имена связываются
-- при создании и от search_path сеанса не зависят, а колонку ends вычисляет роль приложения. Вариант на plpgsql быстрее
-- на 17 % (бенч gencols), но его имена разрешались бы при исполнении (ревью безопасности доработок после 1.2.0)
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
  moved      uuid,
  validator  jsonpath
);
create index if not exists entity_class_tenant on @SCHEMA@.entity (class, tenant);
create index if not exists entity_ends on @SCHEMA@.entity using gin (ends) with (fastupdate = off);
create index if not exists entity_data on @SCHEMA@.entity using gin (data jsonb_path_ops);
-- описание класса по имени (class_row): без вычисления v5 на каждый поиск
create index if not exists entity_class_name on @SCHEMA@.entity ((data->>'name'), tenant) where class = 'Class';
-- строки с владельцем-пользователем: переход владения арендатору при выходе из членства (этап 5)
create index if not exists entity_owner on @SCHEMA@.entity (owner, tenant) where owner <> tenant;

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
  constraint log_id_rev unique (id, rev)
);
-- срез журнала по классу (asOf, withDeleted) — по арендатору (доработки после точки Б): цена запроса не растёт с
-- журналом других арендаторов с тем же именем класса
create index if not exists log_class_tenant_at on @SCHEMA@.log (class, tenant, at);
create index if not exists log_tx_seq on @SCHEMA@.log (tx, seq);
-- versions({ follow: true }): переход по связи старого и нового id при reclass и rekey (этап 6)
create index if not exists log_moved on @SCHEMA@.log (moved) where moved is not null;
-- срез asOf и withDeleted по переходу и deep (ревизия 5): версии, ссылавшиеся на id, — как entity_ends у
-- текущего состояния; без него поиск в журнале перебирал все версии класса (бенч этапа 7)
create index if not exists log_ends on @SCHEMA@.log using gin (@SCHEMA@.link_ids(links));

-- account — строка entity (аккаунт; у служебных строк KEY и LOCK — System): удалённый аккаунт уносит свои строки
-- каскадом внешнего ключа — сессии, хэши паролей и ключей, секреты TOTP, внешние учётные записи (ревизия 7). Строка
-- Account у System не удаляется (trg_entity_bd_account, 60-write.sql)
create table if not exists @SCHEMA@.secret (
  id          uuid primary key default gen_random_uuid(),
  account     uuid not null constraint secret_account_fkey references @SCHEMA@.entity (id) on delete cascade,
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
-- строки аккаунта: каскад внешнего ключа при удалении аккаунта и гашение его сессий (auth_kill) — без перебора таблицы
create index if not exists secret_account on @SCHEMA@.secret (account);

alter table @SCHEMA@.entity owner to @OWNER@;
alter table @SCHEMA@.log owner to @OWNER@;
alter table @SCHEMA@.secret owner to @OWNER@;
alter function @SCHEMA@.link_ids(jsonb) owner to @OWNER@;

-- Права приложения (§2.7, этап 1, п. 1): только пользовательские колонки.
revoke all on @SCHEMA@.entity, @SCHEMA@.log, @SCHEMA@.secret from public, @APP@;
grant select, delete on @SCHEMA@.entity to @APP@;
grant insert (id, tenant, class, links, data, tags, owner) on @SCHEMA@.entity to @APP@;
grant update (class, links, data, tags) on @SCHEMA@.entity to @APP@;
grant select (seq, tx, id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason, moved)
  on @SCHEMA@.log to @APP@;
alter table @SCHEMA@.entity enable row level security;
alter table @SCHEMA@.log enable row level security;
alter table @SCHEMA@.secret enable row level security;
revoke all on all functions in schema @SCHEMA@ from public;
-- генерируемая колонка ends вычисляется с правами пишущей роли: функция чистая, без побочных эффектов
grant execute on function @SCHEMA@.link_ids(jsonb) to @APP@;
