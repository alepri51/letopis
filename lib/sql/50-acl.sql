-- letopis — права: матрица правил со счётом и политики RLS.
--
-- Матрица на строках системных классов:
--   Resource (хаб, ключ [alias]) — data { alias, category, pattern }; category:
--     ACCOUNT — группа (КТО): pattern { categories: "{A,B}" | "!{A,B}", roles: "{a,b}" | "!{a,b}" }, нет ключа — все;
--     API     — действие (ЧТО): pattern { endpoint: <маска> }; нет pattern — все действия;
--     READ | WRITE | DELETE — строки (ЧТО): pattern { class: <маска с предками>, …условие на строку };
--     ROLE    — роль прописки (ЧТО): pattern { role: <имя> }; нет ключа role — все роли. Правило на роль разрешает
--               выдать и снять её: в приглашении, правкой и удалением прописки;
--   rule (связь Group → Resource, Object → Resource, ключ [Group, Object]) — data { permission, weight, enabled,
--     code, message }; у правила по умолчанию ещё default: true, у правил, которые заводит createTenant (консьержу и
--     роли owner), — concierge: true.
--   Маска: сегменты через точку, {a,b} — альтернативы (вложенные можно), * — хвост из 1+ сегментов.
--   Маски categories, roles, endpoint и class — только строки (описание класса Resource, 95-seed); строка с маской не
--   строкой, записанная в обход проверки, разрешений не даёт, а запрет по ней действует на всех.
--
-- Выбор правила — по счёту, для каждой строки (и каждого действия, каждой роли) отдельно:
--   кандидаты — правила System и рабочей квартиры, у которых совпала группа (метки — только в правилах этой же
--   квартиры) и объект (класс, его предки и алиасы, действие или роль); у строки — ещё условие (вхождение @>);
--   счёт = число ключей маски группы + 1 за маску класса, действия или роли + число листьев условия (не больше 1000)
--   + 1 у запрета + вес;
--   вес правила квартиры — от 0 до 999; правила с признаком concierge считаются с записанным весом: правило консьержа —
--   1 000 000, правило роли owner — 100 000, так что запрет жильца их не перебьёт;
--   побеждает больший счёт; ничья «можно» против «нельзя»: строка не видна и не правится, роль не выдаётся, а проверки
--   acl_check, acl_check_data и acl_check_role отвечают ошибкой acl_ambiguous; ничья с одним решением — оно;
--   нет ни одного кандидата — правило по умолчанию (все → *, есть всегда, deny на свежем доме); ролей оно не выдаёт.
-- Условие на строку — шаблон колонок id, owner, tenant, tags, data, links; значения "$actor" (он же "$account") и
-- "$tenant" подставляются.
--
-- Правило меняет и удаляет его владелец (колонка owner — кто завёл) или консьерж; правило по умолчанию — никто
-- (только setup от владельца схемы). Запись правила, которое при тех же масках и равном счёте спорит с действующим, и
-- запись обратного решения поверх правила той же пары — отказ. Триггер entity_acl.
--
-- Политики RLS: строка квартиры сессии видна (и правима) по плану прав; строки Class квартиры и System видны любой
-- сессии; собственная строка Account и собственные прописки — самому аккаунту. План прав считается функцией владельца
-- acl_plan() один раз на упоминание таблицы в запросе; на строку — встраиваемая acl_ok(). Условие видимости
-- продублировано в row_visible(): по нему функции поиска find_* (70-read.sql) и предпросмотр удаления отбирают строки
-- без RLS. Менять оба места вместе; совпадение — тест find-ids-parity.

-- Маска → тело регулярного выражения: {a,b} — альтернативы (рекурсивно), * — хвост из одного и более сегментов,
-- спецсимволы экранируются.
create or replace function @SCHEMA@.acl_mask_re(p_mask text) returns text
language plpgsql immutable parallel safe
as $$
declare
  r text := '';
  n int := char_length(p_mask);
  i int := 1;
  j int;
  depth int;
  inner_s text;
  parts text[];
  d int;
  st int;
  k int;
  ch text;
begin
  while i <= n loop
    ch := substr(p_mask, i, 1);
    if ch = '{' then
      depth := 1;
      j := i + 1;
      while j <= n and depth > 0 loop
        if substr(p_mask, j, 1) = '{' then depth := depth + 1;
        elsif substr(p_mask, j, 1) = '}' then depth := depth - 1;
        end if;
        j := j + 1;
      end loop;
      inner_s := substr(p_mask, i + 1, greatest(j - i - 2, 0));
      parts := '{}';
      d := 0;
      st := 1;
      for k in 1 .. char_length(inner_s) + 1 loop
        if k = char_length(inner_s) + 1 or (substr(inner_s, k, 1) = ',' and d = 0) then
          parts := parts || substr(inner_s, st, k - st);
          st := k + 1;
        elsif substr(inner_s, k, 1) = '{' then d := d + 1;
        elsif substr(inner_s, k, 1) = '}' then d := d - 1;
        end if;
      end loop;
      r := r || '(?:' || array_to_string(array(select @SCHEMA@.acl_mask_re(x) from unnest(parts) with ordinality u(x, o) order by o), '|') || ')';
      i := j;
      continue;
    elsif ch = '*' then
      r := r || '[^.]+(?:\.[^.]+)*';
    elsif position(ch in '.\+?()[]^$|') > 0 then
      r := r || '\' || ch;
    else
      r := r || ch;
    end if;
    i := i + 1;
  end loop;
  return r;
end $$;

create or replace function @SCHEMA@.acl_mask_ok(p_mask text, p_value text) returns boolean
language sql immutable parallel safe
return p_value ~ ('^' || @SCHEMA@.acl_mask_re(p_mask) || '$');

-- Шаблон множества "{A,B}" | "!{A,B}" против значений. Маска — только строка (описание класса Resource); не строка —
-- null, «неизвестно»: строка, записанная в обход проверки, разрешений не даёт, а запрет по ней действует на всех
-- (acl_rules).
create or replace function @SCHEMA@.acl_set_ok(p_spec jsonb, p_have text[]) returns boolean
language plpgsql immutable parallel safe
as $$
declare
  s text;
  neg boolean;
  list text[];
begin
  if jsonb_typeof(p_spec) is distinct from 'string' then
    return null;
  end if;
  s := p_spec #>> '{}';
  neg := left(s, 1) = '!';
  s := regexp_replace(regexp_replace(regexp_replace(s, '^!', ''), '^\{', ''), '\}$', '');
  list := array(select btrim(x) from unnest(string_to_array(s, ',')) x where btrim(x) <> '');
  return (list && coalesce(p_have, '{}')) <> neg;
end $$;

-- Группа (Resource ACCOUNT) против субъекта. p_same — правило той же квартиры, что и рабочая: только тогда
-- учитываются метки прописки. null — решает маска не строкой (acl_set_ok).
create or replace function @SCHEMA@.acl_group_ok(p_pat jsonb, p_cats text[], p_roles text[], p_same boolean) returns boolean
language sql immutable parallel safe
return p_pat is null or jsonb_typeof(p_pat) <> 'object'
    or ((not (p_pat ? 'categories') or @SCHEMA@.acl_set_ok(p_pat->'categories', p_cats))
        and (not (p_pat ? 'roles') or (p_same and @SCHEMA@.acl_set_ok(p_pat->'roles', p_roles))));

