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

-- Версии классов p_classes, действовавшие на момент p_at (последняя версия id среди версий этих классов
-- не позже p_at; p_at null — последняя вообще), которые ссылаются на p_src: кандидаты — версии,
-- ссылавшиеся на p_src (GIN log_ends), затем последняя версия каждого кандидата (log_id_rev); ссылку
-- проверяет она. Класс и время кандидатов — после пробы (offset 0): иначе планировщик объединяет пробу
-- с log_class_tenant_at и читает весь класс в индексе. Без прав: вызывают только функции владельца find_*,
-- видимость — на них.
create or replace function @SCHEMA@.log_refs_at(p_classes text[], p_src uuid, p_at timestamptz)
returns setof @SCHEMA@.log
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  select w.* from (
      select distinct r.id from (
        select l.id, l.class, l.at from @SCHEMA@.log l where @SCHEMA@.link_ids(l.links) @> array[p_src] offset 0) r
      where r.class = any (p_classes) and r.at <= coalesce(p_at, 'infinity'::timestamptz)) c
  cross join lateral (
      select y.* from (select x.* from @SCHEMA@.log x where x.id = c.id offset 0) y
      where y.at <= coalesce(p_at, 'infinity'::timestamptz)
      order by y.rev desc limit 1) w
  -- класс — у последней версии на момент, а не среди версий классов шага (план 2.0, 7.1 №1)
  where w.class = any (p_classes) and @SCHEMA@.link_ids(w.links) @> array[p_src]
$$;

