-- letopis 1.1 — история по журналу: diff и blame (план 1.1, §2.1, этап 1).
--
-- diff_versions и blame — с правами вызывающего (security invoker): журнал читается под политикой log_select,
-- поэтому чужие и скрытые версии в расчёт не попадают. Невидимая версия выглядит как пропуск номера
-- версии — такие результаты помечаются exact: false. Колонка log.changed приложению не выдана (ревью №1
-- точки А плана 1.1): пути версии описывают разницу с предыдущей версией, а та читателю может быть не видна;
-- blame получает их функцией владельца version_paths, только когда предыдущая версия видна. Строку журнала
-- целиком (l.*) приложение не читает — функции перечисляют колонки.
--   jsonb_changes — различия двух значений jsonb по путям;
--   row_changes   — различия двух снимков строки по разделам;
--   change_paths  — пути для колонки changed (пишут триггер правки и log_version);
--   row_leaves    — листья снимка строки (то, что объясняет blame);
--   version_paths — пути из changed тех версий, у которых предыдущая версия видна вызывающему;
--   diff_versions — что изменилось между двумя версиями или моментами (jsonb в виде ответа diff());
--   blame         — какая версия, кто, когда и почему последней изменила каждый лист (ответ blame()).

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
  ), m as (
    -- изменившиеся множественные концы: только они раскладываются на элементы, и разностью множеств, а не
    -- проверкой вхождения на каждый элемент — та шла квадратом длины, и правка любого поля объекта с тысячами
    -- целей стоила секунды в триггере правки (ревью №1 точки А)
    select r.key, coalesce(r.a, '[]'::jsonb) as a, coalesce(r.b, '[]'::jsonb) as b from r
    where r.a is distinct from r.b
      and (r.a is null or jsonb_typeof(r.a) = 'array') and (r.b is null or jsonb_typeof(r.b) = 'array')
  )
  select c.path, c.kind, c.before, c.after, null::text from @SCHEMA@.jsonb_changes(a_data, b_data, '{data}') c
  union all
  select array['links', r.key], case when r.a is null then 'added' when r.b is null then 'removed' else 'changed' end, r.a, r.b, null::text
  from r
  where r.a is distinct from r.b
    and not ((r.a is null or jsonb_typeof(r.a) = 'array') and (r.b is null or jsonb_typeof(r.b) = 'array'))
  union all
  select array['links', m.key], 'added', null::jsonb, d.v, d.v #>> '{}'
  from m cross join lateral (select jsonb_array_elements(m.b) except select jsonb_array_elements(m.a)) d(v)
  union all
  select array['links', m.key], 'removed', d.v, null::jsonb, d.v #>> '{}'
  from m cross join lateral (select jsonb_array_elements(m.a) except select jsonb_array_elements(m.b)) d(v)
  union all
  select array['tags'], 'added', null::jsonb, to_jsonb(d.t), d.t
  from (select unnest(coalesce(b_tags, '{}'::text[])) except select unnest(coalesce(a_tags, '{}'::text[]))) d(t)
  union all
  select array['tags'], 'removed', to_jsonb(d.t), null::jsonb, d.t
  from (select unnest(coalesce(a_tags, '{}'::text[])) except select unnest(coalesce(b_tags, '{}'::text[]))) d(t)
  union all
  select array['owner'], case when a_owner is null then 'added' when b_owner is null then 'removed' else 'changed' end,
         to_jsonb(a_owner), to_jsonb(b_owner), null::text
  where a_owner is distinct from b_owner
  union all
  select array['class'], case when a_class is null then 'added' when b_class is null then 'removed' else 'changed' end,
         to_jsonb(a_class), to_jsonb(b_class), null::text
  where a_class is distinct from b_class;
end;

-- до ревью №1 точки А помощники принимали строку журнала целиком; приложению она теперь недоступна (changed)
drop function if exists @SCHEMA@.version_changes(@SCHEMA@.log, @SCHEMA@.log);
drop function if exists @SCHEMA@.version_leaves(@SCHEMA@.log);

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

