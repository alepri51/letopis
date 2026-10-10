-- letopis 1.1 — история по журналу: diff и blame (план 1.1, §2.1, этап 1).
--
-- Все функции — с правами вызывающего (security invoker): журнал читается под политикой log_select,
-- поэтому чужие и скрытые версии в расчёт не попадают. Невидимая версия выглядит как пропуск номера
-- версии — такие результаты помечаются exact: false.
--   jsonb_changes   — различия двух значений jsonb по путям;
--   version_changes — различия двух версий журнала по разделам строки;
--   version_leaves  — листья версии (то, что объясняет blame);
--   diff_versions   — что изменилось между двумя версиями или моментами (jsonb в виде ответа diff());
--   blame           — какая версия, кто, когда и почему последней изменила каждый лист (ответ blame()).

-- Различия значений по путям: объекты — по ключам рекурсивно, массивы и скаляры — целиком. Отсутствующий
-- ключ (SQL NULL) и JSON null различаются: added — ключа не было, removed — ключа не стало, changed —
-- значение другое. Добавленный или удалённый объект раскрывается до листьев; пустой объект — лист.
create or replace function @SCHEMA@.jsonb_changes(p_a jsonb, p_b jsonb, p_prefix text[] default '{}')
returns table (path text[], kind text, before jsonb, after jsonb)
language sql immutable parallel safe
begin atomic
  with recursive w(path, a, b) as (
    select p_prefix, p_a, p_b
    union all
    select w.path || k.key, w.a -> k.key, w.b -> k.key
    from w cross join lateral (
      select jsonb_object_keys(case when jsonb_typeof(w.a) = 'object' then w.a else '{}'::jsonb end) as key
      union
      select jsonb_object_keys(case when jsonb_typeof(w.b) = 'object' then w.b else '{}'::jsonb end)
    ) k
    where (w.a is null or jsonb_typeof(w.a) = 'object') and (w.b is null or jsonb_typeof(w.b) = 'object')
      and w.a is distinct from w.b
      and not (w.a is null and w.b = '{}'::jsonb) and not (w.b is null and w.a = '{}'::jsonb)
  )
  select w.path, case when w.a is null then 'added' when w.b is null then 'removed' else 'changed' end, w.a, w.b
  from w
  where w.a is distinct from w.b
    and not ((w.a is null or jsonb_typeof(w.a) = 'object') and (w.b is null or jsonb_typeof(w.b) = 'object')
             and not (w.a is null and w.b = '{}'::jsonb) and not (w.b is null and w.a = '{}'::jsonb))
  order by 1;
end;

-- Различия двух снимков строки по разделам: data — jsonb_changes с путём от 'data'; одиночный конец —
-- значение целиком; множественный конец и теги — множества: added и removed по каждому элементу (elem —
-- сам элемент); owner и class — значение. Снимок «до» пуст (объекта не было): всё added.
create or replace function @SCHEMA@.row_changes(a_data jsonb, a_links jsonb, a_tags text[], a_owner uuid, a_class text,
  b_data jsonb, b_links jsonb, b_tags text[], b_owner uuid, b_class text)
returns table (path text[], kind text, before jsonb, after jsonb, elem text)
language sql immutable parallel safe
begin atomic
  with r as (
    select k.key, a_links -> k.key as a, b_links -> k.key as b
    from (select jsonb_object_keys(coalesce(a_links, '{}'::jsonb)) as key
          union select jsonb_object_keys(coalesce(b_links, '{}'::jsonb))) k
  )
  select c.path, c.kind, c.before, c.after, null::text from @SCHEMA@.jsonb_changes(a_data, b_data, '{data}') c
  union all
  select array['links', r.key], case when r.a is null then 'added' when r.b is null then 'removed' else 'changed' end, r.a, r.b, null::text
  from r
  where r.a is distinct from r.b
    and not ((r.a is null or jsonb_typeof(r.a) = 'array') and (r.b is null or jsonb_typeof(r.b) = 'array'))
  union all
  select array['links', r.key], 'added', null::jsonb, e.v, e.v #>> '{}'
  from r cross join lateral jsonb_array_elements(case when jsonb_typeof(r.b) = 'array' then r.b else '[]'::jsonb end) e(v)
  where (r.a is null or jsonb_typeof(r.a) = 'array') and not coalesce(r.a @> jsonb_build_array(e.v), false)
  union all
  select array['links', r.key], 'removed', e.v, null::jsonb, e.v #>> '{}'
  from r cross join lateral jsonb_array_elements(case when jsonb_typeof(r.a) = 'array' then r.a else '[]'::jsonb end) e(v)
  where (r.b is null or jsonb_typeof(r.b) = 'array') and not coalesce(r.b @> jsonb_build_array(e.v), false)
  union all
  select array['tags'], 'added', null::jsonb, to_jsonb(t.t), t.t from unnest(coalesce(b_tags, '{}'::text[])) t(t)
  where not (t.t = any (coalesce(a_tags, '{}'::text[])))
  union all
  select array['tags'], 'removed', to_jsonb(t.t), null::jsonb, t.t from unnest(coalesce(a_tags, '{}'::text[])) t(t)
  where not (t.t = any (coalesce(b_tags, '{}'::text[])))
  union all
  select array['owner'], case when a_owner is null then 'added' when b_owner is null then 'removed' else 'changed' end,
         to_jsonb(a_owner), to_jsonb(b_owner), null::text
  where a_owner is distinct from b_owner
  union all
  select array['class'], case when a_class is null then 'added' when b_class is null then 'removed' else 'changed' end,
         to_jsonb(a_class), to_jsonb(b_class), null::text
  where a_class is distinct from b_class;
