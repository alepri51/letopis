--
-- PostgreSQL database dump
--

-- Dumped from database version 17.4
-- Dumped by pg_dump version 17.0

-- Started on 2025-11-08 16:00:53

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- TOC entry 40 (class 2615 OID 853592552)
-- Name: <SCHEMA-NAME>; Type: SCHEMA; Schema: -; Owner: doadmin
--

CREATE SCHEMA "<SCHEMA-NAME>";


ALTER SCHEMA "<SCHEMA-NAME>" OWNER TO doadmin;

--
-- TOC entry 1407 (class 1255 OID 853592580)
-- Name: entity_before(); Type: FUNCTION; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE FUNCTION "<SCHEMA-NAME>".entity_before() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
    schema_record RECORD;
    old_record RECORD;
    old_record_found BOOLEAN;
    history TEXT = NULL;
    status TEXT;
BEGIN
    -- ================================================================
    -- DELETE: Soft delete с каскадом
    -- ================================================================
    IF TG_OP = 'DELETE' THEN
        -- v4.0: Защита от race condition при параллельных DELETE
        -- pg_advisory_xact_lock блокирует на уровне (partition, id, class) комбинации
        -- Блокировка автоматически снимается при завершении транзакции
        PERFORM pg_advisory_xact_lock(
            ('x' || substr(md5(OLD.partition || '::DELETE::' || OLD.id || '::' || OLD.class), 1, 16))::bit(64)::bigint
        );

        -- Если deleted уже установлен - разрешаем физическое удаление
        -- Это позволяет очищать старые записи
        IF OLD.deleted IS NOT NULL THEN
            RETURN OLD;
        END IF;

        -- Soft delete: устанавливаем deleted вместо физического удаления
        OLD.deleted = NOW();
        OLD.updated = OLD.deleted;

        -- Вставляем обновленную запись обратно в таблицу
        INSERT INTO "<SCHEMA-NAME>"."Entity" VALUES (OLD.*);

        -- Каскадное soft-delete связанных записей
        -- Ищем записи где links содержит {OLD.class: OLD.id}
        -- Пример: DELETE Товар с id="uuid-123" → найдёт links={"Товар": "uuid-123", ...}
        -- Используем @> (containment) - эффективно использует GIN jsonb_path_ops индекс
        INSERT INTO "<SCHEMA-NAME>"."Entity" (partition, id, "class", "data", updated, account, tags, links, deleted)
        SELECT
            e.partition,
            e.id,
            e.class,
            e.data,
            OLD.updated,
            e.account,
            e.tags,
            e.links,
            OLD.deleted
        FROM "<SCHEMA-NAME>"."Entity:Actual" e
        WHERE e.partition = OLD.partition
          AND e.links @> jsonb_build_object(OLD.class, OLD.id);

        -- Уведомление об удалении через pg_notify
        PERFORM pg_notify(OLD.partition, json_build_object(
            'operation', 'DELETE',
            'schema', '"<SCHEMA-NAME>"',
            'partition', OLD.partition,
            'row', row_to_json(OLD)
        )::text);

        -- Возвращаем NULL для отмены физического удаления
        RETURN NULL;
    END IF;

    -- ================================================================
    -- INSERT и UPDATE: Общая валидация
    -- ================================================================

    -- Пропустить валидацию для уже удаленных записей
    -- Это критично для производительности при удалении связанных записей:
    -- при DELETE вставляются записи с NEW.deleted != NULL
    IF NEW.deleted IS NOT NULL THEN
        RETURN NEW;
    END IF;

    -- Загрузить запись схемы для валидации
    -- ВАЖНО: Фильтр по partition - схема загружается из той же партиции
    SELECT * INTO schema_record
    FROM "<SCHEMA-NAME>"."Schema"
    WHERE partition = NEW.partition
      AND id = NEW.class;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ENTITY_BEFORE(): Class "%" not found in Schema (partition: %)', NEW.class, NEW.partition;
    END IF;

    -- Проверка что класс не абстрактный
    IF schema_record.meta->>'abstract' = 'true' THEN
        RAISE EXCEPTION 'ENTITY_BEFORE(): Cannot create or modify object of abstract class "%"', schema_record.id;
    END IF;

    -- Установить data.id = NEW.id
    NEW.data = jsonb_set(NEW.data, '{id}', to_jsonb(NEW.id), true);

    -- ================================================================
    -- INSERT: UPSERT логика, account, updated, pg_notify
    -- ================================================================
    IF TG_OP = 'INSERT' THEN
        -- ВАЖНО: Защита от race condition при параллельных UPSERT
        -- pg_advisory_xact_lock блокирует на уровне (partition, id, class) комбинации
        -- Блокировка автоматически снимается при завершении транзакции
        -- Используем md5 hash для получения bigint из строки
        PERFORM pg_advisory_xact_lock(
            ('x' || substr(md5(NEW.partition || '::' || NEW.id || '::' || NEW.class), 1, 16))::bit(64)::bigint
        );

        -- Загрузить предыдущую запись с таким же partition, id и class
        -- Используем Entity:Actual (View с DISTINCT ON) вместо ORDER BY updated DESC
        SELECT * INTO old_record
        FROM "<SCHEMA-NAME>"."Entity:Actual"
        WHERE partition = NEW.partition
          AND id = NEW.id
          AND class = NEW.class
        LIMIT 1;

        -- Сохранить результат FOUND (перезаписывается каждым SQL запросом!)
        old_record_found := FOUND;

        -- Определить операцию (INSERT или UPDATE)
        IF old_record_found THEN
            status := 'UPDATE';
        ELSE
            status := 'INSERT';
        END IF;

        IF NEW.account IS NULL THEN
            NEW.account = COALESCE(
                old_record.account,
                (SELECT id FROM "<SCHEMA-NAME>"."Account" WHERE 'System' = ANY(categories) LIMIT 1)
            );
        END IF;

        IF NEW.owner IS NULL THEN
            NEW.owner = NEW.account;
        END IF;
        -- ================================================================
        -- ВЕРСИОНИРОВАНИЕ: Проверка schema.meta.history
        -- ================================================================
        -- Если это UPDATE (old_record существует) И schema.meta.history = false,
        -- выполняем UPDATE вместо INSERT (обновление без версий)

		IF NEW.class = 'EventLog' THEN
			SELECT data->>'history' INTO history
	        FROM "<SCHEMA-NAME>"."Entity:Actual"
	        WHERE id = NEW.id
	          AND class = 'Event'
	        LIMIT 1;

		END IF;

        IF old_record_found AND COALESCE(history, schema_record.meta->>'history', 'true')::boolean = false THEN
            NEW.updated = COALESCE((SELECT e.updated FROM "<SCHEMA-NAME>"."Entity:Actual" e WHERE e.partition = NEW.partition AND e.id = NEW.id AND e.class = NEW.class), NOW());

            -- Уведомление через pg_notify (отправляем после UPDATE)
            -- ВАЖНО: Используем GET DIAGNOSTICS для получения обновленной записи
            -- или упрощаем - просто отправляем уведомление с известными данными
            PERFORM pg_notify(NEW.partition, json_build_object(
                'operation', 'UPDATE',
                'schema', '"<SCHEMA-NAME>"',
                'partition', NEW.partition,
                'row', json_build_object(
                    'partition', NEW.partition,
                    'id', NEW.id,
                    'class', NEW.class,
                    'data', NEW.data,
                    'updated', NEW.updated,
                    'account', NEW.account,
                    'tags', array(SELECT DISTINCT unnest(old_record.tags || COALESCE(NEW.tags, ARRAY[]::text[])) ORDER BY 1),
                    'links', NEW.links,
                    'owner', old_record.owner,
                    'deleted', NULL
                ),
                'old', row_to_json(old_record)
            )::text);

            -- RETURN NEW позволяет ON CONFLICT сработать
            RETURN NEW;
        END IF;

        -- Установить updated > предыдущего
        -- ВАЖНО: Проверяем old_record_found перед сравнением, иначе NULL <= NULL = NULL (не TRUE)
        -- ОПТИМИЗАЦИЯ v3.0: GREATEST предотвращает коллизии timestamp при высокой параллельности
        IF old_record_found AND NEW.updated <= old_record.updated THEN
			NEW.updated = GREATEST(
				clock_timestamp(),
				old_record.updated + INTERVAL '1 microsecond'
			);
		ELSIF NOT old_record_found AND NEW.updated IS NULL THEN
			NEW.updated = clock_timestamp();
		END IF;

        -- Уведомление через pg_notify
        PERFORM pg_notify(NEW.partition, json_build_object(
            'operation', status,
            'schema', '"<SCHEMA-NAME>"',
            'partition', NEW.partition,
            'row', row_to_json(NEW),
            'old', CASE WHEN NOT old_record_found THEN NULL ELSE row_to_json(old_record) END
        )::text);

        RETURN NEW;
    END IF;

    -- ================================================================
    -- UPDATE: Проверка account, pg_notify
    -- ================================================================
    IF TG_OP = 'UPDATE' THEN
        -- v4.0: Запрет "воскрешения" deleted записей
        -- Если запись была удалена (OLD.deleted IS NOT NULL), нельзя установить deleted = NULL
        IF OLD.deleted IS NOT NULL AND NEW.deleted IS NULL THEN
            RAISE EXCEPTION 'ENTITY_BEFORE(): Resurrection forbidden: cannot set deleted to NULL for record %.%',
                OLD.class, OLD.id
                USING HINT = 'Use INSERT to create a new version instead of UPDATE';
        END IF;

        -- Защита от race condition при параллельных UPDATE
        -- pg_advisory_xact_lock блокирует на уровне (partition, id, class) комбинации
        PERFORM pg_advisory_xact_lock(
            ('x' || substr(md5(NEW.partition || '::' || NEW.id || '::' || NEW.class), 1, 16))::bit(64)::bigint
        );

        -- Проверка что account не NULL
        IF NEW.account IS NULL THEN
            RAISE EXCEPTION 'ENTITY_BEFORE(): Account cannot be NULL for UPDATE operation';
        END IF;

        -- Уведомление через pg_notify
        PERFORM pg_notify(NEW.partition, json_build_object(
            'operation', 'UPDATE',
            'schema', '"<SCHEMA-NAME>"',
            'partition', NEW.partition,
            'row', row_to_json(NEW),
            'old', row_to_json(OLD)
        )::text);

        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$_$;


