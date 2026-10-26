-- letopis 1.2 — производные представления (план 1.1, §2.4): проекторы из журнала (этап 4а).
--
-- Проектор — процесс администратора, как загрузчик: работает от роли владельца (set local role),
-- читает журнал всех арендаторов функцией watch_read и пишет строки производных классов (derivedBy)
-- только функцией derived_apply. Чекпоинт — строка secret вида PROJECTOR (account = System, ident —
-- имя проектора): курсор журнала со снимком, версия проектора, состояние. Курсор сдвигается в той же
-- транзакции, что и запись результатов; писатель один — транзакционная advisory-блокировка
-- (19542, «схема:имя») на каждую пачку. Функции кредов вид PROJECTOR не видят (80-auth.sql).
-- Приложению функции файла не выданы: их вызывает только роль владельца.

-- Чекпоинт проектора: строка создаётся при первом обращении и блокируется до конца транзакции.
create or replace function @SCHEMA@.projector_state(p_name text) returns jsonb
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  m jsonb;
begin
  select s.meta into m from @SCHEMA@.secret s
  where s.kind = 'PROJECTOR' and s.ident = p_name and s.deleted_at is null
  for update;
  if not found then
    insert into @SCHEMA@.secret (account, kind, ident, meta) values ('@SYSTEM@'::uuid, 'PROJECTOR', p_name, '{}'::jsonb);
    return '{}'::jsonb;
  end if;
  return coalesce(m, '{}'::jsonb);
end $$;

-- Сдвиг чекпоинта: только если курсор тот, что прочитан в начале пачки (иначе false — пачку откатывают).
create or replace function @SCHEMA@.projector_advance(p_name text, p_expected text, p_meta jsonb) returns boolean
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  update @SCHEMA@.secret s set meta = p_meta
  where s.kind = 'PROJECTOR' and s.ident = p_name and s.deleted_at is null
    and s.meta->>'cursor' is not distinct from p_expected;
  return found;
end $$;

-- Строка проектора в формате загрузчика: поля и роли концов на верхнем уровне, служебные $tags, $owner,
-- $id; ключи на $ внутри данных — обычные данные. Делится на данные и концы по описанию класса.
create or replace function @SCHEMA@.derived_split(p_res jsonb, p_row jsonb, out data jsonb, out links jsonb)
language sql immutable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  select coalesce(jsonb_object_agg(x.key, x.value) filter (where not coalesce(p_res->'ends' ? x.key, false) and left(x.key, 1) <> '$'), '{}'::jsonb),
         coalesce(jsonb_object_agg(x.key, x.value) filter (where coalesce(p_res->'ends' ? x.key, false)), '{}'::jsonb)
  from jsonb_each(coalesce(p_row, '{}'::jsonb)) x
$$;

-- id строки проектора: v5 от ключа класса; у класса без ключа — $id строки (null — не задан).
create or replace function @SCHEMA@.derived_id(p_class text, p_tenant uuid, p_row jsonb) returns uuid
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  res jsonb := (@SCHEMA@.class_row(p_class, p_tenant)).data->'resolved';
  sp record;
  kid uuid;
begin
  select * into sp from @SCHEMA@.derived_split(res, p_row);
  kid := @SCHEMA@.key_id(res, p_class, p_tenant, sp.data, sp.links);
  if kid is null and pg_input_is_valid(p_row->>'$id', 'uuid') then
    kid := (p_row->>'$id')::uuid;
  end if;
  return kid;
end $$;

-- Запись результатов проектора p_name. Операции — [{op, class, tenant, row, deltas}]:
--   upsert — создать или заменить целиком по ключу;
--   inc    — создать или дополнить данными строки и прибавить deltas {поле: число} (нет поля — от 0);
--   delete — удалить по ключу или $id (строки нет — ничего).
-- row — строка в формате загрузчика (derived_split); $id нужен только классу без ключа, $owner — при
-- создании. Класс — производный именно этого проектора в арендаторе строки; данные — по описанию класса
-- (умолчания, проверка); концы — живые цели своего арендатора или System подходящего класса, не производные;
-- id — v5 от ключа. Пустая правка версии не даёт. Журнал — по history класса, сигнал — всегда (log_version,
-- tombstone). Возвращает {created, updated, deleted, unchanged}.
create or replace function @SCHEMA@.derived_apply(p_name text, p_ops jsonb) returns jsonb
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  o jsonb;
  op text;
  cname text;
  tid uuid;
  cls @SCHEMA@.entity;
  res jsonb;
  rw jsonb;
  sp record;
  d jsonb;
  bad jsonb;
  lk record;
  kid uuid;
  cur @SCHEMA@.entity;
  e @SCHEMA@.entity;
  last record;
  ts timestamptz;
  k record;
  tg text[];
  own uuid;
  v_agent text := 'letopis projector ' || p_name;
  v_reason text := nullif(current_setting('letopis.reason', true), '');
  n_created int := 0;
  n_updated int := 0;
  n_deleted int := 0;
  n_unchanged int := 0;