-- Объект строк (READ | WRITE | DELETE) против имён класса: класс, предки и их алиасы. Нет маски — все классы; маска не
-- строкой — null, как у acl_set_ok (разрешение по ней не действует, запрет — на все классы).
create or replace function @SCHEMA@.acl_class_ok(p_pat jsonb, p_names text[]) returns boolean
language sql immutable parallel safe
return case when p_pat is null or jsonb_typeof(p_pat) <> 'object' or not (p_pat ? 'class') then true
            when jsonb_typeof(p_pat->'class') <> 'string' then null
            else exists (select 1 from unnest(p_names) n where @SCHEMA@.acl_mask_ok(p_pat->>'class', n)) end;

-- Объект API против действия: нет pattern — все; pattern без строки endpoint — ни одно.
create or replace function @SCHEMA@.acl_endpoint_ok(p_pat jsonb, p_endpoint text) returns boolean
language sql immutable parallel safe
return p_pat is null or jsonb_typeof(p_pat) <> 'object'
    or (jsonb_typeof(p_pat->'endpoint') = 'string' and @SCHEMA@.acl_mask_ok(p_pat->>'endpoint', p_endpoint));

-- Подстановка "$actor" ("$account") и "$tenant" по всем значениям шаблона.
create or replace function @SCHEMA@.acl_subst(v jsonb, p_actor uuid, p_tenant uuid) returns jsonb
language plpgsql immutable parallel safe
as $$
begin
  case jsonb_typeof(v)
    when 'string' then
      if v #>> '{}' in ('$actor', '$account') then return to_jsonb(p_actor::text);
      elsif v #>> '{}' = '$tenant' then return to_jsonb(p_tenant::text);
      end if;
      return v;
    when 'array' then
      return coalesce((select jsonb_agg(@SCHEMA@.acl_subst(x, p_actor, p_tenant) order by o)
                       from jsonb_array_elements(v) with ordinality t(x, o)), '[]'::jsonb);
    when 'object' then
      return coalesce((select jsonb_object_agg(t.k, @SCHEMA@.acl_subst(t.x, p_actor, p_tenant))
                       from jsonb_each(v) t(k, x)), '{}'::jsonb);
    else
      return v;
  end case;
end $$;

-- Условие на строку правила: шаблон без class с подстановкой; {} — без условия.
create or replace function @SCHEMA@.acl_cond(p_pat jsonb, p_actor uuid, p_tenant uuid) returns jsonb
language sql immutable parallel safe
return case when p_pat is null or jsonb_typeof(p_pat) <> 'object' then '{}'::jsonb
            else @SCHEMA@.acl_subst(p_pat - 'class', p_actor, p_tenant) end;

-- Число листьев условия: каждое скалярное значение (во вложенных объектах и массивах) — один лист; {} — 0.
create or replace function @SCHEMA@.acl_leaves(v jsonb) returns int
language plpgsql immutable parallel safe
as $$
begin
  case jsonb_typeof(v)
    when 'object' then
      return coalesce((select sum(@SCHEMA@.acl_leaves(x))::int from jsonb_each(v) t(k, x)), 0);
    when 'array' then
      return coalesce((select sum(@SCHEMA@.acl_leaves(x))::int from jsonb_array_elements(v) x), 0);
    when 'null' then
      return 0;
    else
      return 1;
  end case;
end $$;

-- Решение для строки по кандидатам класса: {} — можно без условий; массив { c, s, d, r } по убыванию счёта — из
-- кандидатов, чьё условие строка проходит, берётся наибольший счёт; в этой группе только «можно» — да, только
-- «нельзя» — нет, и то и другое (правила спорят) — тоже нет: спорная строка не видна и не правится, остальные строки
-- класса решаются как обычно (ошибку ничьей отдаёт проверка acl_check_data). Последний кандидат массива — правило по
-- умолчанию или правило без условия: какой-то кандидат подходит всегда. null — класса в плане нет: нельзя.
create or replace function @SCHEMA@.acl_pick(p_cands jsonb, p_row jsonb) returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  e jsonb;
  s numeric;
  best numeric;
  a boolean := false;
  d boolean := false;
begin
  if p_cands is null then
    return false;
  end if;
  if jsonb_typeof(p_cands) = 'object' then
    return true;
  end if;
  for e in select x from jsonb_array_elements(p_cands) x loop
    s := (e->>'s')::numeric;
    exit when best is not null and s < best;
    if p_row @> coalesce(e->'c', '{}'::jsonb) then
      best := s;
      if (e->>'d')::boolean then d := true; else a := true; end if;
    end if;
  end loop;
  return a and not d;
end $$;

-- Строка проходит план для политик: класс разрешён без условий (p_all) — сразу да, иначе решение по кандидатам класса
-- (acl_pick); класса нет в плане — нельзя. Встраиваемая: каждый параметр — один раз (аргументы-подзапросы иначе не
-- дали бы встроить), тело стандартным SQL.
create or replace function @SCHEMA@.acl_ok(p_all text[], p_plan jsonb, p_class text, p_id uuid, p_owner uuid, p_tenant uuid,
  p_tags text[], p_data jsonb, p_links jsonb) returns boolean
language sql stable parallel safe
return p_class = any (p_all)
    or coalesce(@SCHEMA@.acl_pick(p_plan -> p_class,
         jsonb_build_object('id', p_id, 'owner', p_owner, 'tenant', p_tenant, 'tags', p_tags, 'data', p_data, 'links', p_links)), false);

-- То же по одной карте плана — в функциях владельца, где план лежит в переменной.
create or replace function @SCHEMA@.acl_row_ok(p_plan jsonb, p_class text, p_id uuid, p_owner uuid, p_tenant uuid,
  p_tags text[], p_data jsonb, p_links jsonb) returns boolean
language sql stable parallel safe
return coalesce(@SCHEMA@.acl_pick(p_plan -> p_class,
         jsonb_build_object('id', p_id, 'owner', p_owner, 'tenant', p_tenant, 'tags', p_tags, 'data', p_data, 'links', p_links)), false);