end;


-- Различия двух версий журнала (diff, blame): row_changes по их снимкам.
drop function if exists @SCHEMA@.version_changes(@SCHEMA@.log, @SCHEMA@.log);
create or replace function @SCHEMA@.version_changes(p_a @SCHEMA@.log, p_b @SCHEMA@.log)
returns table (path text[], kind text, before jsonb, after jsonb, elem text)
language sql immutable parallel safe
begin atomic
  select * from @SCHEMA@.row_changes(p_a.data, p_a.links, p_a.tags, p_a.owner, p_a.class, p_b.data, p_b.links, p_b.tags, p_b.owner, p_b.class);
end;

-- Пути изменения для колонки log.changed (ревизия 6): пути row_changes, у элемента множества — с самим
-- элементом в конце (['links', роль, id], ['tags', тег]). Пишут триггер правки и log_version.
create or replace function @SCHEMA@.change_paths(a_data jsonb, a_links jsonb, a_tags text[], a_owner uuid, a_class text,
  b_data jsonb, b_links jsonb, b_tags text[], b_owner uuid, b_class text)
returns jsonb
language sql immutable parallel safe
begin atomic
  select coalesce(jsonb_agg(to_jsonb(c.path || case when c.elem is not null then array[c.elem] else '{}'::text[] end)
                            order by c.path, c.elem), '[]'::jsonb)
  from @SCHEMA@.row_changes(a_data, a_links, a_tags, a_owner, a_class, b_data, b_links, b_tags, b_owner, b_class) c;
end;

