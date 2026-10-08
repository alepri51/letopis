-- letopis 1.0 — права: ACL и политики RLS (план, §2.2, §2.8, этап 5, п. 5).
--
-- Модель прав 0.21 (lib/src/acl.ts тега v0.21.0) на строках системных классов:
--   Resource (хаб, ключ [alias]) — data { alias, category, pattern }; category:
--     ACCOUNT — группа: pattern { categories: "{A,B}" | "!{A,B}", roles: "{a,b}" | "!{a,b}" }, нет ключа — все;
--     API     — эндпоинт: pattern { endpoint: <маска> }; нет pattern — все эндпоинты;
--     READ | WRITE | DELETE — строки: pattern { class: <маска с предками>, …условие на строку };
--   rule (связь Group → Resource, Object → Resource, ключ [Group, Object]) — data { permission, weight,
--     enabled, code, message }.
--   Маска: сегменты через точку, {a,b} — альтернативы (вложенные можно), * — хвост из 1+ сегментов.
-- Решение — ровно одно правило: наибольший вес; при равном весе запрет сильнее разрешения; из равных —
-- объект с меньшим alias; нет правил — запрет.
--
-- Где действуют правила (решение этапа 5): правила арендатора — на строки этого арендатора, правила
-- System — во всех арендаторах. Группа по категориям совпадает по категориям аккаунта (их пишет
-- только системный администратор: строки Account лежат в System); группа по ролям — по ролям членства
-- в рабочем арендаторе и только в правилах этого же арендатора: роль, выданная администратором
-- арендатора, не даёт прав по правилам System. В личном арендаторе (арендатор = аккаунт) роль — owner.
-- Условие на строку — шаблон колонок id, owner, tenant, tags, data, links (вхождение @>), значения
-- "$actor" (он же "$account") и "$tenant" подставляются.
--
-- Политики RLS: строка арендатора сессии видна (и правима) по плану прав; строки Class арендатора и
-- System видны любой сессии; собственная строка Account и собственные членства — самому аккаунту.
-- План прав считается функцией владельца acl_plan() один раз на упоминание таблицы в запросе
-- (подзапрос (select …) PostgreSQL выполняет один раз); на строку — встраиваемая acl_ok().
-- Условие видимости продублировано в row_visible(): по нему функции поиска find_* (70-read.sql) и
-- превью удаления отбирают строки без RLS. Менять оба места вместе; совпадение — тест find-ids-parity.

-- Маска 0.21 → тело регулярного выражения (maskBody, acl.ts:66): {a,b} — альтернативы (рекурсивно),
-- * — хвост из одного и более сегментов, спецсимволы экранируются.
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

-- Шаблон множества "{A,B}" | "!{A,B}" против значений (matchCategories, acl.ts:51): не строка — совпадает.
create or replace function @SCHEMA@.acl_set_ok(p_spec jsonb, p_have text[]) returns boolean
language plpgsql immutable parallel safe
as $$
declare
  s text;
  neg boolean;
  list text[];
begin
  if jsonb_typeof(p_spec) is distinct from 'string' then
    return true;
  end if;
  s := p_spec #>> '{}';
  neg := left(s, 1) = '!';
  s := regexp_replace(regexp_replace(regexp_replace(s, '^!', ''), '^\{', ''), '\}$', '');
  list := array(select btrim(x) from unnest(string_to_array(s, ',')) x where btrim(x) <> '');
  return (list && coalesce(p_have, '{}')) <> neg;
end $$;

-- Группа (Resource ACCOUNT) против субъекта. p_same — правило того же арендатора, что и рабочий:
-- только тогда учитываются роли членства.
create or replace function @SCHEMA@.acl_group_ok(p_pat jsonb, p_cats text[], p_roles text[], p_same boolean) returns boolean
language sql immutable parallel safe
return p_pat is null or jsonb_typeof(p_pat) <> 'object'
    or ((not (p_pat ? 'categories') or @SCHEMA@.acl_set_ok(p_pat->'categories', p_cats))
        and (not (p_pat ? 'roles') or (p_same and @SCHEMA@.acl_set_ok(p_pat->'roles', p_roles))));