-- Правила, применимые к субъекту в рабочей квартире (System и сама квартира), с объектами категории p_category;
-- p_system_only — только правила System. gscore — число ключей маски группы; dflt — правило по умолчанию (только
-- System).
create or replace function @SCHEMA@.acl_rules(p_tenant uuid, p_cats text[], p_roles text[], p_category text, p_system_only boolean)
returns table (id uuid, weight numeric, deny boolean, alias text, pattern jsonb, grp text, code jsonb, message text,
  gscore int, dflt boolean)
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  return query
  -- вес правила квартиры — не больше 999 (запись большего отклоняет trg_entity_acl). Правила с признаком concierge
  -- (их заводит createTenant: консьержу — 1 000 000, роли owner — 100 000) и правила System считаются с весом как есть:
  -- ключи группы, поля условия (не больше 1000 листьев в счёте) и запрет к весу 999 их не догонят — полный доступ
  -- консьержа и owner жилец не отнимет и ничьей с ними не сделает
  select x.id,
         case when coalesce((x.data->>'concierge')::boolean, false) or x.tenant = '@SYSTEM@'::uuid
              then coalesce((x.data->>'weight')::numeric, 0)
              else least(coalesce((x.data->>'weight')::numeric, 0), 999) end,
         coalesce(x.data->>'permission', 'deny') <> 'allow',
         o.data->>'alias', o.data->'pattern', g.data->>'alias', x.data->'code', x.data->>'message',
         case when jsonb_typeof(g.data->'pattern') = 'object'
              then (g.data->'pattern' ? 'categories')::int + (g.data->'pattern' ? 'roles')::int else 0 end,
         x.tenant = '@SYSTEM@'::uuid and coalesce((x.data->>'default')::boolean, false)
  from @SCHEMA@.entity x
  join @SCHEMA@.entity g on g.id = (x.links->>'Group')::uuid and g.class = 'Resource'
  join @SCHEMA@.entity o on o.id = (x.links->>'Object')::uuid and o.class = 'Resource'
  where x.class = 'rule'
    and (x.tenant = '@SYSTEM@'::uuid or (not p_system_only and x.tenant = p_tenant))
    and coalesce((x.data->>'enabled')::boolean, true)
    and g.data->>'category' = 'ACCOUNT' and o.data->>'category' = p_category
    -- маска группы не строкой (null): разрешение не действует, запрет — на всех
    and coalesce(@SCHEMA@.acl_group_ok(g.data->'pattern', p_cats, p_roles, x.tenant = p_tenant),
                 coalesce(x.data->>'permission', 'deny') <> 'allow');
end $$;

-- Кандидаты субъекта на операцию над строками по всем классам квартиры и System: { <класс>: [ { c, s, d, r }, … ] } по
-- убыванию счёта (при равном — запрет первым); список обрезан после первой группы с кандидатом без условия, а без
-- такой группы кончается правилом по умолчанию { c: {}, s: -1, d, r, default: true }. Маска класса разбирается один раз
-- на правило; маска не строкой: разрешение отбрасывается, запрет совпадает со всеми классами.
create or replace function @SCHEMA@.acl_cands_for(p_actor uuid, p_tenant uuid, p_cats text[], p_roles text[], p_op text)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  rules jsonb;
  dflt jsonb;
  res jsonb := '{}'::jsonb;
  k record;
  e jsonb;
  arr jsonb;
  cut numeric;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'r', x.id, 'd', x.deny, 'mask', m.mask,
           're', case when m.mask ~ '[{*]' then '^' || @SCHEMA@.acl_mask_re(m.mask) || '$' end,
           'c', m.c,
           's', x.gscore + (case when m.has_class then 1 else 0 end) + least(@SCHEMA@.acl_leaves(m.c), 1000)
                + (case when x.deny then 1 else 0 end) + x.weight)
           order by x.gscore + (case when m.has_class then 1 else 0 end) + least(@SCHEMA@.acl_leaves(m.c), 1000)
                    + (case when x.deny then 1 else 0 end) + x.weight desc, x.deny desc, x.id) filter (where not x.dflt), '[]'::jsonb),
         (array_agg(jsonb_build_object('c', '{}'::jsonb, 's', -1, 'd', x.deny, 'r', x.id, 'default', true)) filter (where x.dflt))[1]
  into rules, dflt
  from @SCHEMA@.acl_rules(p_tenant, p_cats, p_roles, p_op, false) x
  cross join lateral (select case when jsonb_typeof(x.pattern) = 'object' and jsonb_typeof(x.pattern->'class') = 'string'
                                  then x.pattern->>'class' end as mask,
                             coalesce(jsonb_typeof(x.pattern) = 'object' and x.pattern ? 'class', false) as has_class,
                             coalesce(jsonb_typeof(x.pattern) = 'object' and x.pattern ? 'class'
                                      and jsonb_typeof(x.pattern->'class') <> 'string', false) as bad,
                             @SCHEMA@.acl_cond(x.pattern, p_actor, p_tenant) as c) m
  where x.deny or not m.bad;
  -- правила по умолчанию нет (схему правили руками) — запрет
  dflt := coalesce(dflt, '{"c": {}, "s": -1, "d": true, "r": null, "default": true}'::jsonb);
  for k in
    -- один класс на имя — тот, что строки квартиры находят по имени (class_row): свой, иначе System. Одноимённый класс
    -- System, заведённый после класса квартиры, в план не входит: его предки и алиас давали бы права на строки класса
    -- квартиры
    with cl as (
      select distinct on (c.data->>'name') c.data->>'name' as name, c.data->>'alias' as alias, c.data->'resolved'->'ancestors' as anc
      from @SCHEMA@.entity c
      where c.class = 'Class' and c.tenant in (p_tenant, '@SYSTEM@'::uuid)
      order by c.data->>'name', c.tenant = '@SYSTEM@'::uuid
    )
    select cl.name,
           array(select jsonb_array_elements_text(cl.anc))
           || array(select a.alias from cl a where a.alias is not null and cl.anc ? a.name) as names
    from cl
  loop
    arr := '[]'::jsonb;
    cut := null;
    for e in select r from jsonb_array_elements(rules) r loop
      continue when not (e->>'mask' is null
                         or (e->>'re' is null and e->>'mask' = any (k.names))
                         or (e->>'re' is not null and exists (select 1 from unnest(k.names) n where n ~ (e->>'re'))));
      exit when cut is not null and (e->>'s')::numeric < cut;
      arr := arr || jsonb_build_array(jsonb_build_object('c', e->'c', 's', (e->>'s')::numeric, 'd', (e->>'d')::boolean, 'r', e->>'r'));
      if e->'c' = '{}'::jsonb then
        cut := (e->>'s')::numeric;
      end if;
    end loop;
    if cut is null then
      arr := arr || jsonb_build_array(dflt);
    end if;
    res := res || jsonb_build_object(k.name, arr);
  end loop;
  return res;
end $$;

-- План прав субъекта на операцию над строками: { <класс>: {} } — можно без условий, { <класс>: [кандидаты] } — решение
-- для каждой строки (acl_pick); класса нет — нельзя ни одной строки (верхняя группа — только «нельзя» без условий).
create or replace function @SCHEMA@.acl_plan_for(p_actor uuid, p_tenant uuid, p_cats text[], p_roles text[], p_op text)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  res jsonb := '{}'::jsonb;
  k record;
  top numeric;
  uncond boolean;
  allow_all boolean;
  deny_all boolean;
begin
  for k in select t.key, t.value from jsonb_each(@SCHEMA@.acl_cands_for(p_actor, p_tenant, p_cats, p_roles, p_op)) t loop
    top := (k.value->0->>'s')::numeric;
    select bool_and(x->'c' = '{}'::jsonb), bool_and(not (x->>'d')::boolean), bool_and((x->>'d')::boolean)
      into uncond, allow_all, deny_all
    from jsonb_array_elements(k.value) x where (x->>'s')::numeric = top;
    if uncond and deny_all then
      continue;
    elsif uncond and allow_all then
      res := res || jsonb_build_object(k.key, '{}'::jsonb);
    else
      res := res || jsonb_build_object(k.key, k.value);
    end if;
  end loop;
  return res;
