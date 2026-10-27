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
-- пользовательского lock() (один bigint) пространство ключей advisory-блокировок. p_cls — строка
-- Class класса семейства. Ключ — арендатор корневого класса и имя корня (итоговое ревью
-- безопасности): ужесточение или rekeyClass одноимённого класса в другом арендаторе запись сюда не
-- останавливает; корень из System (общий для всех арендаторов) — ключ System.
create or replace function @SCHEMA@.family_lock(p_cls @SCHEMA@.entity, p_exclusive boolean) returns void
language plpgsql volatile
as $$
declare
  root text := p_cls.data->'resolved'->'ancestors'->>-1;
  k int;
begin
  k := hashtext('@SCHEMA_NAME@:' || (case when p_cls.tenant = '@SYSTEM@'::uuid or p_cls.data->>'name' = root then p_cls.tenant
    else coalesce((@SCHEMA@.class_row(root, p_cls.tenant)).tenant, p_cls.tenant) end)::text || ':' || root);
  if p_exclusive then
    perform pg_advisory_xact_lock(19540, k);
  else
    perform pg_advisory_xact_lock_shared(19540, k);
  end if;
end $$;
-- до итогового ревью безопасности ключ был без арендатора
drop function if exists @SCHEMA@.family_lock(text, boolean);

-- Список классов конца: строка или массив строк → отсортированный jsonb-массив.
create or replace function @SCHEMA@.class_set(p jsonb) returns jsonb
language sql immutable parallel safe
return (
  select coalesce(jsonb_agg(x order by x), '[]'::jsonb)
  from jsonb_array_elements_text(case jsonb_typeof(p) when 'array' then p else jsonb_build_array(p) end) x
);

-- Входит ли класс цели (с учётом его предков) в список допустимых классов конца.
create or replace function @SCHEMA@.class_accepts(p_allowed jsonb, p_target_class text, p_target_tenant uuid) returns boolean
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  select exists (
    select 1
    from jsonb_array_elements_text(@SCHEMA@.class_set(p_allowed)) a(name)
    where a.name in (select jsonb_array_elements_text(
           (@SCHEMA@.class_row(p_target_class, p_target_tenant)).data->'resolved'->'ancestors'))
  )
$$;

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

-- Разбор и нормализация концов (этап 1, п. 7): объявлены, обязательные на месте, у множественных
-- нет повторов, соблюдены min и max; uuid — в каноническом виде строчными. К таблицам не обращается:
-- цели проверяет targets_bad() — триггером после оператора, одним запросом на все строки.
-- Ошибку не бросает: возвращает код и сообщение.
create or replace function @SCHEMA@.links_shape(p_res jsonb, p_links jsonb, out links jsonb, out code text, out msg text)
language plpgsql immutable
as $$
#variable_conflict use_variable
declare
  l record;
  e record;
  v jsonb;
  arr jsonb;
  n int;
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
end $$;

