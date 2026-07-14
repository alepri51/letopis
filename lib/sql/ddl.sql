-- =============================================================================
-- Движок-хранилище: TimescaleDB, append-only.
-- В БД только: структура таблиц + индексы + триггеры ЦЕЛОСТНОСТИ.
-- Вся логика приложения (версии, каскады, локи, валидация data) — в либе letopis.
-- Идемпотентен: можно применять повторно.
-- "<SCHEMA-NAME>" — маркер: letopis.up() / db/apply.mjs подставляет полное имя схемы vN.<имя>.
-- =============================================================================

-- FILE: lib/sql/ddl.sql
-- VERSION: 1.0.0
-- START_MODULE_CONTRACT
--   PURPOSE: Движок-хранилище PostgreSQL/TimescaleDB — таблицы, Entity-hypertable, индексы и триггеры целостности (валидация, версионирование, каскад-tombstone, lineage, notify).
--   SCOPE: таблицы Schema/Entity/Account/Credential/Resource/Rule + триггеры schema_lineage/entity_check/entity_update/entity_delete/entity_notify.
--   DEPENDS: none
--   LINKS: M-DDL, V-M-DDL
--   ROLE: RUNTIME
--   MAP_MODE: SUMMARY
-- END_MODULE_CONTRACT
--
-- START_MODULE_MAP
--   Schema - определения классов (HUB/LINK), наследование, attributes/links
--   Entity - append-only hypertable версий сущностей и связей
--   Account/Credential/Resource/Rule - служебные таблицы auth/ACL
--   schema_lineage - пересчёт ancestors/descendants (statement-level)
--   entity_check - валидация класса и концов LINK при INSERT
--   entity_update - UPDATE → вставка новой версии
--   entity_delete - DELETE → tombstone + рекурсивный каскад (advisory-lock)
--   entity_notify - pg_notify о новой версии (канал = имя схемы)
-- END_MODULE_MAP
--
-- START_CHANGE_SUMMARY
--   LAST_CHANGE: [v1.0.0 - Documented existing module: reverse-engineered contract + markup]
-- END_CHANGE_SUMMARY

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE SCHEMA IF NOT EXISTS "<SCHEMA-NAME>";

-- -----------------------------------------------------------------------------
-- Schema: классы предметной области (HUB — сущности, LINK — связи).
-- Сидится демо-доменом booking: lib/sql/seed.booking.sql (источник правды).
-- -----------------------------------------------------------------------------
-- START_BLOCK_TABLE_SCHEMA
CREATE TABLE IF NOT EXISTS "<SCHEMA-NAME>"."Schema" (
    partition  text   NOT NULL DEFAULT 'entity',
    id         text   NOT NULL,                  -- англ. id класса: 'Staff', 'skill'
    alias      text   NOT NULL,                  -- рус. алиас: 'Сотрудник', 'навык'
    category   text   NOT NULL CHECK (category IN ('HUB', 'LINK')),
    ancestor   text,                             -- прямой родитель (наследование)
    attributes jsonb  NOT NULL DEFAULT '{}',     -- fastest-validator DSL (валидирует либа)
    links      jsonb  NOT NULL DEFAULT '[]',     -- МАССИВ ОБЪЕКТОВ-концов: {"class":…}/{"classes":[…],"optional":…,"cardinality":…} (союзы ролей, матчинг по порядку); legacy-элемент-строка "Org" ("Entity" = полиморфный)
    meta       jsonb  NOT NULL DEFAULT '{}',     -- {abstract?, description?}
    "order"    int    NOT NULL DEFAULT 0,
    ancestors   text[] NOT NULL DEFAULT '{}',    -- [self, parent, …, root] — считает триггер schema_lineage
    descendants text[] NOT NULL DEFAULT '{}',    -- все потомки (транзитивно)  — считает триггер schema_lineage
    PRIMARY KEY (partition, id)
);
-- END_BLOCK_TABLE_SCHEMA