begin
  for o in select x from jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) x loop
    op := o->>'op';
    cname := o->>'class';
    rw := coalesce(o->'row', '{}'::jsonb);
    if op is null or op not in ('upsert', 'inc', 'delete') then
      perform @SCHEMA@.lt_fail('invalid_data', format('проектор %s: неизвестная операция %s', p_name, coalesce(op, 'null')));
    end if;
    if jsonb_typeof(rw) <> 'object' then
      perform @SCHEMA@.lt_fail('invalid_data', format('проектор %s: строка — не объект', p_name));
    end if;
    if not pg_input_is_valid(o->>'tenant', 'uuid') then
      perform @SCHEMA@.lt_fail('invalid_data', format('проектор %s: арендатор строки — не uuid', p_name));
    end if;
    tid := (o->>'tenant')::uuid;
    cls := @SCHEMA@.class_row(cname, tid);
    if cls.id is null then
      perform @SCHEMA@.lt_fail('invalid_class', format('класс %s не найден', cname));
    end if;
    -- как у писателей приложения: разделяемая блокировка семейства, описание — свежее под ней
    perform @SCHEMA@.family_lock(cls, false);
    cls := @SCHEMA@.class_row(cname, tid);
    res := cls.data->'resolved';
    if res->>'derivedBy' is distinct from p_name then
      perform @SCHEMA@.lt_fail('derived_class', format('класс %s не производный проектора %s', cname, p_name));
    end if;
    if coalesce((res->>'abstract')::boolean, false) then
      perform @SCHEMA@.lt_fail('invalid_class', format('класс %s абстрактный', cname));
    end if;
    select * into sp from @SCHEMA@.derived_split(res, rw);
    -- id: v5 от ключа; у класса без ключа — $id строки
    kid := @SCHEMA@.key_id(res, cname, tid, sp.data, sp.links);
    if kid is null then
      if not pg_input_is_valid(rw->>'$id', 'uuid') then
        perform @SCHEMA@.lt_fail('invalid_data', format('класс %s без ключа: проектору нужен $id строки', cname));
      end if;
      kid := (rw->>'$id')::uuid;
    elsif rw ? '$id' and (not pg_input_is_valid(rw->>'$id', 'uuid') or (rw->>'$id')::uuid <> kid) then
      perform @SCHEMA@.lt_fail('id_mismatch', format('$id не равен v5 от ключа класса %s', cname), jsonb_build_object('expected', kid));
    end if;
    select x.* into cur from @SCHEMA@.entity x where x.id = kid for update;
    if cur.id is not null and (cur.class <> cname or cur.tenant <> tid) then
      perform @SCHEMA@.lt_fail('id_mismatch', format('id %s занят строкой другого класса или арендатора', kid));
    end if;
    if op = 'delete' then
      if cur.id is not null then
        delete from @SCHEMA@.entity x where x.id = kid returning x.* into e;
        perform @SCHEMA@.tombstone(e);
        n_deleted := n_deleted + 1;
      end if;
      continue;
    end if;
    if op = 'inc' then
      d := @SCHEMA@.merge(coalesce(cur.data, '{}'::jsonb), sp.data);
      for k in select key, value from jsonb_each(coalesce(o->'deltas', '{}'::jsonb)) loop
        if jsonb_typeof(k.value) <> 'number' then
          perform @SCHEMA@.lt_fail('invalid_data', format('проектор %s: приращение поля %s — не число', p_name, k.key));
        end if;
        d := @SCHEMA@.inc(d, array[k.key], (k.value #>> '{}')::numeric, 0);
      end loop;
    else
      d := sp.data;
    end if;
    d := @SCHEMA@.apply_defaults(res->'schema', d);
    bad := @SCHEMA@.validate_data(res->'rules', cls.validator, res->'vars', d);
    if bad <> '[]'::jsonb then
      perform @SCHEMA@.lt_fail('invalid_data', format('данные не проходят описание класса %s', cname), jsonb_build_object('issues', bad));
    end if;
    -- концы: у inc без концов в строке — прежние
    select * into lk from @SCHEMA@.check_links(res,
      case when op = 'inc' and sp.links = '{}'::jsonb then coalesce(cur.links, '{}'::jsonb) else sp.links end,
      tid, true, null);
    if lk.code is not null then
      perform @SCHEMA@.lt_fail(lk.code, lk.msg);
    end if;
    if rw ? '$tags' and jsonb_typeof(rw->'$tags') <> 'array' then
      perform @SCHEMA@.lt_fail('invalid_data', format('проектор %s: $tags — список строк', p_name));
    end if;
    tg := case when rw ? '$tags' then array(select jsonb_array_elements_text(rw->'$tags')) else coalesce(cur.tags, '{}') end;
    if cur.id is null then
      own := tid;
      if rw->>'$owner' is not null then
        if not pg_input_is_valid(rw->>'$owner', 'uuid') then
          perform @SCHEMA@.lt_fail('invalid_data', format('проектор %s: $owner — не uuid', p_name));
        end if;
        own := (rw->>'$owner')::uuid;
        if own <> tid and not exists (select 1 from @SCHEMA@.entity a where a.id = own and a.class = 'Account' and a.tenant = '@SYSTEM@'::uuid) then
          perform @SCHEMA@.lt_fail('target_not_found', 'владелец строки не найден');
        end if;
      end if;
      -- воскрешение: номер версии и цепочка хэшей продолжаются от последней записи журнала (как trg_entity_bi)
      select l.rev, l.hash, l.at into last from @SCHEMA@.log l where l.id = kid order by l.rev desc limit 1 for update;
      ts := greatest(@SCHEMA@.now_ts(), last.at + interval '1 microsecond');
      insert into @SCHEMA@.entity (id, rev, class, cv, tenant, owner, links, data, tags, at, created_at, author, agent, op, reason, moved, prev_hash, validator)
      values (kid, coalesce(last.rev, 0) + 1, cname, cls.rev, tid, own, lk.links, d, tg, ts, ts, '@SYSTEM@'::uuid, v_agent, 'create',
              v_reason, null, last.hash, null)
      returning * into e;
      perform @SCHEMA@.log_version(e);
      n_created := n_created + 1;
    elsif cur.data = d and cur.links = lk.links and cur.tags = tg then
      n_unchanged := n_unchanged + 1;
    else
      update @SCHEMA@.entity x
         set data = d, links = lk.links, tags = tg, rev = x.rev + 1, prev_hash = x.hash,
             at = greatest(@SCHEMA@.now_ts(), x.at + interval '1 microsecond'),
             author = '@SYSTEM@'::uuid, agent = v_agent, op = 'update', reason = v_reason, moved = null, cv = cls.rev
       where x.id = kid
      returning x.* into e;
      perform @SCHEMA@.log_version(e);
      n_updated := n_updated + 1;
    end if;
  end loop;
  return jsonb_build_object('created', n_created, 'updated', n_updated, 'deleted', n_deleted, 'unchanged', n_unchanged);
end $$;

-- Перестройка проектора: строки всех его производных классов во всех арендаторах удаляются одним
-- оператором; надгробия — по history класса одной вставкой, сигнал — по парам «класс, арендатор».
-- Возвращает число удалённых строк.
create or replace function @SCHEMA@.derived_clear(p_name text) returns int
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  n int;
  pairs text[];
  v_author uuid := '@SYSTEM@'::uuid;
  v_agent text := 'letopis projector ' || p_name;
  v_reason text := nullif(current_setting('letopis.reason', true), '');
begin
  with c as (
    select distinct x.data->>'name' as name, x.tenant from @SCHEMA@.entity x
    where x.class = 'Class' and x.data->'resolved'->>'derivedBy' = p_name
  ), g as (
    delete from @SCHEMA@.entity e using c where e.class = c.name and e.tenant = c.tenant
    returning e.*
  ), t as (
    insert into @SCHEMA@.log (id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason, moved, prev_hash, changed)
    select g.id, g.rev + 1, g.class, g.cv, g.tenant, g.owner, g.links, g.data, g.tags,
           greatest(@SCHEMA@.now_ts(), g.at + interval '1 microsecond'), v_author, v_agent, 'delete', v_reason, null, g.hash, '[]'::jsonb
    from g
    join (select d.class, d.tenant from (select distinct y.class, y.tenant from g y) d
          where @SCHEMA@.history_on(d.class, d.tenant)) h on h.class = g.class and h.tenant = g.tenant
  )
  select count(*)::int, coalesce(array_agg(distinct g.class || ' ' || g.tenant::text), '{}') into n, pairs from g;
  if n > 0 then
    perform @SCHEMA@.signal(array_agg(split_part(x.p, ' ', 1)), array_agg(split_part(x.p, ' ', 2)::uuid))
    from unnest(pairs) x(p);
  end if;
  return n;
end $$;

do $$
declare f text;
begin
  foreach f in array array['projector_state(text)', 'projector_advance(text, text, jsonb)', 'derived_split(jsonb, jsonb)',
    'derived_id(text, uuid, jsonb)', 'derived_apply(text, jsonb)', 'derived_clear(text)'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