ALTER FUNCTION "<SCHEMA-NAME>".entity_before() OWNER TO doadmin;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- TOC entry 1043 (class 1259 OID 853594495)
-- Name: Entity; Type: TABLE; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE TABLE "<SCHEMA-NAME>"."Entity" (
    partition text NOT NULL,
    id text NOT NULL,
    class text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb,
    updated timestamp with time zone DEFAULT now() NOT NULL,
    account uuid,
    tags text[] DEFAULT '{}'::text[],
    owner uuid,
    links jsonb,
    deleted timestamp with time zone
);


ALTER TABLE "<SCHEMA-NAME>"."Entity" OWNER TO doadmin;

--
-- TOC entry 6350 (class 0 OID 0)
-- Dependencies: 1043
-- Name: TABLE "Entity"; Type: COMMENT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

COMMENT ON TABLE "<SCHEMA-NAME>"."Entity" IS 'Unified storage for both entity and core data, partitioned by partition column';


--
-- TOC entry 6351 (class 0 OID 0)
-- Dependencies: 1043
-- Name: COLUMN "Entity".partition; Type: COMMENT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

COMMENT ON COLUMN "<SCHEMA-NAME>"."Entity".partition IS 'Data partition: entity (business domain) or core (system data)';


--
-- TOC entry 1018 (class 1259 OID 853592553)
-- Name: Account; Type: TABLE; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE TABLE "<SCHEMA-NAME>"."Account" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    categories character varying[] DEFAULT ARRAY['User'::text] NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    avatar character varying(255) DEFAULT ('https://i.pravatar.cc/128?img='::text || (floor(((70)::double precision * random())) + (1)::double precision)) NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created timestamp with time zone DEFAULT now() NOT NULL,
    updated timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE "<SCHEMA-NAME>"."Account" OWNER TO doadmin;