-- Объект строк (READ | WRITE | DELETE) против имён класса: класс, предки и их алиасы (matchesRow).
create or replace function @SCHEMA@.acl_class_ok(p_pat jsonb, p_names text[]) returns boolean
language sql immutable parallel safe
return p_pat is null or jsonb_typeof(p_pat) <> 'object' or jsonb_typeof(p_pat->'class') is distinct from 'string'
    or exists (select 1 from unnest(p_names) n where @SCHEMA@.acl_mask_ok(p_pat->>'class', n));

-- Объект API против эндпоинта (matchesApi): нет pattern — все; pattern без строки endpoint — ни один.
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

-- Условие на строку победившего разрешения: шаблон без class с подстановкой; {} — без условия.
create or replace function @SCHEMA@.acl_cond(p_pat jsonb, p_actor uuid, p_tenant uuid) returns jsonb
language sql immutable parallel safe
return case when p_pat is null or jsonb_typeof(p_pat) <> 'object' then '{}'::jsonb
            else @SCHEMA@.acl_subst(p_pat - 'class', p_actor, p_tenant) end;

-- Строка проходит план для политик: класс в списке без условия (p_all) — сразу да, иначе вхождение
-- колонок строки в условие класса (p_plan); класса нет в плане — запрет. Встраиваемая: каждый
-- параметр — один раз (аргументы-подзапросы иначе не дали бы встроить), тело стандартным SQL;
-- объект строки собирается только для классов с условием.
create or replace function @SCHEMA@.acl_ok(p_all text[], p_plan jsonb, p_class text, p_id uuid, p_owner uuid, p_tenant uuid,
  p_tags text[], p_data jsonb, p_links jsonb) returns boolean
language sql stable parallel safe
return p_class = any (p_all)
    or jsonb_build_object('id', p_id, 'owner', p_owner, 'tenant', p_tenant, 'tags', p_tags, 'data', p_data, 'links', p_links)
       @> coalesce(p_plan -> p_class, '[]'::jsonb);

-- То же по одной карте плана — в функциях владельца, где план лежит в переменной (параметр дешёвый,
-- и функция встраивается, хотя план упомянут дважды).
create or replace function @SCHEMA@.acl_row_ok(p_plan jsonb, p_class text, p_id uuid, p_owner uuid, p_tenant uuid,
  p_tags text[], p_data jsonb, p_links jsonb) returns boolean
language sql stable parallel safe
return coalesce(p_plan -> p_class = '{}'::jsonb, false)
    or jsonb_build_object('id', p_id, 'owner', p_owner, 'tenant', p_tenant, 'tags', p_tags, 'data', p_data, 'links', p_links)
       @> coalesce(p_plan -> p_class, '[]'::jsonb);

-- Правила, применимые к субъекту в рабочем арендаторе (System и сам арендатор), с объектами категории
-- p_category; p_system_only — только правила System (права auth.* и letopis.*: их не выдаёт арендатор).
create or replace function @SCHEMA@.acl_rules(p_tenant uuid, p_cats text[], p_roles text[], p_category text, p_system_only boolean)
returns table (id uuid, weight numeric, deny boolean, alias text, pattern jsonb, grp text, code jsonb, message text)
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  -- PL/pgSQL: план запроса кэшируется на сеанс (SQL-функция с set планировала бы его на каждый вызов)
  return query
  select x.id, coalesce((x.data->>'weight')::numeric, 0), coalesce(x.data->>'permission', 'deny') <> 'allow',
         o.data->>'alias', o.data->'pattern', g.data->>'alias', x.data->'code', x.data->>'message'
  from @SCHEMA@.entity x
  join @SCHEMA@.entity g on g.id = (x.links->>'Group')::uuid and g.class = 'Resource'
  join @SCHEMA@.entity o on o.id = (x.links->>'Object')::uuid and o.class = 'Resource'
  where x.class = 'rule'
    and (x.tenant = '@SYSTEM@'::uuid or (not p_system_only and x.tenant = p_tenant))
    and coalesce((x.data->>'enabled')::boolean, true)
    and g.data->>'category' = 'ACCOUNT' and o.data->>'category' = p_category
    and @SCHEMA@.acl_group_ok(g.data->'pattern', p_cats, p_roles, x.tenant = p_tenant);
end $$;