-- Листья версии для blame: скаляры, массивы и пустые объекты data; роль одиночного конца; каждый id
-- множественного конца (путь — роль и id); каждый тег; owner; class.
create or replace function @SCHEMA@.version_leaves(p_v @SCHEMA@.log)
returns setof text[]
language sql immutable parallel safe
begin atomic
  with recursive w(path, v) as (
    select '{data}'::text[], p_v.data
    union all
    select w.path || k.key, w.v -> k.key
    from w cross join lateral jsonb_object_keys(case when jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) k(key)
    where jsonb_typeof(w.v) = 'object' and w.v <> '{}'::jsonb
  )
  select w.path from w where w.v is not null and not (jsonb_typeof(w.v) = 'object' and w.v <> '{}'::jsonb)
  union all
  select array['links', k.key] from jsonb_each(coalesce(p_v.links, '{}'::jsonb)) k(key, val) where jsonb_typeof(k.val) <> 'array'
  union all
  select array['links', k.key, e.v #>> '{}'] from jsonb_each(coalesce(p_v.links, '{}'::jsonb)) k(key, val)
    cross join lateral jsonb_array_elements(case when jsonb_typeof(k.val) = 'array' then k.val else '[]'::jsonb end) e(v)
  union all
  select array['tags', t.t] from unnest(coalesce(p_v.tags, '{}'::text[])) t(t)
  union all
  select array['owner'] where p_v.owner is not null
  union all
  select array['class'] where p_v.class is not null;
end;

-- diff: что изменилось между двумя версиями объекта (ответ терминала diff()). «После» — номер версии
-- p_to, последняя версия на момент p_to_at или последняя вообще; «до» — номер p_from, последняя живая
-- версия на момент p_from_at (объекта не было — null, все пути added) или версия перед «после».
-- p_follow — через смену id (reclass, rekey) по колонке moved; надгробие переноса — не версия.
-- «После» — надгробие: to.deleted, изменения полей не перечисляются.
create or replace function @SCHEMA@.diff_versions(p_id uuid, p_from int default null, p_to int default null,
  p_from_at timestamptz default null, p_to_at timestamptz default null, p_follow boolean default false)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
-- JIT: оценка стоимости запроса по журналу завышена (jsonb_array_elements — 100 строк на вызов), и компиляция
-- JIT занимала бы больше секунды при исполнении в миллисекунды (замер этапа 1б)
set jit = off
as $$
declare
  ids uuid[] := array[p_id];
  t @SCHEMA@.log;
  f @SCHEMA@.log;
begin
  if p_follow then
    with recursive g(id) as (
      select p_id
      union
      select x.id from g cross join lateral (
        select l.moved as id from @SCHEMA@.log l where l.id = g.id and l.moved is not null
        union select l.id from @SCHEMA@.log l where l.moved = g.id) x)
    select array_agg(g.id) into ids from g;
  end if;
  select l.* into t from @SCHEMA@.log l
  where l.id = any (ids) and l.op not in ('purge', 'trim', 'reset') and not (p_follow and l.op = 'delete' and l.moved is not null)
    and (p_to is null or (l.id = p_id and l.rev = p_to)) and (p_to_at is null or l.at <= p_to_at)
  order by l.at desc, l.seq desc limit 1;
  if t.id is null then
    return jsonb_build_object('id', p_id, 'class', null, 'from', null, 'to', null, 'changes', '[]'::jsonb);
  end if;
  if p_from is not null then
    select l.* into f from @SCHEMA@.log l where l.id = p_id and l.rev = p_from and l.op not in ('purge', 'trim', 'reset');
  elsif p_from_at is not null then
    select l.* into f from @SCHEMA@.log l
    where l.id = any (ids) and l.op not in ('purge', 'trim', 'reset') and not (p_follow and l.op = 'delete' and l.moved is not null)
      and l.at <= p_from_at
    order by l.at desc, l.seq desc limit 1;
    -- срез на момент: удалённого объекта тогда не было
    if f.op = 'delete' then f := null; end if;
  else
    select l.* into f from @SCHEMA@.log l
    where l.id = any (ids) and l.op not in ('purge', 'trim', 'reset') and not (p_follow and l.op = 'delete' and l.moved is not null)
      and (l.at, l.seq) < (t.at, t.seq)
    order by l.at desc, l.seq desc limit 1;
  end if;
  return jsonb_build_object(
    'id', p_id,
    'class', t.class,
    'from', case when f.id is null then null
                 else jsonb_build_object('rev', f.rev, 'at', f.at)
                      || case when f.id <> p_id then jsonb_build_object('id', f.id) else '{}'::jsonb end end,
    'to', jsonb_build_object('rev', t.rev, 'at', t.at)
          || case when t.id <> p_id then jsonb_build_object('id', t.id) else '{}'::jsonb end
          || case when t.op = 'delete' then '{"deleted": true}'::jsonb else '{}'::jsonb end,
    'changes', case when t.op = 'delete' then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('path', to_jsonb(c.path), 'kind', c.kind)
               || case when c.before is not null then jsonb_build_object('before', c.before) else '{}'::jsonb end
               || case when c.after is not null then jsonb_build_object('after', c.after) else '{}'::jsonb end
             order by c.path, c.kind, c.before::text, c.after::text)
      from @SCHEMA@.version_changes(f, t) c), '[]'::jsonb) end);
end $$;

-- blame: для каждого листа версии (последней на момент p_at или текущей) — версия, которая последней его
-- изменила, с автором, агентом, видом операции и причиной (ответ терминала blame()). Просматривается не
-- больше p_limit последних версий, назад через смену id (первая версия нового id указывает на прежний
-- колонкой moved). Пропуск номера версии (прореживание, невидимая версия) — exact: false у листьев этой
-- пары; лист, не менявшийся в просмотренной истории, принадлежит самой старой просмотренной версии —
-- exact, только если это версия 1. complete — история просмотрена целиком и без пропусков.
create or replace function @SCHEMA@.blame(p_id uuid, p_at timestamptz default null, p_limit int default 1000)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
-- JIT: оценка стоимости запроса по журналу завышена (jsonb_array_elements — 100 строк на вызов), и компиляция
-- JIT занимала бы больше секунды при исполнении в миллисекунды (замер этапа 1б)
set jit = off
as $$
declare
  ids uuid[] := array[p_id];
  t @SCHEMA@.log;
  prev uuid;
  lim int := greatest(coalesce(p_limit, 1000), 1);
  res jsonb;
