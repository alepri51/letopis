-- letopis 1.0 — классы как сущности (план, §2.2, §2.3, §2.13, этап 1, п. 6).
--
-- Описание класса — данные строки класса Class (метасхема ниже — договор базы и библиотеки):
--   name      имя класса (ключ строки Class); после появления строк класса не меняется
--   kind      'hub' | 'link'
--   parent    имя предка или null
--   abstract  строк класса нет, только у потомков
--   alias     имя для людей
--   fields    JSON Schema собственных полей: { properties, required[, anyOf | oneOf] } — условия по
--             нескольким полям (anyOf, oneOf) потомок заменяет целиком, как поле
--   ends      { <роль>: { class: <класс> | [<класс>…], many, required, min, max, onDelete, meta } }
--   key       [<поле или роль>…] — из них вычисляется id (§2.3); [] — класс без ключа
--   history   true | false | политика хранения (§2.11)
--   ownerDefault 'tenant' | 'actor';  cache { ttl };  meta {…} до 64 КБ
--   derivedBy имя проектора (план 1.1, §2.4): строки класса пишет только он; наследуется, потомок не меняет
--   aggregate { <поле>: { sum: <поле источника> | count: true, of: <класс-источник>, via: <роль>, where?: JSON Schema } }
--             агрегаты в базе (план 1.1, §2.4): поле держит триггер по живым строкам источника; наследуется,
--             потомок заменяет целиком
--   resolved  развёрнутое описание с учётом предков — пишет триггер, присланное значение перезаписывается; у
--             источника агрегатов в нём ещё метка aggregatedBy — какие цели считают его строки (88-derived.sql)
-- Скомпилированная проверка данных класса лежит в колонке validator строки Class.

create or replace function @SCHEMA@.class_metaschema() returns jsonb
language sql immutable parallel safe
return $json${
  "type": "object",
  "required": ["name", "kind"],
  "additionalProperties": false,
  "properties": {
    "name": {"type": "string", "pattern": "^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]{0,62}$"},
    "kind": {"type": "string", "enum": ["hub", "link"]},
    "parent": {"type": ["string", "null"]},
    "abstract": {"type": "boolean"},
    "alias": {"type": ["string", "null"]},
    "system": {"type": "boolean"},
    "fields": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "properties": {"type": "object", "propertyNames": {"type": "string", "pattern": "^[^$]"}},
        "required": {"type": "array", "items": {"type": "string"}, "uniqueItems": true},
        "anyOf": {"type": "array", "minItems": 1, "items": {"type": "object"}},
        "oneOf": {"type": "array", "minItems": 1, "items": {"type": "object"}}
      }
    },
    "ends": {
      "type": "object",
      "propertyNames": {"type": "string", "pattern": "^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]{0,62}$"},
      "additionalProperties": {
        "type": "object",
        "required": ["class"],
        "additionalProperties": false,
        "properties": {
          "class": {"anyOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}, "minItems": 1}]},
          "many": {"type": "boolean"},
          "required": {"type": "boolean"},
          "min": {"type": "integer", "minimum": 0},
          "max": {"type": "integer", "minimum": 1},
          "onDelete": {"type": "string", "enum": ["restrict", "cascade", "unset"]},
          "meta": {"type": "object"}
        }
      }
    },
    "key": {"type": "array", "items": {"type": "string"}, "uniqueItems": true},
    "history": {"anyOf": [{"type": "boolean"}, {
      "type": "object",
      "additionalProperties": false,
      "required": ["all"],
      "properties": {
        "all": {"type": "string"}, "daily": {"type": "string"}, "weekly": {"type": "string"},
        "monthly": {"type": "string"}, "yearly": {"type": "string"}, "tz": {"type": "string"}
      }
    }]},
    "ownerDefault": {"type": "string", "enum": ["tenant", "actor"]},
    "cache": {"type": "object"},
    "meta": {"type": "object"},
    "derivedBy": {"type": "string", "pattern": "^[a-z0-9][a-z0-9_.:-]{0,63}$"},
    "aggregate": {
      "type": "object",
      "propertyNames": {"type": "string", "pattern": "^[^$]"},
      "additionalProperties": {
        "type": "object",
        "required": ["of", "via"],
        "additionalProperties": false,
        "properties": {
          "sum": {"type": "string", "pattern": "^[^$]"},
          "count": {"type": "boolean", "enum": [true]},
          "of": {"type": "string", "pattern": "^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]{0,62}$"},
          "via": {"type": "string", "pattern": "^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]{0,62}$"},
          "where": {"type": "object"}
        }
      }
    },
    "resolved": {"type": "object"}
  }
}$json$::jsonb;