-- -----------------------------------------------------------------------------
-- Триггер lineage: ancestors + descendants пересчитываются автоматически
-- при любом INSERT/UPDATE(ancestor,id)/DELETE в Schema (statement-level).
-- Рекурсивные CTE вверх и вниз; защита от циклов (depth ≤ 32) и от
-- саморекурсии триггера (pg_trigger_depth).
-- -----------------------------------------------------------------------------
-- START_CONTRACT: schema_lineage
--   PURPOSE: Пересчитать ancestors + descendants всех классов при изменении Schema (statement-level; защита от циклов depth≤32 и саморекурсии).
--   INPUTS: { trigger: AFTER INSERT/UPDATE(ancestor,id)/DELETE ON Schema }
--   OUTPUTS: { NULL - обновляет колонки ancestors/descendants }
--   SIDE_EFFECTS: UPDATE Schema.ancestors/descendants
--   LINKS: M-DDL, V-M-DDL
-- END_CONTRACT: schema_lineage
CREATE OR REPLACE FUNCTION "<SCHEMA-NAME>".schema_lineage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;

    WITH RECURSIVE up AS (
        SELECT s.partition, s.id, s.id AS anc, 0 AS depth FROM "<SCHEMA-NAME>"."Schema" s
        UNION ALL
        SELECT u.partition, u.id, p.ancestor, u.depth + 1
        FROM up u
        JOIN "<SCHEMA-NAME>"."Schema" p ON p.partition = u.partition AND p.id = u.anc
        WHERE p.ancestor IS NOT NULL AND u.depth < 32
    ),
    anc AS (
        SELECT partition, id, array_agg(anc ORDER BY depth) AS ancestors
        FROM up GROUP BY partition, id
    ),
    down AS (
        SELECT s.partition, s.id, s.id AS des, 0 AS depth FROM "<SCHEMA-NAME>"."Schema" s
        UNION ALL
        SELECT d.partition, d.id, c.id, d.depth + 1
        FROM down d
        JOIN "<SCHEMA-NAME>"."Schema" c ON c.partition = d.partition AND c.ancestor = d.des
        WHERE d.depth < 32
    ),
    dsc AS (
        SELECT partition, id,
               COALESCE(array_agg(des ORDER BY depth, des) FILTER (WHERE depth > 0), '{}') AS descendants
        FROM down GROUP BY partition, id
    )
    UPDATE "<SCHEMA-NAME>"."Schema" s
       SET ancestors = anc.ancestors, descendants = dsc.descendants
      FROM anc
      JOIN dsc ON dsc.partition = anc.partition AND dsc.id = anc.id
     WHERE s.partition = anc.partition AND s.id = anc.id
       AND (s.ancestors IS DISTINCT FROM anc.ancestors
            OR s.descendants IS DISTINCT FROM dsc.descendants);

    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS schema_lineage ON "<SCHEMA-NAME>"."Schema";
CREATE TRIGGER schema_lineage
    AFTER INSERT OR UPDATE OF ancestor, id OR DELETE ON "<SCHEMA-NAME>"."Schema"
    FOR EACH STATEMENT EXECUTE FUNCTION "<SCHEMA-NAME>".schema_lineage();