--
-- TOC entry 1021 (class 1259 OID 853592630)
-- Name: Credential; Type: TABLE; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE TABLE "<SCHEMA-NAME>"."Credential" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account uuid NOT NULL,
    category character varying(255) DEFAULT 'EMAIL'::character varying NOT NULL,
    identifier character varying(255) NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    confirmed boolean DEFAULT true NOT NULL,
    created timestamp with time zone DEFAULT now() NOT NULL,
    updated timestamp with time zone DEFAULT now() NOT NULL,
    deleted timestamp with time zone
);


ALTER TABLE "<SCHEMA-NAME>"."Credential" OWNER TO doadmin;

--
-- TOC entry 1044 (class 1259 OID 853594514)
-- Name: Entity:Raw; Type: VIEW; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE VIEW "<SCHEMA-NAME>"."Entity:Raw" AS
 SELECT DISTINCT ON (partition, id, class) partition,
    id,
    class,
    data,
    updated,
    account,
    tags,
    links,
    deleted,
    owner
   FROM "<SCHEMA-NAME>"."Entity"
  ORDER BY partition, id, class, updated DESC;


ALTER VIEW "<SCHEMA-NAME>"."Entity:Raw" OWNER TO doadmin;

--
-- TOC entry 6352 (class 0 OID 0)
-- Dependencies: 1044
-- Name: VIEW "Entity:Raw"; Type: COMMENT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

COMMENT ON VIEW "<SCHEMA-NAME>"."Entity:Raw" IS 'Latest version of each entity, includes deleted records';


--
-- TOC entry 1045 (class 1259 OID 853594519)
-- Name: Entity:Actual; Type: VIEW; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE VIEW "<SCHEMA-NAME>"."Entity:Actual" AS
 SELECT partition,
    id,
    class,
    data,
    updated,
    account,
    owner,
    tags,
    links
   FROM "<SCHEMA-NAME>"."Entity:Raw"
  WHERE (deleted IS NULL);


ALTER VIEW "<SCHEMA-NAME>"."Entity:Actual" OWNER TO doadmin;

--
-- TOC entry 6353 (class 0 OID 0)
-- Dependencies: 1045
-- Name: VIEW "Entity:Actual"; Type: COMMENT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

COMMENT ON VIEW "<SCHEMA-NAME>"."Entity:Actual" IS 'Active (not deleted) entities, latest version';


--
-- TOC entry 1020 (class 1259 OID 853592601)
-- Name: Resource; Type: TABLE; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE TABLE "<SCHEMA-NAME>"."Resource" (
    alias character varying(255) NOT NULL,
    category character varying(255) NOT NULL,
    pattern jsonb,
    meta jsonb
);


ALTER TABLE "<SCHEMA-NAME>"."Resource" OWNER TO doadmin;

--
-- TOC entry 1022 (class 1259 OID 853592686)
-- Name: Rule; Type: TABLE; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE TABLE "<SCHEMA-NAME>"."Rule" (
    account character varying(255) NOT NULL,
    resource character varying(255) NOT NULL,
    permission character varying(255) NOT NULL,
    weight integer,
    meta jsonb,
    enabled boolean DEFAULT true NOT NULL
);


ALTER TABLE "<SCHEMA-NAME>"."Rule" OWNER TO doadmin;

--
-- TOC entry 1054 (class 1259 OID 853594718)
-- Name: Schema; Type: TABLE; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE TABLE "<SCHEMA-NAME>"."Schema" (
    partition text DEFAULT 'entity'::text NOT NULL,
    id text NOT NULL,
    alias text NOT NULL,
    category text NOT NULL,
    ancestor text,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    links text[],
    "order" integer DEFAULT 0 NOT NULL,
    ancestors text[] DEFAULT '{}'::text[],
    CONSTRAINT "Schema_category_check" CHECK ((category = ANY (ARRAY['HUB'::text, 'LINK'::text])))
);


ALTER TABLE "<SCHEMA-NAME>"."Schema" OWNER TO doadmin;

--
-- TOC entry 6366 (class 0 OID 0)
-- Dependencies: 1054
-- Name: COLUMN "Schema".ancestors; Type: COMMENT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

COMMENT ON COLUMN "<SCHEMA-NAME>"."Schema".ancestors IS 'Полная цепочка наследования класса: [class_id, parent, grandparent, ..., root]. Вычисляется автоматически при INSERT/UPDATE через триггер.';


--
-- TOC entry 6338 (class 0 OID 853592553)
-- Dependencies: 1018
-- Data for Name: Account; Type: TABLE DATA; Schema: <SCHEMA-NAME>; Owner: doadmin
--

INSERT INTO "<SCHEMA-NAME>"."Account" VALUES ('2eba6d0a-1edd-4bb6-a85a-a703dab49035', '{System}', '{"id": "System", "name": "System"}', '{}', 'https://i.pravatar.cc/128?img=28', true, '2024-10-17 09:06:35.98+00', '2024-10-17 09:06:35.98+00');
INSERT INTO "<SCHEMA-NAME>"."Account" VALUES ('00fcd563-42f3-4b93-ba96-ab62d83ec570', '{User}', '{"name": "Test User", "email": "mychrome51@gmail.com"}', '{"language": "ru"}', 'https://i.pravatar.cc/128?img=41', true, '2025-09-30 13:16:47.362+00', '2025-09-30 13:16:47.362+00');
INSERT INTO "<SCHEMA-NAME>"."Account" VALUES ('a6da8a50-6b9b-43ec-9e5a-53cbc412b323', '{User}', '{"name": "Поддержка"}', '{"source": "telegram", "language": "ru"}', 'https://api.telegram.org/file/bot7406855898:AAFNGOrkXTWzfobRu6irzarCqgwKHy-9pME/photos/file_37.jpg', true, '2025-10-05 19:58:10.303+00', '2025-10-05 19:58:10.303+00');
INSERT INTO "<SCHEMA-NAME>"."Account" VALUES ('e574ac33-ab82-48c0-899a-5e9c497c1bd9', '{User}', '{"name": "Александр Привалов"}', '{"source": "telegram", "language": "ru"}', 'https://api.telegram.org/file/bot7633573702:AAFx_VYWOf5es_4muXh56IO5PYMJz95jJ70/photos/file_2.jpg', true, '2025-10-01 22:26:01.03+00', '2025-10-19 14:48:35.168003+00');


