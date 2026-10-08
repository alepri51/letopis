-- letopis 1.0 — поиск id для шагов цепочки (план, §2.7, §3 «Индексы под RLS», этап 3, п. 3).
--
-- Под RLS PostgreSQL пользуется индексом только для операторов, помеченных leakproof (равенство
-- uuid и текста); поиск внутри jsonb и массивов (@>) к ним не относится, и пометить его так может
-- только суперпользователь. Поэтому шаг цепочки делится на две части:
--   1) функции владельца find_* выполняются без RLS и находят id по индексам GIN (entity_ends,
--      entity_data), сами применяя то же условие видимости, что и политики RLS (row_visible с планом
--      прав READ актора — acl_actor);
--   2) строки читаются по этим id через первичный ключ под RLS, и там же применяются остальные
--      условия шага: операторы с приведением типов, диапазоны, like.
-- Прямой вызов find_* сырым SQL возвращает только id строк, которые пользователь и так видит.
-- Принимаются только условия вложения (@>), которые не падают на неожиданных данных.
-- Обратный переход и deep пробуют индекс entity_ends на каждый id отдельно (lateral … offset 0 —
-- подзапрос не поднимается в общий план, и планировщик не меняет пробы на перебор таблицы), а класс,
-- видимость и условия на data проверяют уже на найденных строках: пересечение каждой пробы с
-- индексами (class, tenant) или data перебирало бы весь класс.
--
-- Источник — текущее состояние (entity) или журнал: версии, действовавшие на момент p_at (срез
-- asOf), либо надгробия удалённых (p_dead, для withDeleted). Возвращается rev версии: строки
-- журнала читаются по паре (id, rev) через уникальный индекс log_id_rev.