-- Цели концов набора строк (решение 2 точки А): существуют, принадлежат арендатору строки или
-- System и относятся к классу конца или его потомку. p_rows — [{class, tenant, links[, ends]}]
-- (ends — описание концов, если его ещё нет в строке Class). При p_lock цели сначала блокируются
-- for key share в порядке id — каждая один раз на оператор, только свои и системные: строку чужого
-- арендатора не заблокировать и по ожиданию не обнаружить. Проверка идёт после блокировки, по
-- свежим строкам: цель, которую успели удалить или перевести в чужой класс, не пройдёт. Класс цели
-- прямо в списке конца — без поиска описания; иначе — предки из строки Class цели.
-- При p_acl ({tenant, account, plan} — план READ актора) цель ещё и должна быть видна актору (этап 5,
-- п. 6): строку, которую он не видит, нельзя использовать как цель — ответ тот же, что для
-- несуществующей. Цели-аккаунты (Account) не проверяются: на них ссылаются членства и владельцы.
-- Возвращает роль первой непрошедшей цели или null; цель — строка производного класса: «!роль»
-- (вызывающий отвечает derived_class).
create or replace function @SCHEMA@.targets_bad(p_rows jsonb, p_lock boolean, p_acl jsonb default null) returns text
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  bad text;
begin
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return null;
  end if;
  if p_lock then
    perform 1 from @SCHEMA@.entity t
    where t.id in (select (v #>> '{}')::uuid from jsonb_array_elements(p_rows) r
                   cross join lateral jsonb_path_query(r->'links', 'lax $.*[*]') v)
      and t.tenant in (select (r->>'tenant')::uuid from jsonb_array_elements(p_rows) r union all select '@SYSTEM@'::uuid)
    order by t.id for key share;
  end if;
  with r as (
    select x.value as item, (x.value->>'tenant')::uuid as tenant from jsonb_array_elements(p_rows) x
  ), c as (
    select d.cls, d.tenant, coalesce(d.ends, (@SCHEMA@.class_row(d.cls, d.tenant)).data->'resolved'->'ends') as ends
    from (select distinct r.item->>'class' as cls, r.tenant, r.item->'ends' as ends from r) d
  ), p as (
    select r.item->>'class' as cls, r.tenant, r.item->'ends' as ends, k.key as role,
           (case jsonb_typeof(k.value) when 'array' then a.value else k.value end #>> '{}')::uuid as tid
    from r
    cross join lateral jsonb_each(r.item->'links') k
    left join lateral jsonb_array_elements(case jsonb_typeof(k.value) when 'array' then k.value else '[]'::jsonb end) a on true
    where jsonb_typeof(k.value) = 'string' or a.value is not null
  )
  select case when x.miss then x.role else '!' || x.role end into bad
  from (
    select p.role,
           t.id is null
           or t.tenant not in (p.tenant, '@SYSTEM@'::uuid)
           or not coalesce(@SCHEMA@.class_set(c.ends->p.role->'class') ? t.class
                   or @SCHEMA@.class_set(c.ends->p.role->'class') ?| array(select jsonb_array_elements_text(kr.res->'ancestors')), false)
           or (p_acl is not null and t.class <> 'Account'
               and not @SCHEMA@.row_visible(t.tenant, t.class, t.id, t.owner, t.tags, t.data, t.links,
                                            (p_acl->>'tenant')::uuid, (p_acl->>'account')::uuid, p_acl->'plan')) as miss,
           coalesce(kr.res ? 'derivedBy', false) as derived
    from p
    join c on c.cls = p.cls and c.tenant = p.tenant and c.ends is not distinct from coalesce(p.ends, c.ends)
    left join @SCHEMA@.entity t on t.id = p.tid
    -- описание класса цели — только когда класс не назван в конце прямо: тогда нужны его предки, а цель
    -- производного класса (конец, названный предком; план 1.1, §2.4) не проходит — прямо назвать производный
    -- класс в конце не даёт описание (class_admit)
    left join lateral (
      select case when t.id is null or @SCHEMA@.class_set(c.ends->p.role->'class') ? t.class then null
             else (select k.data->'resolved' from @SCHEMA@.entity k
                   where k.class = 'Class' and k.data->>'name' = t.class and k.tenant in (t.tenant, '@SYSTEM@'::uuid)
                   order by k.tenant = '@SYSTEM@'::uuid limit 1) end as res
    ) kr on true
  ) x
  where x.miss or x.derived
  limit 1;
  return bad;
end $$;
-- до этапа 5 цели не сверялись с правами актора
drop function if exists @SCHEMA@.targets_bad(jsonb, boolean);

-- Разбор концов и проверка целей одной строки — для функций владельца (reclass, проверка строк
-- семейства), которые пишут мимо триггеров. При p_lock цели блокируются for key share; p_acl — как
-- у targets_bad (цели видны актору).
create or replace function @SCHEMA@.check_links(p_res jsonb, p_links jsonb, p_tenant uuid, p_lock boolean, p_acl jsonb,
  out links jsonb, out code text, out msg text)
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_variable
declare
  bad text;
begin
  select s.links, s.code, s.msg into links, code, msg from @SCHEMA@.links_shape(p_res, p_links) s;
  if code is not null or links = '{}'::jsonb then
    return;
  end if;
  bad := @SCHEMA@.targets_bad(jsonb_build_array(jsonb_build_object(
    'class', p_res->>'name', 'tenant', p_tenant, 'links', links, 'ends', coalesce(p_res->'ends', '{}'::jsonb))), p_lock, p_acl);
  if bad like '!%' then
    code := 'derived_class'; msg := format('конец %s ведёт на строку производного класса', substr(bad, 2));
  elsif bad is not null then
    code := 'target_not_found'; msg := format('цель конца %s не найдена', bad);
  end if;
end $$;
drop function if exists @SCHEMA@.check_links(jsonb, jsonb, uuid, boolean);

-- id класса с ключом — v5 от арендатора, класса и значений ключа (§2.3); у класса без ключа — null.
create or replace function @SCHEMA@.key_id(p_res jsonb, p_class text, p_tenant uuid, p_data jsonb, p_links jsonb) returns uuid
language sql immutable
return case when jsonb_array_length(coalesce(p_res->'key', '[]'::jsonb)) = 0 then null else
  @SCHEMA@.v5_id(p_tenant, p_class, array(
    select case when p_res->'schema'->'properties' ? u.k then p_data->>u.k else lower(p_links->>u.k) end
    from jsonb_array_elements_text(p_res->'key') with ordinality as u(k, i)
    order by u.i)) end;

-- Ведёт ли класс журнал (history: false — нет).
create or replace function @SCHEMA@.history_on(p_class text, p_tenant uuid) returns boolean
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return coalesce((@SCHEMA@.class_row(p_class, p_tenant)).data->'resolved'->>'history', 'true') <> 'false';

-- Сигналы (план 1.1, §2.2): канал — имя схемы, нагрузка — по режиму установки '@SIGNALS@'
-- (up({ signals })): class — имя класса; tenant — «Класс@токен арендатора»; opaque — «токен класса@токен
-- арендатора»; none — сигналов нет. Сессии — session:<16 hex>, сброс — * (кроме none). Токен — первые
-- 96 бит HMAC-SHA256 от «назначение:значение» на ключе сигналов (HMAC ключа строки KEY по
-- 'letopis:signals', его отдаёт signal_key()): без ключа псевдоним не сопоставить с именем, а
-- нагрузка детерминирована — PostgreSQL склеивает одинаковые сигналы транзакции.
-- до плана 1.1 сигнал принимал только имена классов
drop function if exists @SCHEMA@.signal(text[]);

create or replace function @SCHEMA@.signal_token(p_purpose text, p_value text, p_key bytea) returns text
language sql immutable parallel safe
return left(encode(@PGCRYPTO@.hmac(convert_to(p_purpose || ':' || p_value, 'UTF8'), p_key, 'sha256'), 'hex'), 24);

-- Готовые нагрузки: сигналы записи от signal(), сессии и сброс. Транзакция с NOTIFY фиксируется под
-- общей блокировкой кластера вместе с fsync, поэтому библиотека помечает свои транзакции
-- letopis.notify = 'deferred': нагрузки копятся в letopis.changed, а библиотека после фиксации
-- сбрасывает по ним свой кэш и отправляет их одной транзакцией без данных (в режиме none — не
-- отправляет). Сырой SQL шлёт NOTIFY здесь же, вместе с фиксацией; в режиме none — ничего.
create or replace function @SCHEMA@.signal_raw(p_payloads text[]) returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  acc text[];
  pl text;
begin
  p_payloads := array(select distinct x from unnest(p_payloads) x where x <> '' order by x);
  if cardinality(p_payloads) = 0 then
    return;
  end if;
  if coalesce(current_setting('letopis.notify', true), '') = 'deferred' then
    acc := coalesce(string_to_array(nullif(current_setting('letopis.changed', true), ''), ','), '{}');
    if not (acc @> p_payloads) then
      perform set_config('letopis.changed',
        array_to_string(array(select distinct x from unnest(acc || p_payloads) x order by x), ','), true);
    end if;
  elsif '@SIGNALS@' <> 'none' then
    foreach pl in array p_payloads loop
      perform pg_notify('@SCHEMA_NAME@', pl);
    end loop;
  end if;
end $$;

-- Сигнал записи: пары «класс, арендатор» изменённых строк (арендатор null — System) → нагрузки по
-- режиму. Одинаковые пары склеиваются: транзакция, записавшая тысячу строк одного класса одного
-- арендатора, посылает один сигнал.
create or replace function @SCHEMA@.signal(p_classes text[], p_tenants uuid[]) returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  k bytea;
begin
  if p_classes is null or cardinality(p_classes) = 0 then
    return;
  end if;
  if '@SIGNALS@' in ('tenant', 'opaque') then
    select @PGCRYPTO@.hmac(convert_to('letopis:signals', 'UTF8'), s.material, 'sha256') into k
    from @SCHEMA@.secret s where s.id = '@SYSTEM@'::uuid and s.kind = 'KEY';
  end if;
  perform @SCHEMA@.signal_raw(array(
    select case '@SIGNALS@'
             when 'tenant' then p.c || '@' || @SCHEMA@.signal_token('tenant', p.t::text, k)
             when 'opaque' then @SCHEMA@.signal_token('class', p.c, k) || '@' || @SCHEMA@.signal_token('tenant', p.t::text, k)
             else p.c end
    from (select distinct u.c, coalesce(u.t, '@SYSTEM@'::uuid) as t from unnest(p_classes, p_tenants) u(c, t) where u.c is not null) p));
end $$;

-- Версия одной строки в журнал и сигнал — для функций владельца, которые пишут строку сами
-- (пересчёт потомков, снятие конца, перенос на новый id). Классы с history: false журнал не ведут,
-- но сигнал посылают. Обычную запись журналируют триггеры после оператора — одной вставкой.
create or replace function @SCHEMA@.log_version(e @SCHEMA@.entity) returns void
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  p @SCHEMA@.log;
begin
  if @SCHEMA@.history_on(e.class, e.tenant) then
    -- пути изменения: против предыдущей версии id, у первой версии переноса — против прежнего id (moved)
    select l.* into p from @SCHEMA@.log l
    where l.id = case when e.rev > 1 then e.id else e.moved end and l.op not in ('purge', 'trim', 'reset')
    order by l.rev desc limit 1;
    insert into @SCHEMA@.log (id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason, moved, prev_hash, changed)
    values (e.id, e.rev, e.class, e.cv, e.tenant, e.owner, e.links, e.data, e.tags, e.at, e.author, e.agent, e.op, e.reason, e.moved, e.prev_hash,
            case when p.id is not null then @SCHEMA@.change_paths(p.data, p.links, p.tags, p.owner, p.class, e.data, e.links, e.tags, e.owner, e.class) end);
  end if;
  perform @SCHEMA@.signal(array[e.class], array[e.tenant]);
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
  -- смена класса: агрегатные поля новой цели триггер после правки посчитал в эту же версию (план 1.1, §2.4) —
  -- в журнал идёт строка таблицы, а не returning
  if p_class is not null then
    select x.* into e from @SCHEMA@.entity x where x.id = p_id;
  end if;
  perform @SCHEMA@.log_version(e);
  return e;
end $$;

-- Надгробие: последний снимок удалённой строки следующей версией с видом delete; при переносе на
-- новый id (reclass, rekey) moved ссылается на новый id.
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
-- Видимость — та же, что у чтения (row_visible с планом READ актора), а не только арендатор.
create or replace function @SCHEMA@.visible_detail(p_rows jsonb, p_tenant uuid) returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  a jsonb := @SCHEMA@.acl_actor('READ');
  vis jsonb;
begin
  select coalesce(jsonb_agg(r - 'tenant'), '[]'::jsonb) into vis
  from jsonb_array_elements(p_rows) r
  join @SCHEMA@.entity e on e.id = (r->>'id')::uuid
  where (r->>'tenant')::uuid = p_tenant and a is not null
    and @SCHEMA@.row_visible(e.tenant, e.class, e.id, e.owner, e.tags, e.data, e.links,
                             (a->>'tenant')::uuid, (a->>'account')::uuid, a->'plan');
  return jsonb_build_object('rows', vis, 'others', jsonb_array_length(p_rows) - jsonb_array_length(vis));
end $$;

-- Безопасно ли изменение описания класса (этап 1, п. 10): новые необязательные поля и концы,
-- метаданные, алиас, политика истории, кэш. Всё остальное — ужесточение с проверкой строк, в том числе
-- любая правка условий anyOf и oneOf (1.0.1: прежде они не сравнивались, и строки не перепроверялись),
-- признака производного класса derivedBy и описания агрегатов aggregate (план 1.1, §2.6).
create or replace function @SCHEMA@.class_change_safe(o jsonb, n jsonb) returns boolean
language sql immutable
return
  o->'key' = n->'key'
  and o->'ancestors' = n->'ancestors'
  and o->'derivedBy' is not distinct from n->'derivedBy'
  and o->'aggregate' is not distinct from n->'aggregate'
  and (o->'abstract' = n->'abstract' or n->>'abstract' = 'false')
  and o->'schema'->'anyOf' is not distinct from n->'schema'->'anyOf'
  and o->'schema'->'oneOf' is not distinct from n->'schema'->'oneOf'
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
  a jsonb := @SCHEMA@.acl_actor('READ');
  vis boolean;
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
        select * into lk from @SCHEMA@.check_links(res, r.links, r.tenant, false, null);
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
        -- id ссылающейся строки — только если актор её видит (доработки после точки Б)
        select @SCHEMA@.row_visible(x.tenant, x.class, x.id, x.owner, x.tags, x.data, x.links,
                                    (a->>'tenant')::uuid, (a->>'account')::uuid, a->'plan') into vis
        from @SCHEMA@.entity x where x.id = (inc->0->>'id')::uuid;
        problem := case when coalesce(vis, false)
          then format('на строку ссылается роль %s строки %s, которая не принимает класс', inc->0->>'role', inc->0->>'id')
          else format('на строку ссылается роль %s строки, которой актор не видит, и она не принимает класс', inc->0->>'role') end;
      end if;
    end if;
    if problem is not null then
      outv := outv || jsonb_build_object('id', r.id, 'class', r.class, 'tenant', r.tenant, 'problem', problem);
      exit when jsonb_array_length(outv) >= 100;
    end if;
  end loop;
  return outv;
end $$;

-- Методы цепочки — зарезервированные имена (§2.14). Список подставляет установщик из
-- RESERVED_CLASS_NAMES (lib/src/types.ts): при изменении списка функция пересоздаётся накатом.
create or replace function @SCHEMA@.reserved_names() returns text[]
language sql immutable parallel safe
return array[@RESERVED_NAMES@]::text[];

-- Правка класса p_class арендатора p_tenant меняет имена, по которым его строки находят правила прав: предков
-- (parent), алиас или derivedBy (ревью безопасности №2). План прав берёт для класса имена предков и их алиасы
-- (acl_plan_for), поэтому строки класса и его потомков попали бы под правила READ, WRITE и DELETE нового предка или
-- алиаса — право WRITE на Class открывало бы чужие строки. Актору нужно право READ, WRITE и DELETE без условий на
-- все строки самого класса и каждого потомка своего арендатора, иначе acl_denied. Потомков у арендаторов класса
-- System план прав сессии System не видит — они пропускаются, как у агрегатов (agg_source_admit). Проверка — до
-- правки (class_admit): план видит прежние имена, по которым строки уже защищены.
create or replace function @SCHEMA@.class_acl_admit(p_class text, p_tenant uuid) returns void
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  perform @SCHEMA@.class_rows_admit(p_class, p_tenant, array['READ', 'WRITE', 'DELETE'],
    format('класс %s меняет предков, алиас или derivedBy', p_class));
end $$;

-- Право актора на все строки класса p_class и каждого его потомка арендатора p_tenant: по каждой операции p_ops —
-- без условий, иначе acl_denied с текстом «<p_what>: нужно право <op> на все строки класса <класс>». Сам класс первым,
-- потомки — по глубине и имени; потомков у арендаторов класса System план сессии System не видит — они пропускаются.
-- Зовут class_acl_admit (смена предков, алиаса, derivedBy), ужесточение (class_evolve, rekey_class) и смена политики
-- хранения истории (class_admit; доработки после точки Б).
create or replace function @SCHEMA@.class_rows_admit(p_class text, p_tenant uuid, p_ops text[], p_what text) returns void
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c text;
  op text;
  chk jsonb;
begin
  for c in select p_class
           union all
           (select x.data->>'name' from @SCHEMA@.entity x
            where x.class = 'Class' and x.tenant = p_tenant and x.data->>'name' <> p_class
              and x.data->'resolved'->'ancestors' ? p_class
            order by jsonb_array_length(x.data->'resolved'->'ancestors'), x.data->>'name') loop
    foreach op in array p_ops loop
      chk := @SCHEMA@.acl_check_data(c, op);
      if not coalesce((chk->>'allow')::boolean, false) or chk ? 'filter' then
        perform @SCHEMA@.lt_fail('acl_denied', format('%s: нужно право %s на все строки класса %s', p_what, op, c));
      end if;
    end loop;
  end loop;
end $$;

-- Есть ли в журнале версии строк класса p_name арендатора p_tenant (у класса System — любого арендатора); записи purge,
-- trim и reset — не версии (доработки после точки Б: удаление и пересоздание класса, остаток Н2 ревью №2).
create or replace function @SCHEMA@.class_has_history(p_name text, p_tenant uuid) returns boolean
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return exists (select 1 from @SCHEMA@.log l
               where l.class = p_name and (l.tenant = p_tenant or p_tenant = '@SYSTEM@'::uuid)
                 and l.op not in ('purge', 'trim', 'reset'));

-- Проверки строки Class сверх метасхемы (этап 1, п. 6): признак system, имя системного класса,
-- имена связей против методов цепочки, однозначность имени конца во всей схеме, право на агрегаты,
-- алиас и право на смену предков, алиаса и derivedBy (ревью безопасности №2).
create or replace function @SCHEMA@.class_admit(p_data jsonb, p_tenant uuid, out data jsonb, out validator jsonpath)
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_variable
declare
  e record;
  o record;
  dname text;
  drole text;
  tc @SCHEMA@.entity;
  prevd jsonb;
  src text;
  chk jsonb;
  m jsonb;
begin
  if p_tenant <> '@SYSTEM@'::uuid then
    if (p_data->>'name') = any (array['Class', 'Account', 'member', 'Resource', 'rule']) then
      perform @SCHEMA@.lt_fail('invalid_class', format('имя %s зарезервировано за системным классом', p_data->>'name'));
    end if;
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
  -- алиас — второе имя класса и для правил прав (ревью безопасности №2): совпади он с именем другого класса (в том
  -- числе Class и системных) или с чужим алиасом арендатора и System, правила одного класса действовали бы на строки
  -- другого
  if data->>'alias' is not null
     and ((data->>'alias') = any (array['Class', 'Account', 'member', 'Resource', 'rule'])
          or exists (select 1 from @SCHEMA@.entity x
                     where x.class = 'Class' and x.tenant in (p_tenant, '@SYSTEM@'::uuid) and x.data->>'name' <> data->>'name'
                       and (x.data->>'name' = data->>'alias' or x.data->>'alias' = data->>'alias'))) then
    perform @SCHEMA@.lt_fail('invalid_class', format('алиас %s класса %s совпадает с именем или алиасом другого класса',
      data->>'alias', data->>'name'));
  end if;
  -- и наоборот: имя класса — не чужой алиас арендатора и System, иначе правила, написанные для нового класса, действовали
  -- бы и на строки класса с этим алиасом
  if exists (select 1 from @SCHEMA@.entity x
             where x.class = 'Class' and x.tenant in (p_tenant, '@SYSTEM@'::uuid) and x.data->>'name' <> data->>'name'
               and x.data->>'alias' = data->>'name') then
    perform @SCHEMA@.lt_fail('invalid_class', format('имя класса %s совпадает с алиасом другого класса', data->>'name'));
  end if;
  -- агрегаты (план 1.1, §2.4; ревью коммита этапа 4б): поле считают функции владельца по всем строкам источника
  -- арендатора, без прав чтения, поэтому строки попадают в агрегат только с ведома того, кто читает их все. Пути
  -- владельца (сид, class_evolve, rekey_class) сюда не заходят. Описание до правки — для сравнения (нет — новый класс)
  select x.data into prevd from @SCHEMA@.entity x
  where x.class = 'Class' and x.tenant = p_tenant and x.data->>'name' = data->>'name';
  -- производный класс (план 1.1, §2.4) заводит, меняет и удаляет только администратор (/security-review после точки Б):
  -- проектор берёт арендатора в участники по его классам с пометкой и пишет туда итоги по всем строкам источников,
  -- поэтому пользователь с правом WRITE на Class, заведя такой класс сам, читал бы итоги по строкам, которые ему читать
  -- запрещено. Пометка своя или унаследованная, до правки или после; право letopis.projector — у администраторской роли
  -- подключения и по правилам System (системный администратор — маска letopis.*)
  if (data->'resolved' ? 'derivedBy' or coalesce(prevd->'resolved' ? 'derivedBy', false))
     and not @SCHEMA@.letopis_allowed('letopis.projector') then
    perform @SCHEMA@.lt_fail('acl_denied', format('класс %s производный: его описание задаёт только администратор (право letopis.projector)',
      data->>'name'));
  end if;
  -- агрегат развёрнутого описания (свой или унаследованный), новый или изменённый против прежнего — описание
  -- агрегата, новый потомок цели, смена parent, — задаёт только тот, кто без условий читает все строки каждого
  -- класса-источника: класса of и его потомков (agg_classes: классы арендатора, у класса System — классы System).
  -- Неизменённый агрегат не проверяется
  if data->'resolved' ? 'aggregate' then
    for e in select key, value from jsonb_each(data->'resolved'->'aggregate') order by key loop
      continue when prevd->'resolved'->'aggregate'->e.key is not distinct from e.value;
      -- сам класс of первым, потомки — по имени
      foreach src in array array(select n from unnest(@SCHEMA@.agg_classes(e.value->>'of', p_tenant, p_tenant = '@SYSTEM@'::uuid)) n
                                 order by n = (e.value->>'of') desc, n) loop
        chk := @SCHEMA@.acl_check_data(src, 'READ');
        if not coalesce((chk->>'allow')::boolean, false) or chk ? 'filter' then
          perform @SCHEMA@.lt_fail('acl_denied', format('агрегат %s.%s: нужно право READ на все строки класса %s', data->>'name', e.key, src));
        end if;
      end loop;
    end loop;
  end if;
  -- класс становится источником агрегата (новая метка aggregatedBy — смена parent): в агрегат войдут его строки и строки
  -- потомков — нужно право READ без условий на них до правки, по прежним предкам (здесь), и после (agg_source_admit в
  -- триггере после оператора; новый класс проверяется только там: до вставки план прав его не видит)
  m := @SCHEMA@.agg_new_mark(prevd->'resolved', data->'resolved');
  if m is not null and prevd is not null then
    perform @SCHEMA@.agg_source_admit(data->>'name', m);
    for src in select x.data->>'name' from @SCHEMA@.entity x
               where x.class = 'Class' and x.tenant = p_tenant and x.data->>'name' <> data->>'name'
                 and x.data->'resolved'->'ancestors' ? (data->>'name')
               order by jsonb_array_length(x.data->'resolved'->'ancestors'), x.data->>'name' loop
      perform @SCHEMA@.agg_source_admit(src, m);
    end loop;
  end if;
  -- правка меняет предков, алиас или derivedBy (ревью безопасности №2): строки класса и потомков попали бы под правила
  -- других имён — нужно право READ, WRITE и DELETE без условий на все их строки. У нового класса строк ещё нет
  if prevd is not null
     and (prevd->'resolved'->'ancestors' is distinct from data->'resolved'->'ancestors'
          or prevd->>'alias' is distinct from data->>'alias'
          or prevd->'resolved'->'derivedBy' is distinct from data->'resolved'->'derivedBy') then
    perform @SCHEMA@.class_acl_admit(data->>'name', p_tenant);
  end if;
  -- политика хранения истории (доработки после точки Б): по ней maintain() прореживает журнал строк класса, а
  -- history: false выключает журнал. Одним правом WRITE на Class автор правки стирал бы аудит строк, на которые у него
  -- нет прав, поэтому смена развёрнутой history существующего класса требует права READ и DELETE без условий на все
  -- строки класса и его потомков своего арендатора — как trimHistory требует их на каждую цель
  if prevd is not null and prevd->'resolved'->'history' is distinct from data->'resolved'->'history' then
    perform @SCHEMA@.class_rows_admit(data->>'name', p_tenant, array['READ', 'DELETE'],
      format('класс %s меняет политику хранения истории', data->>'name'));
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
  -- на строки производного класса (план 1.1, §2.4) не ссылаются: проектор удаляет и строит их заново.
  -- Классы целей — под разделяемой блокировкой семейства, а класс, который становится производным, — под
  -- исключительной: описание со ссылкой и пометка derivedBy не проходят параллельно мимо друг друга
  for e in select key, value from jsonb_each(coalesce(data->'resolved'->'ends', '{}'::jsonb)) loop
    for tc in select c.* from jsonb_array_elements_text(@SCHEMA@.class_set(e.value->'class')) n(name)
              cross join lateral @SCHEMA@.class_row(n.name, p_tenant) c where c.id is not null order by c.id loop
      perform @SCHEMA@.family_lock(tc, false);
    end loop;
    dname := null;
    select x.data->>'name' into dname
    from @SCHEMA@.entity x
    where x.class = 'Class' and x.tenant in (p_tenant, '@SYSTEM@'::uuid) and x.data->>'name' <> data->>'name'
      and @SCHEMA@.class_set(e.value->'class') ? (x.data->>'name') and x.data->'resolved' ? 'derivedBy'
    limit 1;
    if dname is null and data->'resolved' ? 'derivedBy' and @SCHEMA@.class_set(e.value->'class') ? (data->>'name') then
      dname := data->>'name';
    end if;
    if dname is not null then
      perform @SCHEMA@.lt_fail('derived_class', format('конец %s ведёт на производный класс %s', e.key, dname));
    end if;
  end loop;
  if data->'resolved' ? 'derivedBy' then
    tc := @SCHEMA@.class_row(data->>'name', p_tenant);
    if tc.id is not null then
      perform @SCHEMA@.family_lock(tc, true);
    end if;
    -- класс становится производным, а на него или его потомков уже ссылаются концы других классов (класс
    -- System видят все арендаторы — его ссылки ищутся во всех)
    select x.data->>'name', k.key into dname, drole
    from @SCHEMA@.entity x
    cross join lateral jsonb_each(coalesce(x.data->'resolved'->'ends', '{}'::jsonb)) k
    where x.class = 'Class' and (x.tenant in (p_tenant, '@SYSTEM@'::uuid) or p_tenant = '@SYSTEM@'::uuid)
      and x.data->>'name' <> data->>'name'
      and @SCHEMA@.class_set(k.value->'class') ?| (array[data->>'name'] || array(
        select y.data->>'name' from @SCHEMA@.entity y
        where y.class = 'Class' and (y.tenant in (p_tenant, '@SYSTEM@'::uuid) or p_tenant = '@SYSTEM@'::uuid)
          and y.data->'resolved'->'ancestors' ? (data->>'name')))
    limit 1;
    if dname is not null then
      perform @SCHEMA@.lt_fail('derived_class', format('класс %s не может стать производным: на него ссылается конец %s класса %s',
        data->>'name', drole, dname));
    end if;
  end if;
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
  -- аккаунты (с их категориями) — только в System: их пишет системный администратор (этап 5)
  if NEW.class = 'Account' and NEW.tenant <> '@SYSTEM@'::uuid then
    perform @SCHEMA@.lt_fail('tenant_denied', 'аккаунты лежат в арендаторе System');
  end if;
  cls := @SCHEMA@.class_row(NEW.class, NEW.tenant);
  if cls.id is null then
    perform @SCHEMA@.lt_fail('invalid_class', format('класс %s не найден', NEW.class));
  end if;
  -- разделяемая блокировка корня семейства, затем описание перечитывается под ней
  perform @SCHEMA@.family_lock(cls, false);
  cls := @SCHEMA@.class_row(NEW.class, NEW.tenant);
  res := cls.data->'resolved';
  if coalesce((res->>'abstract')::boolean, false) then
    perform @SCHEMA@.lt_fail('invalid_class', format('класс %s абстрактный', NEW.class));
  end if;
  if res ? 'derivedBy' then
    perform @SCHEMA@.lt_fail('derived_class', format('класс %s производный: его строки пишет проектор %s', NEW.class, res->>'derivedBy'));
  end if;
  if NEW.class = 'Class' then
    select a.data, a.validator into NEW.data, NEW.validator from @SCHEMA@.class_admit(coalesce(NEW.data, '{}'::jsonb), NEW.tenant) a;
  else
    -- агрегатное поле считает база (план 1.1, §2.4): переданное значение — отказ, новое — 0 до умолчаний и
    -- проверки; итог из живых источников ставит триггер после оператора
    if res ? 'aggregate' then
      if coalesce(NEW.data, '{}'::jsonb) ?| @SCHEMA@.agg_fields(res) then
        perform @SCHEMA@.lt_fail('aggregate_field', format('поля %s класса %s считает база (aggregate) — их не передают',
          array_to_string(array(select x from unnest(@SCHEMA@.agg_fields(res)) x where NEW.data ? x), ', '), NEW.class));
      end if;
      NEW.data := @SCHEMA@.agg_zero(res, coalesce(NEW.data, '{}'::jsonb));
    end if;
    NEW.data := @SCHEMA@.apply_defaults(res->'schema', coalesce(NEW.data, '{}'::jsonb));
    bad := @SCHEMA@.validate_data(res->'rules', cls.validator, res->'vars', NEW.data);
    if bad <> '[]'::jsonb then
      perform @SCHEMA@.lt_fail('invalid_data', format('данные не проходят описание класса %s', NEW.class), jsonb_build_object('issues', bad));
    end if;
    NEW.validator := null;
  end if;
  -- цели проверяет и блокирует триггер после оператора (targets_bad) — один раз на оператор
  select * into lk from @SCHEMA@.links_shape(res, NEW.links);
  if lk.code is not null then
    perform @SCHEMA@.lt_fail(lk.code, lk.msg);
  end if;
  NEW.links := lk.links;
  if NEW.class = 'member' and NEW.links->>'Tenant' is distinct from NEW.tenant::text then
    perform @SCHEMA@.lt_fail('invalid_data', 'конец Tenant членства — арендатор строки');
  end if;
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
  -- воскрешение: номер версии и цепочка хэшей продолжаются от последней записи журнала; запись
  -- блокируется — параллельные purge, обрезка и restore того же id ждут (этап 6), а если purge успел
  -- стереть её, пара (id, rev) столкнётся с его записью purge в журнале, и операция повторится
  select l.rev, l.hash, l.at, l.op, l.data into last from @SCHEMA@.log l where l.id = NEW.id order by l.rev desc limit 1 for update;
  -- класс с историей строк в журнале (остаток Н2 ревью №2; доработки после точки Б): правила прав находят строки, и
  -- старые версии тоже, по именам класса, предков и алиасов — класс с другим parent, alias или derivedBy подставил бы
  -- старую историю под чужие правила. Поэтому, если журнал арендатора хранит версии строк класса с этим именем, класс
  -- создаётся только заново и с тем же описанием, что в надгробии его строки Class. Надгробия нет (история осталась от
  -- класса System, удалённого раньше, или строку Class стёрли мимо триггеров) — отказ: сначала purge() строк
  if NEW.class = 'Class' and @SCHEMA@.class_has_history(NEW.data->>'name', NEW.tenant)
     and not (coalesce(last.op = 'delete', false)
              and last.data->'resolved'->'ancestors' is not distinct from NEW.data->'resolved'->'ancestors'
              and last.data->>'alias' is not distinct from NEW.data->>'alias'
              and last.data->'resolved'->'derivedBy' is not distinct from NEW.data->'resolved'->'derivedBy') then
    perform @SCHEMA@.lt_fail('invalid_class', format('журнал хранит историю строк класса %s: создать его можно только заново и с прежними parent, alias и derivedBy (или сначала стереть её purge())',
      NEW.data->>'name'));
  end if;
  ts := @SCHEMA@.now_ts();
  NEW.rev := coalesce(last.rev, 0) + 1;
  NEW.prev_hash := last.hash;
  NEW.at := greatest(ts, last.at + interval '1 microsecond');
  NEW.created_at := NEW.at;
  NEW.cv := cls.rev;
  if NEW.owner is null then
    NEW.owner := case res->>'ownerDefault' when 'actor' then c.account else NEW.tenant end;
  elsif NEW.owner not in (NEW.tenant, c.account)
        and not exists (select 1 from @SCHEMA@.entity a where a.id = NEW.owner and a.class = 'Account' and a.tenant = '@SYSTEM@'::uuid) then
    -- явный владелец — существующий аккаунт; разрешает ли его условие ACL, решает политика вставки
    perform @SCHEMA@.lt_fail('target_not_found', 'владелец строки не найден');
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
  -- строки прав не получаются сменой класса: аккаунт с категориями — только в System (ревью этапа 5)
  if NEW.class <> OLD.class and (NEW.class in ('Account', 'member', 'Resource', 'rule') or OLD.class in ('Account', 'member', 'Resource', 'rule')) then
    perform @SCHEMA@.lt_fail('reclass_denied', 'класс системной строки не меняется');
  end if;
  cls := @SCHEMA@.class_row(NEW.class, OLD.tenant);
  if cls.id is null then
    perform @SCHEMA@.lt_fail('invalid_class', format('класс %s не найден', NEW.class));
  end if;
  perform @SCHEMA@.family_lock(cls, false);
  cls := @SCHEMA@.class_row(NEW.class, OLD.tenant);
  res := cls.data->'resolved';
  if coalesce((res->>'abstract')::boolean, false) then
    perform @SCHEMA@.lt_fail('invalid_class', format('класс %s абстрактный', NEW.class));
  end if;
  if res ? 'derivedBy' or (NEW.class <> OLD.class and (@SCHEMA@.class_row(OLD.class, OLD.tenant)).data->'resolved' ? 'derivedBy') then
    perform @SCHEMA@.lt_fail('derived_class', format('класс %s производный: его строки пишет проектор',
      case when res ? 'derivedBy' then NEW.class else OLD.class end));
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
    -- строка уходит из своего класса — как удаление из него: нужно право DELETE на прежнюю строку (доработки после
    -- точки Б; иначе с одним WRITE строку переносили в класс, где есть DELETE, и удаляли там)
    if not @SCHEMA@.acl_row_ok(@SCHEMA@.acl_plan('DELETE'), OLD.class, OLD.id, OLD.owner, OLD.tenant, OLD.tags, OLD.data, OLD.links) then
      perform @SCHEMA@.lt_fail('acl_denied', format('нет права DELETE на строку класса %s: смена класса убирает её из класса', OLD.class));
    end if;
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
    -- агрегатное поле (план 1.1, §2.4): изменить его нельзя, без поля (замена данных целиком) — прежнее значение;
    -- при смене класса — прежнее число или 0, итог посчитает триггер после оператора
    if res ? 'aggregate' then
      NEW.data := @SCHEMA@.agg_guard(res, OLD.data, NEW.data, NEW.class <> OLD.class);
    end if;
    NEW.data := @SCHEMA@.apply_defaults(res->'schema', NEW.data);
    bad := @SCHEMA@.validate_data(res->'rules', cls.validator, res->'vars', NEW.data);
    if bad <> '[]'::jsonb then
      perform @SCHEMA@.lt_fail('invalid_data', format('данные не проходят описание класса %s', NEW.class), jsonb_build_object('issues', bad));
    end if;
    NEW.validator := null;
  end if;
  select * into lk from @SCHEMA@.links_shape(res, NEW.links);
  if lk.code is not null then
    perform @SCHEMA@.lt_fail(lk.code, lk.msg);
  end if;
  NEW.links := lk.links;
  if NEW.class = 'member' and NEW.links->>'Tenant' is distinct from OLD.tenant::text then
    perform @SCHEMA@.lt_fail('invalid_data', 'конец Tenant членства — арендатор строки');
  end if;
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
    perform @SCHEMA@.family_lock(OLD, true);
    perform @SCHEMA@.family_lock(NEW, true);
    -- смена агрегатов — ещё семейства источников (план 1.1, §2.4): операция, зафиксированная до пересчёта, в него
    -- войдёт, а ожидающая допишет вклад уже по новому описанию
    if OLD.data->'resolved'->'aggregate' is distinct from NEW.data->'resolved'->'aggregate' then
      perform @SCHEMA@.agg_lock_sources(OLD.data->'resolved', NEW.data->'resolved', OLD.tenant);
    end if;
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

-- После оператора insert (решение 2 точки А): все версии оператора — одной вставкой в журнал
-- (по переходной таблице), сигнал — по одному на класс.
create or replace function @SCHEMA@.trg_entity_ai() returns trigger
language plpgsql security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  sc text[];
  st uuid[];
  bad text;
begin
  if exists (select 1 from added n where n.links <> '{}'::jsonb) then
    bad := @SCHEMA@.targets_bad((select jsonb_agg(jsonb_build_object('class', n.class, 'tenant', n.tenant, 'links', n.links))
                                 from added n where n.links <> '{}'::jsonb), true, @SCHEMA@.acl_actor('READ'));
  end if;
  if bad like '!%' then
    perform @SCHEMA@.lt_fail('derived_class', format('конец %s ведёт на строку производного класса', substr(bad, 2)));
  elsif bad is not null then
    perform @SCHEMA@.lt_fail('target_not_found', format('цель конца %s не найдена', bad));
  end if;
  insert into @SCHEMA@.log (id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason, moved, prev_hash)
  select n.id, n.rev, n.class, n.cv, n.tenant, n.owner, n.links, n.data, n.tags, n.at, n.author, n.agent, n.op, n.reason, n.moved, n.prev_hash
  from added n
  join (select k.class, k.tenant from (select distinct a.class, a.tenant from added a) k
        where @SCHEMA@.history_on(k.class, k.tenant)) h on h.class = n.class and h.tenant = n.tenant;
  -- сигнал — по паре «класс, арендатор»
  select array_agg(k.class), array_agg(k.tenant) into sc, st from (select distinct a.class, a.tenant from added a) k;
  perform @SCHEMA@.signal(sc, st);
  if sc && array['rule', 'Resource', 'member', 'Account', 'Class'] then
    perform @SCHEMA@.acl_bump();
  end if;
  if 'Class' = any (sc) then
    -- новый класс — источник агрегата (ревью коммита этапа 4б): нужно право READ без условий на все его строки; план
    -- прав после acl_bump видит новый класс
    perform @SCHEMA@.agg_source_admit(n.data->>'name', @SCHEMA@.agg_new_mark(null, n.data->'resolved'))
    from added n where n.class = 'Class' and n.data->'resolved' ? 'aggregatedBy';
    -- новая цель агрегатов (план 1.1, §2.4): метки её источников (aggregatedBy) — заново
    perform @SCHEMA@.agg_mark(n.tenant, @SCHEMA@.agg_of(n.data->'resolved'))
    from added n where n.class = 'Class' and n.data->'resolved' ? 'aggregate';
  end if;
  return null;
end $$;

-- После оператора update: версии строк, у которых вырос номер версии (пустая правка версии не
-- даёт), — одной вставкой; сигнал; для строк Class — пересчёт потомков и проверка строк семейства
-- при ужесточении.
create or replace function @SCHEMA@.trg_entity_au() returns trigger
language plpgsql security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  sc text[];
  st uuid[];
  o_row @SCHEMA@.entity;
  n_row @SCHEMA@.entity;
  cid uuid;
  bad text;
begin
  -- цели проверяются у строк, у которых изменились концы или класс
  if exists (select 1 from new_rows n join old_rows o on o.id = n.id and o.rev <> n.rev
             where n.links <> '{}'::jsonb and (n.links <> o.links or n.class <> o.class)) then
    bad := @SCHEMA@.targets_bad((select jsonb_agg(jsonb_build_object('class', n.class, 'tenant', n.tenant, 'links', n.links))
                                 from new_rows n join old_rows o on o.id = n.id and o.rev <> n.rev
                                 where n.links <> '{}'::jsonb and (n.links <> o.links or n.class <> o.class)), true, @SCHEMA@.acl_actor('READ'));
  end if;
  if bad like '!%' then
    perform @SCHEMA@.lt_fail('derived_class', format('конец %s ведёт на строку производного класса', substr(bad, 2)));
  elsif bad is not null then
    perform @SCHEMA@.lt_fail('target_not_found', format('цель конца %s не найдена', bad));
  end if;
  insert into @SCHEMA@.log (id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason, moved, prev_hash, changed)
  select n.id, n.rev, n.class, n.cv, n.tenant, n.owner, n.links, n.data, n.tags, n.at, n.author, n.agent, n.op, n.reason, n.moved, n.prev_hash,
         @SCHEMA@.change_paths(o.data, o.links, o.tags, o.owner, o.class, n.data, n.links, n.tags, n.owner, n.class)
  from new_rows n
  join old_rows o on o.id = n.id and o.rev <> n.rev
  join (select k.class, k.tenant from (select distinct a.class, a.tenant from new_rows a) k
        where @SCHEMA@.history_on(k.class, k.tenant)) h on h.class = n.class and h.tenant = n.tenant;
  -- сигнал — по парам нового и прежнего класса: при смене класса без ключа ответы прежнего класса в
  -- кэше других процессов устарели бы (в 1.0.1 сигнал шёл только по новому)
  select array_agg(k.class), array_agg(k.tenant) into sc, st
  from (select distinct v.class, v.tenant from new_rows n join old_rows o on o.id = n.id and o.rev <> n.rev
        cross join lateral (values (n.class, n.tenant), (o.class, o.tenant)) v(class, tenant)) k;
  perform @SCHEMA@.signal(sc, st);
  if sc && array['rule', 'Resource', 'member', 'Account', 'Class'] then
    perform @SCHEMA@.acl_bump();
  end if;
  for cid in select n.id from new_rows n join old_rows o on o.id = n.id and o.rev <> n.rev
             where n.class = 'Class' order by n.id loop
    select * into o_row from old_rows x where x.id = cid;
    select * into n_row from new_rows x where x.id = cid;
    -- класс становится источником агрегата (смена parent; ревью коммита этапа 4б): право READ без условий на его строки
    -- и после правки — по новым предкам (до правки проверил class_admit)
    perform @SCHEMA@.agg_source_admit(n_row.data->>'name', @SCHEMA@.agg_new_mark(o_row.data->'resolved', n_row.data->'resolved'));
    perform @SCHEMA@.class_evolve(o_row, n_row);
  end loop;
  -- отключённый аккаунт: сессии гаснут (этап 5, п. 2), каждая — сигнал кэшу
  for cid in select n.id from new_rows n join old_rows o on o.id = n.id
             where n.class = 'Account' and coalesce((o.data->>'enabled')::boolean, true)
               and not coalesce((n.data->>'enabled')::boolean, true) loop
    perform @SCHEMA@.auth_kill(cid, null);
  end loop;
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
  -- агрегаты (план 1.1, §2.4): источники, чьи метки пересчитываются; цели, поле которых считается заново
  agg_names text[] := '{}';
  agg_own text[] := '{}';
  agg_other text[] := @SCHEMA@.agg_marked(o.data->'resolved', n.data->'resolved');
begin
  if o.data->'resolved'->'aggregate' is distinct from n.data->'resolved'->'aggregate' then
    agg_names := @SCHEMA@.agg_of(o.data->'resolved') || @SCHEMA@.agg_of(n.data->'resolved');
    agg_own := agg_own || (n.data->>'name');
  end if;
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
    -- потомок становится источником вместе с классом (смена parent; ревью коммита этапа 4б) — то же право READ на его
    -- строки по новым предкам (до правки проверил class_admit). class_evolve зовёт только триггер правки приложения;
    -- потомков класса System у арендаторов план прав сессии System не видит, их строки считают агрегаты System для
    -- целей того же арендатора
    if d.tenant = n.tenant then
      perform @SCHEMA@.agg_source_admit(d.data->>'name', @SCHEMA@.agg_new_mark(d.data->'resolved', prep.data->'resolved'));
    end if;
    classes := classes || (d.data->>'name');
    if d.data->'resolved'->'aggregate' is distinct from prep.data->'resolved'->'aggregate' then
      agg_names := agg_names || @SCHEMA@.agg_of(d.data->'resolved') || @SCHEMA@.agg_of(prep.data->'resolved');
      agg_own := agg_own || (d.data->>'name');
    end if;
    agg_other := agg_other || @SCHEMA@.agg_marked(d.data->'resolved', prep.data->'resolved');
  end loop;
  -- агрегаты семейства изменились: метки источников заново и поле у всех целей — из живых источников (строки
  -- проверит ужесточение ниже); у источника сменились предки — заново цели, которые его считают
  if cardinality(agg_names) > 0 then
    perform @SCHEMA@.agg_mark(n.tenant, agg_names);
  end if;
  if cardinality(agg_own) > 0 then
    perform @SCHEMA@.agg_refresh(agg_own, n.tenant, false);
  end if;
  if cardinality(agg_other) > 0 then
    perform @SCHEMA@.agg_refresh(agg_other, n.tenant, true);
  end if;
  if not @SCHEMA@.class_change_safe(o.data->'resolved', n.data->'resolved') then
    -- ужесточение проверяет все строки семейства, в том числе невидимые актору, и отвечает их числом: пробное
    -- ужесточение (maximum, enum, pattern…) было оракулом по чужим строкам (доработки после точки Б). Нужно право READ
    -- без условий на все строки класса и потомков своего арендатора; строки других арендаторов (класс System) —
    -- уровень установки, их число остаётся в others
    perform @SCHEMA@.class_rows_admit(n.data->>'name', n.tenant, array['READ'], format('ужесточение класса %s', n.data->>'name'));
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

-- Действие со строкой, которая ссылается на удаляемые id (p_ids), по правилам её концов (p_ends):
-- cascade сильнее restrict, restrict сильнее unset; null — строка на них не ссылается. Общее правило
-- для триггера удаления и превью delete_preview() (этап 4, п. 6): превью не расходится с удалением.
create or replace function @SCHEMA@.ref_action(p_ends jsonb, p_links jsonb, p_ids uuid[]) returns text
language sql immutable parallel safe
return (
  select case when bool_or(x.a = 'cascade') then 'cascade' when bool_or(x.a = 'restrict') then 'restrict'
              when bool_or(x.a = 'unset') then 'unset' end
  from (select coalesce(p_ends->k.key->>'onDelete', 'restrict') as a
        from jsonb_each(p_links) k
        where exists (select 1 from jsonb_array_elements_text(case jsonb_typeof(k.value) when 'array' then k.value
                                                                 else jsonb_build_array(k.value) end) t
                      where t::uuid = any (p_ids))) x
);

-- Строки арендатора, которыми владел пользователь, переходят арендатору (выход из членства, §2.10):
-- новая версия каждой строки с журналом. Индекс entity_owner — только строки с владельцем-не арендатором.
create or replace function @SCHEMA@.owner_to_tenant(p_tenant uuid, p_user uuid) returns int
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  r @SCHEMA@.entity;
  n int := 0;
begin
  if p_tenant is null or p_user is null or p_tenant = p_user then
    return 0;
  end if;
  select * into c from @SCHEMA@.ctx();
  for r in select x.* from @SCHEMA@.entity x where x.owner = p_user and x.owner <> x.tenant and x.tenant = p_tenant
           order by x.id for update loop
    update @SCHEMA@.entity x
       set owner = p_tenant, rev = x.rev + 1, prev_hash = x.hash,
           at = greatest(@SCHEMA@.now_ts(), x.at + interval '1 microsecond'),
           author = coalesce(c.author, '@SYSTEM@'::uuid), agent = c.agent, op = 'update',
           reason = nullif(current_setting('letopis.reason', true), ''), moved = null
     where x.id = r.id
    returning x.* into r;
    perform @SCHEMA@.log_version(r);
    n := n + 1;
  end loop;
  return n;
end $$;

-- После оператора delete (§2.5, этап 1, п. 8): надгробия, каскад по уровням, restrict по итогу.
-- Строки, которые удалил сам оператор, каскад уже не видит, поэтому сырой delete любого набора
-- связанных строк проходит без ошибки 27000. Надгробия уровня пишутся одной вставкой.
create or replace function @SCHEMA@.trg_entity_ad() returns trigger
language plpgsql security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  r record;
  lvl uuid[];
  all_ids uuid[];
  casc uuid[];
  unsets uuid[];
  classes text[];
  lvl_classes text[];
  pairs text[];
  lvl_pairs text[];
  v_author uuid;
  v_reason text := nullif(current_setting('letopis.reason', true), '');
  newlinks jsonb;
  k record;
  blockers jsonb;
  dplan jsonb;
  wplan jsonb;
  denied text;
  accs uuid[];
  mems jsonb;
  lvl_accs uuid[];
  lvl_mems jsonb;
begin
  select * into c from @SCHEMA@.ctx();
  -- права в замыкании (этап 5, п. 6): DELETE на каждую удаляемую каскадом строку, WRITE — на строку,
  -- у которой снимается конец
  dplan := @SCHEMA@.acl_plan('DELETE');
  wplan := @SCHEMA@.acl_plan('WRITE');
  if exists (select 1 from @SCHEMA@.entity x join gone g on g.id = x.id) then
    perform @SCHEMA@.lt_fail('recreated_in_statement', 'id удалён и создан заново одним оператором');
  end if;
  -- строки производного класса удаляет только проектор (каскад функции владельца сюда не доходит)
  select d.class into denied from (select distinct g.class, g.tenant from gone g) d
  where (@SCHEMA@.class_row(d.class, d.tenant)).data->'resolved' ? 'derivedBy' limit 1;
  if denied is not null then
    perform @SCHEMA@.lt_fail('derived_class', format('класс %s производный: его строки удаляет проектор', denied));
  end if;
  for r in select g.id, g.tenant, g.data->>'name' as name, g.data->'resolved' ? 'derivedBy' as derived from gone g where g.class = 'Class' loop
    -- производный класс удаляет только администратор (class_admit)
    if r.derived and not @SCHEMA@.letopis_allowed('letopis.projector') then
      perform @SCHEMA@.lt_fail('acl_denied', format('класс %s производный: его описание задаёт только администратор (право letopis.projector)', r.name));
    end if;
    if exists (select 1 from @SCHEMA@.entity x where x.class = r.name and (x.tenant = r.tenant or r.tenant = '@SYSTEM@'::uuid))
       or exists (select 1 from @SCHEMA@.entity x where x.class = 'Class' and x.data->>'parent' = r.name
                  and (x.tenant = r.tenant or r.tenant = '@SYSTEM@'::uuid)) then
      perform @SCHEMA@.lt_fail('invalid_class', format('у класса %s есть строки или потомки', r.name));
    end if;
    -- и история строк (остаток Н2; доработки после точки Б): удалённый класс с историей, созданный заново с другими
    -- предками или алиасом, подставил бы её под чужие правила — сначала purge() удалённых строк
    if @SCHEMA@.class_has_history(r.name, r.tenant) then
      perform @SCHEMA@.lt_fail('invalid_class', format('у класса %s есть история строк в журнале: сначала стереть её purge() удалённых строк', r.name));
    end if;
  end loop;
  -- удалена цель агрегатов (план 1.1, §2.4): метки её источников — уже без неё
  perform @SCHEMA@.agg_mark(g.tenant, @SCHEMA@.agg_of(g.data->'resolved'))
  from gone g where g.class = 'Class' and g.data->'resolved' ? 'aggregate';
  v_author := coalesce(c.author, '@SYSTEM@'::uuid);
  -- надгробия: последний снимок следующей версией с видом delete — одной вставкой на уровень
  insert into @SCHEMA@.log (id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason, moved, prev_hash, changed)
  select g.id, g.rev + 1, g.class, g.cv, g.tenant, g.owner, g.links, g.data, g.tags,
         greatest(@SCHEMA@.now_ts(), g.at + interval '1 microsecond'), v_author, c.agent, 'delete', v_reason, null, g.hash, '[]'::jsonb
  from gone g
  join (select d.class, d.tenant from (select distinct x.class, x.tenant from gone x) d
        where @SCHEMA@.history_on(d.class, d.tenant)) h on h.class = g.class and h.tenant = g.tenant;
  -- пары «класс, арендатор» для сигнала — строкой «класс арендатор» (пробела нет ни в имени, ни в uuid)
  select coalesce(array_agg(g.id), '{}'), coalesce(array_agg(distinct g.class), '{}'),
         coalesce(array_agg(distinct g.class || ' ' || g.tenant::text), '{}'),
         coalesce(array_agg(g.id) filter (where g.class = 'Account'), '{}'),
         coalesce(jsonb_agg(jsonb_build_object('tenant', g.tenant, 'user', g.links->>'User')) filter (where g.class = 'member'), '[]'::jsonb)
    into lvl, classes, pairs, accs, mems from gone g;
  all_ids := lvl;
  while cardinality(lvl) > 0 loop
    -- кто ссылается на уровень: действие по правилам концов (общее с превью)
    with refs as (
      select x.id, x.class, x.tenant, x.links from @SCHEMA@.entity x where x.ends && lvl
    ), cls as (
      select d.class, d.tenant, (@SCHEMA@.class_row(d.class, d.tenant)).data->'resolved'->'ends' as ends
      from (select distinct refs.class, refs.tenant from refs) d
    ), act as (
      select refs.id, @SCHEMA@.ref_action(cls.ends, refs.links, all_ids) as a
      from refs join cls on cls.class = refs.class and cls.tenant = refs.tenant
    )
    select coalesce(array_agg(act.id order by act.id) filter (where act.a = 'cascade'), '{}'),
           coalesce(array_agg(act.id order by act.id) filter (where act.a = 'unset'), '{}')
      into casc, unsets from act;
    -- каскад: удаление в порядке id берёт блокировки и ждёт тех, кто как раз пишет ссылки
    with d as (
      delete from @SCHEMA@.entity x
      where x.id in (select y.id from @SCHEMA@.entity y where y.id = any (casc) order by y.id for update)
      returning x.*
    ), t as (
      insert into @SCHEMA@.log (id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason, moved, prev_hash, changed)
      select d.id, d.rev + 1, d.class, d.cv, d.tenant, d.owner, d.links, d.data, d.tags,
             greatest(@SCHEMA@.now_ts(), d.at + interval '1 microsecond'), v_author, c.agent, 'delete', v_reason, null, d.hash, '[]'::jsonb
      from d
      join (select dd.class, dd.tenant from (select distinct x.class, x.tenant from d x) dd
            where @SCHEMA@.history_on(dd.class, dd.tenant)) h on h.class = d.class and h.tenant = d.tenant
    )
    select coalesce(array_agg(d.id), '{}'), coalesce(array_agg(distinct d.class), '{}'),
           coalesce(array_agg(distinct d.class || ' ' || d.tenant::text), '{}'),
           min(d.class) filter (where not @SCHEMA@.acl_row_ok(dplan, d.class, d.id, d.owner, d.tenant, d.tags, d.data, d.links)),
           coalesce(array_agg(d.id) filter (where d.class = 'Account'), '{}'),
           coalesce(jsonb_agg(jsonb_build_object('tenant', d.tenant, 'user', d.links->>'User')) filter (where d.class = 'member'), '[]'::jsonb)
      into lvl, lvl_classes, lvl_pairs, denied, lvl_accs, lvl_mems from d;
    if denied is not null then
      perform @SCHEMA@.lt_fail('acl_denied', format('нет права DELETE на класс %s в каскаде удаления', denied));
    end if;
    accs := accs || lvl_accs;
    mems := mems || lvl_mems;
    classes := classes || lvl_classes;
    pairs := pairs || lvl_pairs;
    -- unset: снять конец, новая версия
    for r in select x.* from @SCHEMA@.entity x where x.id = any (unsets) order by x.id for update loop
      if not @SCHEMA@.acl_row_ok(wplan, r.class, r.id, r.owner, r.tenant, r.tags, r.data, r.links) then
        perform @SCHEMA@.lt_fail('acl_denied', format('нет права WRITE на класс %s: снятие конца при удалении', r.class));
      end if;
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
  -- выход из членства (и удаление аккаунта, которое снимает его членства): строки арендатора, которыми
  -- владел участник, переходят арендатору (§2.10) — новой версией
  for r in select distinct (m->>'tenant')::uuid as tenant, (m->>'user')::uuid as usr from jsonb_array_elements(mems) m loop
    perform @SCHEMA@.owner_to_tenant(r.tenant, r.usr);
  end loop;
  -- удалённый аккаунт: сессии гаснут, креды удаляются (идентификаторы освобождаются)
  for r in select distinct u as acc from unnest(accs) u loop
    perform @SCHEMA@.auth_kill(r.acc, null);
    update @SCHEMA@.secret x set deleted_at = clock_timestamp() where x.account = r.acc and x.deleted_at is null;
  end loop;
  perform @SCHEMA@.signal(array_agg(split_part(x.p, ' ', 1)), array_agg(split_part(x.p, ' ', 2)::uuid))
  from (select distinct p from unnest(pairs) p) x;
  if classes && array['rule', 'Resource', 'member', 'Account', 'Class'] then
    perform @SCHEMA@.acl_bump();
  end if;
  -- restrict — одним запросом после всего каскада
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'class', x.class, 'tenant', x.tenant)), '[]'::jsonb) into blockers
  from (select x.id, x.class, x.tenant from @SCHEMA@.entity x where x.ends && all_ids order by x.id limit 1000) x;
  if blockers <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('delete_restricted', 'на удаляемые строки ссылаются другие строки (onDelete: restrict)',
      @SCHEMA@.visible_detail(blockers, c.tenant));
  end if;
  return null;