-- id строк классов p_classes: по вложению в data (GIN entity_data), по целям концов (GIN entity_ends),
-- по списку id (первичный ключ) или по классу (entity_class_tenant).
-- Арендатор строки — явным условием (доработки после точки Б): row_visible пропускает только строки арендатора
-- сессии и System и свои членства (member) в других арендаторах, поэтому поиск сразу берёт строки этих двух
-- арендаторов, а свои членства — отдельным запросом по концу User; иначе цена поиска росла с данными других
-- арендаторов с теми же именами классов. По списку id условие ничего не даёт — там первичный ключ.
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
  v_tenants uuid[] := array[(a->>'tenant')::uuid, '@SYSTEM@'::uuid];
  v_member boolean := 'member' = any (p_classes);
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
      return;
    elsif p_data is not null and p_ends is not null then
      return query select e.id, e.rev from @SCHEMA@.entity e
        where e.class = any (p_classes) and e.tenant = any (v_tenants) and e.data @> p_data and e.ends @> p_ends
          and @SCHEMA@.row_visible(e.tenant, e.class, e.id, e.owner, e.tags, e.data, e.links, c_tenant, c_account, c_plan);
    elsif p_data is not null then
      return query select e.id, e.rev from @SCHEMA@.entity e
        where e.class = any (p_classes) and e.tenant = any (v_tenants) and e.data @> p_data
          and @SCHEMA@.row_visible(e.tenant, e.class, e.id, e.owner, e.tags, e.data, e.links, c_tenant, c_account, c_plan);
    elsif p_ends is not null then
      return query select e.id, e.rev from @SCHEMA@.entity e
        where e.class = any (p_classes) and e.tenant = any (v_tenants) and e.ends @> p_ends
          and @SCHEMA@.row_visible(e.tenant, e.class, e.id, e.owner, e.tags, e.data, e.links, c_tenant, c_account, c_plan);
    else
      return query select e.id, e.rev from @SCHEMA@.entity e
        where e.class = any (p_classes) and e.tenant = any (v_tenants)
          and @SCHEMA@.row_visible(e.tenant, e.class, e.id, e.owner, e.tags, e.data, e.links, c_tenant, c_account, c_plan);
    end if;
    -- свои членства в других арендаторах: по концу User (GIN entity_ends)
    if v_member then
      return query select e.id, e.rev from @SCHEMA@.entity e
        where e.class = 'member' and e.ends @> array[c_account] and not (e.tenant = any (v_tenants))
          and (p_data is null or e.data @> p_data) and (p_ends is null or e.ends @> p_ends)
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
  elsif p_ends is not null then
    -- по целям концов — от версий, ссылавшихся на первую цель (GIN log_ends); арендатор — после пробы
    return query select v.id, v.rev from @SCHEMA@.log_refs_at(p_classes, p_ends[1], p_at) v
      where (v.tenant = any (v_tenants) or v.class = 'member')
        and (v.op = 'delete') = p_dead
        and (p_data is null or v.data @> p_data) and @SCHEMA@.link_ids(v.links) @> p_ends
        and @SCHEMA@.row_visible(v.tenant, v.class, v.id, v.owner, v.tags, v.data, v.links, c_tenant, c_account, c_plan);
  else
    -- арендатор id неизменен: условие до distinct on не меняет, какая
    -- версия id последняя (индекс log_class_tenant_at)
    -- кандидаты — по классу (индекс log_class_tenant_at), последняя версия id на момент — любого класса, и класс
    -- проверяется у неё (план 2.0, 7.1 №1)
    return query select v.id, v.rev from (
        select distinct l.id from @SCHEMA@.log l
        where l.class = any (p_classes) and l.tenant = any (v_tenants) and l.at <= coalesce(p_at, 'infinity'::timestamptz)) c
      cross join lateral (
        select y.id, y.rev, y.op, y.class, y.tenant, y.owner, y.tags, y.data, y.links
        from @SCHEMA@.log y where y.id = c.id and y.at <= coalesce(p_at, 'infinity'::timestamptz)
        order by y.rev desc limit 1) v
      where v.class = any (p_classes) and (v.op = 'delete') = p_dead
        and (p_data is null or v.data @> p_data) and (p_ends is null or @SCHEMA@.link_ids(v.links) @> p_ends)
        and @SCHEMA@.row_visible(v.tenant, v.class, v.id, v.owner, v.tags, v.data, v.links, c_tenant, c_account, c_plan);
    -- свои членства в других арендаторах: версии, ссылавшиеся на аккаунт (GIN log_ends)
    if v_member then
      return query select v.id, v.rev from @SCHEMA@.log_refs_at(array['member'], c_account, p_at) v
        where not (v.tenant = any (v_tenants))
          and (v.op = 'delete') = p_dead
          and (p_data is null or v.data @> p_data) and (p_ends is null or @SCHEMA@.link_ids(v.links) @> p_ends)
          and @SCHEMA@.row_visible(v.tenant, v.class, v.id, v.owner, v.tags, v.data, v.links, c_tenant, c_account, c_plan);
    end if;
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
    -- на каждый id источника — версии, ссылавшиеся на него (log_refs_at), а не все версии класса
    return query select s.src, v.id, v.rev
      from (select distinct u.x as src from unnest(p_src) u(x)) s
      cross join lateral @SCHEMA@.log_refs_at(p_classes, s.src, p_at) v
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
    -- уровень за уровнем: версии на момент, ссылавшиеся на узел (log_refs_at), а не все версии класса
    return query with recursive d(src, id, rev, depth, seen) as (
        select s.src, v.id, v.rev, 1, array[s.src, v.id]
        from (select distinct u.x as src from unnest(p_src) u(x)) s
        cross join lateral @SCHEMA@.log_refs_at(p_classes, s.src, p_at) v
        where v.op <> 'delete'
          and (p_roles is null or @SCHEMA@.role_has(v.links, p_roles, s.src))
          and @SCHEMA@.row_visible(v.tenant, v.class, v.id, v.owner, v.tags, v.data, v.links, c_tenant, c_account, c_plan)
      union all
        select d.src, v.id, v.rev, d.depth + 1, d.seen || v.id
        from d
        cross join lateral @SCHEMA@.log_refs_at(p_classes, d.id, p_at) v
        where d.depth < p_max and not (v.id = any (d.seen)) and v.op <> 'delete'
          and (p_roles is null or @SCHEMA@.role_has(v.links, p_roles, d.id))
          and @SCHEMA@.row_visible(v.tenant, v.class, v.id, v.owner, v.tags, v.data, v.links, c_tenant, c_account, c_plan))
      select distinct on (d.src, d.id) d.src, d.id, d.rev, d.depth from d order by d.src, d.id, d.depth;
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'role_ids(jsonb, text[])', 'role_has(jsonb, text[], uuid)', 'log_refs_at(text[], uuid, timestamptz)',
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
