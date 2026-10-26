-- letopis 1.2 — производные представления (план 1.1, §2.4): проекторы из журнала (этап 4а) и агрегаты в базе
-- (этап 4б, раздел «Агрегаты» ниже).
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

-- ========================= агрегаты в базе (этап 4б) =========================
--
-- Опция класса aggregate (40-class.sql): { <поле>: { sum: <поле источника> | count: true, of: <класс-источник>,
-- via: <роль конца источника>, where?: JSON Schema } }. Поле цели — сумма поля sum или число живых строк класса of
-- (с потомками) того же арендатора, чей одиночный конец via ведёт на цель и чьи данные проходят where. Строка System
-- и строки других арендаторов в агрегат не входят: общий справочник не считает данные всех арендаторов.
--
-- Держит поле триггер после оператора entity_total_* (без условия WHEN — и для владельца, enable always): по
-- переходным таблицам вклады строк оператора (прежние версии со знаком минус, новые — плюс) группируются по цели,
-- цели блокируются в порядке id, приращение — inc, итог проверяет описание класса цели (minimum: 0 → invalid_data),
-- версия — sys_update (автор, агент и причина — из контекста оператора, журнал по history, сигнал). Новые цели
-- оператора (вставка, restore, смена класса) считаются целиком из живых источников и пишутся в ту же версию — в entity
-- и в уже записанную версию журнала (хэши — генерируемые колонки); поэтому функции владельца, пишущие журнал после
-- вставки, перечитывают строку (restore, sys_update со сменой класса), а sys_create и загрузчик пишут журнал раньше.
-- Перенос строки (move_row: reclass, rekey) — несколько операторов: на это время триггер копит вклады
-- (agg_hold_begin), а перенос в конце применяет их одним итогом. Признак — letopis.agg_hold: HMAC ключом строки KEY
-- от «режим:транзакция», поэтому выставить его приложение не может.
--
-- Источник узнаётся по метке aggregatedBy в resolved его класса: [{ class, field, via }] — какие цели считают его
-- строки (агрегаты своего арендатора и System). Метку считает class_prepare (agg_source), а при появлении, правке и
-- удалении цели — agg_mark: класс-источник часто описывают после цели. Описание агрегата — ужесточение
-- (class_change_safe): исключительные блокировки семейства цели и семейств источников, пересчёт поля у всех целей
-- (class_evolve). Ремонт — rebuild_aggregates, расхождения показывает verify(true) (agg_issues), первая заливка —
-- agg_fill.

-- Агрегатные поля класса по развёрнутому описанию.
create or replace function @SCHEMA@.agg_fields(p_res jsonb) returns text[]
language sql immutable parallel safe
return array(select jsonb_object_keys(coalesce(p_res->'aggregate', '{}'::jsonb)));

-- Классы-источники агрегатов класса (of).
create or replace function @SCHEMA@.agg_of(p_res jsonb) returns text[]
language sql immutable parallel safe
return array(select distinct f.value->>'of' from jsonb_each(coalesce(p_res->'aggregate', '{}'::jsonb)) f);

-- Данные с агрегатными полями: число остаётся (его пересчитают), иначе 0.
create or replace function @SCHEMA@.agg_zero(p_res jsonb, p_data jsonb) returns jsonb
language sql immutable parallel safe
return coalesce(p_data, '{}'::jsonb) || coalesce((select jsonb_object_agg(f, case when jsonb_typeof(p_data->f) = 'number' then p_data->f else '0'::jsonb end)
                                                  from unnest(@SCHEMA@.agg_fields(p_res)) f), '{}'::jsonb);