-- -----------------------------------------------------------------------------
-- Entity: единое хранилище сущностей и связей. Append-only hypertable.
-- Версия = строка; актуальная версия = max(updated); удаление = tombstone (deleted).
-- links = {"Класс": "id", ...} — произвольное число ссылок в одной строке.
-- -----------------------------------------------------------------------------
-- START_BLOCK_ENTITY_STORAGE
CREATE TABLE IF NOT EXISTS "<SCHEMA-NAME>"."Entity" (
    partition text        NOT NULL,
    id        text        NOT NULL,
    class     text        NOT NULL,
    data      jsonb       NOT NULL DEFAULT '{}',
    updated   timestamptz NOT NULL DEFAULT clock_timestamp(),
    account   uuid        NOT NULL,   -- арендатор; default подставляет либа (connect.account → System)
    tags      text[]      NOT NULL DEFAULT '{}',
    owner     uuid        NOT NULL,   -- владелец; default = account
    links     jsonb       NOT NULL DEFAULT '{}',
    deleted   timestamptz,
    PRIMARY KEY (partition, class, id, updated),
    -- ссылочная целостность класса: Entity(partition, class) → Schema(partition, id).
    -- Timescale поддерживает FK hypertable → обычная таблица.
    -- RESTRICT: класс с данными нельзя удалить из Schema (проверка через префикс entity_latest_idx).
    CONSTRAINT entity_class_fk FOREIGN KEY (partition, class)
        REFERENCES "<SCHEMA-NAME>"."Schema"(partition, id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Партиционирование: ТОЛЬКО время updated (чанки по 30 дней). Hash-размерности
-- (partition/class/id) убраны по результатам bench/dimensions.bench.mjs (1.1M строк,
-- год истории): точечный доступ равен PK-btree, простые фильтры −10-20%, зато
-- цепочки LATERAL ×2…×140 медленнее (93 чанка/год против 14) и планирование дороже.
-- Локальность версий сущности даёт компрессия segmentby (db/policies.mjs), не hash.
SELECT create_hypertable(
    '"<SCHEMA-NAME>"."Entity"', 'updated',
    chunk_time_interval => INTERVAL '30 days',
    if_not_exists       => TRUE,
    migrate_data        => TRUE
);

-- Индексы: «последняя версия», обход графа, фильтры, теги, арендатор/владелец.
-- account/owner — полные (не partial): нужны и фильтрам $account/$owner, и RI-сканам FK.
CREATE INDEX IF NOT EXISTS entity_latest_idx  ON "<SCHEMA-NAME>"."Entity" (partition, class, id, updated DESC);
CREATE INDEX IF NOT EXISTS entity_links_idx   ON "<SCHEMA-NAME>"."Entity" USING gin (links jsonb_path_ops);
CREATE INDEX IF NOT EXISTS entity_data_idx    ON "<SCHEMA-NAME>"."Entity" USING gin (data  jsonb_path_ops);
CREATE INDEX IF NOT EXISTS entity_tags_idx    ON "<SCHEMA-NAME>"."Entity" USING gin (tags);
CREATE INDEX IF NOT EXISTS entity_account_idx ON "<SCHEMA-NAME>"."Entity" (account);
CREATE INDEX IF NOT EXISTS entity_owner_idx   ON "<SCHEMA-NAME>"."Entity" (owner);
-- END_BLOCK_ENTITY_STORAGE

-- -----------------------------------------------------------------------------
-- Триггер 1: целостность при INSERT (только проверки, никакой логики приложения).
--   * класс существует в Schema той же partition;
--   * класс не абстрактный;
--   * каждый ключ links — существующий класс, значение — строка (id);
--   * LINK: концы из Schema.links.
--     Формат v2 (элемент — JSON-объект '{"class":…}' / '{"classes":[…]}'):
--     жадный матчинг по порядку объявления, optional-концы могут отсутствовать,
--     связи вне объявленных концов — ошибка.
--     Legacy (элемент — имя класса): конец обязателен по имени, 'Entity' —
--     полиморфный (его резолвит либа), лишние связи не проверяются.
-- Tombstone-версии (deleted IS NOT NULL) не валидируются.
-- -----------------------------------------------------------------------------
-- START_CONTRACT: entity_check
--   PURPOSE: Проверить при INSERT — класс существует и не абстрактный; ключи links — существующие классы со строковыми id; концы LINK (v2 жадный матчинг / legacy).
--   INPUTS: { trigger: BEFORE INSERT ON Entity (NEW) }
--   OUTPUTS: { NEW - либо EXCEPTION }
--   SIDE_EFFECTS: none (валидация; tombstone-версии пропускаются)
--   ERRORS: unknown class; class is abstract; links key not a class; link requires end; stray link
--   LINKS: M-DDL, V-M-DDL, M-WRITE
-- END_CONTRACT: entity_check
CREATE OR REPLACE FUNCTION "<SCHEMA-NAME>".entity_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    s    RECORD;
    bad  text;
    k    text;
    used text[];
    ej   jsonb;
    ecs  text[];
    hit  text;
    c2   text;
    is_v2 boolean;
BEGIN
    IF NEW.deleted IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT * INTO s
    FROM "<SCHEMA-NAME>"."Schema"
    WHERE partition = NEW.partition AND id = NEW.class;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ENTITY_CHECK: unknown class "%" (partition "%")', NEW.class, NEW.partition;
    END IF;

    IF s.meta->>'abstract' = 'true' THEN
        RAISE EXCEPTION 'ENTITY_CHECK: class "%" is abstract', NEW.class;
    END IF;

    -- ключи links — существующие классы, значения — строки
    SELECT e.key INTO bad
    FROM jsonb_each(COALESCE(NEW.links, '{}'::jsonb)) e
    WHERE jsonb_typeof(e.value) <> 'string'
       OR NOT EXISTS (
            SELECT 1 FROM "<SCHEMA-NAME>"."Schema" c
            WHERE c.partition = NEW.partition AND c.id = e.key)
    LIMIT 1;

    IF bad IS NOT NULL THEN
        RAISE EXCEPTION 'ENTITY_CHECK: links key "%" is not a class or its value is not an id string', bad;
    END IF;

    -- LINK: концы по Schema.links — jsonb-массив; элемент-объект = v2 (строгий жадный
    -- матчинг по порядку), элемент-строка = legacy-имя класса
    -- START_BLOCK_ENTITY_CHECK_LINK
    IF s.category = 'LINK' THEN
        is_v2 := EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(s.links, '[]'::jsonb)) le
            WHERE jsonb_typeof(le.value) = 'object');
        IF is_v2 THEN
            used := ARRAY[]::text[];
            FOR ej IN SELECT le.value FROM jsonb_array_elements(COALESCE(s.links, '[]'::jsonb)) le LOOP
                ecs := COALESCE(
                    (SELECT array_agg(x) FROM jsonb_array_elements_text(ej->'classes') x),
                    ARRAY[ej->>'class']);
                hit := NULL;
                FOREACH c2 IN ARRAY ecs LOOP
                    IF (COALESCE(NEW.links, '{}'::jsonb) ? c2) AND NOT (c2 = ANY(used)) THEN
                        hit := c2;
                        EXIT;
                    END IF;
                END LOOP;
                IF hit IS NOT NULL THEN
                    used := used || hit;
                ELSIF NOT COALESCE((ej->>'optional')::boolean, false) THEN
                    RAISE EXCEPTION 'ENTITY_CHECK: link "%" requires end "%"', NEW.class, array_to_string(ecs, '|');
                END IF;
            END LOOP;
            SELECT e.key INTO bad
            FROM jsonb_each(COALESCE(NEW.links, '{}'::jsonb)) e
            WHERE NOT (e.key = ANY(used))
            LIMIT 1;
            IF bad IS NOT NULL THEN
                RAISE EXCEPTION 'ENTITY_CHECK: link "%" has stray link "%" — not an end in Schema.links', NEW.class, bad;
            END IF;
        ELSE
            FOR k IN SELECT le.value #>> '{}' FROM jsonb_array_elements(COALESCE(s.links, '[]'::jsonb)) le LOOP
                IF k <> 'Entity' AND NOT (COALESCE(NEW.links, '{}'::jsonb) ? k) THEN
                    RAISE EXCEPTION 'ENTITY_CHECK: link "%" requires end "%"', NEW.class, k;
                END IF;
            END LOOP;
        END IF;
    END IF;

    -- END_BLOCK_ENTITY_CHECK_LINK
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS entity_check ON "<SCHEMA-NAME>"."Entity";
CREATE TRIGGER entity_check
    BEFORE INSERT ON "<SCHEMA-NAME>"."Entity"
    FOR EACH ROW EXECUTE FUNCTION "<SCHEMA-NAME>".entity_check();

