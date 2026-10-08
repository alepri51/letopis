-- letopis 1.0 — идентификаторы v5 и проверка данных по JSON Schema (план, §2.3, §2.6, этап 1, п. 4–5).

-- ========================= v5 =========================
-- id = uuid_v5(арендатор, '["<класс>", "<значение 1>", …]'). Имя собирается одинаково в базе
-- (jsonb-массив в текстовом виде) и в TypeScript (JSON.stringify элементов через «, »);
-- совпадение закрепляет общий файл векторов lib/test/vectors/v5.json.

create or replace function @SCHEMA@.uuid_v5(ns uuid, name text) returns uuid
language sql immutable strict parallel safe
return (
  select encode(
    set_byte(set_byte(b, 6, (get_byte(b, 6) & 15) | 80), 8, (get_byte(b, 8) & 63) | 128),
    'hex')::uuid
  from (select substring(@PGCRYPTO@.digest(uuid_send(ns) || convert_to(name, 'UTF8'), 'sha1') from 1 for 16) as b) s
);

create or replace function @SCHEMA@.v5_name(class text, vals text[]) returns text
language sql immutable strict parallel safe
return (
  select jsonb_agg(x order by i)::text
  from unnest(array[class] || vals) with ordinality as u(x, i)
);

create or replace function @SCHEMA@.v5_id(tenant uuid, class text, vals text[]) returns uuid
language sql immutable strict parallel safe
return @SCHEMA@.uuid_v5(tenant, @SCHEMA@.v5_name(class, vals));

-- ========================= JSON Schema → jsonpath =========================
-- Компилятор переводит JSON Schema класса в список правил. Каждое правило — предикат jsonpath
-- вида  lax !exists(<путь> ? (!(<условие>)))  над документом: «нет узла, нарушающего условие».
-- Условие всегда начинается с проверки типа узла, поэтому развёртывание массивов в режиме lax
-- не даёт строке ["x"] пройти проверку «равно "x"». Значения правил идут переменными ($v1, $v2…),
-- шаблоны и имена полей экранируются как строковые литералы jsonpath (§2.6).
-- То, чего jsonpath не выражает (длина строки, uniqueItems, смысл даты), идёт «дополнительными
-- проверками» — отдельными записями с полем extra; их выполняет validate_data().

create or replace function @SCHEMA@.jp_str(s text) returns text
language sql immutable strict parallel safe
return to_jsonb(s)::text;

-- Перевод шаблона JavaScript в регулярное выражение PostgreSQL (этап 1, п. 5): разбор по символам,
-- как translatePattern в lib/src/jsonschema.ts. \d \w \s и их отрицания — явными наборами (внутри
-- [ ] — без скобок), экранированная обратная косая черта остаётся собой; \b, \p{…}, именованные
-- группы и обратные ссылки отклоняются.
create or replace function @SCHEMA@.jp_pattern(p text) returns text
language plpgsql immutable strict
as $$
declare
  res text := '';
  i int := 1;
  c text;
  n text;
  in_class boolean := false;
  sp constant text := ' \t\n\r\f\v';
  why text;
begin
  while i <= length(p) loop
    c := substr(p, i, 1);
    if c = '\' then
      n := substr(p, i + 1, 1);
      i := i + 2;
      if n = '' then
        why := 'обратная косая черта в конце шаблона';
      elsif n = 'd' then
        res := res || case when in_class then '0-9' else '[0-9]' end;
      elsif n = 'w' then
        res := res || case when in_class then 'A-Za-z0-9_' else '[A-Za-z0-9_]' end;
      elsif n = 's' then
        res := res || case when in_class then sp else '[' || sp || ']' end;
      elsif n in ('D', 'W', 'S') then
        if in_class then
          why := '\' || n || ' внутри набора [ ] не переводится';
        else
          res := res || case n when 'D' then '[^0-9]' when 'W' then '[^A-Za-z0-9_]' else '[^' || sp || ']' end;
        end if;
      elsif n in ('b', 'B') then
        why := '\' || n || ' в PostgreSQL значит другое';
      elsif n in ('p', 'P') then
        why := '\p{…} не поддерживается';
      elsif n = 'k' or n ~ '[1-9]' then
        why := 'обратные ссылки не поддерживаются';
      else
        res := res || c || n;
      end if;
      if why is not null then
        raise exception using errcode = 'LT010', message = 'letopis: invalid_class: шаблон ' || p || ' несовместим с регулярными выражениями PostgreSQL (' || why || ')';
      end if;
      continue;
    end if;
    if not in_class and substr(p, i, 3) = '(?<' and substr(p, i + 3, 1) not in ('=', '!') then
      raise exception using errcode = 'LT010', message = 'letopis: invalid_class: шаблон ' || p || ' несовместим с регулярными выражениями PostgreSQL (именованные группы не поддерживаются)';
    end if;
    if c = '[' and not in_class then
      in_class := true;
    elsif c = ']' and in_class then
      in_class := false;
    end if;
    res := res || c;
    i := i + 1;
  end loop;
  return res;