-- План прав субъекта на операцию над строками: { <класс>: <условие> } по всем классам арендатора и
-- System; запрещённых классов в плане нет. Маска класса разбирается один раз на правило: простое имя
-- сравнивается строкой, маска с {…} или * — регулярным выражением (как acl_class_ok).
create or replace function @SCHEMA@.acl_plan_for(p_actor uuid, p_tenant uuid, p_cats text[], p_roles text[], p_op text)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  return (
  with r as (
    select x.*, m.mask, case when m.mask ~ '[{*]' then '^' || @SCHEMA@.acl_mask_re(m.mask) || '$' end as re
    from @SCHEMA@.acl_rules(p_tenant, p_cats, p_roles, p_op, false) x
    cross join lateral (select case when jsonb_typeof(x.pattern) = 'object' and jsonb_typeof(x.pattern->'class') = 'string'
                                    then x.pattern->>'class' end as mask) m
  ), cl as (
    select c.data->>'name' as name, c.data->>'alias' as alias, c.data->'resolved'->'ancestors' as anc
    from @SCHEMA@.entity c
    where c.class = 'Class' and c.tenant in (p_tenant, '@SYSTEM@'::uuid)
  ), k as (
    select cl.name,
           array(select jsonb_array_elements_text(cl.anc))
           || array(select a.alias from cl a where a.alias is not null and cl.anc ? a.name) as names
    from cl
  )
  select coalesce(jsonb_object_agg(k.name, @SCHEMA@.acl_cond(w.pattern, p_actor, p_tenant)), '{}'::jsonb)
  from k
  cross join lateral (
    select r.deny, r.pattern from r
    where r.mask is null
       or (r.re is null and r.mask = any (k.names))
       or (r.re is not null and exists (select 1 from unnest(k.names) n where n ~ r.re))
    order by r.weight desc, r.deny desc, r.alias, r.id
    limit 1) w
  where not w.deny);
end $$;

-- Счётчик изменений прав: строки rule, Resource, member, Account и Class меняют планы прав. Его
-- повышают триггеры после оператора, функции владельца и загрузчик; хранится в строке secret с
-- постоянным id (там же ключ подписи плана). Блокировка строки счётчика упорядочивает изменения прав.
create or replace function @SCHEMA@.acl_bump() returns void
language sql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  update @SCHEMA@.secret s set meta = jsonb_build_object('v', coalesce((s.meta->>'v')::bigint, 0) + 1)
  where s.id = '@SYSTEM@'::uuid and s.kind = 'KEY'
$$;

-- План прав из подписанного пропуска letopis.acl (acl_token) или заново. Пропуск — «подпись.json»:
-- HMAC-SHA256 ключом из secret, в json — счётчик изменений прав v, актор a, арендатор t и планы трёх
-- операций. Подходит, только если подпись верна, актор и арендатор те же, а счётчик не изменился
-- (счётчик и правила читаются одним снимком оператора); иначе план считается заново — пропуск лишь
-- ускоряет, на правильность не влияет. Подделать пропуск без ключа нельзя.
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
      if j->>'v' = coalesce(k.meta->>'v', '0') and j->>'a' = p_actor::text and j->>'t' = p_tenant::text and j ? p_op then
        return j->p_op;
      end if;
    end if;
  end if;
  return @SCHEMA@.acl_plan_for(p_actor, p_tenant, p_cats, p_roles, p_op);
end $$;

-- План прав актора сессии (ctx) на операцию: READ, WRITE или DELETE. Нет сессии — пустой план.
create or replace function @SCHEMA@.acl_plan(p_op text) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  if p_op not in ('READ', 'WRITE', 'DELETE') then
    perform @SCHEMA@.lt_fail('invalid_data', format('операция %s: нужна READ, WRITE или DELETE', p_op));
  end if;
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
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

