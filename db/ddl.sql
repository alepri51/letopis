-- =============================================================================
-- Движок-хранилище: TimescaleDB, append-only.
-- В БД только: структура таблиц + индексы + триггеры ЦЕЛОСТНОСТИ.
-- Вся логика приложения (версии, каскады, локи, валидация data) — в либе letopis.
-- Идемпотентен: можно применять повторно.
-- "<SCHEMA-NAME>" — маркер: db/apply.mjs подставляет полное имя схемы vN.<имя> (--schema + --version).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE SCHEMA IF NOT EXISTS "<SCHEMA-NAME>";

-- -----------------------------------------------------------------------------
-- Schema: классы предметной области (HUB — сущности, LINK — связи).
-- Сидится из schema.booking.v2.json (db/seed.booking.sql).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "<SCHEMA-NAME>"."Schema" (
    partition  text   NOT NULL DEFAULT 'entity',
    id         text   NOT NULL,                  -- англ. id класса: 'Staff', 'skill'
    alias      text   NOT NULL,                  -- рус. алиас: 'Сотрудник', 'навык'
    category   text   NOT NULL CHECK (category IN ('HUB', 'LINK')),
    ancestor   text,                             -- прямой родитель (наследование)
    attributes jsonb  NOT NULL DEFAULT '{}',     -- fastest-validator DSL (валидирует либа)
    links      text[] NOT NULL DEFAULT '{}',     -- HUB: встраиваемые цели; LINK: обязательные концы ('Entity' = полиморфный)
    meta       jsonb  NOT NULL DEFAULT '{}',     -- {abstract?, description?}
    "order"    int    NOT NULL DEFAULT 0,
    ancestors   text[] NOT NULL DEFAULT '{}',    -- [self, parent, …, root] — считает триггер schema_lineage
    descendants text[] NOT NULL DEFAULT '{}',    -- все потомки (транзитивно)  — считает триггер schema_lineage
    PRIMARY KEY (partition, id)
);

-- -----------------------------------------------------------------------------
-- Триггер lineage: ancestors + descendants пересчитываются автоматически
-- при любом INSERT/UPDATE(ancestor,id)/DELETE в Schema (statement-level).
-- Рекурсивные CTE вверх и вниз; защита от циклов (depth ≤ 32) и от
-- саморекурсии триггера (pg_trigger_depth).
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- Триггер 1: целостность при INSERT (только проверки, никакой логики приложения).
--   * класс существует в Schema той же partition;
--   * класс не абстрактный;
--   * каждый ключ links — существующий класс, значение — строка (id);
--   * LINK содержит все обязательные концы из Schema.links
--     ('Entity' — полиморфный конец, его резолвит либа).
-- Tombstone-версии (deleted IS NOT NULL) не валидируются.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "<SCHEMA-NAME>".entity_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    s   RECORD;
    bad text;
    k   text;
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

    -- LINK: все объявленные концы обязаны присутствовать
    IF s.category = 'LINK' THEN
        FOREACH k IN ARRAY COALESCE(s.links, '{}') LOOP
            IF k <> 'Entity' AND NOT (COALESCE(NEW.links, '{}'::jsonb) ? k) THEN
                RAISE EXCEPTION 'ENTITY_CHECK: link "%" requires end "%"', NEW.class, k;
            END IF;
        END LOOP;
    END IF;

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
--   * физического удаления не происходит никогда (очистка истории — retention-политики).
-- Работает и для голого SQL: DELETE FROM "<SCHEMA-NAME>"."Entity" WHERE partition=… AND class=… AND id=…
-- -----------------------------------------------------------------------------
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
    FOR EACH ROW EXECUTE FUNCTION "<SCHEMA-NAME>".entity_delete();

-- =============================================================================
-- Служебные таблицы (auth/ACL) — перенесены из legacy-дампа 1:1.
-- Обычные таблицы: UPDATE/DELETE разрешены, версии не ведутся.
-- =============================================================================

-- Аккаунты: пользователи и сервисы. Категории: System | User | Anonymous | Shadow…
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

-- -----------------------------------------------------------------------------
-- Триггер 4: realtime — факт каждой новой версии в pg_notify (канал = имя схемы).
-- Payload лёгкий (без data): подписчик дочитывает нужное сам. Потребитель: db.watch().
-- -----------------------------------------------------------------------------
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