-- Цели концов строки: всех (p_roles is null) или только перечисленных ролей.
create or replace function @SCHEMA@.role_ids(p_links jsonb, p_roles text[]) returns uuid[]
language sql immutable parallel safe
return (
  select coalesce(array_agg(distinct (v #>> '{}')::uuid), '{}'::uuid[])
  from jsonb_each(coalesce(p_links, '{}'::jsonb)) k
  cross join lateral jsonb_array_elements(case jsonb_typeof(k.value) when 'array' then k.value else jsonb_build_array(k.value) end) v
  where (p_roles is null or k.key = any (p_roles)) and jsonb_typeof(v) = 'string'
);

-- Ссылается ли строка на p_id хотя бы одной из ролей (одиночный конец или элемент множественного:
-- массив jsonb содержит строку-примитив).
create or replace function @SCHEMA@.role_has(p_links jsonb, p_roles text[], p_id uuid) returns boolean
language sql immutable parallel safe
return exists (select 1 from unnest(p_roles) r(role) where (p_links -> r.role) @> to_jsonb(p_id::text));

-- id строк классов p_classes: по вложению в data (GIN entity_data), по целям концов (GIN entity_ends),
-- по списку id (первичный ключ) или по классу (entity_class_tenant).
create or replace function @SCHEMA@.find_ids(p_classes text[], p_data jsonb, p_ends uuid[], p_ids uuid[],
  p_at timestamptz default null, p_dead boolean default false)
returns table (id uuid, rev int)
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_column
declare
  a jsonb := @SCHEMA@.acl_actor('READ');
  c_tenant uuid := (a->>'tenant')::uuid;
  c_account uuid := (a->>'account')::uuid;
  c_plan jsonb := a->'plan';
begin
  if c_account is null then
    return;
  end if;
  if p_at is null and not p_dead then
    -- отдельные ветви вместо «p is null or …»: иначе общий план не выбрал бы нужный индекс
    if p_ids is not null then
      return query select e.id, e.rev from @SCHEMA@.entity e
        where e.id = any (p_ids) and e.class = any (p_classes)
          and (p_data is null or e.data @> p_data) and (p_ends is null or e.ends @> p_ends)
          and @SCHEMA@.row_visible(e.tenant, e.class, e.id, e.owner, e.tags, e.data, e.links, c_tenant, c_account, c_plan);
    elsif p_data is not null and p_ends is not null then
      return query select e.id, e.rev from @SCHEMA@.entity e
        where e.class = any (p_classes) and e.data @> p_data and e.ends @> p_ends
          and @SCHEMA@.row_visible(e.tenant, e.class, e.id, e.owner, e.tags, e.data, e.links, c_tenant, c_account, c_plan);
    elsif p_data is not null then
      return query select e.id, e.rev from @SCHEMA@.entity e
        where e.class = any (p_classes) and e.data @> p_data
          and @SCHEMA@.row_visible(e.tenant, e.class, e.id, e.owner, e.tags, e.data, e.links, c_tenant, c_account, c_plan);
    elsif p_ends is not null then
      return query select e.id, e.rev from @SCHEMA@.entity e
        where e.class = any (p_classes) and e.ends @> p_ends
          and @SCHEMA@.row_visible(e.tenant, e.class, e.id, e.owner, e.tags, e.data, e.links, c_tenant, c_account, c_plan);
    else
      return query select e.id, e.rev from @SCHEMA@.entity e
        where e.class = any (p_classes)
          and @SCHEMA@.row_visible(e.tenant, e.class, e.id, e.owner, e.tags, e.data, e.links, c_tenant, c_account, c_plan);
    end if;
  elsif p_ids is not null then
    -- журнал: последняя версия каждого id не позже p_at; удалён — если это надгробие
    return query select v.id, v.rev from (
        select distinct on (l.id) l.id, l.rev, l.op, l.class, l.tenant, l.owner, l.tags, l.data, l.links
        from @SCHEMA@.log l
        where l.id = any (p_ids) and l.at <= coalesce(p_at, 'infinity'::timestamptz)
        order by l.id, l.rev desc) v
      where v.class = any (p_classes) and (v.op = 'delete') = p_dead
        and (p_data is null or v.data @> p_data) and (p_ends is null or @SCHEMA@.link_ids(v.links) @> p_ends)
        and @SCHEMA@.row_visible(v.tenant, v.class, v.id, v.owner, v.tags, v.data, v.links, c_tenant, c_account, c_plan);
  else
    return query select v.id, v.rev from (
        select distinct on (l.id) l.id, l.rev, l.op, l.class, l.tenant, l.owner, l.tags, l.data, l.links
        from @SCHEMA@.log l
        where l.class = any (p_classes) and l.at <= coalesce(p_at, 'infinity'::timestamptz)
        order by l.id, l.rev desc) v
      where (v.op = 'delete') = p_dead
        and (p_data is null or v.data @> p_data) and (p_ends is null or @SCHEMA@.link_ids(v.links) @> p_ends)
        and @SCHEMA@.row_visible(v.tenant, v.class, v.id, v.owner, v.tags, v.data, v.links, c_tenant, c_account, c_plan);
  end if;
end $$;

-- Обратный переход: пары «откуда, куда» — строки классов p_classes, которые ссылаются на id из p_src
-- (любым концом или только ролями p_roles). Соединение с развёрнутым списком id: на каждый id —
-- одна проба индекса entity_ends (решение 5 точки А: «ends && <массив>» на широких списках медленно).
create or replace function @SCHEMA@.find_hop(p_classes text[], p_data jsonb, p_ends uuid[], p_roles text[], p_src uuid[],
  p_at timestamptz default null, p_dead boolean default false)
returns table (src uuid, id uuid, rev int)
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_column
declare
  a jsonb := @SCHEMA@.acl_actor('READ');
  c_tenant uuid := (a->>'tenant')::uuid;
  c_account uuid := (a->>'account')::uuid;
  c_plan jsonb := a->'plan';
begin
  if c_account is null or p_src is null then
    return;
  end if;
  if p_at is null and not p_dead then
    return query select s.src, e.id, e.rev
      from (select distinct u.x as src from unnest(p_src) u(x)) s
      cross join lateral (
        select x.id, x.rev, x.class, x.tenant, x.owner, x.tags, x.data, x.ends, x.links from @SCHEMA@.entity x
        where x.ends @> array[s.src] offset 0) e
      where e.class = any (p_classes)
        and @SCHEMA@.row_visible(e.tenant, e.class, e.id, e.owner, e.tags, e.data, e.links, c_tenant, c_account, c_plan)
        and (p_data is null or e.data @> p_data) and (p_ends is null or e.ends @> p_ends)
        and (p_roles is null or @SCHEMA@.role_has(e.links, p_roles, s.src));
  else
    return query with v as (
        select distinct on (l.id) l.id, l.rev, l.op, l.class, l.tenant, l.owner, l.tags, l.data, l.links
        from @SCHEMA@.log l
        where l.class = any (p_classes) and l.at <= coalesce(p_at, 'infinity'::timestamptz)
        order by l.id, l.rev desc)
      select s.src, v.id, v.rev
      from v
      cross join lateral unnest(@SCHEMA@.link_ids(v.links)) t(x)
      join (select distinct u.x as src from unnest(p_src) u(x)) s on s.src = t.x
      where (v.op = 'delete') = p_dead
        and (p_data is null or v.data @> p_data) and (p_ends is null or @SCHEMA@.link_ids(v.links) @> p_ends)
        and (p_roles is null or @SCHEMA@.role_has(v.links, p_roles, s.src))
        and @SCHEMA@.row_visible(v.tenant, v.class, v.id, v.owner, v.tags, v.data, v.links, c_tenant, c_account, c_plan);
  end if;
end $$;

-- Рекурсивный обход (deep): потомки любой глубины до p_max по обратным ссылкам строк классов
-- p_classes. Видимость проверяется на каждом уровне: невидимый узел обрывает своё поддерево.
-- Циклы в данных обход не зацикливают. Для каждой пары (src, id) — наименьшая глубина.
create or replace function @SCHEMA@.find_deep(p_classes text[], p_roles text[], p_src uuid[], p_max int,
  p_at timestamptz default null)
returns table (src uuid, id uuid, rev int, depth int)
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_column
declare
  a jsonb := @SCHEMA@.acl_actor('READ');
  c_tenant uuid := (a->>'tenant')::uuid;
  c_account uuid := (a->>'account')::uuid;
  c_plan jsonb := a->'plan';
begin
  if c_account is null or p_src is null then
    return;
  end if;
  if p_at is null then
    return query with recursive d(src, id, rev, depth, seen) as (
        select s.src, e.id, e.rev, 1, array[s.src, e.id]
        from (select distinct u.x as src from unnest(p_src) u(x)) s
        cross join lateral (
          select x.id, x.rev, x.class, x.tenant, x.owner, x.tags, x.data, x.links from @SCHEMA@.entity x where x.ends @> array[s.src] offset 0) e
        where e.class = any (p_classes)
          and (p_roles is null or @SCHEMA@.role_has(e.links, p_roles, s.src))
          and @SCHEMA@.row_visible(e.tenant, e.class, e.id, e.owner, e.tags, e.data, e.links, c_tenant, c_account, c_plan)
      union all
        select d.src, e.id, e.rev, d.depth + 1, d.seen || e.id
        from d
        cross join lateral (
          select x.id, x.rev, x.class, x.tenant, x.owner, x.tags, x.data, x.links from @SCHEMA@.entity x where x.ends @> array[d.id] offset 0) e
        where d.depth < p_max and not (e.id = any (d.seen)) and e.class = any (p_classes)
          and (p_roles is null or @SCHEMA@.role_has(e.links, p_roles, d.id))
          and @SCHEMA@.row_visible(e.tenant, e.class, e.id, e.owner, e.tags, e.data, e.links, c_tenant, c_account, c_plan))
      select distinct on (d.src, d.id) d.src, d.id, d.rev, d.depth from d order by d.src, d.id, d.depth;
  else
    return query with recursive v as (
        select w.id, w.rev, w.links from (
          select distinct on (l.id) l.id, l.rev, l.op, l.class, l.tenant, l.owner, l.tags, l.data, l.links
          from @SCHEMA@.log l
          where l.class = any (p_classes) and l.at <= p_at
          order by l.id, l.rev desc) w
        where w.op <> 'delete' and @SCHEMA@.row_visible(w.tenant, w.class, w.id, w.owner, w.tags, w.data, w.links, c_tenant, c_account, c_plan)),
      d(src, id, rev, depth, seen) as (
        select s.src, v.id, v.rev, 1, array[s.src, v.id]
        from (select distinct u.x as src from unnest(p_src) u(x)) s
        join v on @SCHEMA@.link_ids(v.links) @> array[s.src]
        where p_roles is null or @SCHEMA@.role_has(v.links, p_roles, s.src)
      union all
        select d.src, v.id, v.rev, d.depth + 1, d.seen || v.id
        from d
        join v on @SCHEMA@.link_ids(v.links) @> array[d.id]
        where d.depth < p_max and not (v.id = any (d.seen))
          and (p_roles is null or @SCHEMA@.role_has(v.links, p_roles, d.id)))
      select distinct on (d.src, d.id) d.src, d.id, d.rev, d.depth from d order by d.src, d.id, d.depth;
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'role_ids(jsonb, text[])', 'role_has(jsonb, text[], uuid)',
    'find_ids(text[], jsonb, uuid[], uuid[], timestamptz, boolean)',
    'find_hop(text[], jsonb, uuid[], text[], uuid[], timestamptz, boolean)',
    'find_deep(text[], text[], uuid[], int, timestamptz)'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
-- построитель цепочек вызывает их от приложения; row_visible — внутри find_*
grant execute on function @SCHEMA@.role_ids(jsonb, text[]), @SCHEMA@.role_has(jsonb, text[], uuid),
  @SCHEMA@.find_ids(text[], jsonb, uuid[], uuid[], timestamptz, boolean),
  @SCHEMA@.find_hop(text[], jsonb, uuid[], text[], uuid[], timestamptz, boolean),
  @SCHEMA@.find_deep(text[], text[], uuid[], int, timestamptz) to @APP@;