-- -----------------------------------------------------------------------------
-- Триггер 2: UPDATE = новая версия. Физического UPDATE не происходит:
--   * бьёт только АКТУАЛЬНУЮ строку (не-latest молча игнорируются, история неизменна);
--   * вместо апдейта вставляется новая версия с монотонным updated;
--   * вставка проходит entity_check (валидация класса/links).
-- Работает и для голого SQL: UPDATE "<SCHEMA-NAME>"."Entity" SET data=… WHERE …
-- -----------------------------------------------------------------------------
-- START_CONTRACT: entity_update
--   PURPOSE: Превратить UPDATE в INSERT новой версии — бьёт только актуальную строку, историю не трогает, updated монотонно растёт.
--   INPUTS: { trigger: BEFORE UPDATE ON Entity (OLD/NEW) }
--   OUTPUTS: { NULL - физический UPDATE отменён }
--   SIDE_EFFECTS: INSERT новой версии (проходит entity_check)
--   LINKS: M-DDL, V-M-DDL
-- END_CONTRACT: entity_update
CREATE OR REPLACE FUNCTION "<SCHEMA-NAME>".entity_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE latest timestamptz;
BEGIN
    SELECT max(updated) INTO latest FROM "<SCHEMA-NAME>"."Entity"
     WHERE partition = OLD.partition AND class = OLD.class AND id = OLD.id;
    IF OLD.updated <> latest THEN
        RETURN NULL;                                   -- историческая версия неприкосновенна
    END IF;

    INSERT INTO "<SCHEMA-NAME>"."Entity"
        (partition, id, class, data, links, tags, account, owner, updated, deleted)
    VALUES
        (NEW.partition, NEW.id, NEW.class, NEW.data, NEW.links, NEW.tags, NEW.account, NEW.owner,
         GREATEST(clock_timestamp(), OLD.updated + interval '1 microsecond'), NEW.deleted);
    RETURN NULL;                                       -- физический UPDATE отменён
END $$;