-- Подписанный пропуск прав актора сессии для letopis.acl: библиотека берёт его один раз на актора и
-- арендатора и передаёт в каждой транзакции, пока не изменятся права (сигнал) или не истечёт срок.
-- Пропуск открывает клиенту его собственный план (классы и условия), но не правила целиком.
-- Нет сессии — null.
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
  if c.account is null then
    return null;
  end if;
  select s.material, s.meta into k from @SCHEMA@.secret s where s.id = '@SYSTEM@'::uuid and s.kind = 'KEY';
  body := jsonb_build_object('v', coalesce(k.meta->>'v', '0'), 'a', c.account, 't', c.tenant,
    'READ', @SCHEMA@.acl_plan_for(c.account, c.tenant, c.categories, c.roles, 'READ'),
    'WRITE', @SCHEMA@.acl_plan_for(c.account, c.tenant, c.categories, c.roles, 'WRITE'),
    'DELETE', @SCHEMA@.acl_plan_for(c.account, c.tenant, c.categories, c.roles, 'DELETE'))::text;
  return encode(@PGCRYPTO@.hmac(convert_to(body, 'UTF8'), k.material, 'sha256'), 'hex') || '.' || body;
end $$;

-- Актор сессии и его план прав на операцию — для функций владельца, которые отбирают строки без RLS
-- (find_*, превью удаления, проверка целей): { tenant, account, plan }; нет сессии — null.
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
    'plan', @SCHEMA@.acl_plan_cached(c.account, c.tenant, c.categories, c.roles, p_op));
end $$;

-- Субъект прав по аккаунту и арендатору без сессии — для загрузчика с опцией as (§2.6, п. 10;
-- функция владельца, приложению не выдана): аккаунт включён и лежит в System, арендатор — сам аккаунт
-- или по членству (как в ctx). Отдаёт категории, роли и планы READ и WRITE.
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
    perform @SCHEMA@.lt_fail('target_not_found', 'аккаунт не найден или отключён');
  end if;
  if p_tenant <> p_account then
    select x.data into m from @SCHEMA@.entity x
    where x.id = @SCHEMA@.v5_id(p_tenant, 'member', array[p_account::text, p_tenant::text]) and x.class = 'member' and x.tenant = p_tenant;
    if m is null or not exists (select 1 from @SCHEMA@.entity e where e.id = p_tenant and e.class = 'Account'
                                and e.tenant = '@SYSTEM@'::uuid and coalesce((e.data->>'enabled')::boolean, true)) then
      perform @SCHEMA@.lt_fail('tenant_denied', 'нет членства в арендаторе');
    end if;
  end if;
  cats := array(select jsonb_array_elements_text(coalesce(a->'categories', '[]'::jsonb)));
  roles := case when p_tenant = p_account then array['owner'] else array(select jsonb_array_elements_text(coalesce(m->'roles', '[]'::jsonb))) end;
  return jsonb_build_object('categories', to_jsonb(cats), 'roles', to_jsonb(roles),
    'read', @SCHEMA@.acl_plan_for(p_account, p_tenant, cats, roles, 'READ'),
    'write', @SCHEMA@.acl_plan_for(p_account, p_tenant, cats, roles, 'WRITE'));
end $$;

-- Решение по эндпоинту API: { allow, rule, code, message } (check 0.21).
create or replace function @SCHEMA@.acl_api_for(p_tenant uuid, p_cats text[], p_roles text[], p_endpoint text, p_system_only boolean)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  return coalesce((
    select case when not w.deny then jsonb_build_object('allow', true, 'rule', w.rule)
                else jsonb_strip_nulls(jsonb_build_object('allow', false, 'rule', w.rule, 'code', w.code, 'message', w.message)) end
    from (
      select r.deny, r.code, r.message,
             jsonb_build_object('id', r.id, 'group', r.grp, 'object', r.alias, 'weight', r.weight,
                                'permission', case when r.deny then 'deny' else 'allow' end) as rule
      from @SCHEMA@.acl_rules(p_tenant, p_cats, p_roles, 'API', p_system_only) r
      where @SCHEMA@.acl_endpoint_ok(r.pattern, p_endpoint)
      order by r.weight desc, r.deny desc, r.alias, r.id
      limit 1) w),
    jsonb_build_object('allow', false, 'message', 'нет подходящего правила (запрет по умолчанию)'));
end $$;

-- db.acl.check(endpoint): решение для актора сессии по правилам System и его арендатора.
create or replace function @SCHEMA@.acl_check(p_endpoint text) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('no_session', 'нет действующей сессии');
  end if;
  return @SCHEMA@.acl_api_for(c.tenant, c.categories, c.roles, p_endpoint, false);
end $$;