-- Скомпилированная метасхема — один раз на сеанс не нужна: функция immutable, планировщик кэширует.
create or replace function @SCHEMA@.class_meta_validator(out rules jsonb, out validator jsonpath, out vars jsonb)
language plpgsql immutable
as $$
begin
  select c.rules, c.validator, c.vars into rules, validator, vars from @SCHEMA@.compile_validator(@SCHEMA@.class_metaschema()) c;
end $$;

-- Строка класса по имени: собственная строка арендатора или системная. Поиск — по индексу
-- entity_class_name, без вычисления v5 (два SHA-1 стоили 30 мкс на поиск, а запись ищет описание
-- несколько раз). Пара «арендатор, имя» однозначна: id строки Class — v5 от имени. Имя
-- пользовательского класса не совпадает с именем системного (проверка при определении), поэтому
-- порядок нужен только для ясности. Нет строки — null.
create or replace function @SCHEMA@.class_row(p_name text, p_tenant uuid) returns @SCHEMA@.entity
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  select e.* from @SCHEMA@.entity e
  where e.class = 'Class' and e.data->>'name' = p_name and e.tenant in (p_tenant, '@SYSTEM@'::uuid)
  order by e.tenant = '@SYSTEM@'::uuid
  limit 1
$$;

-- Развёрнутое описание класса с учётом предков: поля, концы и ключ наследуются по правилу 0.21
-- «потомок заменяет поле целиком» (buildDef), метаданные — по ключам, null убирает ключ (§2.13).
create or replace function @SCHEMA@.class_resolve(p_data jsonb, p_tenant uuid) returns jsonb
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  chain jsonb[] := array[p_data];
  cur jsonb := p_data;
  names text[] := array[p_data->>'name'];
  props jsonb := '{}';
  req jsonb := '[]';
  ends jsonb := '{}';
  meta jsonb := '{}';
  key jsonb;
  hist jsonb;
  od text;
  cache jsonb;
  der text;
  agg jsonb;
  comp jsonb := '{}';
  i int;
  v jsonb;
  m record;