DROP TRIGGER IF EXISTS entity_no_update ON "<SCHEMA-NAME>"."Entity";
DROP TRIGGER IF EXISTS entity_update ON "<SCHEMA-NAME>"."Entity";
CREATE TRIGGER entity_update
    BEFORE UPDATE ON "<SCHEMA-NAME>"."Entity"
    FOR EACH ROW EXECUTE FUNCTION "<SCHEMA-NAME>".entity_update();

-- -----------------------------------------------------------------------------
-- Триггер 3: DELETE = tombstone + РЕКУРСИВНЫЙ каскад по links — целиком в БД.
--   * бьёт только актуальную ЖИВУЮ строку (история и tombstone неприкосновенны);
--   * advisory-lock сериализует параллельные удаления сущности;
--   * каскад: DELETE живых зависимых (links ⊃ {класс: id}) → рекурсия этого же триггера;
--   * физического удаления не происходит никогда — КРОМЕ явного purge (см. ниже):
--     при SET LOCAL letopis.purge='on' триггер целиком пропускается (WHEN) → физический DELETE.
-- Работает и для голого SQL: DELETE FROM "<SCHEMA-NAME>"."Entity" WHERE partition=… AND class=… AND id=…
-- -----------------------------------------------------------------------------
-- START_CONTRACT: entity_delete
--   PURPOSE: Превратить DELETE в tombstone + рекурсивный каскад по links; advisory-lock сериализует параллельные удаления; физического удаления нет.
--   INPUTS: { trigger: BEFORE DELETE ON Entity (OLD) }
--   OUTPUTS: { NULL - физическое удаление отменено }
--   SIDE_EFFECTS: INSERT tombstone; DELETE живых зависимых (рекурсия триггера); pg_advisory_xact_lock
--   LINKS: M-DDL, V-M-DDL, M-WRITE
-- END_CONTRACT: entity_delete
CREATE OR REPLACE FUNCTION "<SCHEMA-NAME>".entity_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE latest timestamptz;
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended(OLD.partition || '|' || OLD.class || '|' || OLD.id, 0));

    SELECT max(updated) INTO latest FROM "<SCHEMA-NAME>"."Entity"
     WHERE partition = OLD.partition AND class = OLD.class AND id = OLD.id;
    IF OLD.updated <> latest OR OLD.deleted IS NOT NULL THEN
        RETURN NULL;                                   -- не актуальная или уже tombstone: игнор
    END IF;

    -- tombstone-версия
    INSERT INTO "<SCHEMA-NAME>"."Entity"
        (partition, id, class, data, links, tags, account, owner, updated, deleted)
    VALUES
        (OLD.partition, OLD.id, OLD.class, OLD.data, OLD.links, OLD.tags, OLD.account, OLD.owner,
         GREATEST(clock_timestamp(), OLD.updated + interval '1 microsecond'), clock_timestamp());

    -- каскад: живые зависимые; их DELETE рекурсивно повторит этот триггер
    DELETE FROM "<SCHEMA-NAME>"."Entity" e
     WHERE e.partition = OLD.partition
       AND e.deleted IS NULL
       AND e.links @> jsonb_build_object(OLD.class, OLD.id);

    RETURN NULL;                                       -- физическое удаление отменено
END $$;

DROP TRIGGER IF EXISTS entity_delete ON "<SCHEMA-NAME>"."Entity";
CREATE TRIGGER entity_delete
    BEFORE DELETE ON "<SCHEMA-NAME>"."Entity"
    FOR EACH ROW
    -- purge-режим: при SET LOCAL letopis.purge='on' триггер НЕ срабатывает → физический DELETE.
    -- Обычный путь (флаг не выставлен) видит NULL → IS DISTINCT FROM 'on' = true → триггер работает (tombstone).
    WHEN (current_setting('letopis.purge', true) IS DISTINCT FROM 'on')
    EXECUTE FUNCTION "<SCHEMA-NAME>".entity_delete();