-- Внутренняя проверка прав auth.* и letopis.*: только правила System. Отказ — acl_denied.
create or replace function @SCHEMA@.acl_require(p_endpoint text) returns void
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('no_session', 'нет действующей сессии');
  end if;
  if not coalesce((@SCHEMA@.acl_api_for(c.tenant, c.categories, c.roles, p_endpoint, true)->>'allow')::boolean, false) then
    perform @SCHEMA@.lt_fail('acl_denied', format('нет права %s', p_endpoint));
  end if;
end $$;

-- db.acl.checkData(class, op): { allow, filter } для актора сессии.
create or replace function @SCHEMA@.acl_check_data(p_class text, p_op text) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  p jsonb := @SCHEMA@.acl_plan(p_op);
begin
  if not (p ? p_class) then
    return jsonb_build_object('allow', false);
  end if;
  return case when p->p_class = '{}'::jsonb then jsonb_build_object('allow', true)
              else jsonb_build_object('allow', true, 'filter', p->p_class) end;
end $$;

-- Видимость строки для чтения — то же условие, что using политик entity_select и log_select.
-- Отдельная функция, а не выражение политики: аргументы-подзапросы, использованные в теле больше
-- одного раза, не дают PostgreSQL встроить функцию, и политика потеряла бы индексы.
create or replace function @SCHEMA@.row_visible(p_tenant uuid, p_class text, p_id uuid, p_owner uuid, p_tags text[],
  p_data jsonb, p_links jsonb, c_tenant uuid, c_account uuid, c_plan jsonb)
returns boolean
language sql stable parallel safe
return (p_tenant = c_tenant and (p_class = 'Class' or @SCHEMA@.acl_row_ok(c_plan, p_class, p_id, p_owner, p_tenant, p_tags, p_data, p_links)))
    or (p_class = 'Class' and p_tenant = '@SYSTEM@'::uuid and c_account is not null)
    or (p_class = 'Account' and p_id = c_account)
    or (p_class = 'member' and p_links->>'User' = c_account::text);

-- до этапа 5 видимость не зависела от прав
drop function if exists @SCHEMA@.row_visible(uuid, text, uuid, uuid, uuid);

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

-- правка: условие ACL на прежние и на новые значения строки
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

-- ранняя редакция этапа 5: проверка строки по одной карте плана в политиках
drop function if exists @SCHEMA@.acl_ok(jsonb, text, uuid, uuid, uuid, text[], jsonb, jsonb);

do $$
declare f text;
begin
  foreach f in array array[
    'acl_mask_re(text)', 'acl_mask_ok(text, text)', 'acl_set_ok(jsonb, text[])', 'acl_group_ok(jsonb, text[], text[], boolean)',
    'acl_class_ok(jsonb, text[])', 'acl_endpoint_ok(jsonb, text)', 'acl_subst(jsonb, uuid, uuid)', 'acl_cond(jsonb, uuid, uuid)',
    'acl_ok(text[], jsonb, text, uuid, uuid, uuid, text[], jsonb, jsonb)', 'acl_row_ok(jsonb, text, uuid, uuid, uuid, text[], jsonb, jsonb)', 'acl_rules(uuid, text[], text[], text, boolean)',
    'acl_plan_for(uuid, uuid, text[], text[], text)', 'acl_bump()', 'acl_plan_cached(uuid, uuid, text[], text[], text)',
    'acl_plan(text)', 'acl_all(text)', 'acl_token()', 'acl_actor(text)', 'acl_subject(uuid, uuid)', 'acl_api_for(uuid, text[], text[], text, boolean)',
    'acl_check(text)', 'acl_require(text)', 'acl_check_data(text, text)',
    'row_visible(uuid, text, uuid, uuid, text[], jsonb, jsonb, uuid, uuid, jsonb)'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
-- политики вызываются с правами приложения: план прав (функция владельца) и встраиваемая проверка
grant execute on function @SCHEMA@.acl_plan(text), @SCHEMA@.acl_all(text), @SCHEMA@.acl_ok(text[], jsonb, text, uuid, uuid, uuid, text[], jsonb, jsonb),
  @SCHEMA@.acl_check(text), @SCHEMA@.acl_check_data(text, text), @SCHEMA@.acl_token() to @APP@;