end $$;

-- Навигация в строгом режиме без ошибок на отсутствующих ключах и чужих типах:
-- в объект — через keyvalue() с фильтром по имени, в массив — только если узел массив.
create or replace function @SCHEMA@.jp_prop(p text, k text) returns text
language sql immutable strict parallel safe
return p || ' ? (@.type() == "object").keyvalue() ? (@.key == ' || @SCHEMA@.jp_str(k) || ').value';

create or replace function @SCHEMA@.jp_items(p text) returns text
language sql immutable strict parallel safe
return p || ' ? (@.type() == "array")[*]';

create or replace function @SCHEMA@.jp_type_cond(t text) returns text
language sql immutable strict parallel safe
return case t
  when 'integer' then '(@.type() == "number" && @ == @.floor())'
  when 'number'  then '@.type() == "number"'
  when 'string'  then '@.type() == "string"'
  when 'boolean' then '@.type() == "boolean"'
  when 'object'  then '@.type() == "object"'
  when 'array'   then '@.type() == "array"'
  when 'null'    then '@.type() == "null"'
end;

-- Рекурсивная компиляция узла. p_path — jsonpath-путь до узла от базы (например $."a"[*]);
-- p_disp — путь для сообщений; p_in_any — внутри anyOf/oneOf (там нельзя дополнительных проверок).
-- Возвращает массив правил {path, keyword, cond, path_expr, vars, extra}.
create or replace function @SCHEMA@.jp_compile(p_schema jsonb, p_path text, p_disp jsonb, p_in_any boolean, inout p_n int, out rules jsonb)
language plpgsql immutable
as $$
declare
  k text;
  v jsonb;
  t text;
  conds text[];
  sub record;
  r jsonb := '[]'::jsonb;
  vname text;
  vars jsonb;
  allowed text[] := array['type','enum','const','minLength','maxLength','pattern','format','minimum','maximum',
    'exclusiveMinimum','exclusiveMaximum','multipleOf','items','minItems','maxItems','uniqueItems','properties',
    'required','additionalProperties','propertyNames','anyOf','oneOf','default','minProperties','maxProperties',
    'title','description','examples','deprecated'];
  tcond text;
  br jsonb;
  bv jsonb;
  alt text[];
  i int;
  j int;
