-- =============================================================================
-- Движок-хранилище: TimescaleDB, append-only.
-- В БД только: структура таблиц + индексы + триггеры ЦЕЛОСТНОСТИ.
-- Вся логика приложения (версии, каскады, локи, валидация data) — в либе entity-chain.
-- Идемпотентен: можно применять повторно.
-- Для другой PG-схемы замените "booking" на своё имя.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE SCHEMA IF NOT EXISTS "booking";

-- -----------------------------------------------------------------------------
-- Schema: классы предметной области (HUB — сущности, LINK — связи).
-- Сидится из schema.booking.v2.json (db/seed.booking.sql).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "booking"."Schema" (
    partition  text   NOT NULL DEFAULT 'entity',
    id         text   NOT NULL,                  -- англ. id класса: 'Staff', 'skill'
    alias      text   NOT NULL,                  -- рус. алиас: 'Сотрудник', 'навык'
    category   text   NOT NULL CHECK (category IN ('HUB', 'LINK')),
    ancestor   text,                             -- прямой родитель (наследование)
    attributes jsonb  NOT NULL DEFAULT '{}',     -- fastest-validator DSL (валидирует либа)
    links      text[] NOT NULL DEFAULT '{}',     -- HUB: встраиваемые цели; LINK: обязательные концы ('Entity' = полиморфный)
    meta       jsonb  NOT NULL DEFAULT '{}',     -- {abstract?, description?}
    "order"    int    NOT NULL DEFAULT 0,
    ancestors  text[] NOT NULL DEFAULT '{}',     -- полная цепочка наследования (заполняет сид/либа)
    PRIMARY KEY (partition, id)
);

