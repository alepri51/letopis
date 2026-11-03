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
--   history   true | false — вести ли журнал версий
--   ownerDefault 'tenant' | 'actor';  cache { ttl };  meta {…} до 64 КБ
--   resolved  развёрнутое описание с учётом предков — пишет триггер, присланное значение перезаписывается
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
    "history": {"type": "boolean"},
    "ownerDefault": {"type": "string", "enum": ["tenant", "actor"]},
    "cache": {"type": "object"},
    "meta": {"type": "object"},
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

-- Строка класса по имени: собственная строка арендатора, иначе системная. Поиск — по индексу
-- entity_class_name, без вычисления v5 (два SHA-1 стоили 30 мкс на поиск, а запись ищет описание
-- несколько раз). Пара «арендатор, имя» однозначна: id строки Class — v5 от имени. Порядок важен:
-- арендатор не заведёт класс с именем уже существующего класса System (class_admit,
-- system_name_taken), но класс System может появиться позже одноимённого класса арендатора — тогда
-- строк две, и действует собственная (атака №54 в engine-attacks). Нет строки — null.
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
    'meta', meta);
end $$;

-- Проверка описания класса: метасхема, правила ключа (§2.3), правило unset (§2.10), размер meta, журнал системных классов.
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
  -- журнал системных классов — аудит прав и схемы: его не выключают
  if coalesce((data->>'system')::boolean, false) and res->'history' = 'false'::jsonb then
    perform @SCHEMA@.lt_fail('sql-core.system_history_off');
  end if;
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