end $$;

-- Счётчик изменений прав: строки rule, Resource, member, Account и Class меняют планы прав. Его повышают триггеры после
-- оператора, функции владельца и загрузчик; хранится в строке secret с постоянным id (там же ключ подписи плана).
-- Блокировка строки счётчика упорядочивает изменения прав.
create or replace function @SCHEMA@.acl_bump() returns void
language sql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  -- остальные ключи meta сохраняются
  update @SCHEMA@.secret s set meta = s.meta || jsonb_build_object('v', coalesce((s.meta->>'v')::bigint, 0) + 1)
  where s.id = '@SYSTEM@'::uuid and s.kind = 'KEY'
$$;

-- План прав из подписанного пропуска letopis.acl (acl_token) или заново. Пропуск — «подпись.json»: HMAC-SHA256 ключом
-- из secret, в json — счётчик изменений прав v, актор a, квартира t и планы трёх операций. Подходит, только если подпись
-- верна, актор и квартира те же, а счётчик не изменился; иначе план считается заново — пропуск лишь ускоряет, на
-- правильность не влияет. Подделать пропуск без ключа нельзя.
create or replace function @SCHEMA@.acl_plan_cached(p_actor uuid, p_tenant uuid, p_cats text[], p_roles text[], p_op text)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  raw text := nullif(current_setting('letopis.acl', true), '');
  body text;
  k record;
  j jsonb;
begin
  if raw is not null and position('.' in raw) = 65 then
    body := substr(raw, 66);
    select s.material, s.meta into k from @SCHEMA@.secret s where s.id = '@SYSTEM@'::uuid and s.kind = 'KEY';
    -- сравниваются хэши подписей, а не сами подписи: время сравнения ничего не подсказывает
    if k.material is not null
       and sha256(convert_to(left(raw, 64), 'UTF8'))
           = sha256(convert_to(encode(@PGCRYPTO@.hmac(convert_to(body, 'UTF8'), k.material, 'sha256'), 'hex'), 'UTF8')) then
      j := body::jsonb;
      if j->>'v' = coalesce(k.meta->>'v', '0') and j->>'a' = p_actor::text and j->>'t' is not distinct from p_tenant::text and j ? p_op then
        return j->p_op;
      end if;
    end if;
  end if;
  return @SCHEMA@.acl_plan_for(p_actor, p_tenant, p_cats, p_roles, p_op);
end $$;

-- План прав актора сессии (ctx) на операцию: READ, WRITE или DELETE. Нет сессии или квартиры — пустой план.
create or replace function @SCHEMA@.acl_plan(p_op text) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  if p_op not in ('READ', 'WRITE', 'DELETE') then
    perform @SCHEMA@.lt_fail('sql-access.acl_bad_op', jsonb_build_object('op', p_op));
  end if;
  select * into c from @SCHEMA@.ctx();
  if c.account is null or c.tenant is null then
    return '{}'::jsonb;
  end if;
  return @SCHEMA@.acl_plan_cached(c.account, c.tenant, c.categories, c.roles, p_op);
end $$;

-- Классы, разрешённые актору сессии без условия, — для политик (acl_ok).
create or replace function @SCHEMA@.acl_all(p_op text) returns text[]
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  return array(select k.key from jsonb_each(@SCHEMA@.acl_plan(p_op)) k where k.value = '{}'::jsonb);
end $$;

-- Подписанный пропуск прав актора сессии для letopis.acl: библиотека берёт его один раз на актора и квартиру и передаёт
-- в каждой транзакции, пока не изменятся права (сигнал) или не истечёт срок. Пропуск открывает клиенту его собственный
-- план (классы и кандидаты), но не правила целиком. Нет сессии или квартиры — null.
create or replace function @SCHEMA@.acl_token() returns text
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  k record;
  body text;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null or c.tenant is null then
    return null;
  end if;
  select s.material, s.meta into k from @SCHEMA@.secret s where s.id = '@SYSTEM@'::uuid and s.kind = 'KEY';
  body := jsonb_build_object('v', coalesce(k.meta->>'v', '0'), 'a', c.account, 't', c.tenant,
    'READ', @SCHEMA@.acl_plan_for(c.account, c.tenant, c.categories, c.roles, 'READ'),
    'WRITE', @SCHEMA@.acl_plan_for(c.account, c.tenant, c.categories, c.roles, 'WRITE'),
    'DELETE', @SCHEMA@.acl_plan_for(c.account, c.tenant, c.categories, c.roles, 'DELETE'))::text;
  return encode(@PGCRYPTO@.hmac(convert_to(body, 'UTF8'), k.material, 'sha256'), 'hex') || '.' || body;
end $$;

-- Актор сессии и его план прав на операцию — для функций владельца, которые отбирают строки без RLS (find_*,
-- предпросмотр удаления, проверка целей): { tenant, account, plan }; нет сессии — null.
create or replace function @SCHEMA@.acl_actor(p_op text) returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    return null;
  end if;
  return jsonb_build_object('tenant', c.tenant, 'account', c.account,
    'plan', case when c.tenant is null then '{}'::jsonb else @SCHEMA@.acl_plan_cached(c.account, c.tenant, c.categories, c.roles, p_op) end);
end $$;

-- Субъект прав по аккаунту и квартире без сессии — для загрузчика с опцией as (функция владельца, приложению не
-- выдана): аккаунт включён и лежит в System, прописан в квартире (как в ctx). Отдаёт категории, метки и планы READ и
-- WRITE.
create or replace function @SCHEMA@.acl_subject(p_account uuid, p_tenant uuid) returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  a jsonb;
  m jsonb;
  cats text[];
  roles text[];
begin
  select e.data into a from @SCHEMA@.entity e
  where e.id = p_account and e.class = 'Account' and e.tenant = '@SYSTEM@'::uuid and coalesce((e.data->>'enabled')::boolean, true);
  if a is null then
    perform @SCHEMA@.lt_fail('sql-access.account_unavailable');
  end if;
  m := @SCHEMA@.member_row(p_account, p_tenant);
  if not coalesce(a->'categories' ? 'Service', false) and (m is null or not @SCHEMA@.tenant_ok(p_tenant)) then
    perform @SCHEMA@.lt_fail('sql-access.no_membership');
  end if;
  cats := array(select jsonb_array_elements_text(coalesce(a->'categories', '[]'::jsonb)));
  roles := array(select jsonb_array_elements_text(coalesce(m->'roles', '[]'::jsonb)));
  return jsonb_build_object('categories', to_jsonb(cats), 'roles', to_jsonb(roles),
    'read', @SCHEMA@.acl_plan_for(p_account, p_tenant, cats, roles, 'READ'),
    'write', @SCHEMA@.acl_plan_for(p_account, p_tenant, cats, roles, 'WRITE'));
end $$;