end $$;

-- Превью удаления (этап 4, п. 6): что удалит delete этих строк — те же уровни и то же правило
-- ref_action(), что у триггера, но без изменений. Строки: action delete (цели — depth 0, каскад —
-- уровень), unset (конец будет снят) и restrict (мешает удалению). Функция владельца ищет по
-- индексу ends без RLS (§3 «Индексы под RLS»), поэтому и цели, и выдачу пропускает через
-- row_visible() — то же условие, что у политики чтения (как find_*): невидимых строк не раскрывает
-- ни id, ни классом. О невидимых мешающих строках скажет само удаление (visible_detail: число).
create or replace function @SCHEMA@.delete_preview(p_ids uuid[]) returns table(id uuid, class text, action text, depth int)
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
#variable_conflict use_column
declare
  a jsonb := @SCHEMA@.acl_actor('READ');
  c_tenant uuid := (a->>'tenant')::uuid;
  c_account uuid := (a->>'account')::uuid;
  c_plan jsonb := a->'plan';
  lvl uuid[];
  all_ids uuid[];
  casc uuid[];
  d int := 0;
  out_rows jsonb := '[]'::jsonb;
begin
  if c_account is null then
    return;
  end if;
  -- цели — только видимые: превью не подтверждает существование чужих строк
  select coalesce(array_agg(x.id order by x.id), '{}') into lvl
  from @SCHEMA@.entity x
  where x.id = any (p_ids) and @SCHEMA@.row_visible(x.tenant, x.class, x.id, x.owner, x.tags, x.data, x.links, c_tenant, c_account, c_plan);
  out_rows := (select coalesce(jsonb_agg(jsonb_build_array(u, 'delete', 0)), '[]'::jsonb) from unnest(lvl) u);
  all_ids := lvl;
  while cardinality(lvl) > 0 loop
    d := d + 1;
    with refs as (
      select x.id, x.class, x.tenant, x.links from @SCHEMA@.entity x
      where x.ends && lvl and not (x.id = any (all_ids))
    ), cls as (
      select dd.class, dd.tenant, (@SCHEMA@.class_row(dd.class, dd.tenant)).data->'resolved'->'ends' as ends
      from (select distinct refs.class, refs.tenant from refs) dd
    ), act as (
      select refs.id, @SCHEMA@.ref_action(cls.ends, refs.links, all_ids) as a
      from refs join cls on cls.class = refs.class and cls.tenant = refs.tenant
    )
    select coalesce(array_agg(act.id order by act.id) filter (where act.a = 'cascade'), '{}') into casc from act;
    out_rows := out_rows || (select coalesce(jsonb_agg(jsonb_build_array(u, 'delete', d)), '[]'::jsonb) from unnest(casc) u);
    all_ids := all_ids || casc;
    lvl := casc;
  end loop;
  -- кто останется ссылаться на удалённое: снимаемые концы и мешающие строки
  out_rows := out_rows || (
    select coalesce(jsonb_agg(jsonb_build_array(r.id, case when r.a = 'unset' then 'unset' else 'restrict' end, null)), '[]'::jsonb)
    from (select x.id, @SCHEMA@.ref_action((@SCHEMA@.class_row(x.class, x.tenant)).data->'resolved'->'ends', x.links, all_ids) as a
          from @SCHEMA@.entity x where x.ends && all_ids and not (x.id = any (all_ids))) r);
  return query
    select (o->>0)::uuid, e.class, o->>1, (o->>2)::int
    from jsonb_array_elements(out_rows) o
    join @SCHEMA@.entity e on e.id = (o->>0)::uuid
    where @SCHEMA@.row_visible(e.tenant, e.class, e.id, e.owner, e.tags, e.data, e.links, c_tenant, c_account, c_plan);
