-- =============================================================================
-- Сид таблицы Schema из schema.booking.v2.json (источник правды — JSON).
-- Файл сгенерирован, не редактировать вручную. Идемпотентен (ON CONFLICT).
-- =============================================================================

INSERT INTO "booking"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Entity', 'Сущность', 'HUB', NULL, '{"id":"any"}'::jsonb, '{"abstract":true,"description":"Абстрактный корень всех сущностей"}'::jsonb, '{}'::text[], 100, '{"Entity"}'::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "booking"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Org', 'Организация', 'HUB', 'Entity', '{"id":"uuid","name":"string","timezone":{"type":"string","default":"Europe/Moscow"},"address":"string|optional","phone":"string|optional","active":{"type":"boolean","default":true},"settings":{"type":"object","optional":true,"strict":true,"props":{"booking":{"type":"object","optional":true,"strict":true,"props":{"deposit":{"type":"object","optional":true,"strict":true,"props":{"amount":"number|integer|min:0|default:0","currency":{"type":"enum","values":["RUB","USD","EUR","AED"],"default":"RUB"}}},"autoconfirm":"boolean|default:false"}}}}}'::jsonb, '{"abstract":false,"description":"Организация / точка / филиал — владелец каталога и расписаний; settings — вложенные настройки (пример структуры глубины 4)"}'::jsonb, '{}'::text[], 200, '{"Org","Entity"}'::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "booking"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Staff', 'Сотрудник', 'HUB', 'Entity', '{"id":"uuid","name":"string","roles":{"type":"array","items":{"type":"enum","values":["owner","administrator","manager","master"]},"default":["master"]},"active":{"type":"boolean","default":true}}'::jsonb, '{"abstract":false,"description":"Человек: роли совмещаются (owner+master). Бронируемый ⇔ master ∈ roles. Владелец = первый сотрудник с owner."}'::jsonb, '{"Org"}'::text[], 300, '{"Staff","Entity"}'::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "booking"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Folder', 'Папка', 'HUB', 'Entity', '{"id":"uuid","name":"string","kind":{"type":"enum","values":["services","masters"],"default":"services"}}'::jsonb, '{"abstract":false,"description":"Папка-категория; вложенность — ссылкой на родительскую Папку в links"}'::jsonb, '{"Org","Folder"}'::text[], 400, '{"Folder","Entity"}'::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "booking"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Service', 'Услуга', 'HUB', 'Entity', '{"id":"uuid","name":"string","description":"string|optional","duration":"number|integer|positive","price":{"type":"record","key":{"type":"enum","values":["RUB","USD","EUR","AED"]},"value":"number|integer|min:0","default":{"RUB":0}},"active":{"type":"boolean","default":true}}'::jsonb, '{"abstract":false,"description":"Услуга: длительность (мин) + цена; занимает столько подряд окон, сколько покрывает duration"}'::jsonb, '{"Org","Folder"}'::text[], 500, '{"Service","Entity"}'::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "booking"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Complex', 'Комплекс', 'HUB', 'Entity', '{"id":"uuid","name":"string","description":"string|optional","duration":"number|integer|positive","discount":"number|integer|default:0","price":{"type":"record","key":{"type":"enum","values":["RUB","USD","EUR","AED"]},"value":"number|integer|min:0","optional":true}}'::jsonb, '{"abstract":false,"description":"Комплекс: собственный duration; состав — позиция(Комплекс→Услуга); свободный текст цены — в description"}'::jsonb, '{"Org","Folder"}'::text[], 600, '{"Complex","Entity"}'::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "booking"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Customer', 'Клиент', 'HUB', 'Entity', '{"id":"uuid","name":"string|optional","contact":"string|optional","language":{"type":"enum","values":["ru","en"],"default":"ru"},"active":{"type":"boolean","default":true}}'::jsonb, '{"abstract":false,"description":"Клиент — записывается на услуги"}'::jsonb, '{"Org"}'::text[], 700, '{"Customer","Entity"}'::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "booking"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Schedule', 'Расписание', 'HUB', 'Entity', '{"id":"uuid","start":{"type":"date","convert":true},"end":{"type":"date","convert":true},"active":{"type":"boolean","default":true}}'::jsonb, '{"abstract":false,"description":"Расписание — период организации, содержит непересекающиеся Окна (инвариант проверяет приложение)"}'::jsonb, '{"Org"}'::text[], 800, '{"Schedule","Entity"}'::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "booking"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Slot', 'Окно', 'HUB', 'Entity', '{"id":"uuid","start":{"type":"date","convert":true},"end":{"type":"date","convert":true}}'::jsonb, '{"abstract":false,"description":"Окно — общий таймлайн произвольной длины внутри Расписания; статуса нет — занятость мастера хранит LINK занятость"}'::jsonb, '{"Schedule"}'::text[], 900, '{"Slot","Entity"}'::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "booking"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'Booking', 'Запись', 'HUB', 'Entity', '{"id":"uuid","status":{"type":"enum","values":["created","confirmed","completed","cancelled","no_show"],"default":"created"},"source":{"type":"enum","values":["online","web","admin","telegram"],"default":"online"},"comment":"string|optional","total":{"type":"record","key":{"type":"enum","values":["RUB","USD","EUR","AED"]},"value":"number|integer|min:0","default":{"RUB":0}}}'::jsonb, '{"abstract":false,"description":"Запись клиента. Без мастера (мульти-мастер): мастера — на занятости/позиции. Ручная бронь по имени: без Customer, имя в comment. Дата приёма = start первого окна брони. history: полный аудит версиями"}'::jsonb, '{"Customer"}'::text[], 1000, '{"Booking","Entity"}'::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "booking"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'link', 'связь', 'LINK', NULL, '{"id":"any"}'::jsonb, '{"abstract":true,"description":"Абстрактная связь; фактические концы — ключи Entity.links {Класс: id, …}"}'::jsonb, '{"Entity","Entity"}'::text[], 100, '{"link"}'::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "booking"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'item', 'позиция', 'LINK', 'link', '{"id":"any","qty":"number|integer|min:1|default:1","price":{"type":"record","key":{"type":"enum","values":["RUB","USD","EUR","AED"]},"value":"number|integer|min:0","optional":true}}'::jsonb, '{"abstract":false,"description":"Полиморфная позиция: {Запись,(Услуга|Комплекс),Сотрудник} — строка записи со снимком цены и исполнителем; {Комплекс,Услуга} — состав комплекса"}'::jsonb, '{"Entity","Entity"}'::text[], 200, '{"item","link"}'::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "booking"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'skill', 'навык', 'LINK', 'link', '{"id":"any"}'::jsonb, '{"abstract":false,"description":"Навык: Сотрудник умеет (Услуга|Комплекс); при записи проверяется"}'::jsonb, '{"Staff","Entity"}'::text[], 300, '{"skill","link"}'::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "booking"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'shift', 'смена', 'LINK', 'link', '{"id":"any"}'::jsonb, '{"abstract":false,"description":"Ростер: сотрудник работает в расписании ⇒ по умолчанию доступен во всех его окнах"}'::jsonb, '{"Schedule","Staff"}'::text[], 400, '{"shift","link"}'::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;

INSERT INTO "booking"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  ('entity', 'busy', 'занятость', 'LINK', 'link', '{"id":"any","kind":{"type":"enum","values":["off","hold","booking"],"default":"booking"},"reason":"string|optional"}'::jsonb, '{"abstract":false,"description":"Негативная доступность: свободно = НЕТ живой занятости. off — мастер убран из окна; hold — оформление; booking — бронь (+ключ Запись в links). id = uuidv5(Сотрудник, Окно) — детерминирован против двойной брони"}'::jsonb, '{"Staff","Slot"}'::text[], 500, '{"busy","link"}'::text[])
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;