begin
  if p_schema is null or p_schema = 'true'::jsonb or p_schema = '{}'::jsonb then
    rules := r; return;
  end if;
  if jsonb_typeof(p_schema) <> 'object' then
    raise exception using errcode = 'LT010', message = format('letopis: invalid_class: описание узла %s — не объект', p_disp);
  end if;
  for k in select jsonb_object_keys(p_schema) loop
    if not (k = any (allowed) or k like 'x-%') then
      raise exception using errcode = 'LT010', message = format('letopis: invalid_class: ключевое слово %s не поддерживается (узел %s)', k, p_disp);
    end if;
  end loop;

  -- тип: строка или список строк
  if p_schema ? 'type' then
    if jsonb_typeof(p_schema->'type') = 'array' then
      select string_agg(@SCHEMA@.jp_type_cond(x), ' || ') into tcond from jsonb_array_elements_text(p_schema->'type') x;
      tcond := '(' || tcond || ')';
    else
      tcond := @SCHEMA@.jp_type_cond(p_schema->>'type');
    end if;
    if tcond is null then
      raise exception using errcode = 'LT010', message = format('letopis: invalid_class: неизвестный тип в узле %s', p_disp);
    end if;
    r := r || jsonb_build_object('path', p_disp, 'keyword', 'type', 'path_expr', p_path, 'cond', tcond, 'vars', '{}'::jsonb);
  end if;

  -- перечисление и константа: только скаляры внутри jsonpath; объекты и списки — сравнение jsonb
  if p_schema ? 'enum' or p_schema ? 'const' then
    vars := '{}'; conds := '{}';
    for v in select x from jsonb_array_elements(coalesce(p_schema->'enum', jsonb_build_array(p_schema->'const'))) x loop
      if jsonb_typeof(v) in ('object', 'array') then
        if p_in_any then
          raise exception using errcode = 'LT010', message = format('letopis: invalid_class: перечисление объектов внутри anyOf не поддерживается (узел %s)', p_disp);
        end if;
        r := r || jsonb_build_object('path', p_disp, 'keyword', case when p_schema ? 'enum' then 'enum' else 'const' end,
          'path_expr', p_path, 'cond', 'true', 'vars', '{}'::jsonb, 'extra', jsonb_build_object('kind', 'enum', 'values', coalesce(p_schema->'enum', jsonb_build_array(p_schema->'const'))));
        conds := null; exit;
      end if;
      p_n := p_n + 1; vname := 'v' || p_n;
      vars := vars || jsonb_build_object(vname, v);
      conds := conds || format('(@.type() == %s && @ == $%s)', @SCHEMA@.jp_str(case jsonb_typeof(v) when 'number' then 'number' when 'string' then 'string' when 'boolean' then 'boolean' else 'null' end), vname);
    end loop;
    -- пустое перечисление не пропускает ничего: условие «узла нет» ложно для любого узла
    if conds is not null then
      r := r || jsonb_build_object('path', p_disp, 'keyword', case when p_schema ? 'enum' then 'enum' else 'const' end,
        'path_expr', p_path, 'cond', case when cardinality(conds) = 0 then '!exists(@)' else '(' || array_to_string(conds, ' || ') || ')' end, 'vars', vars);
    end if;
  end if;

  -- числовые границы
  foreach k in array array['minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf'] loop
    if p_schema ? k then
      p_n := p_n + 1; vname := 'v' || p_n;
      r := r || jsonb_build_object('path', p_disp, 'keyword', k, 'path_expr', p_path, 'vars', jsonb_build_object(vname, p_schema->k),
        'cond', '(@.type() != "number" || ' || case k
          when 'minimum' then '@ >= $' || vname
          when 'maximum' then '@ <= $' || vname
          when 'exclusiveMinimum' then '@ > $' || vname
          when 'exclusiveMaximum' then '@ < $' || vname
          else '(@ / $' || vname || ') == (@ / $' || vname || ').floor()' end || ')');
    end if;
  end loop;

  -- строки
  if p_schema ? 'pattern' then
    r := r || jsonb_build_object('path', p_disp, 'keyword', 'pattern', 'path_expr', p_path, 'vars', '{}'::jsonb,
      'cond', '(@.type() != "string" || @ like_regex ' || @SCHEMA@.jp_str(@SCHEMA@.jp_pattern(p_schema->>'pattern')) || ')');
  end if;
  if p_schema ? 'format' then
    t := p_schema->>'format';
    r := r || jsonb_build_object('path', p_disp, 'keyword', 'format', 'path_expr', p_path, 'vars', '{}'::jsonb,
      'cond', '(@.type() != "string" || @ like_regex ' || @SCHEMA@.jp_str(case t
        when 'uuid' then '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        when 'date' then '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        when 'date-time' then '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
        when 'email' then '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
        else null end) || ')');
    if t not in ('uuid', 'date', 'date-time', 'email') then
      raise exception using errcode = 'LT010', message = format('letopis: invalid_class: format %s не поддерживается (узел %s)', t, p_disp);
    end if;
    if t in ('date', 'date-time') then
      if p_in_any then
        raise exception using errcode = 'LT010', message = format('letopis: invalid_class: format %s внутри anyOf не поддерживается (узел %s)', t, p_disp);
      end if;
      r := r || jsonb_build_object('path', p_disp, 'keyword', 'format', 'path_expr', p_path, 'cond', 'true', 'vars', '{}'::jsonb,
        'extra', jsonb_build_object('kind', 'date', 'type', case t when 'date' then 'date' else 'timestamptz' end));
    end if;
  end if;
  if p_schema ? 'minLength' or p_schema ? 'maxLength' then
    if p_in_any then
      raise exception using errcode = 'LT010', message = format('letopis: invalid_class: длина строки внутри anyOf не поддерживается (узел %s)', p_disp);
    end if;
    r := r || jsonb_build_object('path', p_disp, 'keyword', case when p_schema ? 'minLength' then 'minLength' else 'maxLength' end,
      'path_expr', p_path, 'cond', 'true', 'vars', '{}'::jsonb,
      'extra', jsonb_build_object('kind', 'length', 'min', p_schema->'minLength', 'max', p_schema->'maxLength'));
  end if;

  -- массивы
  foreach k in array array['minItems','maxItems'] loop
    if p_schema ? k then
      p_n := p_n + 1; vname := 'v' || p_n;
      r := r || jsonb_build_object('path', p_disp, 'keyword', k, 'path_expr', p_path, 'vars', jsonb_build_object(vname, p_schema->k),
        'cond', '(@.type() != "array" || @.size() ' || case k when 'minItems' then '>=' else '<=' end || ' $' || vname || ')');
    end if;
  end loop;
  if coalesce((p_schema->>'uniqueItems')::boolean, false) then
    if p_in_any then
      raise exception using errcode = 'LT010', message = format('letopis: invalid_class: uniqueItems внутри anyOf не поддерживается (узел %s)', p_disp);
    end if;
    r := r || jsonb_build_object('path', p_disp, 'keyword', 'uniqueItems', 'path_expr', p_path, 'cond', 'true', 'vars', '{}'::jsonb,
      'extra', jsonb_build_object('kind', 'unique'));
  end if;
  if p_schema ? 'items' then
    select c.p_n, c.rules into p_n, v from @SCHEMA@.jp_compile(p_schema->'items', @SCHEMA@.jp_items(p_path), p_disp || '"*"'::jsonb, p_in_any, p_n) c;
    r := r || v;
  end if;

  -- объекты
  if p_schema ? 'required' then
    for k in select jsonb_array_elements_text(p_schema->'required') loop
      r := r || jsonb_build_object('path', p_disp || to_jsonb(k), 'keyword', 'required', 'path_expr', p_path, 'vars', '{}'::jsonb,
        'cond', '(@.type() != "object" || exists(@.keyvalue() ? (@.key == ' || @SCHEMA@.jp_str(k) || ')))');
    end loop;
  end if;
  if p_schema ? 'minProperties' or p_schema ? 'maxProperties' then
    if p_in_any then
      raise exception using errcode = 'LT010', message = format('letopis: invalid_class: minProperties внутри anyOf не поддерживается (узел %s)', p_disp);
    end if;
    r := r || jsonb_build_object('path', p_disp, 'keyword', case when p_schema ? 'minProperties' then 'minProperties' else 'maxProperties' end,
      'path_expr', p_path, 'cond', 'true', 'vars', '{}'::jsonb,
      'extra', jsonb_build_object('kind', 'props', 'min', p_schema->'minProperties', 'max', p_schema->'maxProperties'));
  end if;
  if p_schema ? 'properties' then
    for sub in select key, value from jsonb_each(p_schema->'properties') loop
      select c.p_n, c.rules into p_n, v
        from @SCHEMA@.jp_compile(sub.value, @SCHEMA@.jp_prop(p_path, sub.key), p_disp || to_jsonb(sub.key), p_in_any, p_n) c;
      r := r || v;
    end loop;
  end if;
  if p_schema ? 'additionalProperties' then
    v := p_schema->'additionalProperties';
    if v = 'false'::jsonb then
      select string_agg('@.key == ' || @SCHEMA@.jp_str(x), ' || ') into t from jsonb_object_keys(coalesce(p_schema->'properties', '{}')) x;
      r := r || jsonb_build_object('path', p_disp, 'keyword', 'additionalProperties', 'path_expr', p_path, 'vars', '{}'::jsonb,
        'cond', case when t is null then '(@.type() != "object" || !exists(@.keyvalue()))'
                     else '(@.type() != "object" || !exists(@.keyvalue() ? (!(' || t || '))))' end);
    elsif jsonb_typeof(v) = 'object' then
      -- значения прочих ключей проверяются схемой additionalProperties
      select string_agg('@.key != ' || @SCHEMA@.jp_str(x), ' && ') into t from jsonb_object_keys(coalesce(p_schema->'properties', '{}')) x;
      select c.p_n, c.rules into p_n, v
        from @SCHEMA@.jp_compile(v, p_path || ' ? (@.type() == "object").keyvalue() ? (' || coalesce(t, 'exists(@)') || ').value', p_disp || '"*"'::jsonb, p_in_any, p_n) c;
      r := r || v;
    end if;
  end if;
  if p_schema ? 'propertyNames' then
    select c.p_n, c.rules into p_n, v
      from @SCHEMA@.jp_compile(p_schema->'propertyNames' || '{"type": "string"}', p_path || ' ? (@.type() == "object").keyvalue().key', p_disp || '"<ключ>"'::jsonb, p_in_any, p_n) c;
    r := r || v;
  end if;

  -- anyOf и oneOf: каждая ветка — конъюнкция её правил относительно узла @
  foreach k in array array['anyOf', 'oneOf'] loop
    if p_schema ? k then
      alt := '{}';
      vars := '{}';
      for bv in select x from jsonb_array_elements(p_schema->k) x loop
        select c.p_n, c.rules into p_n, br from @SCHEMA@.jp_compile(bv, '@', p_disp, true, p_n) c;
        -- ветка без правил принимает любой узел; в фильтре jsonpath нужно условие, а не значение true
        select coalesce(string_agg(format('!exists(%s ? (!(%s)))', e->>'path_expr', e->>'cond'), ' && '), 'exists(@)')
          into t from jsonb_array_elements(br) e;
        alt := alt || ('(' || t || ')');
        vars := vars || coalesce((select jsonb_object_agg(kv.key, kv.value) from jsonb_array_elements(br) e2, jsonb_each(e2->'vars') kv), '{}');
      end loop;
      t := array_to_string(alt, ' || ');
      if k = 'oneOf' then
        for i in 1 .. cardinality(alt) loop
          for j in i + 1 .. cardinality(alt) loop
            t := t || ') && !(' || alt[i] || ' && ' || alt[j];
          end loop;
        end loop;
      end if;
      r := r || jsonb_build_object('path', p_disp, 'keyword', k, 'path_expr', p_path, 'vars', vars, 'cond', '((' || t || '))');
    end if;
  end loop;
  rules := r;