-- Решение по действию: { allow, rule, score, code?, message? }. Кандидаты — правила с совпавшей группой и действием;
-- побеждает больший счёт (ключи группы + 1 за маску действия + 1 у запрета + вес); ничья «можно» против «нельзя» —
-- acl_ambiguous; кандидатов нет — правило по умолчанию (rule.default = true, score 0).
create or replace function @SCHEMA@.acl_api_for(p_tenant uuid, p_cats text[], p_roles text[], p_endpoint text, p_system_only boolean)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  e record;
  best numeric;
  win record;
  have boolean := false;
  a boolean := false;
  d boolean := false;
  ids jsonb := '[]'::jsonb;
begin
  for e in
    select r.*, r.gscore + (case when jsonb_typeof(r.pattern) = 'object' and r.pattern ? 'endpoint' then 1 else 0 end)
                + (case when r.deny then 1 else 0 end) + r.weight as s
    from @SCHEMA@.acl_rules(p_tenant, p_cats, p_roles, 'API', p_system_only) r
    where not r.dflt and @SCHEMA@.acl_endpoint_ok(r.pattern, p_endpoint)
    order by 11 desc, r.deny desc, r.id
  loop
    exit when best is not null and e.s < best;
    best := e.s;
    if not have then
      win := e;
      have := true;
    end if;
    if e.deny then d := true; else a := true; end if;
    ids := ids || jsonb_build_array(e.id);
  end loop;
  if best is null then
    -- внутренние права движка (letopis.*: сигналы, обслуживание) — только явным правилом System: правило по умолчанию
    -- (в том числе allow от setup({ defaultRule })) их не выдаёт
    if p_system_only then
      return jsonb_build_object('allow', false, 'score', 0, 'message', @SCHEMA@.lt_text('sql-access.default_deny'));
    end if;
    select r.*, 0::numeric as s into win
    from @SCHEMA@.acl_rules(p_tenant, p_cats, p_roles, 'API', p_system_only) r where r.dflt limit 1;
    if not found then
      return jsonb_build_object('allow', false, 'message', @SCHEMA@.lt_text('sql-access.default_deny'));
    end if;
    return jsonb_strip_nulls(jsonb_build_object('allow', not win.deny, 'score', 0,
      'rule', jsonb_build_object('id', win.id, 'group', win.grp, 'object', win.alias, 'weight', win.weight,
                                 'permission', case when win.deny then 'deny' else 'allow' end, 'default', true),
      'code', case when win.deny then win.code end, 'message', case when win.deny then win.message end));
  end if;
  if a and d then
    perform @SCHEMA@.lt_fail('sql-access.acl_ambiguous', jsonb_build_object('rules', ids), jsonb_build_object('rules', ids));
  end if;
  return jsonb_strip_nulls(jsonb_build_object('allow', a, 'score', best,
    'rule', jsonb_build_object('id', win.id, 'group', win.grp, 'object', win.alias, 'weight', win.weight,
                               'permission', case when win.deny then 'deny' else 'allow' end),
    'code', case when win.deny then win.code end, 'message', case when win.deny then win.message end));
end $$;

-- acl.check(endpoint): решение для актора сессии по правилам System и его квартиры.
create or replace function @SCHEMA@.acl_check(p_endpoint text) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('sql-access.no_session');
  end if;
  -- letopis.* — внутренние права движка: решают только правила System, как при самом вызове (acl_require,
  -- letopis_allowed), — ответ проверки не расходится с тем, что разрешит база
  return @SCHEMA@.acl_api_for(c.tenant, c.categories, c.roles, p_endpoint, coalesce(p_endpoint like 'letopis.%', false));
end $$;

-- Внутренняя проверка прав letopis.*: только правила System. Отказ — acl_denied.
create or replace function @SCHEMA@.acl_require(p_endpoint text) returns void
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('sql-access.no_session');
  end if;
  if not coalesce((@SCHEMA@.acl_api_for(c.tenant, c.categories, c.roles, p_endpoint, true)->>'allow')::boolean, false) then
    perform @SCHEMA@.lt_fail('sql-access.no_right', jsonb_build_object('endpoint', p_endpoint));
  end if;
end $$;

-- Решение «можно ли субъекту выдать (и снять) роль p_role»: { allow, rule?, score?, ambiguous? }. Кандидаты — правила с
-- совпавшей группой и объектом категории ROLE: без имени роли (все роли) или с этим именем; p_role null — «любые роли»:
-- подходят только объекты без имени роли. Побеждает больший счёт (ключи группы + 1 за имя роли + 1 у запрета + вес);
-- ничья «можно» против «нельзя» — нельзя (ambiguous: true, rules); кандидатов нет — нельзя: правило по умолчанию ролей
-- не выдаёт.
create or replace function @SCHEMA@.acl_role_for(p_tenant uuid, p_cats text[], p_roles text[], p_role text) returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  e record;
  best numeric;
  win record;
  have boolean := false;
  a boolean := false;
  d boolean := false;
  ids jsonb := '[]'::jsonb;
begin
  for e in
    select r.*, r.gscore + (case when jsonb_typeof(r.pattern) = 'object' and r.pattern ? 'role' then 1 else 0 end)
                + (case when r.deny then 1 else 0 end) + r.weight as s
    from @SCHEMA@.acl_rules(p_tenant, p_cats, p_roles, 'ROLE', false) r
    where not r.dflt
      and (r.pattern is null or jsonb_typeof(r.pattern) <> 'object' or not (r.pattern ? 'role')
           or (p_role is not null and jsonb_typeof(r.pattern->'role') = 'string' and r.pattern->>'role' = p_role)
           -- имя роли не строкой (запись в обход проверки): разрешение не действует, запрет — на все роли
           or (jsonb_typeof(r.pattern->'role') <> 'string' and r.deny))
    order by 11 desc, r.deny desc, r.id
  loop
    exit when best is not null and e.s < best;
    best := e.s;
    if not have then
      win := e;
      have := true;
    end if;
    if e.deny then d := true; else a := true; end if;
    ids := ids || jsonb_build_array(e.id);
  end loop;
  if best is null then
    return jsonb_build_object('allow', false, 'score', 0, 'message', @SCHEMA@.lt_text('sql-access.default_deny'));
  end if;
  return jsonb_strip_nulls(jsonb_build_object('allow', a and not d, 'score', best,
    'ambiguous', case when a and d then true end, 'rules', case when a and d then ids end,
    'rule', jsonb_build_object('id', win.id, 'group', win.grp, 'object', win.alias, 'weight', win.weight,
                               'permission', case when win.deny then 'deny' else 'allow' end)));
end $$;

-- acl.checkRole(role): может ли актор сессии выдать и снять роль ('*' — любые роли). Консьерж (не от имени жильца) —
-- всегда. Ничья — ошибка acl_ambiguous.
create or replace function @SCHEMA@.acl_check_role(p_role text) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  r jsonb;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null or c.tenant is null then
    perform @SCHEMA@.lt_fail('sql-access.no_session');
  end if;
  if c.service is null and coalesce('Service' = any (c.categories), false) then
    return jsonb_build_object('allow', true);
  end if;
  r := @SCHEMA@.acl_role_for(c.tenant, c.categories, c.roles, nullif(p_role, '*'));
  if coalesce((r->>'ambiguous')::boolean, false) then
    perform @SCHEMA@.lt_fail('sql-access.acl_ambiguous', jsonb_build_object('rules', r->'rules'), jsonb_build_object('rules', r->'rules'));
  end if;
  return r - 'rules';