-- -----------------------------------------------------------------------------
-- Entity: единое хранилище сущностей и связей. Append-only hypertable.
-- Версия = строка; актуальная версия = max(updated); удаление = tombstone (deleted).
-- links = {"Класс": "id", ...} — произвольное число ссылок в одной строке.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "booking"."Entity" (
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
        REFERENCES "booking"."Schema"(partition, id)
        ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Партиционирование по (partition, class, id, updated):
--   updated — временная размерность (чанки по 30 дней),
--   partition / class / id — hash-размерности (число партиций подстроить под нагрузку).
-- PK (partition, class, id, updated) содержит все размерности — требование Timescale выполнено.
SELECT create_hypertable(
    '"booking"."Entity"', 'updated',
    chunk_time_interval => INTERVAL '30 days',
    if_not_exists       => TRUE,
    migrate_data        => TRUE
);
SELECT add_dimension('"booking"."Entity"', 'partition', number_partitions => 2,  if_not_exists => TRUE);
SELECT add_dimension('"booking"."Entity"', 'class',     number_partitions => 8,  if_not_exists => TRUE);
SELECT add_dimension('"booking"."Entity"', 'id',        number_partitions => 8,  if_not_exists => TRUE);

-- Индексы: «последняя версия», обход графа, фильтры, теги, арендатор/владелец.
-- account/owner — полные (не partial): нужны и фильтрам $account/$owner, и RI-сканам FK.
CREATE INDEX IF NOT EXISTS entity_latest_idx  ON "booking"."Entity" (partition, class, id, updated DESC);
CREATE INDEX IF NOT EXISTS entity_links_idx   ON "booking"."Entity" USING gin (links jsonb_path_ops);
CREATE INDEX IF NOT EXISTS entity_data_idx    ON "booking"."Entity" USING gin (data  jsonb_path_ops);
CREATE INDEX IF NOT EXISTS entity_tags_idx    ON "booking"."Entity" USING gin (tags);
CREATE INDEX IF NOT EXISTS entity_account_idx ON "booking"."Entity" (account);
CREATE INDEX IF NOT EXISTS entity_owner_idx   ON "booking"."Entity" (owner);

-- -----------------------------------------------------------------------------
-- Триггер 1: целостность при INSERT (только проверки, никакой логики приложения).
--   * класс существует в Schema той же partition;
--   * класс не абстрактный;
--   * каждый ключ links — существующий класс, значение — строка (id);
--   * LINK содержит все обязательные концы из Schema.links
--     ('Entity' — полиморфный конец, его резолвит либа).
-- Tombstone-версии (deleted IS NOT NULL) не валидируются.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "booking".entity_check() RETURNS trigger
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
    FROM "booking"."Schema"
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
            SELECT 1 FROM "booking"."Schema" c
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

DROP TRIGGER IF EXISTS entity_check ON "booking"."Entity";
CREATE TRIGGER entity_check
    BEFORE INSERT ON "booking"."Entity"
    FOR EACH ROW EXECUTE FUNCTION "booking".entity_check();

-- -----------------------------------------------------------------------------
-- Триггер 2: enforce append-only — физические UPDATE/DELETE запрещены.
-- Новая версия / tombstone — только INSERT (делает либа).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "booking".entity_readonly() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ENTITY is append-only: use INSERT (new version / tombstone)';
END $$;

DROP TRIGGER IF EXISTS entity_no_update ON "booking"."Entity";
CREATE TRIGGER entity_no_update
    BEFORE UPDATE OR DELETE ON "booking"."Entity"
    FOR EACH ROW EXECUTE FUNCTION "booking".entity_readonly();

-- =============================================================================
-- Служебные таблицы (auth/ACL) — перенесены из legacy-дампа 1:1.
-- Обычные таблицы: UPDATE/DELETE разрешены, версии не ведутся.
-- =============================================================================

-- Аккаунты: пользователи и сервисы. Категории: System | User | Anonymous | Shadow…
CREATE TABLE IF NOT EXISTS "booking"."Account" (
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
ALTER TABLE "booking"."Entity" DROP CONSTRAINT IF EXISTS entity_account_fk;
ALTER TABLE "booking"."Entity" ADD CONSTRAINT entity_account_fk
    FOREIGN KEY (account) REFERENCES "booking"."Account"(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE "booking"."Entity" DROP CONSTRAINT IF EXISTS entity_owner_fk;
ALTER TABLE "booking"."Entity" ADD CONSTRAINT entity_owner_fk
    FOREIGN KEY (owner) REFERENCES "booking"."Account"(id) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- Способы входа аккаунта: EMAILPASSWORD | APIKEY | KEYSECRET | TELEGRAM …
-- Мягкое удаление колонкой deleted; уникальность способа на аккаунт.
CREATE TABLE IF NOT EXISTS "booking"."Credential" (
    id         uuid                   DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    account    uuid                   NOT NULL REFERENCES "booking"."Account"(id) ON UPDATE CASCADE ON DELETE CASCADE,
    category   character varying(255) DEFAULT 'EMAIL'::character varying NOT NULL,
    identifier character varying(255) NOT NULL,
    meta       jsonb                  DEFAULT '{}'::jsonb NOT NULL,
    confirmed  boolean                DEFAULT true NOT NULL,
    created    timestamptz            DEFAULT now() NOT NULL,
    updated    timestamptz            DEFAULT now() NOT NULL,
    deleted    timestamptz,
    CONSTRAINT credential_unique UNIQUE (account, category, identifier)
);
CREATE INDEX IF NOT EXISTS credential_account_idx ON "booking"."Credential" (account) WHERE deleted IS NULL;

-- Именованные ресурсы ACL: субъекты ('authenticated:ACCOUNT') и объекты ('payment:API').
CREATE TABLE IF NOT EXISTS "booking"."Resource" (
    alias    character varying(255) NOT NULL PRIMARY KEY,
    category character varying(255) NOT NULL,
    pattern  jsonb,
    meta     jsonb
);

-- Правила ACL: субъект → объект → allow|deny (+вес). Оба конца — Resource.alias (как в дампе).
CREATE TABLE IF NOT EXISTS "booking"."Rule" (
    account    character varying(255) NOT NULL REFERENCES "booking"."Resource"(alias) ON UPDATE CASCADE ON DELETE CASCADE,
    resource   character varying(255) NOT NULL REFERENCES "booking"."Resource"(alias) ON UPDATE CASCADE ON DELETE CASCADE,
    permission character varying(255) NOT NULL,
    weight     integer,
    meta       jsonb,
    enabled    boolean DEFAULT true NOT NULL,
    PRIMARY KEY (account, resource)
);

-- -----------------------------------------------------------------------------
-- Опционально (включать по мере роста данных):
--
-- Сжатие старых чанков (экономия на версиях занятости/записей):
--   ALTER TABLE "booking"."Entity" SET (
--       timescaledb.compress,
--       timescaledb.compress_segmentby = 'partition, class, id',
--       timescaledb.compress_orderby   = 'updated DESC'
--   );
--   SELECT add_compression_policy('"booking"."Entity"', INTERVAL '30 days');
--
-- Retention (если старые версии не нужны вечно):
--   SELECT add_retention_policy('"booking"."Entity"', INTERVAL '2 years');
-- -----------------------------------------------------------------------------
