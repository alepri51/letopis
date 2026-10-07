-- letopis 1.0 — идентификаторы v5 (план, §2.3, этап 1, п. 4).
-- id = uuid_v5(арендатор, '["<класс>", "<значение 1>", …]'). Имя собирается одинаково в базе
-- (jsonb_build_array(...)::text) и в TypeScript (JSON.stringify элементов через «, »);
-- совпадение закрепляет общий файл векторов lib/test/vectors/v5.json.
-- Компилятор JSON Schema в jsonpath дописывается в этот файл (этап 1, п. 5).

-- UUID версии 5 по RFC 9562: SHA-1 от байтов пространства имён и имени в UTF-8.
create or replace function @SCHEMA@.uuid_v5(ns uuid, name text) returns uuid
language sql immutable strict parallel safe
return (
  select encode(
    set_byte(set_byte(b, 6, (get_byte(b, 6) & 15) | 80), 8, (get_byte(b, 8) & 63) | 128),
    'hex')::uuid
  from (select substring(@PGCRYPTO@.digest(uuid_send(ns) || convert_to(name, 'UTF8'), 'sha1') from 1 for 16) as b) s
);

-- Имя v5: JSON-массив из имени класса и значений ключа в объявленном порядке.
create or replace function @SCHEMA@.v5_name(class text, vals text[]) returns text
language sql immutable strict parallel safe
return (
  select jsonb_agg(x order by i)::text
  from unnest(array[class] || vals) with ordinality as u(x, i)
);

create or replace function @SCHEMA@.v5_id(tenant uuid, class text, vals text[]) returns uuid
language sql immutable strict parallel safe
return @SCHEMA@.uuid_v5(tenant, @SCHEMA@.v5_name(class, vals));

alter function @SCHEMA@.uuid_v5(uuid, text) owner to @OWNER@;
alter function @SCHEMA@.v5_name(text, text[]) owner to @OWNER@;
alter function @SCHEMA@.v5_id(uuid, text, text[]) owner to @OWNER@;
revoke all on function @SCHEMA@.uuid_v5(uuid, text), @SCHEMA@.v5_name(text, text[]), @SCHEMA@.v5_id(uuid, text, text[]) from public;
grant execute on function @SCHEMA@.uuid_v5(uuid, text), @SCHEMA@.v5_name(text, text[]), @SCHEMA@.v5_id(uuid, text, text[]) to @APP@;