-- -----------------------------------------------------------------------------
-- Физический hard-erase (purge). Вся логика — в БД (две функции); либа лишь зовёт purge():
--   * purge_closure(partition,class,ids[]) — (class,id) всего поддерева по links (вкл. tombstone);
--     единый источник замыкания (UNION отсекает циклы/диаманты).
--   * purge(partition,class,id[,dry]) RETURNS SETOF Entity — двухфазный снос корня + поддерева:
--       - ДВУХФАЗНОСТЬ: только если сущность уже логически удалена (актуальная версия — tombstone);
--         живую не трогает (0 строк);
--       - dry=true  → превью (актуальные версии замыкания), БД не трогается;
--       - dry=false → SET LOCAL letopis.purge='on' отключает entity_delete (см. WHEN выше) → плоский DELETE
--         замыкания без вложенного DML (без TM_SelfModified, детерминированно), возвращает снесённое;
--       - флаг транзакционный (is_local) + явный сброс → дальше в той же tx снова tombstone; привилегий не требует.
-- Голый SQL:  SELECT * FROM "<SCHEMA-NAME>".purge('entity','Order','X');          -- снос
--             SELECT * FROM "<SCHEMA-NAME>".purge('entity','Order','X', true);    -- превью
-- -----------------------------------------------------------------------------
-- START_CONTRACT: purge_closure
--   PURPOSE: (class,id)-замыкание поддерева по links (вкл. tombstone) — что снесёт purge(); переиспользуется самой purge() (снос и dry-превью).
--   INPUTS: { p_partition text; p_class text; p_ids text[] }
--   OUTPUTS: { SETOF (class text, id text) - узлы замыкания }
--   SIDE_EFFECTS: none (STABLE)
--   LINKS: M-DDL, V-M-DDL, M-WRITE, M-SQL
-- END_CONTRACT: purge_closure
CREATE OR REPLACE FUNCTION "<SCHEMA-NAME>".purge_closure(p_partition text, p_class text, p_ids text[])
RETURNS TABLE(class text, id text) LANGUAGE sql STABLE AS $$
    WITH RECURSIVE closure(cls, cid) AS (
        SELECT p_class, x FROM unnest(p_ids) AS x
        UNION                                          -- не ALL → отсекает циклы/диаманты links
        SELECT e.class, e.id
          FROM "<SCHEMA-NAME>"."Entity" e
          JOIN closure c ON e.links @> jsonb_build_object(c.cls, c.cid)
         WHERE e.partition = p_partition
    )
    SELECT cls, cid FROM closure;
$$;

-- START_CONTRACT: purge
--   PURPOSE: Двухфазно физически стереть логически удалённый корень и всё поддерево (по links, все версии); dry=превью.
--   INPUTS: { p_partition text; p_class text; p_id text; p_dry boolean = false }
--   OUTPUTS: { SETOF Entity - снесённые (по одному на сущность, latest) либо превью (dry); пусто если не tombstone }
--   SIDE_EFFECTS: при dry=false — SET LOCAL letopis.purge (отключает entity_delete на tx) + физический DELETE; advisory-lock
--   LINKS: M-DDL, V-M-DDL, M-WRITE, M-TABLES
-- END_CONTRACT: purge
CREATE OR REPLACE FUNCTION "<SCHEMA-NAME>".purge(
    p_partition text, p_class text, p_id text, p_dry boolean DEFAULT false)
RETURNS SETOF "<SCHEMA-NAME>"."Entity" LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended(p_partition || '|' || p_class || '|' || p_id, 0));

    -- двухфазность: hard-purge только ПОСЛЕ логического удаления — актуальная версия обязана быть tombstone.
    -- Живую (не удалённую) сущность purge НЕ трогает (возвращает 0 строк).
    IF NOT EXISTS (
        SELECT 1 FROM "<SCHEMA-NAME>"."Entity" e
         WHERE e.partition = p_partition AND e.class = p_class AND e.id = p_id AND e.deleted IS NOT NULL
           AND e.updated = (SELECT max(updated) FROM "<SCHEMA-NAME>"."Entity"
                             WHERE partition = p_partition AND class = p_class AND id = p_id)
    ) THEN
        RETURN;
    END IF;

    IF p_dry THEN
        -- превью: актуальная версия каждого члена замыкания, БД не трогаем
        RETURN QUERY
          SELECT DISTINCT ON (e.class, e.id) e.* FROM "<SCHEMA-NAME>"."Entity" e
            JOIN "<SCHEMA-NAME>".purge_closure(p_partition, p_class, ARRAY[p_id]) c
              ON e.class = c.class AND e.id = c.id
           WHERE e.partition = p_partition
           ORDER BY e.class, e.id, e.updated DESC;
        RETURN;
    END IF;

    PERFORM set_config('letopis.purge', 'on', true);   -- SET LOCAL: entity_delete отключён на эту tx
    RETURN QUERY
      WITH del AS (
        DELETE FROM "<SCHEMA-NAME>"."Entity" e
         USING "<SCHEMA-NAME>".purge_closure(p_partition, p_class, ARRAY[p_id]) c
         WHERE e.partition = p_partition AND e.class = c.class AND e.id = c.id  -- триггер пропущен (WHEN)
        RETURNING e.*
      )
      SELECT DISTINCT ON (class, id) * FROM del ORDER BY class, id, updated DESC;
    PERFORM set_config('letopis.purge', '', true);     -- сброс: дальше в той же tx снова tombstone
    RETURN;