end $$;

create or replace trigger entity_bi before insert on @SCHEMA@.entity
  for each row when (current_user <> '@OWNER_NAME@') execute function @SCHEMA@.trg_entity_bi();
create or replace trigger entity_bu before update on @SCHEMA@.entity
  for each row when (current_user <> '@OWNER_NAME@') execute function @SCHEMA@.trg_entity_bu();
-- до ревизии 2 журнал писал строковый триггер entity_ai после insert или update
drop trigger if exists entity_ai on @SCHEMA@.entity;
create trigger entity_ai after insert on @SCHEMA@.entity referencing new table as added
  for each statement when (current_user <> '@OWNER_NAME@') execute function @SCHEMA@.trg_entity_ai();
create or replace trigger entity_au after update on @SCHEMA@.entity referencing old table as old_rows new table as new_rows
  for each statement when (current_user <> '@OWNER_NAME@') execute function @SCHEMA@.trg_entity_au();
create or replace trigger entity_bd before delete on @SCHEMA@.entity
  for each statement when (current_user <> '@OWNER_NAME@') execute function @SCHEMA@.trg_entity_bd();
create or replace trigger entity_ad after delete on @SCHEMA@.entity referencing old table as gone
  for each statement when (current_user <> '@OWNER_NAME@') execute function @SCHEMA@.trg_entity_ad();