begin
  select l.* into t from @SCHEMA@.log l
  where l.id = p_id and l.op not in ('purge', 'trim', 'reset') and (p_at is null or l.at <= p_at)
  order by l.rev desc limit 1;
  if t.id is null then return null; end if;
  loop
    select l.moved into prev from @SCHEMA@.log l
    where l.id = ids[cardinality(ids)] and l.moved is not null and l.op in ('reclass', 'rekey') order by l.rev limit 1;
    exit when prev is null or prev = any (ids);
    ids := ids || prev;
  end loop;
  with v as (
    -- соседняя более старая версия — окном (lead), а не соединением CTE с собой: соединение шло бы вложенным
    -- циклом по квадрату числа версий
    select l as r, l.id, l.rev, l.at, l.seq, l.op, l.author, l.agent, l.reason, l.changed,
           row_number() over o as n, lead(l.id) over o as o_id, lead(l.rev) over o as o_rev, lead(l) over o as o_r
    from @SCHEMA@.log l
    where l.id = any (ids) and l.op not in ('purge', 'trim', 'reset') and not (l.op = 'delete' and l.moved is not null)
      and (l.at, l.seq) <= (t.at, t.seq)
    window o as (order by l.at desc, l.seq desc)
    order by l.at desc, l.seq desc limit lim + 1
  ), w as (
    select * from v where v.n <= lim
  ), gaps as (
    select w.n from w where w.o_id = w.id and w.rev - w.o_rev > 1
  ), bare as materialized (
    -- пары, у новой версии которых путей нет (создание, загрузчик, импорт): только их сравнивать
    select w.n, w.o_r as o, w.r from w where w.changed is null and w.o_id is not null
  ), ch as (
    -- пути изменения версии из колонки changed (ревизия 6); версия без них — сравнение с соседней
    select nw.n, array(select jsonb_array_elements_text(c.p)) as path
    from w nw cross join lateral jsonb_array_elements(nw.changed) c(p)
    where nw.changed is not null
    union all
    select z.n, c.path || case when c.elem is not null then array[c.elem] else '{}'::text[] end
    from bare z cross join lateral @SCHEMA@.version_changes(z.o, z.r) c
  ), leaves as (
    select x as path from @SCHEMA@.version_leaves(t) x
  ), hit as (
    select lv.path, min(ch.n) as n
    -- лист и путь изменения совпадают по префиксу в любую сторону: изменён сам лист, объект над ним или
    -- лист внутри (пустой объект стал непустым); элемент множества — по пути с элементом
    from leaves lv join ch on lv.path[1:cardinality(ch.path)] = ch.path or ch.path[1:cardinality(lv.path)] = lv.path
    group by lv.path
  ), oldest as (
    select w.n, w.rev from w order by w.n desc limit 1
  ), cut as (
    select count(*) > lim as cut from v
  ), fields as (
    select lv.path,
      jsonb_build_object('path', to_jsonb(lv.path), 'rev', cv.rev, 'at', cv.at, 'author', cv.author, 'op', cv.op,
        'exact', case when h.n is not null then not exists (select 1 from gaps g where g.n = h.n)
                      else (select o.rev = 1 from oldest o) and not (select c.cut from cut c) end)
      || case when cv.id <> p_id then jsonb_build_object('id', cv.id) else '{}'::jsonb end
      || case when cv.agent is not null then jsonb_build_object('agent', cv.agent) else '{}'::jsonb end
      || case when cv.reason is not null then jsonb_build_object('reason', cv.reason) else '{}'::jsonb end as obj
    from leaves lv
    left join hit h on h.path = lv.path
    join w cv on cv.n = coalesce(h.n, (select o.n from oldest o))
  )
  select jsonb_build_object('id', p_id, 'class', t.class, 'rev', t.rev,
           'complete', (select o.rev = 1 from oldest o) and not (select c.cut from cut c) and not exists (select 1 from gaps),
           'fields', coalesce((select jsonb_agg(f.obj order by f.path) from fields f), '[]'::jsonb))
         || case when t.op = 'delete' then '{"deleted": true}'::jsonb else '{}'::jsonb end
  into res;
  return res;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'jsonb_changes(jsonb, jsonb, text[])', 'version_changes(@SCHEMA@.log, @SCHEMA@.log)', 'version_leaves(@SCHEMA@.log)',
    'row_changes(jsonb, jsonb, text[], uuid, text, jsonb, jsonb, text[], uuid, text)',
    'change_paths(jsonb, jsonb, text[], uuid, text, jsonb, jsonb, text[], uuid, text)',
    'diff_versions(uuid, int, int, timestamptz, timestamptz, boolean)', 'blame(uuid, timestamptz, int)'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
-- терминалы diff() и blame() вызывают их от приложения; сырой SQL — так же, под RLS журнала
grant execute on function @SCHEMA@.jsonb_changes(jsonb, jsonb, text[]),
  @SCHEMA@.row_changes(jsonb, jsonb, text[], uuid, text, jsonb, jsonb, text[], uuid, text),
  @SCHEMA@.change_paths(jsonb, jsonb, text[], uuid, text, jsonb, jsonb, text[], uuid, text),
  @SCHEMA@.version_changes(@SCHEMA@.log, @SCHEMA@.log), @SCHEMA@.version_leaves(@SCHEMA@.log),
  @SCHEMA@.diff_versions(uuid, int, int, timestamptz, timestamptz, boolean),
  @SCHEMA@.blame(uuid, timestamptz, int) to @APP@;