END $$;

-- =============================================================================
-- Служебные таблицы (auth/ACL) — перенесены из legacy-дампа 1:1.
-- Обычные таблицы: UPDATE/DELETE разрешены, версии не ведутся.
-- =============================================================================

-- Аккаунты: пользователи и сервисы. Категории: System | User | Anonymous | Shadow…
-- START_BLOCK_AUTH_TABLES
CREATE TABLE IF NOT EXISTS "<SCHEMA-NAME>"."Account" (
    id         uuid                   DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    categories character varying[]    DEFAULT ARRAY['User'::text] NOT NULL,
    data       jsonb                  DEFAULT '{}'::jsonb NOT NULL,
    meta       jsonb                  DEFAULT '{}'::jsonb NOT NULL,
    avatar     character varying(255) DEFAULT ('https://i.pravatar.cc/128?img='::text || (floor(((70)::double precision * random())) + (1)::double precision)) NOT NULL,
    enabled    boolean                DEFAULT true NOT NULL,
    created    timestamptz            DEFAULT now() NOT NULL,
    updated    timestamptz            DEFAULT now() NOT NULL
);

-- Ссылочная целостность Entity → Account. ТОЛЬКО RESTRICT:
-- CASCADE/SET NULL невозможны — Entity append-only (физические UPDATE/DELETE запрещены триггером).
-- Аккаунт со строками Entity (включая историю/tombstone) не удаляется — вместо этого enabled = false.
ALTER TABLE "<SCHEMA-NAME>"."Entity" DROP CONSTRAINT IF EXISTS entity_account_fk;
ALTER TABLE "<SCHEMA-NAME>"."Entity" ADD CONSTRAINT entity_account_fk
    FOREIGN KEY (account) REFERENCES "<SCHEMA-NAME>"."Account"(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE "<SCHEMA-NAME>"."Entity" DROP CONSTRAINT IF EXISTS entity_owner_fk;
ALTER TABLE "<SCHEMA-NAME>"."Entity" ADD CONSTRAINT entity_owner_fk
    FOREIGN KEY (owner) REFERENCES "<SCHEMA-NAME>"."Account"(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- Способы входа аккаунта: EMAILPASSWORD | APIKEY | KEYSECRET | TELEGRAM …
-- Мягкое удаление колонкой deleted; уникальность способа на аккаунт.
CREATE TABLE IF NOT EXISTS "<SCHEMA-NAME>"."Credential" (
    id         uuid                   DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    account    uuid                   NOT NULL REFERENCES "<SCHEMA-NAME>"."Account"(id) ON UPDATE CASCADE ON DELETE CASCADE,
    category   character varying(255) DEFAULT 'EMAIL'::character varying NOT NULL,
    identifier character varying(255) NOT NULL,
    meta       jsonb                  DEFAULT '{}'::jsonb NOT NULL,
    confirmed  boolean                DEFAULT true NOT NULL,
    created    timestamptz            DEFAULT now() NOT NULL,
    updated    timestamptz            DEFAULT now() NOT NULL,
    deleted    timestamptz,
    CONSTRAINT credential_unique UNIQUE (account, category, identifier)
);
CREATE INDEX IF NOT EXISTS credential_account_idx ON "<SCHEMA-NAME>"."Credential" (account) WHERE deleted IS NULL;
-- Вход по identifier должен быть однозначен: один живой кред на (category, identifier) во всей схеме.
CREATE UNIQUE INDEX IF NOT EXISTS credential_identity_udx ON "<SCHEMA-NAME>"."Credential" (category, identifier) WHERE deleted IS NULL;

-- Именованные ресурсы ACL: субъекты ('authenticated:ACCOUNT') и объекты ('payment:API').
CREATE TABLE IF NOT EXISTS "<SCHEMA-NAME>"."Resource" (
    alias    character varying(255) NOT NULL PRIMARY KEY,
    category character varying(255) NOT NULL,
    pattern  jsonb,
    meta     jsonb
);

-- Правила ACL: субъект → объект → allow|deny (+вес). Оба конца — Resource.alias (как в дампе).
CREATE TABLE IF NOT EXISTS "<SCHEMA-NAME>"."Rule" (
    account    character varying(255) NOT NULL REFERENCES "<SCHEMA-NAME>"."Resource"(alias) ON UPDATE CASCADE ON DELETE CASCADE,
    resource   character varying(255) NOT NULL REFERENCES "<SCHEMA-NAME>"."Resource"(alias) ON UPDATE CASCADE ON DELETE CASCADE,
    permission character varying(255) NOT NULL,
    weight     integer,
    meta       jsonb,
    enabled    boolean DEFAULT true NOT NULL,
    PRIMARY KEY (account, resource)
);
-- END_BLOCK_AUTH_TABLES

-- -----------------------------------------------------------------------------
-- purge_account(): полный физический офбординг тенанта — все Entity (account|owner) + сам Account.
--   Credential уходит FK-каскадом (ON DELETE CASCADE). Флаг letopis.purge отключает entity_delete на
--   снос Entity (см. WHEN). Права/предохранители (Owner-only, последний Owner, не-себя) — в либе
--   (accounts.purge, им нужен ctx/ACL). Возвращает id снесённого Account либо NULL.
-- -----------------------------------------------------------------------------
-- START_CONTRACT: purge_account
--   PURPOSE: Физически стереть тенанта: все Entity с account|owner = id + сам Account (Credential — FK-каскад).
--   INPUTS: { p_id uuid }
--   OUTPUTS: { uuid - id снесённого Account, либо NULL если не найден }
--   SIDE_EFFECTS: SET LOCAL letopis.purge (отключает entity_delete); физический DELETE Entity + Account
--   LINKS: M-DDL, V-M-DDL, M-TABLES
-- END_CONTRACT: purge_account
CREATE OR REPLACE FUNCTION "<SCHEMA-NAME>".purge_account(p_id uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE gone uuid;
BEGIN
    PERFORM set_config('letopis.purge', 'on', true);   -- SET LOCAL: entity_delete отключён (см. WHEN)
    DELETE FROM "<SCHEMA-NAME>"."Entity" WHERE account = p_id OR owner = p_id;  -- обе оси (иначе entity_owner_fk RESTRICT)
    PERFORM set_config('letopis.purge', '', true);
    DELETE FROM "<SCHEMA-NAME>"."Account" WHERE id = p_id RETURNING id INTO gone;  -- Credential — FK-каскад
    RETURN gone;
END $$;

-- -----------------------------------------------------------------------------
-- Триггер 4: realtime — факт каждой новой версии в pg_notify (канал = имя схемы).
-- Payload лёгкий (без data): подписчик дочитывает нужное сам. Потребитель: db.watch().
-- -----------------------------------------------------------------------------
-- START_CONTRACT: entity_notify
--   PURPOSE: Опубликовать факт новой версии в pg_notify (канал = имя схемы), лёгкий payload без data.
--   INPUTS: { trigger: AFTER INSERT ON Entity (NEW) }
--   OUTPUTS: { NULL }
--   SIDE_EFFECTS: pg_notify(канал = имя схемы)
--   LINKS: M-DDL, V-M-DDL, M-CHAIN
-- END_CONTRACT: entity_notify
CREATE OR REPLACE FUNCTION "<SCHEMA-NAME>".entity_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- канал = имя схемы ЛИТЕРАЛОМ: триггер исполняется на чанке hypertable,
    -- где TG_TABLE_SCHEMA = '_timescaledb_internal' (apply.mjs заменяет литерал)
    PERFORM pg_notify('<SCHEMA-NAME>', json_build_object(
        'partition', NEW.partition, 'class', NEW.class, 'id', NEW.id,
        'updated', NEW.updated, 'deleted', NEW.deleted IS NOT NULL)::text);
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS entity_notify ON "<SCHEMA-NAME>"."Entity";
CREATE TRIGGER entity_notify
    AFTER INSERT ON "<SCHEMA-NAME>"."Entity"
    FOR EACH ROW EXECUTE FUNCTION "<SCHEMA-NAME>".entity_notify();

-- -----------------------------------------------------------------------------
-- Опционально (включать по мере роста данных):
--
-- Сжатие старых чанков (экономия на версиях занятости/записей):
--   ALTER TABLE "<SCHEMA-NAME>"."Entity" SET (
--       timescaledb.compress,
--       timescaledb.compress_segmentby = 'partition, class, id',
--       timescaledb.compress_orderby   = 'updated DESC'
--   );
--   SELECT add_compression_policy('"<SCHEMA-NAME>"."Entity"', INTERVAL '30 days');
--
-- Retention (если старые версии не нужны вечно):
--   SELECT add_retention_policy('"<SCHEMA-NAME>"."Entity"', INTERVAL '2 years');
-- -----------------------------------------------------------------------------