-- в режиме репликации (session_replication_role = replica) триггеры тоже работают
alter table @SCHEMA@.entity enable always trigger entity_bi;
alter table @SCHEMA@.entity enable always trigger entity_bu;
alter table @SCHEMA@.entity enable always trigger entity_ai;
alter table @SCHEMA@.entity enable always trigger entity_au;
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
-- удаляется с надгробием, которое ссылается на новый id. Проверки делает вызывающая функция; p_plan — план WRITE
-- актора (reclass, rekey, rekey_class): каждая строка, чьи ссылки перевод переписывает, на всех уровнях рекурсии должна
-- им проходить (доработки после точки Б: прежде проверялся только первый уровень); null — путь владельца.
-- Агрегаты (план 1.1, §2.4): перенос — несколько операторов (новая строка, перевод ссылок, удаление старой), и
-- триггер агрегатов на это время только копит их вклады (agg_hold_begin), а в конце применяет одним итогом: сумма
-- не проходит через промежуточные значения, новая цель считается целиком из живых источников.
drop function if exists @SCHEMA@.move_row(@SCHEMA@.entity, uuid, text, jsonb, jsonb, text);
create or replace function @SCHEMA@.move_row(o @SCHEMA@.entity, p_new_id uuid, p_class text, p_data jsonb, p_links jsonb, p_op text,
  p_plan jsonb default null)
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
  held boolean := @SCHEMA@.agg_hold_begin('acc');