-- Листья снимка строки для blame: скаляры, массивы и пустые объекты data; роль одиночного конца; каждый id
-- множественного конца (путь — роль и id); каждый тег; owner; class.
create or replace function @SCHEMA@.row_leaves(p_data jsonb, p_links jsonb, p_tags text[], p_owner uuid, p_class text)
returns setof text[]
language sql immutable parallel safe
begin atomic
  with recursive w(path, v) as (
    select '{data}'::text[], p_data
    union all
    select w.path || k.key, w.v -> k.key
    from w cross join lateral jsonb_object_keys(case when jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) k(key)
    where jsonb_typeof(w.v) = 'object' and w.v <> '{}'::jsonb
  )
  select w.path from w where w.v is not null and not (jsonb_typeof(w.v) = 'object' and w.v <> '{}'::jsonb)
  union all
  select array['links', k.key] from jsonb_each(coalesce(p_links, '{}'::jsonb)) k(key, val) where jsonb_typeof(k.val) <> 'array'
  union all
  select array['links', k.key, e.v #>> '{}'] from jsonb_each(coalesce(p_links, '{}'::jsonb)) k(key, val)
    cross join lateral jsonb_array_elements(case when jsonb_typeof(k.val) = 'array' then k.val else '[]'::jsonb end) e(v)
  union all
  select array['tags', t.t] from unnest(coalesce(p_tags, '{}'::text[])) t(t)
  union all
  select array['owner'] where p_owner is not null
  union all
  select array['class'] where p_class is not null;
end;

-- Пути из колонки changed для blame. Колонка приложению не выдана: пути версии описывают разницу с предыдущей
-- версией, а та читателю может быть не видна — условие ACL на теги, данные или концы скрывает одну версию и
-- пропускает следующую, и в путях видны снятые теги, цели и ключи скрытой (ревью №1 точки А). Пути отдаются
-- только для версии, у которой и она сама, и предыдущая версия того же id — настоящие версии, видимые
-- вызывающему (то же условие, что у политики log_select: row_visible с планом прав чтения). Такую разницу
-- вызывающий и так получит сравнением двух видимых ему строк.
create or replace function @SCHEMA@.version_paths(p_ids uuid[], p_revs int[])
returns table (id uuid, rev int, changed jsonb)
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
  return query
    select n.id, n.rev, n.changed
    from unnest(p_ids, p_revs) q(id, rev)
    join @SCHEMA@.log n on n.id = q.id and n.rev = q.rev
    join @SCHEMA@.log o on o.id = n.id and o.rev = n.rev - 1
    where n.changed is not null
      and n.op not in ('purge', 'trim', 'reset') and o.op not in ('purge', 'trim', 'reset')
      and @SCHEMA@.row_visible(n.tenant, n.class, n.id, n.owner, n.tags, n.data, n.links, c_tenant, c_account, c_plan)
      and @SCHEMA@.row_visible(o.tenant, o.class, o.id, o.owner, o.tags, o.data, o.links, c_tenant, c_account, c_plan);
end $$;

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
  t record;
  f record;
  has_f boolean;
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
  select l.id, l.rev, l.at, l.seq, l.op, l.class, l.data, l.links, l.tags, l.owner into t from @SCHEMA@.log l
  where l.id = any (ids) and l.op not in ('purge', 'trim', 'reset') and not (p_follow and l.op = 'delete' and l.moved is not null)
    and (p_to is null or (l.id = p_id and l.rev = p_to)) and (p_to_at is null or l.at <= p_to_at)
  order by l.at desc, l.seq desc limit 1;
  if t.id is null then
    return jsonb_build_object('id', p_id, 'class', null, 'from', null, 'to', null, 'changes', '[]'::jsonb);
  end if;
  if p_from is not null then
    select l.id, l.rev, l.at, l.op, l.class, l.data, l.links, l.tags, l.owner into f from @SCHEMA@.log l
    where l.id = p_id and l.rev = p_from and l.op not in ('purge', 'trim', 'reset');
    has_f := f.id is not null;
  elsif p_from_at is not null then
    select l.id, l.rev, l.at, l.op, l.class, l.data, l.links, l.tags, l.owner into f from @SCHEMA@.log l
    where l.id = any (ids) and l.op not in ('purge', 'trim', 'reset') and not (p_follow and l.op = 'delete' and l.moved is not null)
      and l.at <= p_from_at
    order by l.at desc, l.seq desc limit 1;
    -- срез на момент: удалённого объекта тогда не было
    has_f := f.id is not null and f.op <> 'delete';
  else
    select l.id, l.rev, l.at, l.op, l.class, l.data, l.links, l.tags, l.owner into f from @SCHEMA@.log l
    where l.id = any (ids) and l.op not in ('purge', 'trim', 'reset') and not (p_follow and l.op = 'delete' and l.moved is not null)
      and (l.at, l.seq) < (t.at, t.seq)
    order by l.at desc, l.seq desc limit 1;
    has_f := f.id is not null;
  end if;
  return jsonb_build_object(
    'id', p_id,
    'class', t.class,
    'from', case when not has_f then null
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
      from @SCHEMA@.row_changes(case when has_f then f.data end, case when has_f then f.links end,
        case when has_f then f.tags end, case when has_f then f.owner end, case when has_f then f.class end,
        t.data, t.links, t.tags, t.owner, t.class) c), '[]'::jsonb) end);
end $$;