begin
  while cur->>'parent' is not null loop
    cur := (@SCHEMA@.class_row(cur->>'parent', p_tenant)).data;
    if cur is null then
      perform @SCHEMA@.lt_fail('sql-core.parent_not_found', jsonb_build_object('parent', chain[cardinality(chain)]->>'parent'));
    end if;
    if cur->>'name' = any (names) then
      perform @SCHEMA@.lt_fail('sql-core.inheritance_cycle', jsonb_build_object('cls', cur->>'name'));
    end if;
    names := names || (cur->>'name');
    chain := chain || cur;
  end loop;
  -- от корня к самому классу: потомок поверх предка
  for i in reverse cardinality(chain) .. 1 loop
    v := chain[i];
    props := props || coalesce(v->'fields'->'properties', '{}');
    req := (select coalesce(jsonb_agg(distinct x), '[]') from jsonb_array_elements_text(req || coalesce(v->'fields'->'required', '[]')) x);
    ends := ends || coalesce(v->'ends', '{}');
    if v->'fields' ? 'anyOf' or v->'fields' ? 'oneOf' then
      comp := jsonb_strip_nulls(jsonb_build_object('anyOf', v->'fields'->'anyOf', 'oneOf', v->'fields'->'oneOf'));
    end if;
    if v ? 'key' then key := v->'key'; end if;
    if v ? 'history' then hist := v->'history'; end if;
    if v ? 'ownerDefault' then od := v->>'ownerDefault'; end if;
    if v ? 'cache' then cache := v->'cache'; end if;
    -- производный класс (план 1.1, §2.4): проектор задаёт предок, потомок его не меняет
    if v ? 'derivedBy' then
      if der is not null and der <> v->>'derivedBy' then
        perform @SCHEMA@.lt_fail('sql-core.derived_by_mismatch',
          jsonb_build_object('cls', v->>'name', 'derivedBy', v->>'derivedBy', 'inherited', der));
      end if;
      der := v->>'derivedBy';
    end if;
    -- агрегаты (план 1.1, §2.4): потомок заменяет описание предка целиком, {} — снимает унаследованное
    if v ? 'aggregate' then agg := v->'aggregate'; end if;
    for m in select * from jsonb_each(coalesce(v->'meta', '{}')) loop
      if m.value = 'null'::jsonb then meta := meta - m.key; else meta := meta || jsonb_build_object(m.key, m.value); end if;
    end loop;
  end loop;
  return jsonb_build_object(
    'name', p_data->>'name',
    'kind', p_data->>'kind',
    'abstract', coalesce((p_data->>'abstract')::boolean, false),
    'ancestors', to_jsonb(names),
    'schema', jsonb_build_object('type', 'object', 'properties', props, 'required', req, 'additionalProperties', false) || comp,
    'ends', ends,
    'key', coalesce(key, '[]'),
    'history', coalesce(hist, 'true'),
    'ownerDefault', coalesce(od, 'tenant'),
    'cache', cache,
    -- ключи только у производных и у целей агрегатов: у описаний до 1.2 их нет, и сравнение «было — стало» их не задевает
    'meta', meta) || case when der is not null then jsonb_build_object('derivedBy', der) else '{}'::jsonb end
                  || case when agg is not null and agg <> '{}'::jsonb then jsonb_build_object('aggregate', agg) else '{}'::jsonb end;
end $$;

-- Проверка описания класса: метасхема, правила ключа (§2.3), правило unset (§2.10), размер meta.
-- Возвращает строку с заполненными resolved и validator.
create or replace function @SCHEMA@.class_prepare(p_data jsonb, p_tenant uuid, out data jsonb, out validator jsonpath)
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  ms record;
  bad jsonb;
  res jsonb;
  k text;
  fld jsonb;
  e record;
  c record;
  prev interval;
  tiers text[];
  i int;