end $$;

-- acl.checkData(class, op): { allow, all, candidates } для актора сессии. allow — можно ли хоть какие-то строки; all —
-- можно ли все без условий; candidates — кандидаты в порядке выбора: { rule, score, permission, filter, default? }.
-- Среди кандидатов разрешение и запрет с равным счётом, а условие одного входит в условие другого (в том числе оба без
-- условия): на строках, подходящих обоим, правила спорят — ошибка acl_ambiguous (сами строки при чтении скрыты).
create or replace function @SCHEMA@.acl_check_data(p_class text, p_op text) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  arr jsonb;
  p jsonb;
  tie jsonb;
begin
  if p_op not in ('READ', 'WRITE', 'DELETE') then
    perform @SCHEMA@.lt_fail('sql-access.acl_bad_op', jsonb_build_object('op', p_op));
  end if;
  select * into c from @SCHEMA@.ctx();
  if c.account is null or c.tenant is null then
    return jsonb_build_object('allow', false, 'all', false, 'candidates', '[]'::jsonb);
  end if;
  arr := @SCHEMA@.acl_cands_for(c.account, c.tenant, c.categories, c.roles, p_op) -> p_class;
  select jsonb_build_array(x->>'r', y->>'r') into tie
  from jsonb_array_elements(coalesce(arr, '[]'::jsonb)) x, jsonb_array_elements(coalesce(arr, '[]'::jsonb)) y
  where (x->>'s')::numeric = (y->>'s')::numeric and not (x->>'d')::boolean and (y->>'d')::boolean
    and (coalesce(x->'c', '{}'::jsonb) @> coalesce(y->'c', '{}'::jsonb) or coalesce(y->'c', '{}'::jsonb) @> coalesce(x->'c', '{}'::jsonb))
  limit 1;
  if tie is not null then
    perform @SCHEMA@.lt_fail('sql-access.acl_ambiguous', jsonb_build_object('rules', tie), jsonb_build_object('rules', tie));
  end if;
  p := @SCHEMA@.acl_plan_cached(c.account, c.tenant, c.categories, c.roles, p_op);
  return jsonb_build_object(
    'allow', p ? p_class and exists (select 1 from jsonb_array_elements(coalesce(arr, '[]'::jsonb)) x where not (x->>'d')::boolean),
    'all', coalesce(p -> p_class = '{}'::jsonb, false),
    'candidates', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'rule', x->>'r', 'score', case when x ? 'default' then to_jsonb(0) else x->'s' end,
        'permission', case when (x->>'d')::boolean then 'deny' else 'allow' end,
        'filter', x->'c', 'default', x->'default')) order by o)
      from jsonb_array_elements(arr) with ordinality t(x, o)), '[]'::jsonb));
end $$;

-- Видимость строки для чтения — то же условие, что using политик entity_select и log_select. Отдельная функция, а не
-- выражение политики: аргументы-подзапросы, использованные в теле больше одного раза, не дают PostgreSQL встроить
-- функцию, и политика потеряла бы индексы.
create or replace function @SCHEMA@.row_visible(p_tenant uuid, p_class text, p_id uuid, p_owner uuid, p_tags text[],
  p_data jsonb, p_links jsonb, c_tenant uuid, c_account uuid, c_plan jsonb)
returns boolean
language sql stable parallel safe
return (p_tenant = c_tenant and (p_class = 'Class' or @SCHEMA@.acl_row_ok(c_plan, p_class, p_id, p_owner, p_tenant, p_tags, p_data, p_links)))
    or (p_class = 'Class' and p_tenant = '@SYSTEM@'::uuid and c_account is not null)
    or (p_class = 'Account' and p_id = c_account)
    or (p_class = 'member' and p_links->>'User' = c_account::text);

-- Защита матрицы. Правило: новое принадлежит тому, кто его завёл; менять и удалять его может владелец или консьерж;
-- правило по умолчанию — никто (только setup от владельца схемы); признаки default и concierge ставит только консьерж
-- и владелец схемы; вес правила квартиры без признака — целое от 0 до 999; обратное решение поверх правила той же пары
-- (deny поверх allow и наоборот) — отказ rule_flip, а не молчаливая замена; правило, которое при тех же масках КТО и
-- ЧТО и равном счёте спорит с действующим, — отказ rule_tie. Прописка: заводится только приглашением; каждую
-- добавленную и снятую роль (правка) и каждую роль выписываемого (удаление чужой прописки) должна разрешать матрица —
-- ресурс ROLE (acl_role_for); консьержу можно всегда.
create or replace function @SCHEMA@.trg_entity_acl() returns trigger
language plpgsql security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  svc boolean;
  -- класс правки и удаления — прежний: смену класса отклонит trg_entity_bu, но охрана не должна от неё зависеть
  cls text := case when TG_OP = 'INSERT' then NEW.class else OLD.class end;
  r text;
  w numeric;
  flagged boolean;
  deny boolean;
  other record;
  t uuid;