end $$;

-- Компиляция описания класса: правила и общее выражение validator (одно на класс, §2.6).
create or replace function @SCHEMA@.compile_validator(p_schema jsonb, out rules jsonb, out validator jsonpath, out vars jsonb)
language plpgsql immutable
as $$
declare
  n int := 0;
  expr text;
begin
  select c.rules into rules from @SCHEMA@.jp_compile(p_schema, '$', '[]'::jsonb, false, n) c;
  select coalesce(string_agg(format('!exists(%s ? (!(%s)))', e->>'path_expr', e->>'cond'), ' && ') filter (where e->>'cond' <> 'true'), 'true'),
         coalesce((select jsonb_object_agg(kv.key, kv.value) from jsonb_array_elements(rules) e2, jsonb_each(e2->'vars') kv), '{}')
    into expr, vars
    from jsonb_array_elements(rules) e;
  validator := ('strict ' || expr)::jsonpath;
end $$;

-- Проверка данных: общий вызов jsonb_path_match; при отказе — список нарушений по правилам.
-- Результат сравнивается через is true: ошибка внутри выражения даёт NULL, а не «да» (этап 1, п. 5).
create or replace function @SCHEMA@.validate_data(p_rules jsonb, p_validator jsonpath, p_vars jsonb, p_data jsonb) returns jsonb
language plpgsql stable
as $$
declare
  e jsonb;
  bad jsonb := '[]'::jsonb;
  ok boolean;
  x jsonb;