begin
  data := p_data - 'resolved';
  select * into ms from @SCHEMA@.class_meta_validator();
  bad := @SCHEMA@.validate_data(ms.rules, ms.validator, ms.vars, data);
  if bad <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('sql-core.class_metaschema', '{}'::jsonb, jsonb_build_object('issues', bad));
  end if;
  if octet_length(coalesce(data->'meta', '{}')::text) > 65536 then
    perform @SCHEMA@.lt_fail('sql-core.meta_too_large');
  end if;
  res := @SCHEMA@.class_resolve(data, p_tenant);
  -- ключ: только обязательные строковые поля и обязательные одиночные концы
  for k in select jsonb_array_elements_text(res->'key') loop
    fld := res->'schema'->'properties'->k;
    if fld is not null then
      if not (res->'schema'->'required' ? k) or coalesce(fld->>'type', '') <> 'string' then
        perform @SCHEMA@.lt_fail('sql-core.key_field_type', jsonb_build_object('field', k));
      end if;
    elsif res->'ends' ? k then
      if coalesce((res->'ends'->k->>'many')::boolean, false) or not coalesce((res->'ends'->k->>'required')::boolean, false) then
        perform @SCHEMA@.lt_fail('sql-core.key_end_type', jsonb_build_object('end', k));
      end if;
    else
      perform @SCHEMA@.lt_fail('sql-core.key_unknown_name', jsonb_build_object('name', k));
    end if;
  end loop;
  -- unset — только для необязательного одиночного конца и множественного без min
  for e in select key, value from jsonb_each(res->'ends') loop
    if e.value->>'onDelete' = 'unset' and (coalesce((e.value->>'required')::boolean, false) or coalesce((e.value->>'min')::int, 0) > 0) then
      perform @SCHEMA@.lt_fail('sql-core.unset_required_end', jsonb_build_object('end', e.key));
    end if;
  end loop;
  -- политика хранения: для системных классов запрещена (§2.11)
  if coalesce((data->>'system')::boolean, false) and jsonb_typeof(res->'history') <> 'boolean' then
    perform @SCHEMA@.lt_fail('sql-core.system_history_policy');
  end if;
  if coalesce((data->>'system')::boolean, false) and res->'history' = 'false'::jsonb then
    perform @SCHEMA@.lt_fail('sql-core.system_history_off');
  end if;
  -- политика хранения (§2.11): сроки ярусов по возрастанию, all не меньше суток, 'forever' — только последний
  if jsonb_typeof(res->'history') = 'object' then
    prev := interval '0';
    tiers := array(select u.tn from unnest(array['all', 'daily', 'weekly', 'monthly', 'yearly']) with ordinality u(tn, ord)
                   where res->'history' ? u.tn order by u.ord);
    for i in 1 .. cardinality(tiers) loop
      k := res->'history'->>tiers[i];
      if k = 'forever' then
        if i <> cardinality(tiers) then
          perform @SCHEMA@.lt_fail('sql-core.history_forever_not_last', jsonb_build_object('tier', tiers[i]));
        end if;
      elsif not pg_input_is_valid(k, 'interval') then
        perform @SCHEMA@.lt_fail('sql-core.history_tier_unparsable', jsonb_build_object('tier', tiers[i], 'value', k));
      elsif k::interval <= prev then
        perform @SCHEMA@.lt_fail('sql-core.history_tiers_order', jsonb_build_object('tier', tiers[i]));
      else
        prev := k::interval;
      end if;
    end loop;
    if (res->'history'->>'all') <> 'forever' and (res->'history'->>'all')::interval < interval '1 day' then
      perform @SCHEMA@.lt_fail('sql-core.history_all_min_day');
    end if;
    if res->'history' ? 'tz' and not exists (select 1 from pg_timezone_names where name = res->'history'->>'tz') then
      perform @SCHEMA@.lt_fail('sql-core.history_unknown_tz', jsonb_build_object('tz', res->'history'->>'tz'));
    end if;
  end if;
  -- производный класс (план 1.1, §2.4): системным не бывает; его строки проектор удаляет и строит заново,
  -- поэтому они не мешают удалять строки, на которые ссылаются (onDelete только cascade или unset)
  if res ? 'derivedBy' then
    if coalesce((data->>'system')::boolean, false) then
      perform @SCHEMA@.lt_fail('sql-core.system_derived');
    end if;
    for e in select key, value from jsonb_each(res->'ends') loop
      if coalesce(e.value->>'onDelete', 'restrict') not in ('cascade', 'unset') then
        perform @SCHEMA@.lt_fail('sql-core.derived_end_on_delete', jsonb_build_object('end', e.key));
      end if;
    end loop;
  end if;
  -- агрегаты (план 1.1, §2.4; 88-derived.sql): цель — поля, источники, цикл, условия where; источник — метка
  -- aggregatedBy и та же сверка против агрегатов, которые считают его строки (источник часто описывают после цели)
  if res ? 'aggregate' then
    res := @SCHEMA@.agg_prepare(res, data, p_tenant);
  end if;
  res := @SCHEMA@.agg_source(res, p_tenant);
  select * into c from @SCHEMA@.compile_validator(res->'schema');
  data := data || jsonb_build_object('resolved', res || jsonb_build_object('rules', c.rules, 'vars', c.vars));
  validator := c.validator;
end $$;

do $$
declare f text;
begin
  foreach f in array array['class_metaschema()', 'class_meta_validator()', 'class_row(text, uuid)',
    'class_resolve(jsonb, uuid)', 'class_prepare(jsonb, uuid)'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
