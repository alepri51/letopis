-- =============================================================================
-- Сид таблицы Schema — ИСТОЧНИК ПРАВДЫ демо-домена booking (20 классов: 12 HUB + 8 LINK).
-- Редактируется руками; накат: db/apply.mjs / up() (маркер <SCHEMA-NAME>).
-- Идемпотентен (ON CONFLICT). Концы связей — Schema.links v2 (JSON-объекты в text[]).
-- =============================================================================
--
-- FILE: lib/sql/seed.booking.sql
-- VERSION: 1.0.1
-- START_MODULE_CONTRACT
--   PURPOSE: Идемпотентный сид таблицы Schema — источник правды демо-домена booking (классы HUB + LINK).
--   SCOPE: 20 INSERT-ов классов (12 HUB: Entity/Org/Person/Staff/Customer/Location/Element/Service/Product/Complex/Schedule/Folder; 8 LINK: link/address/slot/booking/content/compo/skill/price).
--   DEPENDS: none
--   LINKS: M-SEED-BOOKING, V-M-SEED-BOOKING
--   ROLE: CONFIG
--   MAP_MODE: SUMMARY
-- END_MODULE_CONTRACT
--
-- START_MODULE_MAP
--   HUB-классы - сущности домена (наследование от Entity; id v5/v7)
--   LINK-классы - связи (концы Schema.links v2; id v5 из концов)
--   NB: 20 классов (12 HUB + 8 LINK); число в заголовке файла сверяет scripts/check-docs.mjs
-- END_MODULE_MAP
--
-- START_CHANGE_SUMMARY
--   LAST_CHANGE: [v1.0.1 - Docs-only: заголовок файла приведён к факту (20 классов: 12 HUB + 8 LINK);
--     число теперь проверяется автоматически. INSERT-ы не менялись]
-- END_CHANGE_SUMMARY
--
-- START_BLOCK_SEED_HUB_CLASSES

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Entity', 'Сущность', 'HUB', NULL, '{"id":{"type":"uuid","generate":7}}'::jsonb, '{"abstract":true,"appearance":{"icon":{"name":"mdi:atom","color":"text-violet-500"}},"description":"Абстрактный корень всех сущностей; дефолт id v7 наследуют все классы без своего правила"}'::jsonb, '[]'::jsonb, 100, ARRAY['Entity']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Org', 'Организация', 'HUB', 'Entity', '{"name":"string","timezone":{"type":"string","default":"Europe/Moscow"},"address":"string|optional","phone":"string|optional","active":{"type":"boolean","default":true},"settings":{"type":"object","optional":true,"strict":true,"props":{"booking":{"type":"object","optional":true,"strict":true,"props":{"deposit":{"type":"object","optional":true,"strict":true,"props":{"amount":"number|integer|min:0|default:0","currency":{"type":"enum","values":["RUB","USD","EUR","AED"],"default":"RUB"}}},"autoconfirm":"boolean|default:false"}}}}}'::jsonb, '{"abstract":false,"appearance":{"icon":{"name":"mdi:domain","color":"text-blue-600"}},"description":"Организация — арендатор (мультитенантность): владелец каталога, локаций и расписаний; settings — вложенные настройки (пример структуры глубины 4)"}'::jsonb, '[]'::jsonb, 200, ARRAY['Org', 'Entity']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Person', 'Контрагент', 'HUB', 'Entity', '{"name":"string","phone":"string"}'::jsonb, '{"abstract":true,"appearance":{"icon":{"name":"mdi:account-outline","color":"text-blue-500"}},"description":"Абстрактный контрагент: имя + телефон; наследуют Мастер и Клиент"}'::jsonb, '[]'::jsonb, 300, ARRAY['Person', 'Entity']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Staff', 'Мастер', 'HUB', 'Person', '{"photo":"string|optional","description":"string|optional","specialization":"string|optional"}'::jsonb, '{"abstract":false,"appearance":{"icon":{"name":"mdi:account-star","color":"text-indigo-500"}},"description":"Мастер — бронируемый исполнитель; name/phone наследует от Контрагента; локации — LINK адрес, доступность — LINK окно"}'::jsonb, '[{"class":"Org","cardinality":1}]'::jsonb, 400, ARRAY['Staff', 'Person', 'Entity']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Customer', 'Клиент', 'HUB', 'Person', '{"notes":"string|optional","preferred_contact":{"type":"enum","values":["phone","email","messenger"],"default":"phone"}}'::jsonb, '{"abstract":false,"appearance":{"icon":{"name":"mdi:account","color":"text-green-500"}},"description":"Клиент — записывается на услуги; name/phone наследует от Контрагента"}'::jsonb, '[{"class":"Org","cardinality":1}]'::jsonb, 500, ARRAY['Customer', 'Person', 'Entity']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Location', 'Локация', 'HUB', 'Entity', '{"address":"string","coordinates":{"type":"object","optional":true,"props":{"lat":"number","lng":"number"}},"description":"string|optional"}'::jsonb, '{"abstract":false,"appearance":{"icon":{"name":"mdi:map-marker","color":"text-red-500"}},"description":"Локация — точка обслуживания организации"}'::jsonb, '[{"class":"Org","cardinality":1}]'::jsonb, 600, ARRAY['Location', 'Entity']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Element', 'Элемент', 'HUB', 'Entity', '{"id":{"type":"uuid","generate":5,"from":["Org","name"]},"name":"string","description":"string|optional"}'::jsonb, '{"abstract":true,"appearance":{"icon":{"name":"mdi:view-list","color":"text-teal-500"}},"description":"Абстрактная каталожная единица (Услуга/Товар/Комплекс). Правило id v5(Org, name) объявлено здесь один раз — наследуется потомками (имя уникально в организации, classId различает классы); links не наследуются — конец Org каждый потомок объявляет сам. Цена — отдельный LINK «цена» (варианты по пожеланиям, мультивалюта)"}'::jsonb, '[{"class":"Org","cardinality":1}]'::jsonb, 700, ARRAY['Element', 'Entity']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Service', 'Услуга', 'HUB', 'Element', '{"duration":"number|min:0|optional"}'::jsonb, '{"abstract":false,"appearance":{"icon":{"name":"mdi:spa","color":"text-purple-500"}},"description":"Услуга: длительность (мин); name/id-правило наследует от Элемента; цена — LINK «цена»"}'::jsonb, '[{"class":"Org","cardinality":1}]'::jsonb, 800, ARRAY['Service', 'Element', 'Entity']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Product', 'Товар', 'HUB', 'Element', '{"sku":"string|optional","unit":{"type":"string","default":"шт"}}'::jsonb, '{"abstract":false,"appearance":{"icon":{"name":"mdi:package","color":"text-blue-400"}},"description":"Товар: артикул + единица измерения; name/id-правило наследует от Элемента; цена — LINK «цена»"}'::jsonb, '[{"class":"Org","cardinality":1}]'::jsonb, 900, ARRAY['Product', 'Element', 'Entity']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Complex', 'Комплекс', 'HUB', 'Element', '{"cost":"number|min:0","duration":"number|min:0"}'::jsonb, '{"abstract":false,"appearance":{"icon":{"name":"mdi:package-variant-closed","color":"text-orange-500"}},"description":"Комплекс: собственные cost/duration; состав — LINK состав (Комплекс ← Элемент); цена — LINK «цена»"}'::jsonb, '[{"class":"Org","cardinality":1}]'::jsonb, 1000, ARRAY['Complex', 'Element', 'Entity']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Schedule', 'Расписание', 'HUB', 'Entity', '{"name":"string","year":"number|integer","month":"number|integer|min:1|max:12"}'::jsonb, '{"abstract":false,"appearance":{"icon":{"name":"mdi:calendar","color":"text-cyan-500"}},"description":"Месячное расписание организации; наполнение — LINK окно"}'::jsonb, '[{"class":"Org","cardinality":1}]'::jsonb, 1100, ARRAY['Schedule', 'Entity']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Folder', 'Папка', 'HUB', 'Entity', '{"name":"string"}'::jsonb, '{"abstract":false,"appearance":{"icon":{"name":"mdi:folder","color":"text-yellow-500"}},"description":"Папка-категория; вложенность — HUB-конец на родительскую Папку; наполнение — LINK содержимое"}'::jsonb, '[{"class":"Org","cardinality":1},{"class":"Folder","optional":true,"cardinality":1}]'::jsonb, 1200, ARRAY['Folder', 'Entity']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