--
-- TOC entry 6341 (class 0 OID 853592630)
-- Dependencies: 1021
-- Data for Name: Credential; Type: TABLE DATA; Schema: <SCHEMA-NAME>; Owner: doadmin
--

INSERT INTO "<SCHEMA-NAME>"."Credential" VALUES ('49642ec7-f7af-4f7c-a454-918bfc51683b', '2eba6d0a-1edd-4bb6-a85a-a703dab49035', 'APIKEY', '27a0d56af1ffe538a82fe3a2ee8ccf9995efeda609c713b3dee4d5edaba1bb94', '{"key": "27a0d56af1ffe538a82fe3a2ee8ccf9995efeda609c713b3dee4d5edaba1bb94"}', true, '2025-01-28 20:35:37.067+00', '2025-01-28 20:35:37.067+00', NULL);
INSERT INTO "<SCHEMA-NAME>"."Credential" VALUES ('c435e946-e71c-4b1e-b3a6-41596932294a', '2eba6d0a-1edd-4bb6-a85a-a703dab49035', 'KEYSECRET', '7uurGO0x', '{"key": "7uurGO0x", "secret": "46c677001c58e956b3ce3e22c533d520bd46ba5c758693a293d5a5c5d0acf0be"}', true, '2025-01-28 20:35:37.158+00', '2025-01-28 20:35:37.158+00', NULL);
INSERT INTO "<SCHEMA-NAME>"."Credential" VALUES ('1eda2b51-87ee-4c6a-91ef-e27e82e081fe', 'a6da8a50-6b9b-43ec-9e5a-53cbc412b323', 'TELEGRAM', '1635246915', '{"username": "roboteza", "first_name": "Поддержка", "telegram_id": 1635246915}', true, '2025-10-05 19:58:10.375+00', '2025-10-05 19:58:10.375+00', NULL);
INSERT INTO "<SCHEMA-NAME>"."Credential" VALUES ('b9fea4f7-7250-4315-99cb-99e692de1c74', '00fcd563-42f3-4b93-ba96-ab62d83ec570', 'EMAILPASSWORD', 'mychrome51@gmail.com', '{"email": "mychrome51@gmail.com", "password": "$2b$12$u6utNfSbhLGwS1.02YqN4uZ3ZHyuqmRjH9rKhUcbLGRM0/C3zy6W2"}', true, '2025-09-30 13:16:47.432+00', '2025-09-30 16:15:36.714+00', NULL);
INSERT INTO "<SCHEMA-NAME>"."Credential" VALUES ('1222c961-c7e6-438f-b5e2-5f4143c18508', '00fcd563-42f3-4b93-ba96-ab62d83ec570', 'APIKEY', 'b71b14c7369f90924402e162d0e8e2cfa11e095a92cf346c13bb2a97e9e4c41a', '{"key": "b71b14c7369f90924402e162d0e8e2cfa11e095a92cf346c13bb2a97e9e4c41a", "name": "My Test API Key"}', true, '2025-09-30 16:17:19.239+00', '2025-09-30 16:17:19.239+00', NULL);
INSERT INTO "<SCHEMA-NAME>"."Credential" VALUES ('b155af32-f372-428c-9f44-930026299a82', '00fcd563-42f3-4b93-ba96-ab62d83ec570', 'KEYSECRET', '56PVMKCe', '{"key": "56PVMKCe", "name": "My Integration Key", "secret": "a6aaef893babef3d5ce073bf90798bcdd577b9d07663595f39eefc236b3ad2fc"}', true, '2025-09-30 16:17:53.981+00', '2025-09-30 16:17:53.981+00', NULL);
INSERT INTO "<SCHEMA-NAME>"."Credential" VALUES ('34159965-6c92-440f-84b8-005798c6e4ad', 'e574ac33-ab82-48c0-899a-5e9c497c1bd9', 'TELEGRAM', '201501423', '{"username": "indianakhalil", "last_name": "Привалов", "photo_url": "https://api.telegram.org/file/bot7633573702:AAFx_VYWOf5es_4muXh56IO5PYMJz95jJ70/photos/file_2.jpg", "first_name": "Александр", "telegram_id": 201501423}', true, '2025-10-01 22:26:01.103+00', '2025-10-19 14:48:35.15787+00', NULL);


--
-- TOC entry 6340 (class 0 OID 853592601)
-- Dependencies: 1020
-- Data for Name: Resource; Type: TABLE DATA; Schema: <SCHEMA-NAME>; Owner: doadmin
--