begin
  select * into c from @SCHEMA@.ctx();
  select l.rev, l.hash, l.at into last from @SCHEMA@.log l where l.id = p_new_id order by l.rev desc limit 1 for update;
  ts := greatest(@SCHEMA@.now_ts(), last.at + interval '1 microsecond');
  insert into @SCHEMA@.entity (id, rev, class, cv, tenant, owner, links, data, tags, at, created_at, author, agent, op, reason, moved, prev_hash, validator)
  values (p_new_id, coalesce(last.rev, 0) + 1, p_class, coalesce((@SCHEMA@.class_row(p_class, o.tenant)).rev, 0), o.tenant, o.owner,
          p_links, p_data, o.tags, ts, ts, coalesce(c.author, '@SYSTEM@'::uuid), c.agent, p_op,
          nullif(current_setting('letopis.reason', true), ''), o.id, last.hash, null)
  returning * into n;
  perform @SCHEMA@.log_version(n);
  for r in select x.* from @SCHEMA@.entity x where x.ends @> array[o.id] and x.id <> p_new_id order by x.id for update loop
    -- строки производного класса пишет только проектор: перевод их ссылок мимо него оставил бы проекцию
    -- несогласованной (ревью безопасности №3, №3)
    if (@SCHEMA@.class_row(r.class, r.tenant)).data->'resolved' ? 'derivedBy' then
      perform @SCHEMA@.lt_fail('derived_class', format('на строку ссылается строка производного класса %s: её пишет проектор', r.class));
    end if;
    if p_plan is not null and not @SCHEMA@.acl_row_ok(p_plan, r.class, r.id, r.owner, r.tenant, r.tags, r.data, r.links) then
      perform @SCHEMA@.lt_fail('acl_denied', 'нет права WRITE на ссылающиеся строки');
    end if;
    nl := @SCHEMA@.links_replace(r.links, o.id, p_new_id);
    rid := coalesce(@SCHEMA@.key_id((@SCHEMA@.class_row(r.class, r.tenant)).data->'resolved', r.class, r.tenant, r.data, nl), r.id);
    if rid <> r.id then
      perform @SCHEMA@.move_row(r, rid, r.class, r.data, nl, 'rekey', p_plan);
    else
      perform @SCHEMA@.sys_update(r.id, r.data, nl, r.validator, 'update');
    end if;
  end loop;
  delete from @SCHEMA@.entity x where x.id = o.id returning x.* into r;
  -- надгробие всегда вида delete (по нему срез на момент отличает удалённый id), moved — новый id
  perform @SCHEMA@.tombstone(r, 'delete', p_new_id);
  if held then
    perform @SCHEMA@.agg_hold_end(true);
  end if;
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
  rd jsonb;
  wplan jsonb;
  denied text;
  n_denied int;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('no_session', 'нет действующей сессии');
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    perform @SCHEMA@.lt_fail('isolation_level', 'смена класса разрешена только в read committed');
  end if;
  rd := @SCHEMA@.acl_actor('READ');
  wplan := @SCHEMA@.acl_plan('WRITE');
  select x.* into o from @SCHEMA@.entity x where x.id = p_id and x.tenant = c.tenant for update;
  if o.id is null or not @SCHEMA@.row_visible(o.tenant, o.class, o.id, o.owner, o.tags, o.data, o.links, c.tenant, c.account, rd->'plan') then
    perform @SCHEMA@.lt_fail('target_not_found', 'цель не найдена');
  end if;
  if not @SCHEMA@.acl_row_ok(wplan, o.class, o.id, o.owner, o.tenant, o.tags, o.data, o.links) then
    perform @SCHEMA@.lt_fail('acl_denied', format('нет права WRITE на строку класса %s', o.class));
  end if;
  -- строка уходит из своего класса — как удаление из него: нужно право DELETE на прежнюю строку (доработки после
  -- точки Б; иначе с одним WRITE строку переносили в класс, где есть DELETE, и удаляли там)
  if not @SCHEMA@.acl_row_ok(@SCHEMA@.acl_plan('DELETE'), o.class, o.id, o.owner, o.tenant, o.tags, o.data, o.links) then
    perform @SCHEMA@.lt_fail('acl_denied', format('нет права DELETE на строку класса %s: смена класса убирает её из класса', o.class));
  end if;
  -- строки прав и классов функция не трогает
  if o.class in ('Class', 'Account', 'member', 'Resource', 'rule') or p_class in ('Class', 'Account', 'member', 'Resource', 'rule') then
    perform @SCHEMA@.lt_fail('reclass_denied', 'класс системной строки не меняется');
  end if;
  cls := @SCHEMA@.class_row(p_class, o.tenant);
  if cls.id is null then
    perform @SCHEMA@.lt_fail('invalid_class', format('класс %s не найден', p_class));
  end if;
  perform @SCHEMA@.family_lock(cls, false);
  cls := @SCHEMA@.class_row(p_class, o.tenant);
  res := cls.data->'resolved';
  if coalesce((res->>'abstract')::boolean, false) then
    perform @SCHEMA@.lt_fail('invalid_class', format('класс %s абстрактный', p_class));
  end if;
  if res ? 'derivedBy' or (@SCHEMA@.class_row(o.class, o.tenant)).data->'resolved' ? 'derivedBy' then
    perform @SCHEMA@.lt_fail('derived_class', 'строки производного класса пишет только его проектор');
  end if;
  d := coalesce(p_data, o.data);
  -- агрегатные поля нового класса считает база (план 1.1, §2.4): в данных их не передают; прежнее число остаётся
  -- до пересчёта, иначе 0
  if res ? 'aggregate' then
    if p_data ?| @SCHEMA@.agg_fields(res) then
      perform @SCHEMA@.lt_fail('aggregate_field', format('агрегатные поля класса %s считает база — в данных reclass их не передают', p_class));
    end if;
    d := @SCHEMA@.agg_zero(res, d);
  end if;
  d := @SCHEMA@.apply_defaults(res->'schema', d);
  bad := @SCHEMA@.validate_data(res->'rules', cls.validator, res->'vars', d);
  if bad <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('invalid_data', format('данные не проходят описание класса %s', p_class), jsonb_build_object('issues', bad));
  end if;
  select * into lk from @SCHEMA@.check_links(res, o.links, o.tenant, true, rd);
  if lk.code is not null then
    perform @SCHEMA@.lt_fail(lk.code, lk.msg);
  end if;
  inc := @SCHEMA@.incoming_conflicts(o.id, p_class, o.tenant);
  if inc <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('reclass_denied', format('роли ссылающихся строк не принимают класс %s', p_class),
      @SCHEMA@.visible_detail(inc, c.tenant));
  end if;
  nid := coalesce(@SCHEMA@.key_id(res, p_class, o.tenant, d, lk.links), o.id);
  if not @SCHEMA@.acl_row_ok(wplan, p_class, nid, o.owner, o.tenant, o.tags, d, lk.links) then
    perform @SCHEMA@.lt_fail('acl_denied', format('нет права WRITE на класс %s', p_class));
  end if;
  if nid <> o.id then
    -- перевод ссылок пишет ссылающиеся строки: на них тоже нужно право WRITE (глубже первого уровня — move_row);
    -- класс такой строки называется, только если актор её видит
    select min(x.class) filter (where @SCHEMA@.row_visible(x.tenant, x.class, x.id, x.owner, x.tags, x.data, x.links, c.tenant, c.account, rd->'plan')),
           count(*) into denied, n_denied from @SCHEMA@.entity x
    where x.ends @> array[o.id] and not @SCHEMA@.acl_row_ok(wplan, x.class, x.id, x.owner, x.tenant, x.tags, x.data, x.links);
    if n_denied > 0 then
      perform @SCHEMA@.lt_fail('acl_denied', case when denied is not null then format('нет права WRITE на ссылающиеся строки класса %s', denied)
                                                   else 'нет права WRITE на ссылающиеся строки' end);
    end if;
  end if;
  if nid = o.id then
    perform @SCHEMA@.sys_update(o.id, d, lk.links, null, 'reclass', p_class);
  else
    perform @SCHEMA@.move_row(o, nid, p_class, d, lk.links, 'reclass', wplan);
  end if;
  return nid;