-- END_BLOCK_SEED_HUB_CLASSES
-- START_BLOCK_SEED_LINK_CLASSES
INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'link', 'связь', 'LINK', NULL, '{"id":{"type":"uuid","generate":7}}'::jsonb, '{"abstract":true,"appearance":{"icon":{"name":"mdi:link","color":"text-sky-500"}},"description":"Абстрактная связь; концы объявляются потомками в links (Schema.links v2: объекты-концы, только HUB-классы)"}'::jsonb, '[]'::jsonb, 100, ARRAY['link']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'address', 'адрес', 'LINK', 'link', '{"id":{"type":"uuid","generate":5,"from":["Staff","Location"]},"default":"boolean|default:false","schedule_info":"string|optional"}'::jsonb, '{"abstract":false,"appearance":{"icon":{"name":"mdi:link","color":"text-sky-500"}},"description":"Адрес: Мастер работает в Локации; default — основная точка мастера"}'::jsonb, '[{"class":"Staff","cardinality":1},{"class":"Location","cardinality":1}]'::jsonb, 200, ARRAY['address', 'link']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'slot', 'окно', 'LINK', 'link', '{"id":{"type":"uuid","generate":5,"from":["Staff","start_datetime"]},"start_datetime":{"type":"date","convert":true},"end_datetime":{"type":"date","convert":true}}'::jsonb, '{"abstract":false,"appearance":{"icon":{"name":"mdi:clock-outline","color":"text-amber-500"}},"description":"Окно доступности: Мастер × Локация × Расписание + интервал. id = v5(Мастер, старт) — мастер не задваивает время ни в одной локации"}'::jsonb, '[{"class":"Staff","cardinality":1},{"class":"Location","cardinality":1},{"class":"Schedule","cardinality":1}]'::jsonb, 300, ARRAY['slot', 'link']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'booking', 'запись', 'LINK', 'slot', '{"notes":"string|optional"}'::jsonb, '{"abstract":false,"validation":"strict","appearance":{"icon":{"name":"mdi:calendar-check","color":"text-emerald-500"}},"description":"Запись — наследник окна (start/end_datetime и правило id v5(Мастер, старт) наследуются): бронь мастера на Элемент для Клиента. Ручная бронь — без Клиента, имя в notes. classId в v5-формуле различает окно и запись; двойная бронь того же времени мертва"}'::jsonb, '[{"class":"Staff","cardinality":1},{"class":"Location","cardinality":1},{"class":"Schedule","cardinality":1},{"classes":["Service","Product","Complex"],"cardinality":1},{"class":"Customer","optional":true,"cardinality":1}]'::jsonb, 400, ARRAY['booking', 'slot', 'link']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'content', 'содержимое', 'LINK', 'link', '{"id":{"type":"uuid","generate":5,"from":["Folder","Service|Product|Complex"]},"order":"number|integer|default:0"}'::jsonb, '{"abstract":false,"appearance":{"icon":{"name":"mdi:link","color":"text-sky-500"}},"description":"Содержимое папки: Папка ← Элемент (+порядок); элемент может лежать в нескольких папках"}'::jsonb, '[{"class":"Folder","cardinality":1},{"classes":["Service","Product","Complex"],"cardinality":1}]'::jsonb, 500, ARRAY['content', 'link']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'compo', 'состав', 'LINK', 'link', '{"id":{"type":"uuid","generate":5,"from":["Complex","Service|Product"]},"order":"number|integer|default:0","quantity":"number|integer|min:1|default:1"}'::jsonb, '{"abstract":false,"appearance":{"icon":{"name":"mdi:link","color":"text-sky-500"}},"description":"Состав комплекса: Комплекс ← Элемент (+порядок, +количество); в состав входят и услуги, и товары"}'::jsonb, '[{"class":"Complex","cardinality":1},{"classes":["Service","Product"],"cardinality":1}]'::jsonb, 600, ARRAY['compo', 'link']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'skill', 'навык', 'LINK', 'link', '{"id":{"type":"uuid","generate":5,"from":["Staff","Service"]},"level":{"type":"enum","values":["basic","intermediate","advanced","expert"],"default":"intermediate"}}'::jsonb, '{"abstract":false,"appearance":{"icon":{"name":"mdi:link","color":"text-sky-500"}},"description":"Навык: Мастер умеет Услугу (+уровень); умение комплекса вычислимо по составу"}'::jsonb, '[{"class":"Staff","cardinality":1},{"class":"Service","cardinality":1}]'::jsonb, 700, ARRAY['skill', 'link']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'price', 'цена', 'LINK', 'link', '{"id":{"type":"uuid","generate":5,"from":["Service|Product|Complex","note"]},"note":{"type":"string","default":"базовая"},"amounts":{"type":"record","key":{"type":"enum","values":["RUB","USD","EUR","AED"]},"value":"number|integer|min:0"}}'::jsonb, '{"abstract":false,"appearance":{"icon":{"name":"mdi:cash-multiple","color":"text-green-600"}},"description":"Вариант цены каталожного элемента: мультивалютные суммы (amounts) + описание (note). У элемента несколько вариантов по пожеланиям клиента (note различает: базовая/с дизайном/…); id v5(элемент, note) — note не задан ⇒ дефолт «базовая»; правку одной валюты amounts мержит точечно"}'::jsonb, '[{"classes":["Service","Product","Complex"],"cardinality":1}]'::jsonb, 800, ARRAY['price', 'link']::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;
-- END_BLOCK_SEED_LINK_CLASSES
