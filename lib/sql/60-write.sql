-- letopis 1.0 — конвейер записи (план, §2.5, §2.7, §2.10, этап 1, п. 7–11).
--
-- Приложение пишет обычными insert, update, delete; всё проверяют триггеры entity. У каждого
-- триггера условие when (current_user <> владелец): изменения, которые делает функция владельца
-- (в том числе сами триггерные функции — они security definer), триггеры не перепроверяют,
-- поэтому функции владельца обязаны проверять всё сами, сами писать журнал и сами посылать NOTIFY.

-- Время версии: обёртка над clock_timestamp(); тест монотонности подменяет её в своей схеме.
create or replace function @SCHEMA@.now_ts() returns timestamptz
language sql volatile
return clock_timestamp();

-- Блокировки семейства (этап 1, п. 10): писатели и загрузчик берут разделяемую блокировку корня
-- семейства, ужесточение описания — исключительную. Форма с двумя int4 — отдельное от
-- пользовательского lock() (один bigint) пространство ключей advisory-блокировок.
create or replace function @SCHEMA@.family_lock(p_root text, p_exclusive boolean) returns void
language plpgsql volatile
as $$
begin
  if p_exclusive then
    perform pg_advisory_xact_lock(19540, hashtext('@SCHEMA_NAME@:' || p_root));
  else
    perform pg_advisory_xact_lock_shared(19540, hashtext('@SCHEMA_NAME@:' || p_root));
  end if;
end $$;

-- Список классов конца: строка или массив строк → отсортированный jsonb-массив.
create or replace function @SCHEMA@.class_set(p jsonb) returns jsonb
language sql immutable parallel safe
return (
  select coalesce(jsonb_agg(x order by x), '[]'::jsonb)
  from jsonb_array_elements_text(case jsonb_typeof(p) when 'array' then p else jsonb_build_array(p) end) x
);

-- Принимает ли роль ref_role класса ref_class цель класса target_class (с учётом предков цели).
create or replace function @SCHEMA@.role_accepts(p_ref_class text, p_ref_tenant uuid, p_role text,
  p_target_class text, p_target_tenant uuid) returns boolean
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  select exists (
    select 1
    from jsonb_array_elements_text(@SCHEMA@.class_set(
           (@SCHEMA@.class_row(p_ref_class, p_ref_tenant)).data->'resolved'->'ends'->p_role->'class')) a(name)
    where a.name in (select jsonb_array_elements_text(
           (@SCHEMA@.class_row(p_target_class, p_target_tenant)).data->'resolved'->'ancestors'))
  )
$$;

-- Умолчания из JSON Schema: на каждом уровне для отсутствующих полей; во вложенные объекты —
-- только если объект уже есть.
create or replace function @SCHEMA@.apply_defaults(p_schema jsonb, p_data jsonb) returns jsonb
language plpgsql immutable
as $$
declare
  p record;
  d jsonb := p_data;
begin
  if jsonb_typeof(d) is distinct from 'object' or jsonb_typeof(p_schema->'properties') is distinct from 'object' then
    return d;
  end if;
  for p in select key, value from jsonb_each(p_schema->'properties') loop
    if not (d ? p.key) then
      if p.value ? 'default' then
        d := d || jsonb_build_object(p.key, p.value->'default');
      end if;
    elsif jsonb_typeof(d->p.key) = 'object' then
      d := jsonb_set(d, array[p.key], @SCHEMA@.apply_defaults(p.value, d->p.key));
    end if;
  end loop;
  return d;
end $$;

-- Проверка и нормализация концов (этап 1, п. 7): объявлены, обязательные на месте, у множественных
-- нет повторов, соблюдены min и max; uuid — в каноническом виде строчными. Цели (при p_lock — под
-- for key share в порядке id) существуют, принадлежат своему арендатору или System и относятся
-- к объявленному классу или его потомку. Ошибку не бросает: возвращает код и сообщение.
create or replace function @SCHEMA@.check_links(p_res jsonb, p_links jsonb, p_tenant uuid, p_lock boolean,
  out links jsonb, out code text, out msg text)
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_variable
declare
  l record;
  e record;
  v jsonb;
  arr jsonb;
  n int;
  ids uuid[];
  bad text;