end $$;

-- ========================= merge, inc, links_patch =========================

-- Правка концов слотами (этап 4, п. 4): .Роль.set(), .unset(), а для множественных концов .add()
-- и .remove() — атомарно над свежей строкой, без предварительного чтения списка. p_ops — список
-- [{role, op: set | unset | add | remove, value}]: у set — id, список id или null; у add и remove —
-- список id. Повтор в add не добавляется, отсутствующий в remove — пропускается. Проверку концов
-- делают триггеры, как при любой правке.
create or replace function @SCHEMA@.links_patch(p_links jsonb, p_ops jsonb) returns jsonb
language plpgsql immutable parallel safe
as $$
declare
  o jsonb;
  role text;
  res jsonb := coalesce(p_links, '{}'::jsonb);
  cur jsonb;
  v jsonb;
begin
  for o in select x from jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) x loop
    role := o->>'role';
    case o->>'op'
      when 'set' then
        if o->'value' is null or o->'value' = 'null'::jsonb then
          res := res - role;
        else
          res := jsonb_set(res, array[role], o->'value');
        end if;
      when 'unset' then
        res := res - role;
      when 'add' then
        cur := coalesce(res->role, '[]'::jsonb);
        if jsonb_typeof(cur) = 'array' then
          for v in select x from jsonb_array_elements(o->'value') x loop
            v := to_jsonb(lower(v #>> '{}'));
            if not cur @> jsonb_build_array(v) then
              cur := cur || jsonb_build_array(v);
            end if;
          end loop;
        end if;
        res := jsonb_set(res, array[role], cur);
      when 'remove' then
        cur := coalesce(res->role, '[]'::jsonb);
        if jsonb_typeof(cur) = 'array' then
          cur := coalesce((select jsonb_agg(x) from jsonb_array_elements(cur) x
                           where not exists (select 1 from jsonb_array_elements_text(o->'value') r where lower(r) = x #>> '{}')), '[]'::jsonb);
        end if;
        res := jsonb_set(res, array[role], cur);
      else
        raise exception using errcode = 'LT003', message = 'letopis: invalid_data: links_patch: неизвестная операция ' || coalesce(o->>'op', 'null');
    end case;
  end loop;
  return res;
end $$;

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

do $$
declare f text;
begin
  foreach f in array array[
    'now_ts()', 'family_lock(@SCHEMA@.entity, boolean)', 'class_set(jsonb)', 'class_accepts(jsonb, text, uuid)', 'role_accepts(text, uuid, text, text, uuid)',
    'apply_defaults(jsonb, jsonb)', 'links_shape(jsonb, jsonb)', 'targets_bad(jsonb, boolean, jsonb)', 'check_links(jsonb, jsonb, uuid, boolean, jsonb)', 'key_id(jsonb, text, uuid, jsonb, jsonb)',
    'log_version(@SCHEMA@.entity)', 'sys_update(uuid, jsonb, jsonb, jsonpath, text, text)', 'tombstone(@SCHEMA@.entity, text, uuid)',
    'links_replace(jsonb, uuid, uuid)', 'move_row(@SCHEMA@.entity, uuid, text, jsonb, jsonb, text, jsonb)', 'reclass(uuid, text, jsonb)',
    'incoming_conflicts(uuid, text, uuid)', 'visible_detail(jsonb, uuid)', 'class_change_safe(jsonb, jsonb)',
    'family_conflicts(text[], uuid, boolean)', 'reserved_names()', 'class_acl_admit(text, uuid)', 'class_rows_admit(text, uuid, text[], text)', 'class_has_history(text, uuid)', 'class_admit(jsonb, uuid)',
    'trg_entity_bi()', 'trg_entity_bu()', 'trg_entity_ai()', 'trg_entity_au()', 'history_on(text, uuid)', 'signal_token(text, text, bytea)', 'signal_raw(text[])', 'signal(text[], uuid[])', 'class_evolve(@SCHEMA@.entity, @SCHEMA@.entity)',
    'trg_entity_bd()', 'trg_entity_ad()', 'owner_to_tenant(uuid, uuid)', 'ref_action(jsonb, jsonb, uuid[])', 'delete_preview(uuid[])', 'merge(jsonb, jsonb)', 'inc(jsonb, text[], numeric, numeric)', 'links_patch(jsonb, jsonb)'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
-- сырой SQL пишет теми же merge, inc и links_patch, что и библиотека; verify() — в 90-time.sql
-- до этапа 6 verify() был без параметров
drop function if exists @SCHEMA@.verify();
grant execute on function @SCHEMA@.merge(jsonb, jsonb), @SCHEMA@.inc(jsonb, text[], numeric, numeric), @SCHEMA@.links_patch(jsonb, jsonb),
  @SCHEMA@.reserved_names(), @SCHEMA@.reclass(uuid, text, jsonb), @SCHEMA@.delete_preview(uuid[]) to @APP@;