begin
  if cls not in ('rule', 'member', 'Resource') then
    return case when TG_OP = 'DELETE' then OLD else NEW end;
  end if;
  select * into c from @SCHEMA@.ctx();
  svc := c.account is not null and c.service is null and coalesce('Service' = any (c.categories), false);
  if cls = 'member' then
    if TG_OP = 'DELETE' then
      -- чужую прописку снимает тот, кому матрица разрешает каждую её роль; свою (выписка цепочкой) — сам жилец
      if not svc and OLD.links->>'User' is distinct from c.account::text and jsonb_typeof(OLD.data->'roles') = 'array' then
        for r in select x from jsonb_array_elements_text(OLD.data->'roles') x loop
          if not coalesce((@SCHEMA@.acl_role_for(c.tenant, c.categories, c.roles, r)->>'allow')::boolean, false) then
            perform @SCHEMA@.lt_fail('sql-access.role_denied', jsonb_build_object('role', r));
          end if;
        end loop;
      end if;
      return OLD;
    end if;
    -- прописка — только по приглашению (invite_accept): жилец не заводит её сам и не переносит на другой аккаунт
    -- вставка строки, которая уже есть (upsert своей прописки), — правка, а не новая прописка: её проверит правка
    if not svc and ((TG_OP = 'INSERT' and not exists (select 1 from @SCHEMA@.entity x where x.id = NEW.id))
                    or (TG_OP = 'UPDATE' and NEW.links->>'User' is distinct from OLD.links->>'User')) then
      perform @SCHEMA@.lt_fail('sql-access.member_invite_only');
    end if;
    if NEW.data ? 'roles' and not @SCHEMA@.auth_roles_ok(NEW.data->'roles') then
      perform @SCHEMA@.lt_fail('sql-access.roles_args');
    end if;
    -- роль — ресурс матрицы: каждую добавленную и каждую снятую роль должно разрешать правило (право писать member
    -- само ролей не даёт — иначе оно равнялось бы праву стать owner)
    if TG_OP = 'UPDATE' and not svc and NEW.data->'roles' is distinct from OLD.data->'roles' then
      for r in
        select x from (
          (select jsonb_array_elements_text(coalesce(NEW.data->'roles', '[]'::jsonb)) as x
           except select jsonb_array_elements_text(coalesce(OLD.data->'roles', '[]'::jsonb)))
          union
          (select jsonb_array_elements_text(coalesce(OLD.data->'roles', '[]'::jsonb))
           except select jsonb_array_elements_text(coalesce(NEW.data->'roles', '[]'::jsonb)))) t
      loop
        if not coalesce((@SCHEMA@.acl_role_for(c.tenant, c.categories, c.roles, r)->>'allow')::boolean, false) then
          perform @SCHEMA@.lt_fail('sql-access.role_denied', jsonb_build_object('role', r));
        end if;
      end loop;
    end if;
    return NEW;
  end if;
  if cls = 'Resource' then
    -- маску ресурса (группы или объекта правила) меняет и удаляет только тот, кто её завёл, или консьерж: иначе жилец с
    -- правом писать Resource переписал бы чужое правило через его ресурс. Пустая правка (upsert того же ресурса
    -- обёрткой acl) — не изменение
    if TG_OP = 'INSERT' then
      NEW.owner := coalesce(c.account, NEW.owner);
      return NEW;
    end if;
    -- владелец ресурса не меняется никем, кроме консьержа: upsert другого жильца (owner из вставки) его не перепишет
    if TG_OP = 'UPDATE' and not svc then
      NEW.owner := OLD.owner;
    end if;
    if not svc and OLD.owner is distinct from c.account
       and (TG_OP = 'DELETE' or NEW.data is distinct from OLD.data or NEW.links is distinct from OLD.links
            or NEW.tags is distinct from OLD.tags or NEW.class is distinct from OLD.class) then
      perform @SCHEMA@.lt_fail('sql-access.resource_foreign', '{}'::jsonb, jsonb_build_object('resource', OLD.id));
    end if;
    return case when TG_OP = 'DELETE' then OLD else NEW end;
  end if;
  if TG_OP <> 'INSERT' then
    if coalesce((OLD.data->>'default')::boolean, false) then
      perform @SCHEMA@.lt_fail('sql-access.rule_default_protected');
    end if;
    if not svc and OLD.owner is distinct from c.account then
      perform @SCHEMA@.lt_fail('sql-access.rule_foreign', '{}'::jsonb, jsonb_build_object('rule', OLD.id));
    end if;
    if TG_OP = 'DELETE' then
      return OLD;
    end if;
  end if;
  -- признаки default и concierge ставит и меняет только консьерж: у новой строки — само их наличие, у правки — их
  -- изменение (чужое правило с признаком до сюда не доходит: его правка — rule_foreign)
  if not svc and ((TG_OP = 'INSERT' and (NEW.data ? 'default' or NEW.data ? 'concierge'))
                  or (TG_OP = 'UPDATE' and (NEW.data->'default' is distinct from OLD.data->'default'
                                            or NEW.data->'concierge' is distinct from OLD.data->'concierge'))) then
    perform @SCHEMA@.lt_fail('sql-access.rule_reserved');
  end if;
  if TG_OP = 'UPDATE' then
    -- обратное решение поверх правила той же пары — не молчаливая замена: сначала снять прежнее
    if coalesce(NEW.data->>'permission', 'deny') is distinct from coalesce(OLD.data->>'permission', 'deny') then
      perform @SCHEMA@.lt_fail('sql-access.rule_flip', jsonb_build_object('permission', coalesce(OLD.data->>'permission', 'deny')),
        jsonb_build_object('rule', OLD.id));
    end if;
  end if;
  flagged := coalesce((NEW.data->>'concierge')::boolean, false) or coalesce((NEW.data->>'default')::boolean, false);
  w := case when jsonb_typeof(NEW.data->'weight') = 'number' then (NEW.data->>'weight')::numeric else 0 end;
  -- квартира новой строки: вставка может прийти без неё — её проставит trg_entity_bi (он срабатывает позже) по сессии
  t := coalesce(NEW.tenant, c.tenant);
  if not flagged and t is distinct from '@SYSTEM@'::uuid and (w < 0 or w > 999 or w <> trunc(w)) then
    perform @SCHEMA@.lt_fail('sql-access.rule_weight', jsonb_build_object('weight', w));
  end if;
  -- спор с действующим правилом: те же маски КТО и ЧТО, обратное решение, равный счёт (у запрета счёт на 1 больше —
  -- значит, вес разрешения = вес запрета + 1). Такое правило спорило бы на каждой строке
  deny := coalesce(NEW.data->>'permission', 'deny') <> 'allow';
  if coalesce((NEW.data->>'enabled')::boolean, true) then
    select x.id, coalesce(x.data->>'permission', 'deny') as permission, coalesce((x.data->>'weight')::numeric, 0) as weight into other
    from @SCHEMA@.entity x
    join @SCHEMA@.entity g on g.id = (x.links->>'Group')::uuid and g.class = 'Resource'
    join @SCHEMA@.entity o on o.id = (x.links->>'Object')::uuid and o.class = 'Resource'
    join @SCHEMA@.entity ng on ng.id = (NEW.links->>'Group')::uuid and ng.class = 'Resource'
    join @SCHEMA@.entity n_o on n_o.id = (NEW.links->>'Object')::uuid and n_o.class = 'Resource'
    where x.class = 'rule' and x.tenant = t and coalesce((x.data->>'enabled')::boolean, true)
      and not (x.links->>'Group' = NEW.links->>'Group' and x.links->>'Object' = NEW.links->>'Object')
      and (coalesce(x.data->>'permission', 'deny') <> 'allow') <> deny
      and (coalesce((x.data->>'concierge')::boolean, false) or coalesce((x.data->>'default')::boolean, false)) = flagged
      and coalesce(g.data->'pattern', '{}'::jsonb) = coalesce(ng.data->'pattern', '{}'::jsonb)
      and o.data->>'category' = n_o.data->>'category'
      and coalesce(o.data->'pattern', '{}'::jsonb) = coalesce(n_o.data->'pattern', '{}'::jsonb)
      and case when deny then w + 1 = coalesce((x.data->>'weight')::numeric, 0)
               else w = coalesce((x.data->>'weight')::numeric, 0) + 1 end
    limit 1;
    if other.id is not null then
      perform @SCHEMA@.lt_fail('sql-access.rule_tie',
        jsonb_build_object('permission', case when deny then 'deny' else 'allow' end, 'weight', w, 'rule', other.id,
                           'other', other.permission, 'other_weight', other.weight),
        jsonb_build_object('rule', other.id));
    end if;
  end if;
  if TG_OP = 'INSERT' then
    NEW.owner := coalesce(c.account, NEW.owner);
    return NEW;
  end if;
  -- владелец правила остаётся тем, кто его завёл: передать правило другому может только консьерж
  if not svc then
    NEW.owner := OLD.owner;
  end if;
  return NEW;
end $$;

-- раньше триггеров записи (имя по алфавиту): владелец нового правила проставлен до их проверок
create or replace trigger entity_acl before insert or update or delete on @SCHEMA@.entity
  for each row when (current_user <> '@OWNER_NAME@') execute function @SCHEMA@.trg_entity_acl();