-- Число из значения источника: не число — 0.
create or replace function @SCHEMA@.agg_num(p_v jsonb) returns numeric
language sql immutable parallel safe
return case when jsonb_typeof(p_v) = 'number' then (p_v #>> '{}')::numeric else 0 end;

-- Проходят ли данные источника условие where агрегата (скомпилированное: rules, path, vars); условия нет — да.
create or replace function @SCHEMA@.agg_where_ok(p_m jsonb, p_data jsonb) returns boolean
language sql stable
return p_m is null or @SCHEMA@.validate_data(p_m->'rules', (p_m->>'path')::jsonpath, p_m->'vars', p_data) = '[]'::jsonb;

-- Правка строки приложением (trg_entity_bu): агрегатное поле не меняется — изменённое значение отклоняется, без поля
-- (замена данных целиком) возвращается прежнее; при смене класса — прежнее число или 0 (итог посчитает триггер).
create or replace function @SCHEMA@.agg_guard(p_res jsonb, p_old jsonb, p_new jsonb, p_reclass boolean) returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  f text;
  d jsonb := coalesce(p_new, '{}'::jsonb);
begin
  if p_reclass then
    return @SCHEMA@.agg_zero(p_res, d);
  end if;
  foreach f in array @SCHEMA@.agg_fields(p_res) loop
    if not (d ? f) then
      d := d || jsonb_build_object(f, coalesce(p_old->f, '0'::jsonb));
    elsif d->f is distinct from p_old->f then
      perform @SCHEMA@.lt_fail('aggregate_field', format('поле %s класса %s считает база (aggregate) — его не меняют', f, p_res->>'name'));
    end if;
  end loop;
  return d;
end $$;

-- Правка существующей строки загрузчиком (existing: 'update'): агрегатные поля — прежние.
create or replace function @SCHEMA@.agg_keep(p_class text, p_tenant uuid, p_old jsonb, p_new jsonb) returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  res jsonb := (@SCHEMA@.class_row(p_class, p_tenant)).data->'resolved';
begin
  if res is null or not (res ? 'aggregate') then
    return p_new;
  end if;
  return coalesce(p_new, '{}'::jsonb) || coalesce((select jsonb_object_agg(f, coalesce(p_old->f, '0'::jsonb))
                                                   from unnest(@SCHEMA@.agg_fields(res)) f), '{}'::jsonb);
end $$;

-- Сверка источника с агрегатом цели: класс не системный и не производный, роль via — одиночный конец, принимающий
-- класс цели (или предка), поле суммы — число (сумма number в поле integer не помещается). p_src, p_tgt — resolved.
create or replace function @SCHEMA@.agg_check_source(p_src jsonb, p_tgt jsonb, p_field text, p_def jsonb) returns void
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  w text := format('агрегат %s.%s', p_tgt->>'name', p_field);
  e jsonb := p_src->'ends'->(p_def->>'via');
  fld jsonb;
begin
  if (p_src->>'name') = any (array['Class', 'Account', 'member', 'Resource', 'rule']) then
    perform @SCHEMA@.lt_raise('LT010', 'invalid_class', format('%s: системный класс %s не бывает источником агрегата', w, p_src->>'name'));
  end if;
  if p_src ? 'derivedBy' then
    perform @SCHEMA@.lt_raise('LT010', 'invalid_class', format('%s: производный класс %s не бывает источником агрегата', w, p_src->>'name'));
  end if;
  if e is null then
    perform @SCHEMA@.lt_raise('LT010', 'invalid_class', format('%s: у источника %s нет конца %s', w, p_src->>'name', p_def->>'via'));
  end if;
  if coalesce((e->>'many')::boolean, false) then
    perform @SCHEMA@.lt_raise('LT010', 'invalid_class',
      format('%s: конец %s источника %s множественный — агрегат считается через одиночный конец', w, p_def->>'via', p_src->>'name'));
  end if;
  if not coalesce(@SCHEMA@.class_set(e->'class') ?| array(select jsonb_array_elements_text(p_tgt->'ancestors')), false) then
    perform @SCHEMA@.lt_raise('LT010', 'invalid_class',
      format('%s: конец %s источника %s не принимает класс %s', w, p_def->>'via', p_src->>'name', p_tgt->>'name'));
  end if;
  if p_def ? 'sum' then
    fld := p_src->'schema'->'properties'->(p_def->>'sum');
    if fld is null or coalesce(fld->>'type', '') not in ('integer', 'number') then
      perform @SCHEMA@.lt_raise('LT010', 'invalid_class', format('%s: поле суммы %s источника %s — число (integer или number)', w, p_def->>'sum', p_src->>'name'));
    end if;
    if fld->>'type' = 'number' and p_tgt->'schema'->'properties'->p_field->>'type' = 'integer' then
      perform @SCHEMA@.lt_raise('LT010', 'invalid_class', format('%s: сумма поля number %s.%s в поле integer не помещается', w, p_src->>'name', p_def->>'sum'));
    end if;
  end if;
end $$;

-- Цикл агрегатов через класс p_res (арендатор и System; описание p_res — вместо его строки): цель a зависит от цели
-- b, если считает строки семейства, в которое входит b. Нет цикла — null, иначе путь «A → B → A».
create or replace function @SCHEMA@.agg_cycle(p_tenant uuid, p_res jsonb) returns text
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  with recursive tg as (
    select x.data->>'name' as name, x.data->'resolved' as res from @SCHEMA@.entity x
    where x.class = 'Class' and x.tenant in (p_tenant, '@SYSTEM@'::uuid) and x.data->>'name' <> p_res->>'name'
      and x.data->'resolved' ? 'aggregate'
    union all
    select p_res->>'name', p_res
  ), edge as (
    select distinct a.name as a, b.name as b
    from tg a
    cross join lateral jsonb_each(a.res->'aggregate') g
    join tg b on b.res->'ancestors' ? (g.value->>'of')
  ), walk(node, path) as (
    select e.b, array[e.a, e.b] from edge e where e.a = p_res->>'name'
    union all
    select e.b, w.path || e.b from walk w join edge e on e.a = w.node
    where w.node <> p_res->>'name' and not (e.b = any (w.path[2:]))
  )
  select array_to_string(w.path, ' → ') from walk w where w.node = p_res->>'name' limit 1
$$;

-- Описание агрегатов цели (из class_prepare): ровно одно из sum и count; поле — число из схемы класса, не в ключе;
-- уже описанные источники (класс of и его потомки) сверены; цели нет в цикле; условие where скомпилировано (match).
-- Цель — не системный и не производный класс; агрегат арендатора не считает строки класса System.
create or replace function @SCHEMA@.agg_prepare(p_res jsonb, p_data jsonb, p_tenant uuid) returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  nm text := p_res->>'name';
  f record;
  d jsonb;
  fld jsonb;
  s record;
  c record;
  outv jsonb := '{}'::jsonb;
  cyc text;
begin
  if coalesce((p_data->>'system')::boolean, false) then
    perform @SCHEMA@.lt_raise('LT010', 'invalid_class', 'системный класс не бывает целью агрегата');
  end if;
  if p_res ? 'derivedBy' then
    perform @SCHEMA@.lt_raise('LT010', 'invalid_class', format('производный класс %s не бывает целью агрегата: его строки строит проектор', nm));
  end if;
  for f in select key, value from jsonb_each(p_res->'aggregate') order by key loop
    d := f.value - 'match';
    if (d ? 'sum') = (d ? 'count') then
      perform @SCHEMA@.lt_raise('LT010', 'invalid_class', format('агрегат %s.%s: нужно ровно одно из sum (поле источника) и count: true', nm, f.key));
    end if;
    fld := p_res->'schema'->'properties'->f.key;
    if fld is null then
      perform @SCHEMA@.lt_raise('LT010', 'invalid_class', format('агрегатного поля %s нет среди полей класса %s', f.key, nm));
    end if;
    if coalesce(fld->>'type', '') not in ('integer', 'number') then
      perform @SCHEMA@.lt_raise('LT010', 'invalid_class', format('агрегатное поле %s.%s — число (integer или number)', nm, f.key));
    end if;
    if coalesce(p_res->'key' ? f.key, false) then
      perform @SCHEMA@.lt_raise('LT010', 'invalid_class', format('агрегатное поле %s.%s в ключ не входит', nm, f.key));
    end if;
    for s in select x.tenant, x.data->'resolved' as res from @SCHEMA@.entity x
             where x.class = 'Class' and x.data->>'name' <> nm
               and (x.tenant in (p_tenant, '@SYSTEM@'::uuid) or p_tenant = '@SYSTEM@'::uuid)
               and x.data->'resolved'->'ancestors' ? (d->>'of')
             order by x.id loop
      if p_tenant <> '@SYSTEM@'::uuid and s.tenant = '@SYSTEM@'::uuid and (s.res->>'name') = (d->>'of') then
        perform @SCHEMA@.lt_raise('LT010', 'invalid_class',
          format('агрегат %s.%s: источник %s — класс System, а агрегат арендатора считает только классы своего арендатора', nm, f.key, d->>'of'));
      end if;
      perform @SCHEMA@.agg_check_source(s.res, p_res, f.key, d);
    end loop;
    if d ? 'where' then
      select * into c from @SCHEMA@.compile_validator(d->'where');
      d := d || jsonb_build_object('match', jsonb_build_object('rules', c.rules, 'path', c.validator::text, 'vars', c.vars));
    end if;
    outv := outv || jsonb_build_object(f.key, d);
  end loop;
  p_res := p_res || jsonb_build_object('aggregate', outv);
  cyc := @SCHEMA@.agg_cycle(p_tenant, p_res);
  if cyc is not null then
    perform @SCHEMA@.lt_raise('LT010', 'invalid_class', format('цикл агрегатов: %s', cyc));
  end if;
  return p_res;
end $$;

-- Метка источника (из class_prepare): агрегаты своего арендатора и System, которые считают строки класса (of — сам
-- класс или предок), и та же сверка, что при описании цели. Классу System метка — только от агрегатов System:
-- агрегат арендатора, чей источник оказался бы классом System, отклоняется.
create or replace function @SCHEMA@.agg_source(p_res jsonb, p_tenant uuid) returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  k record;
  f record;
  marks jsonb := '[]'::jsonb;
begin
  for k in select x.tenant, x.data->'resolved' as res from @SCHEMA@.entity x
           where x.class = 'Class' and x.data->>'name' <> p_res->>'name' and x.data->'resolved' ? 'aggregate'
             and (x.tenant in (p_tenant, '@SYSTEM@'::uuid) or p_tenant = '@SYSTEM@'::uuid)
           order by x.data->>'name', x.tenant loop
    for f in select key, value from jsonb_each(k.res->'aggregate') where p_res->'ancestors' ? (value->>'of') order by key loop
      if p_tenant = '@SYSTEM@'::uuid and k.tenant <> '@SYSTEM@'::uuid then
        -- у арендатора свой класс с этим именем — его агрегат считает свой класс, а не класс System
        if not exists (select 1 from @SCHEMA@.entity y where y.class = 'Class' and y.tenant = k.tenant and y.data->>'name' = f.value->>'of') then
          perform @SCHEMA@.lt_raise('LT010', 'invalid_class',
            format('класс %s — источник агрегата %s.%s арендатора %s, а агрегат арендатора считает только классы своего арендатора',
              p_res->>'name', k.res->>'name', f.key, k.tenant));
        end if;
        continue;
      end if;
      perform @SCHEMA@.agg_check_source(p_res, k.res, f.key, f.value);
      marks := marks || jsonb_build_array(jsonb_build_object('class', k.res->>'name', 'field', f.key, 'via', f.value->>'via'));
    end loop;
  end loop;
  return case when marks = '[]'::jsonb then p_res - 'aggregatedBy' else p_res || jsonb_build_object('aggregatedBy', marks) end;
end $$;

-- Цели, чей набор источников изменился вместе с меткой класса (смена предков): их поле считается заново.
create or replace function @SCHEMA@.agg_marked(p_old jsonb, p_new jsonb) returns text[]
language sql immutable parallel safe
return case when p_old->'aggregatedBy' is not distinct from p_new->'aggregatedBy' then '{}'::text[]
  else array(select distinct m->>'class' from jsonb_array_elements(coalesce(p_old->'aggregatedBy', '[]'::jsonb)
                                                                    || coalesce(p_new->'aggregatedBy', '[]'::jsonb)) m) end;

-- Метки источников заново: классы арендатора p_tenant (System — всех), в предках которых есть одно из имён p_names;
-- изменившееся описание — новой версией строки Class (журнал, сигнал).
create or replace function @SCHEMA@.agg_mark(p_tenant uuid, p_names text[]) returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  d @SCHEMA@.entity;
  prep record;
begin
  if p_names is null or cardinality(p_names) = 0 then
    return;
  end if;
  for d in select x.* from @SCHEMA@.entity x
           where x.class = 'Class' and (x.tenant = p_tenant or p_tenant = '@SYSTEM@'::uuid)
             and x.data->'resolved'->'ancestors' ?| p_names
           order by jsonb_array_length(x.data->'resolved'->'ancestors'), x.id loop
    select p.data, p.validator into prep from @SCHEMA@.class_prepare(d.data, d.tenant) p;
    if prep.data is distinct from d.data or prep.validator::text is distinct from d.validator::text then
      perform @SCHEMA@.sys_update(d.id, prep.data, d.links, prep.validator, 'update');
    end if;
  end loop;
end $$;

-- Исключительные блокировки семейств источников прежнего и нового описания агрегатов (смена описания, ремонт):
-- писатели источников держат разделяемую, поэтому зафиксированное до пересчёта в него войдёт, а ожидающие допишут
-- вклад по новому описанию. Цель System — источники во всех арендаторах.
create or replace function @SCHEMA@.agg_lock_sources(p_old jsonb, p_new jsonb, p_tenant uuid) returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  tc @SCHEMA@.entity;
begin
  for tc in select x.* from @SCHEMA@.entity x
            where x.class = 'Class' and x.data->>'name' = any (@SCHEMA@.agg_of(p_old) || @SCHEMA@.agg_of(p_new))
              and (x.tenant in (p_tenant, '@SYSTEM@'::uuid) or p_tenant = '@SYSTEM@'::uuid)
            order by x.id loop
    perform @SCHEMA@.family_lock(tc, true);
  end loop;
end $$;

-- Классы-источники of в арендаторе: сам класс и потомки (свои и System).
create or replace function @SCHEMA@.agg_classes(p_of text, p_tenant uuid) returns text[]
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  select coalesce(array_agg(x.data->>'name'), '{}') from @SCHEMA@.entity x
  where x.class = 'Class' and x.tenant in (p_tenant, '@SYSTEM@'::uuid) and x.data->'resolved'->'ancestors' ? p_of
$$;

-- Агрегатные поля цели p_id целиком из живых источников её арендатора: { поле: итог }.
create or replace function @SCHEMA@.agg_compute(p_res jsonb, p_id uuid, p_tenant uuid) returns jsonb
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  with d as (
    select f.key as field, f.value as def, @SCHEMA@.agg_classes(f.value->>'of', p_tenant) as cls
    from jsonb_each(coalesce(p_res->'aggregate', '{}'::jsonb)) f
  )
  select coalesce(jsonb_object_agg(d.field, to_jsonb(coalesce(x.v, 0))), '{}'::jsonb)
  from d
  left join lateral (
    select sum(case when d.def ? 'count' then 1 else @SCHEMA@.agg_num(s.data->(d.def->>'sum')) end) as v
    from @SCHEMA@.entity s
    where s.ends @> array[p_id] and s.tenant = p_tenant and s.class = any (d.cls)
      and s.links->>(d.def->>'via') = p_id::text and @SCHEMA@.agg_where_ok(d.def->'match', s.data)
  ) x on true
$$;

-- Итог цели проходит описание её класса (minimum: 0 и прочие правила), иначе invalid_data с нарушениями.
create or replace function @SCHEMA@.agg_check(p_class text, p_tenant uuid, p_data jsonb) returns void
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  cls @SCHEMA@.entity := @SCHEMA@.class_row(p_class, p_tenant);
  bad jsonb;
begin
  bad := @SCHEMA@.validate_data(cls.data->'resolved'->'rules', cls.validator, cls.data->'resolved'->'vars', p_data);
  if bad <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('invalid_data', format('данные не проходят описание класса %s (агрегатное поле)', p_class), jsonb_build_object('issues', bad));
  end if;
end $$;

-- Новое значение цели — версией от имени владельца (sys_update); то же значение — без версии. Возвращает «записано».
create or replace function @SCHEMA@.agg_write(r @SCHEMA@.entity, p_data jsonb, p_check boolean) returns boolean
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  if p_data is not distinct from r.data then
    return false;
  end if;
  if p_check then
    perform @SCHEMA@.agg_check(r.class, r.tenant, p_data);
  end if;
  perform @SCHEMA@.sys_update(r.id, p_data, r.links, r.validator, 'update');
  return true;
end $$;

-- Признак «триггер агрегатов копит» (acc) или «молчит» (off) в этой транзакции: HMAC ключом строки KEY.
create or replace function @SCHEMA@.agg_token(p_mode text) returns text
language sql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  select encode(@PGCRYPTO@.hmac(convert_to('letopis:aggregates:' || p_mode || ':' || pg_current_xact_id()::text, 'UTF8'), s.material, 'sha256'), 'hex')
  from @SCHEMA@.secret s where s.id = '@SYSTEM@'::uuid and s.kind = 'KEY'
$$;

create or replace function @SCHEMA@.agg_held() returns text
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  h text := current_setting('letopis.agg_hold', true);
begin
  if h is null or h = '' then
    return null;
  end if;
  if h = @SCHEMA@.agg_token('acc') then
    return 'acc';
  end if;
  if h = @SCHEMA@.agg_token('off') then
    return 'off';
  end if;
  return null;
end $$;

-- Начало несколькооператорной операции владельца: acc — вклады копятся до agg_hold_end, off — не считаются (сброс
-- арендатора). Уже начато (вложенный перенос) — false: итог применит внешний вызов.
create or replace function @SCHEMA@.agg_hold_begin(p_mode text) returns boolean
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  tok text;
begin
  if @SCHEMA@.agg_held() is not null then
    return false;
  end if;
  tok := @SCHEMA@.agg_token(p_mode);
  if tok is null then
    return false;
  end if;
  perform set_config('letopis.agg_acc', '{}', true);
  perform set_config('letopis.agg_hold', tok, true);
  return true;
end $$;

-- Конец: признак снимается до применения — записи итога идут обычным путём (и считаются агрегатами выше по цепочке).
create or replace function @SCHEMA@.agg_hold_end(p_apply boolean) returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  acc jsonb := case when p_apply then nullif(current_setting('letopis.agg_acc', true), '')::jsonb end;
begin
  perform set_config('letopis.agg_hold', '', true);
  perform set_config('letopis.agg_acc', '', true);
  if acc is not null then
    perform @SCHEMA@.agg_flush(acc);
  end if;
end $$;

-- Сложение накопленных приращений { id: { поле: число } }.
create or replace function @SCHEMA@.agg_merge(a jsonb, b jsonb) returns jsonb
language sql immutable parallel safe
return (
  select coalesce(jsonb_object_agg(z.id, z.f), '{}'::jsonb)
  from (select y.id, jsonb_object_agg(y.field, y.v) as f
        from (select i.key as id, f.key as field, sum((f.value #>> '{}')::numeric) as v
              from (select * from jsonb_each(coalesce(a, '{}'::jsonb)) union all select * from jsonb_each(coalesce(b, '{}'::jsonb))) i
              cross join lateral jsonb_each(i.value) f
              group by 1, 2) y
        group by y.id) z
);

-- Итог накопленного: цели по возрастанию id, новые (f) — целиком из живых источников, остальные — приращения (d).
create or replace function @SCHEMA@.agg_flush(p_acc jsonb) returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  ids uuid[] := array(select distinct y.x::uuid from (
      select jsonb_object_keys(coalesce(p_acc->'d', '{}'::jsonb)) as x
      union select jsonb_array_elements_text(coalesce(p_acc->'f', '[]'::jsonb))) y);
  r @SCHEMA@.entity;
  res jsonb;
  d jsonb;
  k record;
begin
  for r in select x.* from @SCHEMA@.entity x where x.id = any (ids) order by x.id for no key update loop
    res := (@SCHEMA@.class_row(r.class, r.tenant)).data->'resolved';
    continue when not coalesce(res ? 'aggregate', false);
    if coalesce(p_acc->'f', '[]'::jsonb) ? r.id::text then
      d := r.data || @SCHEMA@.agg_compute(res, r.id, r.tenant);
    else
      d := r.data;
      for k in select key, value from jsonb_each(p_acc->'d'->(r.id::text)) where res->'aggregate' ? key loop
        d := @SCHEMA@.inc(d, array[k.key], (k.value #>> '{}')::numeric, 0);
      end loop;
    end if;
    perform @SCHEMA@.agg_write(r, d, true);
  end loop;
end $$;

-- Касается ли класс агрегатов в арендаторе: target — у него есть агрегаты, source — его строки считают, both — оба.
create or replace function @SCHEMA@.agg_kind(p_class text, p_tenant uuid) returns text
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  select case when x.r ? 'aggregate' then case when x.r ? 'aggregatedBy' then 'both' else 'target' end
              when x.r ? 'aggregatedBy' then 'source' end
  from (select (@SCHEMA@.class_row(p_class, p_tenant)).data->'resolved' as r) x
$$;

-- Вклады строк одного оператора (из триггеров entity_total_*): p_old — прежние версии (вклад вычитается), p_new —
-- новые (прибавляется), [{id, class, tenant, links, data}] только классов, касающихся агрегатов; p_fresh — новые цели
-- оператора, их поле считается целиком.
create or replace function @SCHEMA@.agg_apply(p_old jsonb, p_new jsonb, p_fresh uuid[]) returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  hold text := @SCHEMA@.agg_held();
  fresh uuid[] := coalesce(p_fresh, '{}');
  tids uuid[];
  deltas jsonb := '{}'::jsonb;
  acc jsonb;
  r @SCHEMA@.entity;
  res jsonb;
  d jsonb;
  k record;
begin
  if hold = 'off' then
    return;
  end if;
  -- цели вкладов: живые строки того же арендатора по концам via из меток классов-источников; новые цели оператора
  -- приращения обходят — их поле считается целиком ниже
  with src as (
    select x.* from jsonb_to_recordset(coalesce(p_old, '[]'::jsonb) || coalesce(p_new, '[]'::jsonb))
      as x(id uuid, class text, tenant uuid, links jsonb, data jsonb)
  ), mk as (
    select distinct p.class, p.tenant, m.value->>'via' as via
    from (select distinct s.class, s.tenant from src s) p
    cross join lateral jsonb_array_elements(coalesce((@SCHEMA@.class_row(p.class, p.tenant)).data->'resolved'->'aggregatedBy', '[]'::jsonb)) m
  )
  select coalesce(array_agg(distinct t.id order by t.id), '{}') into tids
  from src s
  join mk on mk.class = s.class and mk.tenant = s.tenant
  join @SCHEMA@.entity t on t.id = case when jsonb_typeof(s.links->mk.via) = 'string' then (s.links->>mk.via)::uuid end
                        and t.tenant = s.tenant
  where not (t.id = any (fresh));
  if cardinality(tids) > 0 then
    -- блокировка до подсчёта: описание класса цели и её строка — свежие
    perform 1 from @SCHEMA@.entity x where x.id = any (tids) order by x.id for no key update;
    with src as (
      select -1 as sign, x.* from jsonb_to_recordset(coalesce(p_old, '[]'::jsonb)) as x(id uuid, class text, tenant uuid, links jsonb, data jsonb)
      union all
      select 1, x.* from jsonb_to_recordset(coalesce(p_new, '[]'::jsonb)) as x(id uuid, class text, tenant uuid, links jsonb, data jsonb)
    ), mk as (
      select distinct p.class, p.tenant, m.value->>'via' as via
      from (select distinct s.class, s.tenant from src s) p
      cross join lateral jsonb_array_elements(coalesce((@SCHEMA@.class_row(p.class, p.tenant)).data->'resolved'->'aggregatedBy', '[]'::jsonb)) m
    ), lk as (
      select s.sign, s.class, s.tenant, s.data, mk.via,
             case when jsonb_typeof(s.links->mk.via) = 'string' then (s.links->>mk.via)::uuid end as tid
      from src s join mk on mk.class = s.class and mk.tenant = s.tenant
    ), tg as (
      select lk.*, t.class as tclass from lk join @SCHEMA@.entity t on t.id = lk.tid and t.tenant = lk.tenant
      where lk.tid = any (tids)
    ), td as (
      select p.tclass, p.tenant, (@SCHEMA@.class_row(p.tclass, p.tenant)).data->'resolved'->'aggregate' as agg
      from (select distinct tg.tclass, tg.tenant from tg) p
    ), sa as (
      select p.class, p.tenant, (@SCHEMA@.class_row(p.class, p.tenant)).data->'resolved'->'ancestors' as anc
      from (select distinct tg.class, tg.tenant from tg) p
    ), ct as (
      select tg.tid, f.key as field,
             sum(tg.sign * case when f.value ? 'count' then 1 else @SCHEMA@.agg_num(tg.data->(f.value->>'sum')) end) as delta
      from tg
      join td on td.tclass = tg.tclass and td.tenant = tg.tenant
      join sa on sa.class = tg.class and sa.tenant = tg.tenant
      cross join lateral jsonb_each(coalesce(td.agg, '{}'::jsonb)) f
      where f.value->>'via' = tg.via and sa.anc ? (f.value->>'of') and @SCHEMA@.agg_where_ok(f.value->'match', tg.data)
      group by tg.tid, f.key
    )
    select coalesce(jsonb_object_agg(z.tid, z.f), '{}'::jsonb) into deltas
    from (select ct.tid, jsonb_object_agg(ct.field, ct.delta) as f from ct where ct.delta <> 0 group by ct.tid) z;
  end if;
  -- перенос строки (move_row): вклады и новые цели копятся до его конца
  if hold = 'acc' then
    acc := coalesce(nullif(current_setting('letopis.agg_acc', true), '')::jsonb, '{}'::jsonb);
    acc := jsonb_build_object('d', @SCHEMA@.agg_merge(acc->'d', deltas),
      'f', to_jsonb(array(select distinct x from unnest(array(select jsonb_array_elements_text(coalesce(acc->'f', '[]'::jsonb))) || fresh::text[]) x
                          order by x)));
    perform set_config('letopis.agg_acc', acc::text, true);
    return;
  end if;
  -- приращения: inc по пути, итог — по описанию класса, версия — sys_update
  for r in select x.* from @SCHEMA@.entity x where x.id = any (tids) and deltas ? x.id::text order by x.id loop
    d := r.data;
    for k in select key, value from jsonb_each(deltas->(r.id::text)) loop
      d := @SCHEMA@.inc(d, array[k.key], (k.value #>> '{}')::numeric, 0);
    end loop;
    perform @SCHEMA@.agg_write(r, d, true);
  end loop;
  -- новые цели оператора: поле целиком из живых источников — в ту же версию, в entity и в журнал
  for r in select x.* from @SCHEMA@.entity x where x.id = any (fresh) order by x.id loop
    res := (@SCHEMA@.class_row(r.class, r.tenant)).data->'resolved';
    continue when not coalesce(res ? 'aggregate', false);
    d := r.data || @SCHEMA@.agg_compute(res, r.id, r.tenant);
    continue when d = r.data;
    perform @SCHEMA@.agg_check(r.class, r.tenant, d);
    update @SCHEMA@.entity x set data = d where x.id = r.id;
    update @SCHEMA@.log l set data = d, changed = null where l.id = r.id and l.rev = r.rev;
  end loop;
end $$;

-- Поле целей классов p_classes арендатора p_tenant (System — всех арендаторов) целиком из живых источников: строки по
-- возрастанию id под блокировкой, версия — только там, где значение изменилось. p_check — проверять итог описанием
-- класса (пересчёт при ужесточении проверяет ужесточение). Возвращает число исправленных строк.
create or replace function @SCHEMA@.agg_refresh(p_classes text[], p_tenant uuid, p_check boolean) returns int
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  r @SCHEMA@.entity;
  res jsonb;
  n int := 0;
begin
  for r in select x.* from @SCHEMA@.entity x
           where x.class = any (p_classes) and (x.tenant = p_tenant or p_tenant = '@SYSTEM@'::uuid)
           order by x.id for no key update loop
    res := (@SCHEMA@.class_row(r.class, r.tenant)).data->'resolved';
    continue when not coalesce(res ? 'aggregate', false);
    if @SCHEMA@.agg_write(r, r.data || @SCHEMA@.agg_compute(res, r.id, r.tenant), p_check) then
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Ремонт (db.rebuildAggregates): агрегаты класса и его потомков во всех арендаторах — из текущих строк, под
-- исключительными блокировками семейств целей и источников. Только роль владельца (администраторское подключение).
create or replace function @SCHEMA@.rebuild_aggregates(p_class text) returns int
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  cr @SCHEMA@.entity;
  names text[] := '{}';
begin
  for cr in select x.* from @SCHEMA@.entity x
            where x.class = 'Class' and x.data->'resolved' ? 'aggregate' and x.data->'resolved'->'ancestors' ? p_class
            order by x.id loop
    perform @SCHEMA@.family_lock(cr, true);
    perform @SCHEMA@.agg_lock_sources(cr.data->'resolved', null, cr.tenant);
    names := names || (cr.data->>'name');
  end loop;
  if cardinality(names) = 0 then
    perform @SCHEMA@.lt_fail('invalid_class', format('у класса %s и его потомков нет агрегатов (aggregate) — пересчитывать нечего', p_class));
  end if;
  return @SCHEMA@.agg_refresh(array(select distinct x from unnest(names) x), '@SYSTEM@'::uuid, true);
end $$;

-- Расхождения агрегатов (verify с p_data): строка, поле, значение в строке и итог живых источников.
create or replace function @SCHEMA@.agg_issues() returns table (id uuid, class text, field text, stored jsonb, expected jsonb)
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  select x.id, x.class, f.key, x.data->f.key, f.value
  from @SCHEMA@.entity x
  cross join lateral (select (@SCHEMA@.class_row(x.class, x.tenant)).data->'resolved' as res) c
  cross join lateral jsonb_each(@SCHEMA@.agg_compute(c.res, x.id, x.tenant)) f
  where x.class in (select k.data->>'name' from @SCHEMA@.entity k where k.class = 'Class' and k.data->'resolved' ? 'aggregate')
    and coalesce(c.res ? 'aggregate', false)
    and x.data->f.key is distinct from f.value
  order by x.id, f.key
$$;

-- Первая заливка (load.ts:initialSession): триггеров и индексов нет, поэтому поле целей считается одним оператором на
-- агрегат и пишется в ту же (последнюю) версию в entity и log — строки ещё никто не видел, хэши — генерируемые колонки.
-- Цепочки агрегатов (сумма агрегатного поля) сходятся повторными проходами. Итог проверяется описанием класса.
create or replace function @SCHEMA@.agg_fill() returns int
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  k record;
  f record;
  m int;
  n int := 0;
  pass int := 0;
  more boolean;
  bad record;
begin
  loop
    more := false;
    for k in select x.tenant as ct, x.data->>'name' as name, x.data->'resolved' as res from @SCHEMA@.entity x
             where x.class = 'Class' and x.data->'resolved' ? 'aggregate' order by x.id loop
      for f in select key, value from jsonb_each(k.res->'aggregate') order by key loop
        with sc as (
          select y.tenant as ct, y.data->>'name' as name from @SCHEMA@.entity y
          where y.class = 'Class' and y.data->'resolved'->'ancestors' ? (f.value->>'of')
        ), tot as (
          select (s.links->>(f.value->>'via'))::uuid as tid, s.tenant,
                 sum(case when f.value ? 'count' then 1 else @SCHEMA@.agg_num(s.data->(f.value->>'sum')) end) as v
          from @SCHEMA@.entity s join sc on sc.name = s.class and sc.ct in (s.tenant, '@SYSTEM@'::uuid)
          where jsonb_typeof(s.links->(f.value->>'via')) = 'string' and @SCHEMA@.agg_where_ok(f.value->'match', s.data)
          group by 1, 2
        ), nv as (
          select t.id, t.rev, jsonb_set(t.data, array[f.key], to_jsonb(coalesce(tot.v, 0))) as data
          from @SCHEMA@.entity t
          left join tot on tot.tid = t.id and tot.tenant = t.tenant
          where t.class = k.name and (t.tenant = k.ct or k.ct = '@SYSTEM@'::uuid)
            and t.data->f.key is distinct from to_jsonb(coalesce(tot.v, 0))
        ), ue as (
          update @SCHEMA@.entity x set data = nv.data from nv where x.id = nv.id returning 1
        ), ul as (
          update @SCHEMA@.log l set data = nv.data from nv where l.id = nv.id and l.rev = nv.rev returning 1
        )
        select count(*)::int into m from ue;
        if m > 0 then
          more := true;
          n := n + m;
        end if;
      end loop;
    end loop;
    exit when not more;
    pass := pass + 1;
    if pass > 32 then
      perform @SCHEMA@.lt_fail('invalid_class', 'первая заливка: агрегаты не сошлись за 32 прохода');
    end if;
  end loop;
  select x.id, x.class, v.bad into bad
  from @SCHEMA@.entity x
  cross join lateral (select c.data->'resolved' as res, c.validator from @SCHEMA@.class_row(x.class, x.tenant) c) c
  cross join lateral (select @SCHEMA@.validate_data(c.res->'rules', c.validator, c.res->'vars', x.data) as bad) v
  where x.class in (select k2.data->>'name' from @SCHEMA@.entity k2 where k2.class = 'Class' and k2.data->'resolved' ? 'aggregate')
    and v.bad <> '[]'::jsonb
  limit 1;
  if bad.id is not null then
    perform @SCHEMA@.lt_fail('invalid_data', format('данные не проходят описание класса %s (агрегатное поле строки %s после первой заливки)', bad.class, bad.id),
      jsonb_build_object('issues', bad.bad, 'id', bad.id));
  end if;
  return n;
end $$;

-- Триггеры агрегатов: после оператора, по одному на событие, с переходными таблицами, без условия WHEN — и для
-- владельца (функции владельца, каскад, загрузчик, сырой SQL); имена — после entity_a*: AFTER-триггеры одного события
-- срабатывают по алфавиту, журнал и проверки целей оператора уже записаны. Быстрый выход — среди пар «класс,
-- арендатор» оператора нет ни цели, ни источника агрегата.
create or replace function @SCHEMA@.trg_entity_total_ai() returns trigger
language plpgsql security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  rel text[];
  tgt text[];
begin
  select coalesce(array_agg(p.k) filter (where p.kind is not null), '{}'),
         coalesce(array_agg(p.k) filter (where p.kind in ('target', 'both')), '{}')
    into rel, tgt
  from (select k.c || ' ' || k.t as k, @SCHEMA@.agg_kind(k.c, k.t) as kind
        from (select distinct a.class as c, a.tenant as t from added a) k) p;
  if cardinality(rel) = 0 then
    return null;
  end if;
  perform @SCHEMA@.agg_apply('[]'::jsonb,
    (select jsonb_agg(jsonb_build_object('id', a.id, 'class', a.class, 'tenant', a.tenant, 'links', a.links, 'data', a.data))
     from added a where a.class || ' ' || a.tenant = any (rel)),
    array(select a.id from added a where a.class || ' ' || a.tenant = any (tgt)));
  return null;
end $$;

create or replace function @SCHEMA@.trg_entity_total_au() returns trigger
language plpgsql security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  rel text[];
  tgt text[];
begin
  -- строки, у которых изменились класс, концы или данные (владелец и теги вклада не меняют)
  select coalesce(array_agg(p.k) filter (where p.kind is not null), '{}'),
         coalesce(array_agg(p.k) filter (where p.kind in ('target', 'both')), '{}')
    into rel, tgt
  from (select k.c || ' ' || k.t as k, @SCHEMA@.agg_kind(k.c, k.t) as kind
        from (select distinct v.c, v.t from new_rows n join old_rows o on o.id = n.id
              cross join lateral (values (n.class, n.tenant), (o.class, o.tenant)) v(c, t)
              where n.class <> o.class or n.links <> o.links or n.data <> o.data) k) p;
  if cardinality(rel) = 0 then
    return null;
  end if;
  perform @SCHEMA@.agg_apply(
    (select jsonb_agg(jsonb_build_object('id', o.id, 'class', o.class, 'tenant', o.tenant, 'links', o.links, 'data', o.data))
     from old_rows o join new_rows n on n.id = o.id
     where (n.class <> o.class or n.links <> o.links or n.data <> o.data) and o.class || ' ' || o.tenant = any (rel)),
    (select jsonb_agg(jsonb_build_object('id', n.id, 'class', n.class, 'tenant', n.tenant, 'links', n.links, 'data', n.data))
     from new_rows n join old_rows o on o.id = n.id
     where (n.class <> o.class or n.links <> o.links or n.data <> o.data) and n.class || ' ' || n.tenant = any (rel)),
    -- смена класса в цель: поле считается целиком
    array(select n.id from new_rows n join old_rows o on o.id = n.id
          where n.class <> o.class and n.class || ' ' || n.tenant = any (tgt)));
  return null;
end $$;

create or replace function @SCHEMA@.trg_entity_total_ad() returns trigger
language plpgsql security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  rel text[];
begin
  select coalesce(array_agg(p.k) filter (where p.kind is not null), '{}') into rel
  from (select k.c || ' ' || k.t as k, @SCHEMA@.agg_kind(k.c, k.t) as kind
        from (select distinct g.class as c, g.tenant as t from gone g) k) p;
  if cardinality(rel) = 0 then
    return null;
  end if;
  perform @SCHEMA@.agg_apply(
    (select jsonb_agg(jsonb_build_object('id', g.id, 'class', g.class, 'tenant', g.tenant, 'links', g.links, 'data', g.data))
     from gone g where g.class || ' ' || g.tenant = any (rel)),
    '[]'::jsonb, '{}'::uuid[]);
  return null;
end $$;

create or replace trigger entity_total_ai after insert on @SCHEMA@.entity referencing new table as added
  for each statement execute function @SCHEMA@.trg_entity_total_ai();
create or replace trigger entity_total_au after update on @SCHEMA@.entity referencing old table as old_rows new table as new_rows
  for each statement execute function @SCHEMA@.trg_entity_total_au();
create or replace trigger entity_total_ad after delete on @SCHEMA@.entity referencing old table as gone
  for each statement execute function @SCHEMA@.trg_entity_total_ad();
-- и в режиме репликации (session_replication_role = replica)
alter table @SCHEMA@.entity enable always trigger entity_total_ai;
alter table @SCHEMA@.entity enable always trigger entity_total_au;
alter table @SCHEMA@.entity enable always trigger entity_total_ad;

do $$
declare f text;
begin
  foreach f in array array['agg_fields(jsonb)', 'agg_of(jsonb)', 'agg_zero(jsonb, jsonb)', 'agg_num(jsonb)', 'agg_where_ok(jsonb, jsonb)',
    'agg_guard(jsonb, jsonb, jsonb, boolean)', 'agg_keep(text, uuid, jsonb, jsonb)', 'agg_check_source(jsonb, jsonb, text, jsonb)',
    'agg_cycle(uuid, jsonb)', 'agg_prepare(jsonb, jsonb, uuid)', 'agg_source(jsonb, uuid)', 'agg_marked(jsonb, jsonb)',
    'agg_mark(uuid, text[])', 'agg_lock_sources(jsonb, jsonb, uuid)', 'agg_classes(text, uuid)', 'agg_compute(jsonb, uuid, uuid)',
    'agg_check(text, uuid, jsonb)', 'agg_write(@SCHEMA@.entity, jsonb, boolean)', 'agg_token(text)', 'agg_held()',
    'agg_hold_begin(text)', 'agg_hold_end(boolean)', 'agg_merge(jsonb, jsonb)', 'agg_flush(jsonb)', 'agg_kind(text, uuid)',
    'agg_apply(jsonb, jsonb, uuid[])', 'agg_refresh(text[], uuid, boolean)', 'rebuild_aggregates(text)', 'agg_issues()', 'agg_fill()',
    'trg_entity_total_ai()', 'trg_entity_total_au()', 'trg_entity_total_ad()'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