-- blame: для каждого листа версии (последней на момент p_at или текущей) — версия, которая последней его
-- изменила, с автором, агентом, видом операции и причиной (ответ терминала blame()). Просматривается не
-- больше p_limit последних версий, назад через смену id (первая версия нового id указывает на прежний
-- колонкой moved). Пропуск номера версии (прореживание, обрезка, невидимая версия) — выпавшая версия могла
-- изменить лист и вернуть значение, поэтому лист точен (exact), только если от текущей версии до найденной
-- пропусков нет; лист, не менявшийся в просмотренной истории, принадлежит самой старой просмотренной версии —
-- exact, только если это версия 1 и пропусков нет вовсе. complete — история просмотрена целиком и без пропусков.
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
  t record;
  prev uuid;
  lim int := greatest(coalesce(p_limit, 1000), 1);
  res jsonb;
begin
  select l.id, l.rev, l.at, l.seq, l.op, l.class, l.data, l.links, l.tags, l.owner into t from @SCHEMA@.log l
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
    select l.id, l.rev, l.at, l.seq, l.op, l.author, l.agent, l.reason, l.data, l.links, l.tags, l.owner, l.class,
           row_number() over o as n, lead(l.id) over o as o_id, lead(l.rev) over o as o_rev,
           lead(l.data) over o as o_data, lead(l.links) over o as o_links, lead(l.tags) over o as o_tags,
           lead(l.owner) over o as o_owner, lead(l.class) over o as o_class
    from @SCHEMA@.log l
    where l.id = any (ids) and l.op not in ('purge', 'trim', 'reset') and not (l.op = 'delete' and l.moved is not null)
      and (l.at, l.seq) <= (t.at, t.seq)
    window o as (order by l.at desc, l.seq desc)
    order by l.at desc, l.seq desc limit lim + 1
  ), w as (
    select * from v where v.n <= lim
  ), gaps as (
    select w.n from w where w.o_id = w.id and w.rev - w.o_rev > 1
  ), stored as materialized (
    -- пути колонки changed (ревизия 6) — только у пар одного id без пропуска номера: version_paths отдаёт их,
    -- лишь когда и предыдущая версия видна вызывающему; после пропуска пути описывали бы разницу с выпавшей
    -- версией, а не с соседней в окне (ревью №1 точки А)
    select p.id, p.rev, p.changed from @SCHEMA@.version_paths(
      array(select w.id from w where w.o_id = w.id and w.o_rev = w.rev - 1),
      array(select w.rev from w where w.o_id = w.id and w.o_rev = w.rev - 1)) p
  ), ch as (
    select w.n, array(select jsonb_array_elements_text(c.p)) as path
    from w join stored s on s.id = w.id and s.rev = w.rev cross join lateral jsonb_array_elements(s.changed) c(p)
    union all
    -- остальные пары (пропуск номера, смена id, версия без путей — создание, загрузчик, импорт) — сравнение
    -- соседних версий окна
    select w.n, c.path || case when c.elem is not null then array[c.elem] else '{}'::text[] end
    from w cross join lateral @SCHEMA@.row_changes(w.o_data, w.o_links, w.o_tags, w.o_owner, w.o_class,
      w.data, w.links, w.tags, w.owner, w.class) c
    where w.o_id is not null and not exists (select 1 from stored s where s.id = w.id and s.rev = w.rev)
  ), leaves as (
    select x as path from @SCHEMA@.row_leaves(t.data, t.links, t.tags, t.owner, t.class) x
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
        'exact', case when h.n is not null then not exists (select 1 from gaps g where g.n <= h.n)
                      else (select o.rev = 1 from oldest o) and not (select c.cut from cut c) and not exists (select 1 from gaps) end)
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
    'jsonb_changes(jsonb, jsonb, text[])',
    'row_changes(jsonb, jsonb, text[], uuid, text, jsonb, jsonb, text[], uuid, text)',
    'change_paths(jsonb, jsonb, text[], uuid, text, jsonb, jsonb, text[], uuid, text)',
    'row_leaves(jsonb, jsonb, text[], uuid, text)', 'version_paths(uuid[], int[])',
    'diff_versions(uuid, int, int, timestamptz, timestamptz, boolean)', 'blame(uuid, timestamptz, int)'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
-- терминалы diff() и blame() вызывают их от приложения; сырой SQL — так же, под RLS журнала (version_paths
-- проверяет видимость обеих версий сама)
grant execute on function @SCHEMA@.jsonb_changes(jsonb, jsonb, text[]),
  @SCHEMA@.row_changes(jsonb, jsonb, text[], uuid, text, jsonb, jsonb, text[], uuid, text),
  @SCHEMA@.change_paths(jsonb, jsonb, text[], uuid, text, jsonb, jsonb, text[], uuid, text),
  @SCHEMA@.row_leaves(jsonb, jsonb, text[], uuid, text), @SCHEMA@.version_paths(uuid[], int[]),
  @SCHEMA@.diff_versions(uuid, int, int, timestamptz, timestamptz, boolean),
  @SCHEMA@.blame(uuid, timestamptz, int) to @APP@;