alter table @SCHEMA@.entity enable always trigger entity_acl;

-- Охрана матрицы при удалении — те же отказы, что у entity_acl, для строк, которых он не видит: каскад удаления
-- (trg_entity_ad удаляет от владельца схемы) и предпросмотр (delete_preview, ничего не удаляет). p_row — строка entity
-- целиком (to_jsonb); p_actor — аккаунт сессии, p_svc — консьерж. Правило по умолчанию не удаляет никто
-- (rule_default_protected); чужое правило и чужой ресурс — только консьерж (rule_foreign, resource_foreign). id
-- отказавшей строки — в detail, только если актор её видит (visible_class): каскад мог дойти до невидимой.
create or replace function @SCHEMA@.acl_delete_guard(p_row jsonb, p_actor uuid, p_svc boolean) returns void
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  cls text := p_row->>'class';
  shown boolean;
begin
  if cls = 'rule' and coalesce((p_row->'data'->>'default')::boolean, false) then
    perform @SCHEMA@.lt_fail('sql-access.rule_default_protected');
  end if;
  if cls not in ('rule', 'Resource') or p_svc or (p_row->>'owner')::uuid is not distinct from p_actor then
    return;
  end if;
  shown := @SCHEMA@.visible_class(jsonb_build_array(p_row)) is not null;
  if cls = 'rule' then
    perform @SCHEMA@.lt_fail('sql-access.rule_foreign', '{}'::jsonb,
      case when shown then jsonb_build_object('rule', p_row->>'id') else '{}'::jsonb end);
  end if;
  perform @SCHEMA@.lt_fail('sql-access.resource_foreign', '{}'::jsonb,
    case when shown then jsonb_build_object('resource', p_row->>'id') else '{}'::jsonb end);
end $$;

-- Политики: create policy не знает or replace — повторный накат пересоздаёт их (drop policy if exists и create policy).
drop policy if exists entity_select on @SCHEMA@.entity;
create policy entity_select on @SCHEMA@.entity for select to @APP@
  using (
    (tenant = (select @SCHEMA@.ctx_tenant())
      and (class = 'Class' or @SCHEMA@.acl_ok((select @SCHEMA@.acl_all('READ')), (select @SCHEMA@.acl_plan('READ')), class, id, owner, tenant, tags, data, links)))
    or (class = 'Class' and tenant = '@SYSTEM@'::uuid and (select @SCHEMA@.ctx_account()) is not null)
    or (class = 'Account' and id = (select @SCHEMA@.ctx_account()))
    or (class = 'member' and links->>'User' = (select @SCHEMA@.ctx_account())::text)
  );

drop policy if exists entity_insert on @SCHEMA@.entity;
create policy entity_insert on @SCHEMA@.entity for insert to @APP@
  with check (tenant = (select @SCHEMA@.ctx_tenant())
    and @SCHEMA@.acl_ok((select @SCHEMA@.acl_all('WRITE')), (select @SCHEMA@.acl_plan('WRITE')), class, id, owner, tenant, tags, data, links));

-- правка: решение по прежним и по новым значениям строки
drop policy if exists entity_update on @SCHEMA@.entity;
create policy entity_update on @SCHEMA@.entity for update to @APP@
  using (tenant = (select @SCHEMA@.ctx_tenant())
    and @SCHEMA@.acl_ok((select @SCHEMA@.acl_all('WRITE')), (select @SCHEMA@.acl_plan('WRITE')), class, id, owner, tenant, tags, data, links))
  with check (tenant = (select @SCHEMA@.ctx_tenant())
    and @SCHEMA@.acl_ok((select @SCHEMA@.acl_all('WRITE')), (select @SCHEMA@.acl_plan('WRITE')), class, id, owner, tenant, tags, data, links));

drop policy if exists entity_delete on @SCHEMA@.entity;
create policy entity_delete on @SCHEMA@.entity for delete to @APP@
  using (tenant = (select @SCHEMA@.ctx_tenant())
    and @SCHEMA@.acl_ok((select @SCHEMA@.acl_all('DELETE')), (select @SCHEMA@.acl_plan('DELETE')), class, id, owner, tenant, tags, data, links));

drop policy if exists log_select on @SCHEMA@.log;
create policy log_select on @SCHEMA@.log for select to @APP@
  using (
    (tenant = (select @SCHEMA@.ctx_tenant())
      and (class = 'Class' or @SCHEMA@.acl_ok((select @SCHEMA@.acl_all('READ')), (select @SCHEMA@.acl_plan('READ')), class, id, owner, tenant, tags, data, links)))
    or (class = 'Class' and tenant = '@SYSTEM@'::uuid and (select @SCHEMA@.ctx_account()) is not null)
    or (class = 'Account' and id = (select @SCHEMA@.ctx_account()))
    or (class = 'member' and links->>'User' = (select @SCHEMA@.ctx_account())::text)
  );

do $$
declare f text;
begin
  foreach f in array array[
    'acl_mask_re(text)', 'acl_mask_ok(text, text)', 'acl_set_ok(jsonb, text[])', 'acl_group_ok(jsonb, text[], text[], boolean)',
    'acl_class_ok(jsonb, text[])', 'acl_endpoint_ok(jsonb, text)', 'acl_subst(jsonb, uuid, uuid)', 'acl_cond(jsonb, uuid, uuid)',
    'acl_leaves(jsonb)', 'acl_pick(jsonb, jsonb)',
    'acl_ok(text[], jsonb, text, uuid, uuid, uuid, text[], jsonb, jsonb)', 'acl_row_ok(jsonb, text, uuid, uuid, uuid, text[], jsonb, jsonb)', 'acl_rules(uuid, text[], text[], text, boolean)',
    'acl_cands_for(uuid, uuid, text[], text[], text)', 'acl_plan_for(uuid, uuid, text[], text[], text)', 'acl_bump()', 'acl_plan_cached(uuid, uuid, text[], text[], text)',
    'acl_plan(text)', 'acl_all(text)', 'acl_token()', 'acl_actor(text)', 'acl_subject(uuid, uuid)', 'acl_api_for(uuid, text[], text[], text, boolean)',
    'acl_check(text)', 'acl_require(text)', 'acl_role_for(uuid, text[], text[], text)', 'acl_check_role(text)', 'acl_check_data(text, text)', 'trg_entity_acl()', 'acl_delete_guard(jsonb, uuid, boolean)',
    'row_visible(uuid, text, uuid, uuid, text[], jsonb, jsonb, uuid, uuid, jsonb)'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
-- политики вызываются с правами приложения: план прав (функция владельца) и встраиваемая проверка с решением по
-- кандидатам (acl_pick — функция владельца)
grant execute on function @SCHEMA@.acl_plan(text), @SCHEMA@.acl_all(text), @SCHEMA@.acl_ok(text[], jsonb, text, uuid, uuid, uuid, text[], jsonb, jsonb),
  @SCHEMA@.acl_pick(jsonb, jsonb), @SCHEMA@.acl_check(text), @SCHEMA@.acl_check_role(text), @SCHEMA@.acl_check_data(text, text), @SCHEMA@.acl_token() to @APP@;