INSERT INTO "<SCHEMA-NAME>"."Resource" VALUES ('anonymous:ACCOUNT', 'ACCOUNT', '{"categories": "{Anonymous,Shadow}"}', '{"description": "Unauthenticated users (includes Anonymous and Shadow categories)"}');
INSERT INTO "<SCHEMA-NAME>"."Resource" VALUES ('authenticated:ACCOUNT', 'ACCOUNT', '{"categories": "!{Anonymous,Shadow}"}', '{"description": "Authenticated users (excludes Anonymous and Shadow)"}');
INSERT INTO "<SCHEMA-NAME>"."Resource" VALUES ('any:ACCOUNT', 'ACCOUNT', NULL, '{"description": "All account categories (no pattern = match all)"}');
INSERT INTO "<SCHEMA-NAME>"."Resource" VALUES ('auth.user.password:API', 'API', '{"endpoint": "v2.auth.password.change"}', '{"endpoints": ["v2.auth.password.change"], "description": "Change own password"}');
INSERT INTO "<SCHEMA-NAME>"."Resource" VALUES ('auth.user.session:API', 'API', '{"endpoint": "v2.auth.session.signout"}', '{"endpoints": ["v2.auth.session.signout"], "description": "Logout (revoke session)"}');
INSERT INTO "<SCHEMA-NAME>"."Resource" VALUES ('auth.user.apikey:API', 'API', '{"endpoint": "v2.auth.apikey.*"}', '{"endpoints": ["v2.auth.apikey.create", "v2.auth.apikey.list", "v2.auth.apikey.revoke"], "description": "Manage own API keys (auto-filtered by account)"}');
INSERT INTO "<SCHEMA-NAME>"."Resource" VALUES ('auth.user.basic:API', 'API', '{"endpoint": "v2.auth.basic.*"}', '{"endpoints": ["v2.auth.basic.create", "v2.auth.basic.list", "v2.auth.basic.revoke"], "description": "Manage own Basic Auth credentials (auto-filtered by account)"}');
INSERT INTO "<SCHEMA-NAME>"."Resource" VALUES ('any:API', 'API', NULL, '{"description": "All API endpoints (no pattern = match all, for default deny)"}');
INSERT INTO "<SCHEMA-NAME>"."Resource" VALUES ('chrono.user.events:API', 'API', '{"endpoint": "v2.chrono.*"}', '{"endpoint": "v2.chrono.*", "description": "User event management (auto-filtered by account)"}');
INSERT INTO "<SCHEMA-NAME>"."Resource" VALUES ('auth.anonymous:API', 'API', '{"endpoint": "v2.auth.password.{signup,signin,reset.*,email.*}"}', '{"endpoints": ["v2.auth.password.signup", "v2.auth.password.signin", "v2.auth.password.reset.request", "v2.auth.password.reset.complete", "v2.auth.password.email.verify", "v2.auth.password.email.resend"], "description": "Anonymous auth endpoints (signup, signin, reset, email verification)"}');
INSERT INTO "<SCHEMA-NAME>"."Resource" VALUES ('auth.telegram:API', 'API', '{"endpoint": "v2.auth.telegram.{initiate,poll}"}', '{"endpoints": ["v2.auth.telegram.initiate", "v2.auth.telegram.poll"], "description": "Telegram passwordless login (initiate, long polling)"}');
INSERT INTO "<SCHEMA-NAME>"."Resource" VALUES ('payment.callback:API', 'API', '{"endpoint": "v2.payment.callback.*"}', '{"endpoints": ["v2.payment.callback.yookassa", "v2.payment.callback.robokassa"], "description": "Payment provider webhooks (YOOKASSA, ROBOKASSA)"}');
INSERT INTO "<SCHEMA-NAME>"."Resource" VALUES ('shop:API', 'API', '{"endpoint": "<SCHEMA-NAME>.*"}', '{"description": "Resale demo endpoints1"}');
INSERT INTO "<SCHEMA-NAME>"."Resource" VALUES ('payment:API', 'API', '{"endpoint": "v2.payment.*"}', '{"endpoints": ["v2.payment.create"], "description": "Create payment (authenticated users only)"}');
INSERT INTO "<SCHEMA-NAME>"."Resource" VALUES ('billing:API', 'API', '{"endpoint": "v2.billing.*"}', NULL);
INSERT INTO "<SCHEMA-NAME>"."Resource" VALUES ('geo:API','API','{"endpoint": "v2.geo.*"}',NULL);


--
-- TOC entry 6342 (class 0 OID 853592686)
-- Dependencies: 1022
-- Data for Name: Rule; Type: TABLE DATA; Schema: <SCHEMA-NAME>; Owner: doadmin
--

INSERT INTO "<SCHEMA-NAME>"."Rule" VALUES ('authenticated:ACCOUNT', 'auth.user.password:API', 'allow', 90, '{"description": "Users can change their own password"}', true);
INSERT INTO "<SCHEMA-NAME>"."Rule" VALUES ('authenticated:ACCOUNT', 'auth.user.session:API', 'allow', 90, '{"description": "Users can logout (revoke their session)"}', true);
INSERT INTO "<SCHEMA-NAME>"."Rule" VALUES ('authenticated:ACCOUNT', 'auth.user.apikey:API', 'allow', 90, '{"description": "Users can manage their own API keys (service auto-filters by ctx.meta.$account.id)"}', true);
INSERT INTO "<SCHEMA-NAME>"."Rule" VALUES ('authenticated:ACCOUNT', 'auth.user.basic:API', 'allow', 90, '{"description": "Users can manage their own Basic Auth (service auto-filters by ctx.meta.$account.id)"}', true);
INSERT INTO "<SCHEMA-NAME>"."Rule" VALUES ('any:ACCOUNT', 'any:API', 'deny', 0, '{"code": 403, "message": "Access denied - default for any ACCOUNT to any API"}', true);
INSERT INTO "<SCHEMA-NAME>"."Rule" VALUES ('authenticated:ACCOUNT', 'chrono.user.events:API', 'allow', 90, '{"description": "Users can manage their own scheduled events (filtered by ctx.meta.$account.id)"}', true);
INSERT INTO "<SCHEMA-NAME>"."Rule" VALUES ('any:ACCOUNT', 'auth.anonymous:API', 'allow', 105, '{"description": "Anonymous users can signup, signin, reset password, use OTP"}', true);
INSERT INTO "<SCHEMA-NAME>"."Rule" VALUES ('anonymous:ACCOUNT', 'auth.telegram:API', 'allow', 105, '{"description": "Anonymous users can login via Telegram (initiate, poll)"}', true);
INSERT INTO "<SCHEMA-NAME>"."Rule" VALUES ('authenticated:ACCOUNT', 'payment:API', 'allow', 90, '{"description": "Users can create payments (uses ctx.meta.$account.id)"}', true);
INSERT INTO "<SCHEMA-NAME>"."Rule" VALUES ('authenticated:ACCOUNT', 'shop:API', 'allow', 90, '{"description": "Users can access resale"}', true);
INSERT INTO "<SCHEMA-NAME>"."Rule" VALUES ('authenticated:ACCOUNT', 'billing:API', 'allow', 90, '{"description": "Users can access billing (uses ctx.meta.$account.id)"}', true);
INSERT INTO "<SCHEMA-NAME>"."Rule" VALUES ('authenticated:ACCOUNT','geo:API','allow',90,'{"description": "Users can access billing (uses ctx.meta.$account.id)"}',true);


--
-- TOC entry 6344 (class 0 OID 853594718)
-- Dependencies: 1054
-- Data for Name: Schema; Type: TABLE DATA; Schema: <SCHEMA-NAME>; Owner: doadmin
--

INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('entity', 'Товар', 'Product', 'HUB', NULL, '{"id": "uuid", "sku": "string", "name": "string", "price": {"key": {"type": "enum", "values": ["RUB", "USD", "EUR"]}, "type": "record", "value": "number|integer"}, "category": "string|optional", "in_stock": {"type": "number", "default": 0, "integer": true}}', '{"abstract": false, "description": "Товар для продажи"}', '{}', 200, '{Товар}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('entity', 'Клиент', 'Customer', 'HUB', NULL, '{"id": "uuid", "name": "string", "email": "email|optional", "phone": "string", "balance": {"key": {"type": "enum", "values": ["RUB", "USD", "EUR"]}, "type": "record", "value": "number|integer", "default": {"RUB": 0}}, "loyalty_points": {"type": "number", "default": 0, "integer": true}}', '{"abstract": false, "description": "Клиент магазина"}', '{}', 300, '{Клиент}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('entity', 'Поставщик', 'Supplier', 'HUB', NULL, '{"id": "uuid", "name": "string", "email": "email|optional", "phone": "string", "rating": {"max": 5, "min": 0, "type": "number", "default": 0}, "contact_person": "string|optional"}', '{"abstract": false, "description": "Поставщик товаров"}', '{}', 400, '{Поставщик}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('entity', 'ассортимент', 'assortment', 'LINK', NULL, '{"id": "any", "quantity": {"type": "number", "default": 0, "integer": true}, "price_markup": {"type": "number", "default": 0}}', '{"abstract": false, "description": "Товар в ассортименте магазина"}', '{Магазин,Товар}', 500, '{ассортимент}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('entity', 'позиция-заказа', 'order-item', 'LINK', NULL, '{"id": "any", "price": {"key": {"type": "enum", "values": ["RUB", "USD", "EUR"]}, "type": "record", "value": "number|integer"}, "quantity": {"min": 1, "type": "number", "integer": true}}', '{"abstract": false, "description": "Позиция товара в заказе"}', '{Заказ,Товар}', 600, '{позиция-заказа}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('entity', 'поставка', 'supply', 'LINK', NULL, '{"id": "any", "cost": {"key": {"type": "enum", "values": ["RUB", "USD", "EUR"]}, "type": "record", "value": "number|integer"}, "quantity": {"min": 1, "type": "number", "integer": true}, "delivery_date": "string|optional"}', '{"abstract": false, "description": "Поставка товара от поставщика"}', '{Поставщик,Товар}', 700, '{поставка}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('entity', 'Заказ', 'Order', 'HUB', NULL, '{"id": "uuid", "status": {"type": "enum", "values": ["pending", "processing", "completed", "cancelled"], "default": "pending"}, "created_at": {"type": "string", "default": "now"}, "order_number": "string", "total_amount": {"key": {"type": "enum", "values": ["RUB", "USD", "EUR"]}, "type": "record", "value": "number|integer"}}', '{"abstract": false, "description": "Заказ клиента"}', '{Клиент}', 800, '{Заказ}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('entity', 'Магазин', 'Shop', 'HUB', NULL, '{"id": "uuid", "name": "string", "phone": "string|optional", "active": {"type": "boolean", "default": true}, "address": "string", "balance": {"key": {"type": "enum", "values": ["RUB", "USD", "EUR"]}, "type": "record", "value": "number|integer", "default": {"RUB": 0}}}', '{"abstract": false, "description": "Магазин - торговая точка"}', '{}', 100, '{Магазин}');

INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.billing', 'Bank', 'Банк', 'HUB', 'Contragent', '{"env": {"key": "string|uppercase", "type": "record", "value": "any"}, "provider": {"type": "enum", "values": ["ROBOKASSA", "YOOKASSA", "RUKASSA", "SELFWORK"]}}', '{}', '{}', 600, '{Bank,Contragent,Entity}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.billing', 'Entity', 'Сущность', 'HUB', NULL, '{"id": "any"}', '{"abstract": true}', NULL, 100, '{Entity}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.billing', 'Service', 'Сервис', 'HUB', 'Contragent', '{"id": "any", "name": "string", "balance": {"type": "object", "optional": true}, "webhook": {"type": "string", "optional": true}}', '{}', '{}', 500, '{Service,Contragent,Entity}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.billing', 'Subscription', 'Подписка', 'HUB', 'Tariff', '{}', '{}', '{Tariff}', 800, '{Subscription,Tariff,Entity}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.billing', 'Tariff', 'Тариф', 'HUB', 'Entity', '{"name": "string", "default": "boolean|default:false"}', '{}', '{}', 300, '{Tariff,Entity}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.billing', 'bonus', 'бонус', 'LINK', 'transaction', '{"id": "any"}', '{}', '{Service,Client}', 700, '{bonus,transaction,link}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.billing', 'charge', 'списание', 'LINK', 'transaction', '{"id": "any"}', '{}', '{Client,Service}', 600, '{charge,transaction,link}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.billing', 'deposit', 'депозит', 'LINK', 'transaction', '{}', '{}', '{Client,Bank}', 500, '{deposit,transaction,link}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.billing', 'link', 'связь', 'LINK', NULL, '{"id": "any"}', '{"abstract": true}', '{Entity,Entity}', 100, '{link}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.billing', 'option', 'опция', 'LINK', 'link', '{"id": "any", "price": {"key": {"type": "enum", "values": ["RUB", "USD", "AED", "EUR"]}, "type": "record", "value": "number|integer|positive"}, "expires": "number|default:0", "schedule": "string"}', '{}', '{Tariff,Tool}', 200, '{option,link}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.billing', 'payment', 'платеж', 'LINK', 'transaction', '{"payment": "object", "provider": {"type": "enum", "values": ["ROBOKASSA", "YOOKASSA", "RUKASSA", "SELFWORK"]}}', '{}', '{Client,Bank}', 400, '{payment,transaction,link}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.billing', 'transaction', 'транзакция', 'LINK', 'link', '{"id": "uuid", "value": {"key": {"type": "enum", "values": ["RUB", "USD", "AED", "EUR"]}, "type": "record", "value": "number|integer|min:0"}, "description": "string|optional"}', '{"abstract": true}', '{}', 300, '{transaction,link}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.billing', 'Client', 'Клиент', 'HUB', 'Contragent', '{"active": "boolean|default:true", "webhook": [{"type": "object", "props": {"url": "string", "data": "object|optional", "method": {"type": "string", "default": "GET", "uppercase": true}, "headers": "object|optional"}, "optional": true}, {"type": "string", "empty": false, "optional": true}], "min_balance": {"key": {"type": "enum", "values": ["RUB", "USD", "AED", "EUR"]}, "type": "record", "value": "number", "optional": true}}', '{}', '{Subscription}', 700, '{Client,Contragent,Entity}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.billing', 'Contragent', 'Контрагент', 'HUB', 'Entity', '{"name": "string", "balance": {"key": {"type": "enum", "values": ["RUB", "USD", "AED", "EUR"]}, "type": "record", "value": "number", "default": {"RUB": 0}}}', '{"abstract": true}', NULL, 200, '{Contragent}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.billing', 'Tool', 'Инструмент', 'HUB', 'Entity', '{"alias": "string|empty:false", "category": {"type": "enum", "values": ["interface", "system"], "default": "interface"}, "description": "string|optional"}', '{}', '{}', 400, '{Tool,Entity}');

INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.chrono', 'EventLog', 'Лог', 'HUB', NULL, '{"id": "any", "executed_at": "string", "error_message": "any|optional", "response_code": "any", "response_data": "any|optional"}', '{"history": true, "abstract": false, "description": "Результат выполнения события"}', '{}', 200, '{EventLog}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.chrono', 'Event', 'Событие', 'HUB', NULL, '{"id": "string", "meta": {"type": "object", "default": {}}, "stop": [{"type": "string", "optional": true}, {"type": "number", "optional": true}], "start": [{"type": "string", "optional": true}, {"type": "number", "optional": true}], "history": "boolean|optional:true", "pattern": [{"type": "number"}, {"type": "string", "empty": false}], "webhook": [{"type": "object", "props": {"url": "string", "data": "object|optional", "method": {"type": "string", "default": "GET", "uppercase": true}, "headers": "object|optional"}}, {"type": "string", "empty": false}], "next_run": {"type": "number", "optional": true}, "timezone": {"type": "string", "default": "Europe/Moscow"}}', '{"history": false, "abstract": false, "description": "Событие сервиса Chrono"}', '{}', 100, '{Event}');

INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.geo', 'Toponym', 'Топоним', 'HUB', NULL, '{"id": "uuid", "name": "string", "type": "string", "type_short": "string|optional", "meta": "object|optional"}', '{"history": false, "abstract": false, "description": "Топоним - промежуточный адресный объект (страна, регион, город, улица, метро)"}', '{Toponym}', 100, '{Toponym}');
INSERT INTO "<SCHEMA-NAME>"."Schema" VALUES ('core.geo', 'Address', 'Адрес', 'HUB', 'Toponym', '{}', '{"history": false, "abstract": false, "description": "Адрес - листовой узел цепочки (квартира, комната, дом, гараж) с полными реквизитами DaData"}', '{Toponym}', 200, '{Address,Toponym}');

--
-- TOC entry 6092 (class 2606 OID 853592567)
-- Name: Account Account_pkey; Type: CONSTRAINT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

ALTER TABLE ONLY "<SCHEMA-NAME>"."Account"
    ADD CONSTRAINT "Account_pkey" PRIMARY KEY (id);


--
-- TOC entry 6103 (class 2606 OID 853592642)
-- Name: Credential Credential_pkey; Type: CONSTRAINT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

ALTER TABLE ONLY "<SCHEMA-NAME>"."Credential"
    ADD CONSTRAINT "Credential_pkey" PRIMARY KEY (id);


--
-- TOC entry 6115 (class 2606 OID 853594504)
-- Name: Entity Entity_pkey; Type: CONSTRAINT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

ALTER TABLE ONLY "<SCHEMA-NAME>"."Entity"
    ADD CONSTRAINT "Entity_pkey" PRIMARY KEY (partition, class, id, updated);


--
-- TOC entry 6101 (class 2606 OID 853592607)
-- Name: Resource Resource_pkey; Type: CONSTRAINT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

ALTER TABLE ONLY "<SCHEMA-NAME>"."Resource"
    ADD CONSTRAINT "Resource_pkey" PRIMARY KEY (alias);


--
-- TOC entry 6107 (class 2606 OID 853592693)
-- Name: Rule Rule_pkey; Type: CONSTRAINT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

ALTER TABLE ONLY "<SCHEMA-NAME>"."Rule"
    ADD CONSTRAINT "Rule_pkey" PRIMARY KEY (account, resource);


--
-- TOC entry 6120 (class 2606 OID 853594729)
-- Name: Schema Schema_pkey; Type: CONSTRAINT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

ALTER TABLE ONLY "<SCHEMA-NAME>"."Schema"
    ADD CONSTRAINT "Schema_pkey" PRIMARY KEY (partition, id);


--
-- TOC entry 6105 (class 2606 OID 853592644)
-- Name: Credential credential_unique; Type: CONSTRAINT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

ALTER TABLE ONLY "<SCHEMA-NAME>"."Credential"
    ADD CONSTRAINT credential_unique UNIQUE (account, category, identifier);


--
-- TOC entry 6108 (class 1259 OID 853594513)
-- Name: Entity_account_deleted_idx; Type: INDEX; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE INDEX "Entity_account_deleted_idx" ON "<SCHEMA-NAME>"."Entity" USING btree (account, deleted) WHERE (deleted IS NULL);


--
-- TOC entry 6109 (class 1259 OID 853594511)
-- Name: Entity_account_idx; Type: INDEX; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE INDEX "Entity_account_idx" ON "<SCHEMA-NAME>"."Entity" USING btree (account);


--
-- TOC entry 6367 (class 0 OID 0)
-- Dependencies: 6109
-- Name: INDEX "Entity_account_idx"; Type: COMMENT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

COMMENT ON INDEX "<SCHEMA-NAME>"."Entity_account_idx" IS 'Index for filtering by account';


--
-- TOC entry 6110 (class 1259 OID 853594508)
-- Name: Entity_data_idx; Type: INDEX; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE INDEX "Entity_data_idx" ON "<SCHEMA-NAME>"."Entity" USING gin (data jsonb_path_ops);


--
-- TOC entry 6368 (class 0 OID 0)
-- Dependencies: 6110
-- Name: INDEX "Entity_data_idx"; Type: COMMENT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

COMMENT ON INDEX "<SCHEMA-NAME>"."Entity_data_idx" IS 'JSONB containment search in data column using jsonb_path_ops';


--
-- TOC entry 6111 (class 1259 OID 853594510)
-- Name: Entity_deleted_idx; Type: INDEX; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE INDEX "Entity_deleted_idx" ON "<SCHEMA-NAME>"."Entity" USING btree (deleted) WHERE (deleted IS NULL);


--
-- TOC entry 6369 (class 0 OID 0)
-- Dependencies: 6111
-- Name: INDEX "Entity_deleted_idx"; Type: COMMENT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

COMMENT ON INDEX "<SCHEMA-NAME>"."Entity_deleted_idx" IS 'Partial index for active (non-deleted) records';


--
-- TOC entry 6112 (class 1259 OID 853594509)
-- Name: Entity_links_idx; Type: INDEX; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE INDEX "Entity_links_idx" ON "<SCHEMA-NAME>"."Entity" USING gin (links jsonb_path_ops);


--
-- TOC entry 6370 (class 0 OID 0)
-- Dependencies: 6112
-- Name: INDEX "Entity_links_idx"; Type: COMMENT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

COMMENT ON INDEX "<SCHEMA-NAME>"."Entity_links_idx" IS 'JSONB containment search in links column using jsonb_path_ops';


--
-- TOC entry 6113 (class 1259 OID 853594506)
-- Name: Entity_partition_updated_idx; Type: INDEX; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE INDEX "Entity_partition_updated_idx" ON "<SCHEMA-NAME>"."Entity" USING btree (partition, updated DESC);


--
-- TOC entry 6116 (class 1259 OID 853594512)
-- Name: Entity_tags_idx; Type: INDEX; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE INDEX "Entity_tags_idx" ON "<SCHEMA-NAME>"."Entity" USING gin (tags);


--
-- TOC entry 6371 (class 0 OID 0)
-- Dependencies: 6116
-- Name: INDEX "Entity_tags_idx"; Type: COMMENT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

COMMENT ON INDEX "<SCHEMA-NAME>"."Entity_tags_idx" IS 'GIN index for array operations on tags';


--
-- TOC entry 6117 (class 1259 OID 853594505)
-- Name: Entity_updated_idx; Type: INDEX; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE INDEX "Entity_updated_idx" ON "<SCHEMA-NAME>"."Entity" USING btree (updated DESC);


--
-- TOC entry 6118 (class 1259 OID 853594730)
-- Name: Schema_partition_category_idx; Type: INDEX; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE INDEX "Schema_partition_category_idx" ON "<SCHEMA-NAME>"."Schema" USING btree (partition, category);


--
-- TOC entry 6124 (class 2620 OID 853594691)
-- Name: Entity entity_before_delete; Type: TRIGGER; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE TRIGGER entity_before_delete BEFORE DELETE ON "<SCHEMA-NAME>"."Entity" FOR EACH ROW EXECUTE FUNCTION "<SCHEMA-NAME>".entity_before();


--
-- TOC entry 6125 (class 2620 OID 853594700)
-- Name: Entity entity_before_insert; Type: TRIGGER; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE TRIGGER entity_before_insert BEFORE INSERT ON "<SCHEMA-NAME>"."Entity" FOR EACH ROW EXECUTE FUNCTION "<SCHEMA-NAME>".entity_before();


--
-- TOC entry 6126 (class 2620 OID 853594709)
-- Name: Entity entity_before_update; Type: TRIGGER; Schema: <SCHEMA-NAME>; Owner: doadmin
--

CREATE TRIGGER entity_before_update BEFORE UPDATE ON "<SCHEMA-NAME>"."Entity" FOR EACH ROW EXECUTE FUNCTION "<SCHEMA-NAME>".entity_before();

--
-- TOC entry 6121 (class 2606 OID 853592645)
-- Name: Credential credential_account_fk; Type: FK CONSTRAINT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

ALTER TABLE ONLY "<SCHEMA-NAME>"."Credential"
    ADD CONSTRAINT credential_account_fk FOREIGN KEY (account) REFERENCES "<SCHEMA-NAME>"."Account"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 6122 (class 2606 OID 853592694)
-- Name: Rule rule_resource_fk; Type: FK CONSTRAINT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

ALTER TABLE ONLY "<SCHEMA-NAME>"."Rule"
    ADD CONSTRAINT rule_resource_fk FOREIGN KEY (account) REFERENCES "<SCHEMA-NAME>"."Resource"(alias) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- TOC entry 6123 (class 2606 OID 853592699)
-- Name: Rule rule_resource_fk_1; Type: FK CONSTRAINT; Schema: <SCHEMA-NAME>; Owner: doadmin
--

ALTER TABLE ONLY "<SCHEMA-NAME>"."Rule"
    ADD CONSTRAINT rule_resource_fk_1 FOREIGN KEY (resource) REFERENCES "<SCHEMA-NAME>"."Resource"(alias) ON UPDATE CASCADE ON DELETE CASCADE;


-- Completed on 2025-11-08 16:00:53

--
-- PostgreSQL database dump complete
--

-- ПЕРЕКЛЮЧИТЬ СХЕМУ И ЗАПУСТИТЬ СКРИПТ НИЖЕ
SET search_path TO "public";

SELECT create_hypertable(
    '"<SCHEMA-NAME>"."Entity"',    -- Таблица, которую нужно преобразовать
    'updated',                -- Временная колонка
    partitioning_column => 'class',
    migrate_data => true,
    number_partitions => 128,
    chunk_time_interval => INTERVAL '7 days'
);

--ALTER TABLE "<SCHEMA-NAME>"."Entity" SET (timescaledb.compress, timescaledb.compress_segmentby = 'id, class', timescaledb.compress_orderby = 'updated DESC');

--SELECT * FROM timescaledb_information.hypertables;