begin
  ok := jsonb_path_match(p_data, p_validator, p_vars, true) is true;
  if ok and not exists (select 1 from jsonb_array_elements(p_rules) r where r ? 'extra') then
    return bad;
  end if;
  for e in select value from jsonb_array_elements(p_rules) loop
    if e ? 'extra' then
      for x in select * from jsonb_path_query(p_data, ('strict ' || (e->>'path_expr'))::jsonpath, '{}'::jsonb, true) loop
        if (e->'extra'->>'kind') = 'length' and jsonb_typeof(x) = 'string' then
          if char_length(x #>> '{}') < coalesce((e->'extra'->>'min')::int, 0)
             or char_length(x #>> '{}') > coalesce((e->'extra'->>'max')::int, 2147483647) then
            bad := bad || jsonb_build_object('path', e->'path', 'keyword', e->>'keyword', 'message', 'длина строки вне границ');
          end if;
        elsif (e->'extra'->>'kind') = 'unique' and jsonb_typeof(x) = 'array' then
          if (select count(*) from jsonb_array_elements(x)) <> (select count(distinct y) from jsonb_array_elements(x) y) then
            bad := bad || jsonb_build_object('path', e->'path', 'keyword', 'uniqueItems', 'message', 'элементы повторяются');
          end if;
        elsif (e->'extra'->>'kind') = 'date' and jsonb_typeof(x) = 'string' then
          if not pg_input_is_valid(x #>> '{}', e->'extra'->>'type') then
            bad := bad || jsonb_build_object('path', e->'path', 'keyword', 'format', 'message', 'такой даты не бывает');
          end if;
        elsif (e->'extra'->>'kind') = 'props' and jsonb_typeof(x) = 'object' then
          if (select count(*) from jsonb_object_keys(x)) < coalesce((e->'extra'->>'min')::int, 0)
             or (select count(*) from jsonb_object_keys(x)) > coalesce((e->'extra'->>'max')::int, 2147483647) then
            bad := bad || jsonb_build_object('path', e->'path', 'keyword', e->>'keyword', 'message', 'число ключей вне границ');
          end if;
        elsif (e->'extra'->>'kind') = 'enum' then
          if not exists (select 1 from jsonb_array_elements(e->'extra'->'values') y where y = x) then
            bad := bad || jsonb_build_object('path', e->'path', 'keyword', e->>'keyword', 'message', 'значение не из перечисления');
          end if;
        end if;
      end loop;
    elsif not ok then
      if jsonb_path_match(p_data, ('strict !exists(' || (e->>'path_expr') || ' ? (!(' || (e->>'cond') || ')))')::jsonpath, e->'vars', true) is not true then
        bad := bad || jsonb_build_object('path', e->'path', 'keyword', e->>'keyword', 'message', 'нарушено правило ' || (e->>'keyword'));
      end if;
    end if;
  end loop;
  if not ok and bad = '[]'::jsonb then
    bad := jsonb_build_array(jsonb_build_object('path', '[]'::jsonb, 'keyword', 'schema', 'message', 'данные не проходят описание'));
  end if;
  return bad;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'uuid_v5(uuid, text)', 'v5_name(text, text[])', 'v5_id(uuid, text, text[])', 'jp_str(text)', 'jp_pattern(text)',
    'jp_type_cond(text)', 'jp_prop(text, text)', 'jp_items(text)', 'jp_compile(jsonb, text, jsonb, boolean, int)', 'compile_validator(jsonb)',
    'validate_data(jsonb, jsonpath, jsonb, jsonb)'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
grant execute on function @SCHEMA@.uuid_v5(uuid, text), @SCHEMA@.v5_name(text, text[]), @SCHEMA@.v5_id(uuid, text, text[]) to @APP@;