begin
  links := '{}'::jsonb;
  if p_links is null or p_links = 'null'::jsonb then
    p_links := '{}'::jsonb;
  end if;
  if jsonb_typeof(p_links) <> 'object' then
    code := 'invalid_data'; msg := 'links — не объект'; return;
  end if;
  for l in select key, value from jsonb_each(p_links) loop
    if not coalesce(p_res->'ends' ? l.key, false) then
      code := 'undeclared_end'; msg := format('конец %s не объявлен в классе %s', l.key, p_res->>'name'); return;
    end if;
    continue when l.value = 'null'::jsonb;
    if coalesce((p_res->'ends'->l.key->>'many')::boolean, false) then
      if jsonb_typeof(l.value) <> 'array' then
        code := 'invalid_data'; msg := format('конец %s — список id', l.key); return;
      end if;
      arr := '[]'::jsonb;
      for v in select value from jsonb_array_elements(l.value) loop
        if jsonb_typeof(v) <> 'string' or not pg_input_is_valid(v #>> '{}', 'uuid') then
          code := 'invalid_data'; msg := format('конец %s: значение не uuid', l.key); return;
        end if;
        v := to_jsonb((v #>> '{}')::uuid::text);
        if arr @> jsonb_build_array(v) then
          code := 'invalid_data'; msg := format('конец %s: цель повторяется', l.key); return;
        end if;
        arr := arr || jsonb_build_array(v);
      end loop;
      links := links || jsonb_build_object(l.key, arr);
    else
      if jsonb_typeof(l.value) <> 'string' or not pg_input_is_valid(l.value #>> '{}', 'uuid') then
        code := 'invalid_data'; msg := format('конец %s: значение не uuid', l.key); return;
      end if;
      links := links || jsonb_build_object(l.key, (l.value #>> '{}')::uuid::text);
    end if;
  end loop;
  for e in select key, value from jsonb_each(coalesce(p_res->'ends', '{}'::jsonb)) loop
    if coalesce((e.value->>'many')::boolean, false) then
      n := coalesce(jsonb_array_length(links->e.key), 0);
      if n < greatest(coalesce((e.value->>'min')::int, 0), case when coalesce((e.value->>'required')::boolean, false) then 1 else 0 end) then
        code := 'invalid_data'; msg := format('у конца %s слишком мало целей', e.key); return;
      end if;
      if e.value ? 'max' and n > (e.value->>'max')::int then
        code := 'invalid_data'; msg := format('у конца %s слишком много целей', e.key); return;
      end if;
    elsif coalesce((e.value->>'required')::boolean, false) and not links ? e.key then
      code := 'invalid_data'; msg := format('обязательный конец %s не задан', e.key); return;
    end if;
  end loop;
  ids := @SCHEMA@.link_ids(links);
  if cardinality(ids) = 0 then
    return;
  end if;
  if p_lock then
    perform 1 from @SCHEMA@.entity t where t.id = any (ids) order by t.id for key share;
  end if;
  select r.role into bad
  from (
    select k.key as role, (case jsonb_typeof(k.value) when 'array' then a.value else k.value end #>> '{}')::uuid as tid
    from jsonb_each(links) k
    left join lateral jsonb_array_elements(case jsonb_typeof(k.value) when 'array' then k.value else '[]'::jsonb end) a on true
    where jsonb_typeof(k.value) = 'string' or a.value is not null
  ) r
  left join @SCHEMA@.entity t on t.id = r.tid
  where t.id is null
     or t.tenant not in (p_tenant, '@SYSTEM@'::uuid)
     or not @SCHEMA@.role_accepts(p_res->>'name', p_tenant, r.role, t.class, t.tenant)
  limit 1;
  if bad is not null then
    code := 'target_not_found'; msg := format('цель конца %s не найдена', bad);
  end if;
end $$;

-- id класса с ключом — v5 от арендатора, класса и значений ключа (§2.3); у класса без ключа — null.
create or replace function @SCHEMA@.key_id(p_res jsonb, p_class text, p_tenant uuid, p_data jsonb, p_links jsonb) returns uuid
language sql immutable
return case when jsonb_array_length(coalesce(p_res->'key', '[]'::jsonb)) = 0 then null else
  @SCHEMA@.v5_id(p_tenant, p_class, array(
    select case when p_res->'schema'->'properties' ? u.k then p_data->>u.k else lower(p_links->>u.k) end
    from jsonb_array_elements_text(p_res->'key') with ordinality as u(k, i)
    order by u.i)) end;

-- Версия в журнал и сигнал NOTIFY с именем класса (§2.12). Классы с history: false журнал не ведут,
-- но сигнал посылают.
create or replace function @SCHEMA@.log_version(e @SCHEMA@.entity) returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  if coalesce((@SCHEMA@.class_row(e.class, e.tenant)).data->'resolved'->>'history', 'true') <> 'false' then
    insert into @SCHEMA@.log (id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason, moved, prev_hash)
    values (e.id, e.rev, e.class, e.cv, e.tenant, e.owner, e.links, e.data, e.tags, e.at, e.author, e.agent, e.op, e.reason, e.moved, e.prev_hash);
  end if;
  perform pg_notify('@SCHEMA_NAME@', e.class);
end $$;

-- Новая версия строки от имени владельца (пересчёт описаний потомков, снятие конца при удалении):
-- служебные колонки, журнал, сигнал. Триггеры при этом не срабатывают.
create or replace function @SCHEMA@.sys_update(p_id uuid, p_data jsonb, p_links jsonb, p_validator jsonpath, p_op text,
  p_class text default null)
returns @SCHEMA@.entity
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  e @SCHEMA@.entity;
  c record;
begin
  select * into c from @SCHEMA@.ctx();
  update @SCHEMA@.entity x
     set class = coalesce(p_class, x.class), data = p_data, links = p_links, validator = p_validator,
         rev = x.rev + 1, prev_hash = x.hash,
         at = greatest(@SCHEMA@.now_ts(), x.at + interval '1 microsecond'),
         author = coalesce(c.author, '@SYSTEM@'::uuid), agent = c.agent, op = p_op,
         reason = nullif(current_setting('letopis.reason', true), ''), moved = null,
         cv = coalesce((@SCHEMA@.class_row(coalesce(p_class, x.class), x.tenant)).rev, x.cv)
   where x.id = p_id
  returning x.* into e;
  perform @SCHEMA@.log_version(e);
  return e;
end $$;

-- Надгробие: последний снимок удалённой строки следующей версией с видом delete (или reclass/rekey
-- со ссылкой moved на новый id).
create or replace function @SCHEMA@.tombstone(e @SCHEMA@.entity, p_op text default 'delete', p_moved uuid default null) returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  select * into c from @SCHEMA@.ctx();
  e.rev := e.rev + 1;
  e.prev_hash := e.hash;
  e.at := greatest(@SCHEMA@.now_ts(), e.at + interval '1 microsecond');
  e.author := coalesce(c.author, '@SYSTEM@'::uuid);
  e.agent := c.agent;
  e.op := p_op;
  e.reason := nullif(current_setting('letopis.reason', true), '');
  e.moved := p_moved;
  perform @SCHEMA@.log_version(e);
end $$;

-- Входящие ссылки на строку p_id, роли которых не принимают класс p_class (смена класса, смена родителя).
create or replace function @SCHEMA@.incoming_conflicts(p_id uuid, p_class text, p_tenant uuid) returns jsonb
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'class', r.class, 'role', k.key, 'tenant', r.tenant)), '[]'::jsonb)
  from @SCHEMA@.entity r
  cross join lateral jsonb_each(r.links) k
  where r.ends @> array[p_id]
    and (k.value = to_jsonb(p_id::text) or (jsonb_typeof(k.value) = 'array' and k.value @> jsonb_build_array(p_id::text)))
    and not @SCHEMA@.role_accepts(r.class, r.tenant, k.key, p_class, p_tenant)
$$;

-- Перечень видимых актору строк и число остальных — для ошибок restrict, смены класса, ужесточения.
create or replace function @SCHEMA@.visible_detail(p_rows jsonb, p_tenant uuid) returns jsonb
language sql stable
return jsonb_build_object(
  'rows', coalesce((select jsonb_agg(r - 'tenant') from jsonb_array_elements(p_rows) r where (r->>'tenant')::uuid = p_tenant), '[]'::jsonb),
  'others', (select count(*) from jsonb_array_elements(p_rows) r where (r->>'tenant')::uuid is distinct from p_tenant));

-- Безопасно ли изменение описания класса (этап 1, п. 10): новые необязательные поля и концы,
-- метаданные, алиас, политика истории, кэш. Всё остальное — ужесточение с проверкой строк.
create or replace function @SCHEMA@.class_change_safe(o jsonb, n jsonb) returns boolean
language sql immutable
return
  o->'key' = n->'key'
  and o->'ancestors' = n->'ancestors'
  and (o->'abstract' = n->'abstract' or n->>'abstract' = 'false')
  and coalesce(o->'schema'->'required', '[]'::jsonb) @> coalesce(n->'schema'->'required', '[]'::jsonb)
  and not exists (select 1 from jsonb_each(coalesce(o->'schema'->'properties', '{}'::jsonb)) p
                  where n->'schema'->'properties'->p.key is distinct from p.value)
  and not exists (select 1 from jsonb_each(coalesce(o->'ends', '{}'::jsonb)) e
                  where n->'ends'->e.key is distinct from e.value)
  and not exists (select 1 from jsonb_each(coalesce(n->'ends', '{}'::jsonb)) e
                  where not coalesce(o->'ends' ? e.key, false)
                    and (coalesce((e.value->>'required')::boolean, false) or coalesce((e.value->>'min')::int, 0) > 0));

-- Строки семейства, которые не проходят текущие описания своих классов (после ужесточения).
-- Не больше 100 строк; p_incoming — проверять ещё и входящие ссылки (смена родителя).
create or replace function @SCHEMA@.family_conflicts(p_classes text[], p_tenant uuid, p_incoming boolean) returns jsonb
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  r @SCHEMA@.entity;
  cls @SCHEMA@.entity;
  res jsonb;
  bad jsonb;
  lk record;
  problem text;
  inc jsonb;
  outv jsonb := '[]'::jsonb;
begin
  for r in select e.* from @SCHEMA@.entity e
           where e.class = any (p_classes) and (e.tenant = p_tenant or p_tenant = '@SYSTEM@'::uuid)
           order by e.id loop
    cls := @SCHEMA@.class_row(r.class, r.tenant);
    res := cls.data->'resolved';
    problem := null;
    if coalesce((res->>'abstract')::boolean, false) then
      problem := 'класс абстрактный';
    else
      bad := @SCHEMA@.validate_data(res->'rules', cls.validator, res->'vars', r.data);
      if bad <> '[]'::jsonb then
        problem := 'данные: ' || bad::text;
      else
        select * into lk from @SCHEMA@.check_links(res, r.links, r.tenant, false);
        if lk.code is not null then
          problem := lk.msg;
        elsif coalesce(@SCHEMA@.key_id(res, r.class, r.tenant, r.data, r.links), r.id) <> r.id then
          problem := 'id не соответствует ключу класса';
        end if;
      end if;
    end if;
    if problem is null and p_incoming then
      inc := @SCHEMA@.incoming_conflicts(r.id, r.class, r.tenant);
      if inc <> '[]'::jsonb then
        problem := format('на строку ссылается роль %s строки %s, которая не принимает класс', inc->0->>'role', inc->0->>'id');
      end if;
    end if;
    if problem is not null then
      outv := outv || jsonb_build_object('id', r.id, 'class', r.class, 'tenant', r.tenant, 'problem', problem);
      exit when jsonb_array_length(outv) >= 100;
    end if;
  end loop;
  return outv;
end $$;

-- Методы цепочки — зарезервированные имена (§2.14). Предварительный список этапа 1; этап 3 заменит
-- его сгенерированным из кода.
create or replace function @SCHEMA@.reserved_names() returns text[]
language sql immutable parallel safe
return array['then', 'entity', 'paths', 'rows', 'first', 'ids', 'count', 'limit', 'offset', 'sort', 'asOf',
  'withDeleted', 'deep', 'exact', 'sum', 'avg', 'min', 'max', 'countBy', 'after', 'versions', 'create', 'update',
  'upsert', 'set', 'unset', 'add', 'remove', 'delete', 'anonymize', 'reclass', 'restore', 'purge', 'alias', 'tags',
  'owner', 'forUpdate', 'cache', 'as', 'begin', 'commit', 'rollback', 'lock', 'batch', 'watch', 'close', 'registry',
  'sql', 'load', 'verify', 'maintain', 'reset', 'describe', 'auth', 'acl', 'discard', 'size', 'run'];

-- Проверки строки Class сверх метасхемы (этап 1, п. 6): признак system, имя системного класса,
-- имена связей против методов цепочки, однозначность имени конца во всей схеме.
create or replace function @SCHEMA@.class_admit(p_data jsonb, p_tenant uuid, out data jsonb, out validator jsonpath)
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_variable
declare
  e record;
  o record;
begin
  if p_tenant <> '@SYSTEM@'::uuid then
    if coalesce((p_data->>'system')::boolean, false) then
      perform @SCHEMA@.lt_fail('invalid_class', 'признак system задаёт только установка');
    end if;
    if exists (select 1 from @SCHEMA@.entity s
               where s.id = @SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array[p_data->>'name']) and s.class = 'Class') then
      perform @SCHEMA@.lt_fail('invalid_class', format('имя %s занято системным классом', p_data->>'name'));
    end if;
  end if;
  select c.data, c.validator into data, validator from @SCHEMA@.class_prepare(p_data, p_tenant) c;
  if data->>'kind' = 'link' and (data->>'name') = any (@SCHEMA@.reserved_names()) then
    perform @SCHEMA@.lt_fail('invalid_class', format('имя связи %s совпадает с методом цепочки', data->>'name'));
  end if;
  for e in select key, value from jsonb_each(coalesce(data->'resolved'->'ends', '{}'::jsonb)) loop
    select x.data->>'name' as name into o
    from @SCHEMA@.entity x
    where x.class = 'Class' and x.tenant in (p_tenant, '@SYSTEM@'::uuid)
      and x.data->>'name' <> data->>'name'
      and x.data->'resolved'->'ends' ? e.key
      and @SCHEMA@.class_set(x.data->'resolved'->'ends'->e.key->'class') <> @SCHEMA@.class_set(e.value->'class')
    limit 1;
    if o.name is not null then
      perform @SCHEMA@.lt_fail('invalid_class', format('конец %s в классе %s ведёт на другой класс', e.key, o.name));
    end if;
  end loop;
end $$;

-- ========================= триггеры =========================

create or replace function @SCHEMA@.trg_entity_bi() returns trigger
language plpgsql security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  cls @SCHEMA@.entity;
  res jsonb;
  root text;
  bad jsonb;
  lk record;
  kid uuid;
  last record;
  ts timestamptz;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('no_session', 'нет действующей сессии');
  end if;
  NEW.tenant := coalesce(NEW.tenant, c.tenant);
  if NEW.tenant <> c.tenant then
    perform @SCHEMA@.lt_fail('tenant_denied', 'запись в чужого арендатора');
  end if;
  cls := @SCHEMA@.class_row(NEW.class, NEW.tenant);
  if cls.id is null then
    perform @SCHEMA@.lt_fail('invalid_class', format('класс %s не найден', NEW.class));
  end if;
  -- разделяемая блокировка корня семейства, затем описание перечитывается под ней
  root := cls.data->'resolved'->'ancestors'->>-1;
  perform @SCHEMA@.family_lock(root, false);
  cls := @SCHEMA@.class_row(NEW.class, NEW.tenant);
  res := cls.data->'resolved';
  if coalesce((res->>'abstract')::boolean, false) then
    perform @SCHEMA@.lt_fail('invalid_class', format('класс %s абстрактный', NEW.class));
  end if;
  if NEW.class = 'Class' then
    select a.data, a.validator into NEW.data, NEW.validator from @SCHEMA@.class_admit(coalesce(NEW.data, '{}'::jsonb), NEW.tenant) a;
  else
    NEW.data := @SCHEMA@.apply_defaults(res->'schema', coalesce(NEW.data, '{}'::jsonb));
    bad := @SCHEMA@.validate_data(res->'rules', cls.validator, res->'vars', NEW.data);
    if bad <> '[]'::jsonb then
      perform @SCHEMA@.lt_fail('invalid_data', format('данные не проходят описание класса %s', NEW.class), jsonb_build_object('issues', bad));
    end if;
    NEW.validator := null;
  end if;
  select * into lk from @SCHEMA@.check_links(res, NEW.links, NEW.tenant, true);
  if lk.code is not null then
    perform @SCHEMA@.lt_fail(lk.code, lk.msg);
  end if;
  NEW.links := lk.links;
  kid := @SCHEMA@.key_id(res, NEW.class, NEW.tenant, NEW.data, NEW.links);
  if kid is null then
    if NEW.id is not null then
      perform @SCHEMA@.lt_fail('id_from_db', format('id класса без ключа %s выдаёт база', NEW.class));
    end if;
    NEW.id := @SCHEMA@.v5_id(NEW.tenant, NEW.class, array[gen_random_uuid()::text]);
  else
    if NEW.id is not null and NEW.id <> kid then
      perform @SCHEMA@.lt_fail('id_mismatch', format('id не равен v5 от ключа класса %s', NEW.class), jsonb_build_object('expected', kid));
    end if;
    NEW.id := kid;
  end if;
  -- воскрешение: номер версии и цепочка хэшей продолжаются от последней записи журнала
  select l.rev, l.hash, l.at into last from @SCHEMA@.log l where l.id = NEW.id order by l.rev desc limit 1;
  ts := @SCHEMA@.now_ts();
  NEW.rev := coalesce(last.rev, 0) + 1;
  NEW.prev_hash := last.hash;
  NEW.at := greatest(ts, last.at + interval '1 microsecond');
  NEW.created_at := NEW.at;
  NEW.cv := cls.rev;
  if NEW.owner is null then
    NEW.owner := case res->>'ownerDefault' when 'actor' then c.account else NEW.tenant end;
  elsif NEW.owner not in (NEW.tenant, c.account) then
    -- явный владелец — только по условию ACL (этап 5); до него — арендатор или сам автор
    perform @SCHEMA@.lt_fail('acl_denied', 'владелец строки не разрешён');
  end if;
  NEW.author := c.author;
  NEW.agent := c.agent;
  NEW.op := 'create';
  NEW.reason := nullif(current_setting('letopis.reason', true), '');
  NEW.moved := null;
  NEW.tags := coalesce(NEW.tags, '{}');
  return NEW;
end $$;

create or replace function @SCHEMA@.trg_entity_bu() returns trigger
language plpgsql security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  cls @SCHEMA@.entity;
  res jsonb;
  old_res jsonb;
  root text;
  bad jsonb;
  lk record;
  kid uuid;
  op text := 'update';
  inc jsonb;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('no_session', 'нет действующей сессии');
  end if;
  if NEW.id <> OLD.id or NEW.tenant <> OLD.tenant or NEW.owner <> OLD.owner or NEW.created_at <> OLD.created_at then
    perform @SCHEMA@.lt_fail('immutable_key', 'id, арендатора, владельца и время создания менять нельзя');
  end if;
  if (NEW.class = 'Class') <> (OLD.class = 'Class') then
    perform @SCHEMA@.lt_fail('invalid_class', 'строку Class нельзя превратить в данные и наоборот');
  end if;
  cls := @SCHEMA@.class_row(NEW.class, OLD.tenant);
  if cls.id is null then
    perform @SCHEMA@.lt_fail('invalid_class', format('класс %s не найден', NEW.class));
  end if;
  root := cls.data->'resolved'->'ancestors'->>-1;
  perform @SCHEMA@.family_lock(root, false);
  cls := @SCHEMA@.class_row(NEW.class, OLD.tenant);
  res := cls.data->'resolved';
  if coalesce((res->>'abstract')::boolean, false) then
    perform @SCHEMA@.lt_fail('invalid_class', format('класс %s абстрактный', NEW.class));
  end if;
  if NEW.class <> OLD.class then
    -- смена класса (этап 1, п. 9): только read committed, только для классов без ключа
    if current_setting('transaction_isolation') <> 'read committed' then
      perform @SCHEMA@.lt_fail('isolation_level', 'смена класса разрешена только в read committed');
    end if;
    old_res := (@SCHEMA@.class_row(OLD.class, OLD.tenant)).data->'resolved';
    if jsonb_array_length(coalesce(old_res->'key', '[]'::jsonb)) > 0 or jsonb_array_length(coalesce(res->'key', '[]'::jsonb)) > 0 then
      perform @SCHEMA@.lt_fail('use_reclass', format('у класса %s или %s есть ключ: id меняется, используйте reclass()', OLD.class, NEW.class));
    end if;
    -- обычный update берёт слабую блокировку; смене класса нужна for update, чтобы дождаться
    -- транзакций, которые как раз пишут ссылку на эту строку
    perform 1 from @SCHEMA@.entity x where x.id = OLD.id for update;
    inc := @SCHEMA@.incoming_conflicts(OLD.id, NEW.class, OLD.tenant);
    if inc <> '[]'::jsonb then
      perform @SCHEMA@.lt_fail('reclass_denied', format('роли ссылающихся строк не принимают класс %s', NEW.class),
        @SCHEMA@.visible_detail(inc, c.tenant));
    end if;
    op := 'reclass';
  end if;
  if NEW.class = 'Class' then
    select a.data, a.validator into NEW.data, NEW.validator from @SCHEMA@.class_admit(NEW.data, OLD.tenant) a;
  else
    NEW.data := @SCHEMA@.apply_defaults(res->'schema', NEW.data);
    bad := @SCHEMA@.validate_data(res->'rules', cls.validator, res->'vars', NEW.data);
    if bad <> '[]'::jsonb then
      perform @SCHEMA@.lt_fail('invalid_data', format('данные не проходят описание класса %s', NEW.class), jsonb_build_object('issues', bad));
    end if;
    NEW.validator := null;
  end if;
  select * into lk from @SCHEMA@.check_links(res, NEW.links, OLD.tenant, NEW.links is distinct from OLD.links);
  if lk.code is not null then
    perform @SCHEMA@.lt_fail(lk.code, lk.msg);
  end if;
  NEW.links := lk.links;
  kid := @SCHEMA@.key_id(res, NEW.class, OLD.tenant, NEW.data, NEW.links);
  if kid is not null and kid <> OLD.id then
    perform @SCHEMA@.lt_fail('immutable_key', format('ключевое поле класса %s менять нельзя: id изменился бы (rekey)', NEW.class));
  end if;
  -- ничего не изменилось: строка возвращается как есть, версии нет, оператор считает её затронутой
  if NEW.class = OLD.class and NEW.data = OLD.data and NEW.links = OLD.links and NEW.tags = OLD.tags then
    return OLD;
  end if;
  if NEW.class = 'Class' and not @SCHEMA@.class_change_safe(OLD.data->'resolved', NEW.data->'resolved') then
    -- ужесточение: исключительная блокировка корня семейства (и нового корня при смене родителя)
    perform @SCHEMA@.family_lock(OLD.data->'resolved'->'ancestors'->>-1, true);
    perform @SCHEMA@.family_lock(NEW.data->'resolved'->'ancestors'->>-1, true);
  end if;
  NEW.rev := OLD.rev + 1;
  NEW.prev_hash := OLD.hash;
  NEW.at := greatest(@SCHEMA@.now_ts(), OLD.at + interval '1 microsecond');
  NEW.cv := cls.rev;
  NEW.author := c.author;
  NEW.agent := c.agent;
  NEW.op := op;
  NEW.reason := nullif(current_setting('letopis.reason', true), '');
  NEW.moved := null;
  return NEW;
end $$;

-- После вставки и правки: версия в журнал, сигнал; для строк Class — пересчёт потомков и проверка
-- строк семейства при ужесточении.
create or replace function @SCHEMA@.trg_entity_ai() returns trigger
language plpgsql security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  if TG_OP = 'UPDATE' and NEW.rev = OLD.rev then
    return null;
  end if;
  perform @SCHEMA@.log_version(NEW);
  if TG_OP = 'UPDATE' and NEW.class = 'Class' then
    perform @SCHEMA@.class_evolve(OLD, NEW);
  end if;
  return null;
end $$;

create or replace function @SCHEMA@.class_evolve(o @SCHEMA@.entity, n @SCHEMA@.entity) returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  d @SCHEMA@.entity;
  prep record;
  classes text[] := array[n.data->>'name'];
  conflicts jsonb;
  c record;
begin
  -- потомки: описание resolved и validator пересчитываются, каждый пересчёт — версия класса в журнале
  for d in select x.* from @SCHEMA@.entity x
           where x.class = 'Class' and x.id <> n.id
             and (x.tenant = n.tenant or n.tenant = '@SYSTEM@'::uuid)
             and x.data->'resolved'->'ancestors' ? (n.data->>'name')
           order by jsonb_array_length(x.data->'resolved'->'ancestors'), x.id loop
    select p.data, p.validator into prep from @SCHEMA@.class_prepare(d.data, d.tenant) p;
    if prep.data is distinct from d.data or prep.validator::text is distinct from d.validator::text then
      perform @SCHEMA@.sys_update(d.id, prep.data, d.links, prep.validator, 'update');
    end if;
    classes := classes || (d.data->>'name');
  end loop;
  if not @SCHEMA@.class_change_safe(o.data->'resolved', n.data->'resolved') then
    conflicts := @SCHEMA@.family_conflicts(classes, n.tenant, o.data->'resolved'->'ancestors' is distinct from n.data->'resolved'->'ancestors');
    if conflicts <> '[]'::jsonb then
      select * into c from @SCHEMA@.ctx();
      perform @SCHEMA@.lt_fail('tightening_conflict', format('новому описанию класса %s не соответствуют строки', n.data->>'name'),
        @SCHEMA@.visible_detail(conflicts, c.tenant));
    end if;
  end if;
end $$;

-- Перед оператором delete: только read committed (§2.10).
create or replace function @SCHEMA@.trg_entity_bd() returns trigger
language plpgsql security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    perform @SCHEMA@.lt_fail('isolation_level', 'удаление разрешено только в read committed');
  end if;
  return null;
end $$;

-- После оператора delete (§2.5, этап 1, п. 8): надгробия, каскад по уровням, restrict по итогу.
-- Строки, которые удалил сам оператор, каскад уже не видит, поэтому сырой delete любого набора
-- связанных строк проходит без ошибки 27000.
create or replace function @SCHEMA@.trg_entity_ad() returns trigger
language plpgsql security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  e @SCHEMA@.entity;
  r record;
  lvl uuid[];
  all_ids uuid[];
  casc uuid[];
  unset_rows jsonb;
  act text;
  hit boolean;
  newlinks jsonb;
  k record;
  blockers jsonb;
begin
  select * into c from @SCHEMA@.ctx();
  if exists (select 1 from @SCHEMA@.entity x join gone g on g.id = x.id) then
    perform @SCHEMA@.lt_fail('recreated_in_statement', 'id удалён и создан заново одним оператором');
  end if;
  for r in select g.id, g.tenant, g.data->>'name' as name from gone g where g.class = 'Class' loop
    if exists (select 1 from @SCHEMA@.entity x where x.class = r.name and (x.tenant = r.tenant or r.tenant = '@SYSTEM@'::uuid))
       or exists (select 1 from @SCHEMA@.entity x where x.class = 'Class' and x.data->>'parent' = r.name
                  and (x.tenant = r.tenant or r.tenant = '@SYSTEM@'::uuid)) then
      perform @SCHEMA@.lt_fail('invalid_class', format('у класса %s есть строки или потомки', r.name));
    end if;
  end loop;
  for e in select g.* from gone g order by g.id loop
    perform @SCHEMA@.tombstone(e);
  end loop;
  select coalesce(array_agg(g.id), '{}') into lvl from gone g;
  all_ids := lvl;
  while cardinality(lvl) > 0 loop
    casc := '{}';
    unset_rows := '[]'::jsonb;
    for r in select x.id, x.class, x.tenant, x.links from @SCHEMA@.entity x where x.ends && lvl order by x.id loop
      act := null;
      for k in select key, value from jsonb_each(r.links) loop
        hit := exists (select 1 from jsonb_array_elements_text(case jsonb_typeof(k.value) when 'array' then k.value else jsonb_build_array(k.value) end) t
                       where t::uuid = any (all_ids));
        continue when not hit;
        case coalesce((@SCHEMA@.class_row(r.class, r.tenant)).data->'resolved'->'ends'->k.key->>'onDelete', 'restrict')
          when 'cascade' then act := 'cascade';
          when 'unset' then act := coalesce(act, 'unset');
          else act := case when act = 'cascade' then 'cascade' else 'restrict' end;
        end case;
      end loop;
      if act = 'cascade' then
        casc := casc || r.id;
      elsif act = 'unset' then
        unset_rows := unset_rows || jsonb_build_array(r.id);
      end if;
    end loop;
    -- каскад: удаление в порядке id берёт блокировки и ждёт тех, кто как раз пишет ссылки
    lvl := '{}';
    for e in delete from @SCHEMA@.entity x
             where x.id in (select y.id from @SCHEMA@.entity y where y.id = any (casc) order by y.id for update)
             returning x.* loop
      perform @SCHEMA@.tombstone(e);
      lvl := lvl || e.id;
    end loop;
    -- unset: снять конец, новая версия
    for r in select x.* from @SCHEMA@.entity x
             where x.id in (select (j #>> '{}')::uuid from jsonb_array_elements(unset_rows) j) order by x.id for update loop
      newlinks := '{}'::jsonb;
      for k in select key, value from jsonb_each(r.links) loop
        if jsonb_typeof(k.value) = 'array' then
          newlinks := newlinks || jsonb_build_object(k.key, coalesce(
            (select jsonb_agg(t) from jsonb_array_elements_text(k.value) t where not (t::uuid = any (all_ids))), '[]'::jsonb));
        elsif not ((k.value #>> '{}')::uuid = any (all_ids)) then
          newlinks := newlinks || jsonb_build_object(k.key, k.value);
        end if;
      end loop;
      perform @SCHEMA@.sys_update(r.id, r.data, newlinks, r.validator, 'update');
    end loop;
    all_ids := all_ids || lvl;
  end loop;
  -- restrict — одним запросом после всего каскада
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'class', x.class, 'tenant', x.tenant)), '[]'::jsonb) into blockers
  from (select x.id, x.class, x.tenant from @SCHEMA@.entity x where x.ends && all_ids order by x.id limit 1000) x;
  if blockers <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('delete_restricted', 'на удаляемые строки ссылаются другие строки (onDelete: restrict)',
      @SCHEMA@.visible_detail(blockers, c.tenant));
  end if;
  return null;
end $$;

create or replace trigger entity_bi before insert on @SCHEMA@.entity
  for each row when (current_user <> '@OWNER_NAME@') execute function @SCHEMA@.trg_entity_bi();
create or replace trigger entity_bu before update on @SCHEMA@.entity
  for each row when (current_user <> '@OWNER_NAME@') execute function @SCHEMA@.trg_entity_bu();
create or replace trigger entity_ai after insert or update on @SCHEMA@.entity
  for each row when (current_user <> '@OWNER_NAME@') execute function @SCHEMA@.trg_entity_ai();
create or replace trigger entity_bd before delete on @SCHEMA@.entity
  for each statement when (current_user <> '@OWNER_NAME@') execute function @SCHEMA@.trg_entity_bd();
create or replace trigger entity_ad after delete on @SCHEMA@.entity referencing old table as gone
  for each statement when (current_user <> '@OWNER_NAME@') execute function @SCHEMA@.trg_entity_ad();
-- в режиме репликации (session_replication_role = replica) триггеры тоже работают
alter table @SCHEMA@.entity enable always trigger entity_bi;
alter table @SCHEMA@.entity enable always trigger entity_bu;
alter table @SCHEMA@.entity enable always trigger entity_ai;
alter table @SCHEMA@.entity enable always trigger entity_bd;
alter table @SCHEMA@.entity enable always trigger entity_ad;

-- ========================= смена класса с ключом =========================

-- Замена id цели во всех концах.
create or replace function @SCHEMA@.links_replace(p_links jsonb, p_old uuid, p_new uuid) returns jsonb
language sql immutable parallel safe
return (
  select coalesce(jsonb_object_agg(k.key, case jsonb_typeof(k.value)
    when 'array' then coalesce((select jsonb_agg(case when x = p_old::text then to_jsonb(p_new::text) else to_jsonb(x) end)
                                from jsonb_array_elements_text(k.value) x), '[]'::jsonb)
    else case when k.value #>> '{}' = p_old::text then to_jsonb(p_new::text) else k.value end end), '{}'::jsonb)
  from jsonb_each(p_links) k
);

-- Перенос строки на новый id (смена класса с ключом, смена ключа): новая строка продолжает журнал
-- нового id и ссылается на старый (moved), ссылки переводятся — если переведённый конец входит
-- в ключ ссылающейся строки, её id тоже меняется, и перевод идёт дальше рекурсивно; старая строка
-- удаляется с надгробием, которое ссылается на новый id. Проверки делает вызывающая функция.
create or replace function @SCHEMA@.move_row(o @SCHEMA@.entity, p_new_id uuid, p_class text, p_data jsonb, p_links jsonb, p_op text)
returns @SCHEMA@.entity
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  last record;
  ts timestamptz;
  n @SCHEMA@.entity;
  r @SCHEMA@.entity;
  nl jsonb;
  rid uuid;
begin
  select * into c from @SCHEMA@.ctx();
  select l.rev, l.hash, l.at into last from @SCHEMA@.log l where l.id = p_new_id order by l.rev desc limit 1;
  ts := greatest(@SCHEMA@.now_ts(), last.at + interval '1 microsecond');
  insert into @SCHEMA@.entity (id, rev, class, cv, tenant, owner, links, data, tags, at, created_at, author, agent, op, reason, moved, prev_hash, validator)
  values (p_new_id, coalesce(last.rev, 0) + 1, p_class, coalesce((@SCHEMA@.class_row(p_class, o.tenant)).rev, 0), o.tenant, o.owner,
          p_links, p_data, o.tags, ts, ts, coalesce(c.author, '@SYSTEM@'::uuid), c.agent, p_op,
          nullif(current_setting('letopis.reason', true), ''), o.id, last.hash, null)
  returning * into n;
  perform @SCHEMA@.log_version(n);
  for r in select x.* from @SCHEMA@.entity x where x.ends @> array[o.id] and x.id <> p_new_id order by x.id for update loop
    nl := @SCHEMA@.links_replace(r.links, o.id, p_new_id);
    rid := coalesce(@SCHEMA@.key_id((@SCHEMA@.class_row(r.class, r.tenant)).data->'resolved', r.class, r.tenant, r.data, nl), r.id);
    if rid <> r.id then
      perform @SCHEMA@.move_row(r, rid, r.class, r.data, nl, 'rekey');
    else
      perform @SCHEMA@.sys_update(r.id, r.data, nl, r.validator, 'update');
    end if;
  end loop;
  delete from @SCHEMA@.entity x where x.id = o.id returning x.* into r;
  perform @SCHEMA@.tombstone(r, p_op, p_new_id);
  return n;
end $$;

-- Смена класса (этап 1, п. 9): у класса с ключом id вычисляется заново для нового класса, ссылки
-- переводятся в той же транзакции, журнал связывает старый и новый id. У класса без ключа id
-- сохраняется. Только read committed; на строку сначала берётся for update.
create or replace function @SCHEMA@.reclass(p_id uuid, p_class text, p_data jsonb default null) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  o @SCHEMA@.entity;
  cls @SCHEMA@.entity;
  res jsonb;
  d jsonb;
  bad jsonb;
  lk record;
  nid uuid;
  inc jsonb;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('no_session', 'нет действующей сессии');
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    perform @SCHEMA@.lt_fail('isolation_level', 'смена класса разрешена только в read committed');
  end if;
  select x.* into o from @SCHEMA@.entity x where x.id = p_id and x.tenant = c.tenant for update;
  if o.id is null then
    perform @SCHEMA@.lt_fail('target_not_found', 'цель не найдена');
  end if;
  -- строки прав и классов функция не трогает (ACL — этап 5)
  if o.class in ('Class', 'Account', 'member', 'Resource', 'rule') or p_class in ('Class', 'Account', 'member', 'Resource', 'rule') then
    perform @SCHEMA@.lt_fail('reclass_denied', 'класс системной строки не меняется');
  end if;
  cls := @SCHEMA@.class_row(p_class, o.tenant);
  if cls.id is null then
    perform @SCHEMA@.lt_fail('invalid_class', format('класс %s не найден', p_class));
  end if;
  perform @SCHEMA@.family_lock(cls.data->'resolved'->'ancestors'->>-1, false);
  cls := @SCHEMA@.class_row(p_class, o.tenant);
  res := cls.data->'resolved';
  if coalesce((res->>'abstract')::boolean, false) then
    perform @SCHEMA@.lt_fail('invalid_class', format('класс %s абстрактный', p_class));
  end if;
  d := @SCHEMA@.apply_defaults(res->'schema', coalesce(p_data, o.data));
  bad := @SCHEMA@.validate_data(res->'rules', cls.validator, res->'vars', d);
  if bad <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('invalid_data', format('данные не проходят описание класса %s', p_class), jsonb_build_object('issues', bad));
  end if;
  select * into lk from @SCHEMA@.check_links(res, o.links, o.tenant, true);
  if lk.code is not null then
    perform @SCHEMA@.lt_fail(lk.code, lk.msg);
  end if;
  inc := @SCHEMA@.incoming_conflicts(o.id, p_class, o.tenant);
  if inc <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('reclass_denied', format('роли ссылающихся строк не принимают класс %s', p_class),
      @SCHEMA@.visible_detail(inc, c.tenant));
  end if;
  nid := coalesce(@SCHEMA@.key_id(res, p_class, o.tenant, d, lk.links), o.id);
  if nid = o.id then
    perform @SCHEMA@.sys_update(o.id, d, lk.links, null, 'reclass', p_class);
  else
    perform @SCHEMA@.move_row(o, nid, p_class, d, lk.links, 'reclass');
  end if;
  return nid;
end $$;

-- ========================= merge и inc =========================

-- Слияние патча (§2.5): повторяет deepMerge 0.21 без исключений — объекты сливаются рекурсивно,
-- массивы, скаляры и null заменяются. Ключи на $ — обычные данные.
create or replace function @SCHEMA@.merge(base jsonb, patch jsonb) returns jsonb
language plpgsql immutable parallel safe
as $$
declare
  k text;
  v jsonb;
  res jsonb := coalesce(base, '{}'::jsonb);
begin
  if patch is null then
    return res;
  end if;
  if jsonb_typeof(patch) <> 'object' or jsonb_typeof(res) <> 'object' then
    return patch;
  end if;
  for k, v in select key, value from jsonb_each(patch) loop
    if jsonb_typeof(v) = 'object' and jsonb_typeof(res->k) = 'object' then
      res := jsonb_set(res, array[k], @SCHEMA@.merge(res->k, v));
    else
      res := res || jsonb_build_object(k, v);
    end if;
  end loop;
  return res;
end $$;

-- Приращение числа по пути (§2.5): путь только через существующие объекты; отсутствующее поле —
-- ошибка без start; null и не число — ошибка и со start. Сумма считается в numeric точно.
create or replace function @SCHEMA@.inc(data jsonb, path text[], delta numeric, start numeric default null) returns jsonb
language plpgsql immutable parallel safe
as $$
declare
  cur jsonb := data;
  v jsonb;
  i int;
  fail text;
begin
  if path is null or cardinality(path) = 0 or delta is null then
    fail := 'inc: нужны путь и величина';
  else
    for i in 1 .. cardinality(path) - 1 loop
      if jsonb_typeof(cur) is distinct from 'object' or not cur ? path[i] then
        fail := format('inc: путь %s идёт через отсутствующий объект', array_to_string(path, '.'));
        exit;
      end if;
      cur := cur->path[i];
    end loop;
    if fail is null and jsonb_typeof(cur) is distinct from 'object' then
      fail := format('inc: путь %s идёт не через объект', array_to_string(path, '.'));
    end if;
    if fail is null then
      v := cur->path[cardinality(path)];
      if v is null then
        if start is null then
          fail := format('inc: поля %s нет — задайте start', array_to_string(path, '.'));
        else
          return jsonb_set(data, path, to_jsonb(start + delta), true);
        end if;
      elsif jsonb_typeof(v) <> 'number' then
        fail := format('inc: в поле %s не число', array_to_string(path, '.'));
      else
        return jsonb_set(data, path, to_jsonb((v #>> '{}')::numeric + delta));
      end if;
    end if;
  end if;
  raise exception using errcode = 'LT003', message = 'letopis: invalid_data: ' || fail,
    detail = jsonb_build_object('issues', jsonb_build_array(jsonb_build_object(
      'path', to_jsonb(coalesce(path, '{}')), 'keyword', 'inc', 'message', fail)))::text;
end $$;

-- ========================= verify =========================

-- Проверка цепочек хэшей (этап 1, п. 11): номера версий подряд с 1, prev_hash каждой версии равен
-- хэшу предыдущей, строка entity совпадает с последней версией журнала. Возвращает находки и якорь —
-- хэш всех голов цепочек, который можно хранить вне базы. Только системный администратор.
create or replace function @SCHEMA@.verify() returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  issues jsonb;
  anchor text;
begin
  select * into c from @SCHEMA@.ctx();
  if not (coalesce('System' = any (c.categories), false)
          or exists (select 1 from pg_roles where rolname = session_user and rolsuper)
          or pg_has_role(session_user, '@OWNER_NAME@', 'SET')) then
    perform @SCHEMA@.lt_fail('acl_denied', 'verify доступен только системному администратору');
  end if;
  with chain as (
    select l.id, l.rev, l.prev_hash, l.hash,
           lag(l.rev) over w as prev_rev, lag(l.hash) over w as prev_h
    from @SCHEMA@.log l
    window w as (partition by l.id order by l.rev)
  ), found as (
    select jsonb_build_object('id', id, 'rev', rev, 'problem', 'цепочка начинается не с версии 1') as f
      from chain where prev_rev is null and (rev <> 1 or prev_hash is not null)
    union all
    select jsonb_build_object('id', id, 'rev', prev_rev + 1, 'problem', 'разрыв: нет версий ' || (prev_rev + 1) || '…' || (rev - 1))
      from chain where prev_rev is not null and rev <> prev_rev + 1
    union all
    select jsonb_build_object('id', id, 'rev', prev_rev, 'problem', 'хэш версии не совпадает с prev_hash следующей')
      from chain where prev_rev is not null and rev = prev_rev + 1 and prev_hash is distinct from prev_h
    union all
    select jsonb_build_object('id', e.id, 'rev', e.rev, 'problem', 'строка entity не совпадает с последней версией журнала')
      from @SCHEMA@.entity e
      left join lateral (select l.hash, l.rev from @SCHEMA@.log l where l.id = e.id order by l.rev desc limit 1) l on true
      where coalesce((@SCHEMA@.class_row(e.class, e.tenant)).data->'resolved'->>'history', 'true') <> 'false'
        and (l.hash is distinct from e.hash or l.rev is distinct from e.rev)
  )
  select coalesce(jsonb_agg(f), '[]'::jsonb) into issues from found;
  select encode(sha256(coalesce(string_agg(e.hash, ''::bytea order by e.id), ''::bytea)), 'hex') into anchor
  from @SCHEMA@.entity e;
  return jsonb_build_object('ok', issues = '[]'::jsonb, 'issues', issues, 'anchor', anchor);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'now_ts()', 'family_lock(text, boolean)', 'class_set(jsonb)', 'role_accepts(text, uuid, text, text, uuid)',
    'apply_defaults(jsonb, jsonb)', 'check_links(jsonb, jsonb, uuid, boolean)', 'key_id(jsonb, text, uuid, jsonb, jsonb)',
    'log_version(@SCHEMA@.entity)', 'sys_update(uuid, jsonb, jsonb, jsonpath, text, text)', 'tombstone(@SCHEMA@.entity, text, uuid)',
    'links_replace(jsonb, uuid, uuid)', 'move_row(@SCHEMA@.entity, uuid, text, jsonb, jsonb, text)', 'reclass(uuid, text, jsonb)',
    'incoming_conflicts(uuid, text, uuid)', 'visible_detail(jsonb, uuid)', 'class_change_safe(jsonb, jsonb)',
    'family_conflicts(text[], uuid, boolean)', 'reserved_names()', 'class_admit(jsonb, uuid)',
    'trg_entity_bi()', 'trg_entity_bu()', 'trg_entity_ai()', 'class_evolve(@SCHEMA@.entity, @SCHEMA@.entity)',
    'trg_entity_bd()', 'trg_entity_ad()', 'merge(jsonb, jsonb)', 'inc(jsonb, text[], numeric, numeric)', 'verify()'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
-- сырой SQL пишет теми же merge и inc, что и библиотека
grant execute on function @SCHEMA@.merge(jsonb, jsonb), @SCHEMA@.inc(jsonb, text[], numeric, numeric),
  @SCHEMA@.verify(), @SCHEMA@.reserved_names(), @SCHEMA@.reclass(uuid, text, jsonb) to @APP@;
