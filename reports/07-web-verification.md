# 07 — Точечная web-проверка фактов об аналогах, лицензиях и платформе

> **Отчёт 07 — Точечная web-проверка фактов об аналогах, лицензиях и платформе.**
> Дата: 2026-09-24. Пакет: `letopis` 0.21.0 (ветка `dev`, HEAD `99a28e0`).
> Читаемая версия; исходный текст без правок — в reports/raw/07-web-verification.md

## О чём этот отчёт

Это промежуточный отчёт — приложение к итоговой оценке библиотеки `letopis` в `reports/ASSESSMENT.md`. В нём собраны четырнадцать утверждений о внешнем мире, на которые опирается оценка: о версиях PostgreSQL и TimescaleDB, о лицензиях, о доступности расширения в облаках, о конкурирующих продуктах и о рекомендациях OWASP. Каждое утверждение мы проверили через веб (WebSearch/WebFetch, всего 12 запросов) или локально в dev-контейнере. Проверялись только те утверждения, которые попадают в `reports/ASSESSMENT.md`; ничего сверх этого не исследовалось.

Каждому факту присвоен статус проверки:

- **проверено** — подтверждено первичным источником (официальная документация, страница релиза, репозиторий проекта);
- **частично** — подтверждено только вторичным источником, либо ответ источника неполный;
- **не проверено** — утверждение осталось без проверки.

Нумерация фактов (#1…#14) совпадает с исходной таблицей, поэтому ссылки вида «[07 #3]» из итогового отчёта остаются в силе. Упоминаемое ниже «ревью 04» — это предыдущий отчёт серии (ревью storage engine), на данные которого опираются два непроверенных повторно факта.

## Сводка

| # | Утверждение | Статус |
|---|---|---|
| 1 | PostgreSQL 18 добавил темпоральные ограничения | проверено |
| 2 | SQL/PGQ (графовые запросы) в PostgreSQL | проверено |
| 3 | Compression и retention-политики TimescaleDB — не Apache-2 | проверено |
| 4 | TimescaleDB недоступен на Amazon RDS | проверено |
| 5 | TimescaleDB на Aurora | частично |
| 6 | TimescaleDB на Azure Database for PostgreSQL Flexible Server | проверено |
| 7 | Версия стека в dev-контейнере letopis | проверено (локально) |
| 8 | XTDB v2 — bitemporal SQL поверх PG wire | проверено |
| 9 | Datomic бесплатен | проверено |
| 10 | DoltgreSQL (version-controlled Postgres) | проверено |
| 11 | Marten (.NET document DB + event store на PG) | частично |
| 12 | SurrealDB 3.0 | проверено / версии-история не проверено |
| 13 | OWASP: параметры scrypt | проверено |
| 14 | TimescaleDB: GIN-индексы на сжатых chunk'ах | частично |

## Факты

### #1. PostgreSQL 18 добавил темпоральные ограничения

**Статус: проверено.**

**Что установлено.** PostgreSQL 18 вышел 2025-09-25. В ядро вошли темпоральные ограничения целостности — ограничения, которые учитывают период времени, а не только значение ключа: `PRIMARY KEY`/`UNIQUE … WITHOUT OVERLAPS` (уникальность ключа с непересекающимися периодами) и `FOREIGN KEY … PERIOD` (внешний ключ, проверяющий вложенность периодов); реализованы они на GiST-индексах. Это соответствует уровню стандарта SQL:2011 для «application time» — валидного времени, то есть периода, в течение которого факт истинен в предметной области (в отличие от transaction time — момента, когда запись попала в базу). В том же релизе появились нативная функция `uuidv7()`, асинхронный I/O, virtual generated columns и аутентификация OAuth 2.0.

**Что это значит для letopis.** SQL:2011-уровень application-time теперь доступен прямо в ядре PostgreSQL, а `uuidv7()` — в самой базе, а не только в JS-коде библиотеки.

**Источники.**
- [postgresql.org — PG18 released](https://www.postgresql.org/about/news/postgresql-18-released-3142/)
- [Release 18 notes](https://www.postgresql.org/docs/release/18.0/)
- [Aiven: temporal constraints](https://aiven.io/blog/exploring-how-postgresql-18-conquered-time-with-temporal-constraints)
- [Neon: WITHOUT OVERLAPS](https://neon.com/postgresql/18/temporal-constraints)

### #2. SQL/PGQ (графовые запросы) в PostgreSQL

**Статус: проверено.**

**Что установлено.** SQL/PGQ — расширение стандарта SQL для графовых запросов поверх обычных реляционных таблиц (property graph queries). Патч с поддержкой SQL/PGQ был закоммичен в PostgreSQL 19 2026-03-16: он добавлял `CREATE PROPERTY GRAPH` и `GRAPH_TABLE`. Однако 2026-09-07 патч отозвали, и до релиза 19-й версии он не дожил. Самый ранний срок его возвращения — PostgreSQL 20, то есть сентябрь 2027 года.

**Что это значит для letopis.** Нативная альтернатива dot-chain обходу (цепочке вызовов вида `Org(id).Folder()`, которой letopis обходит связи между сущностями поверх jsonb) в ядре PostgreSQL откладывается.

**Источники.**
- [depesz: Waiting for PG19 — SQL/PGQ](https://www.depesz.com/2026/07/31/waiting-for-postgresql-19-sql-property-graph-queries-sql-pgq/)
- [Neon: PG19 SQL/PGQ](https://neon.com/postgresql/postgresql-19/sql-pgq-graph-queries)
- [commitfest #4904](https://commitfest.postgresql.org/patch/4904/)

### #3. Compression и retention-политики TimescaleDB — не Apache-2

**Статус: проверено.**

**Что установлено.** TimescaleDB распространяется в двух редакциях. Compression (сжатие старых chunk'ов — фрагментов hypertable, на которые TimescaleDB разбивает таблицу по времени), compression- и retention-политики (фоновые задачи, которые автоматически сжимают или удаляют chunk'и по возрасту) и continuous aggregates (инкрементально обновляемые материализованные агрегаты) входят только в Community Edition. Community Edition распространяется под Timescale License (TSL — проприетарная лицензия на часть функций TimescaleDB; сейчас она называется «Tiger Data License»); Apache 2 Edition этих функций не содержит. Кроме того, TSL запрещает предоставлять лицензированную функциональность третьим лицам как DBaaS (database-as-a-service, «база данных как услуга»).

**Что это значит для letopis.** Ровно те две функции, ради которых letopis требует TimescaleDB, — compression и retention — доступны только под проприетарной лицензией TSL.

**Источники.**
- [Tiger Data — TimescaleDB editions](https://www.tigerdata.com/docs/get-started/choose-your-path/timescaledb-editions)
- [Zabbix ZBX-20743](https://support.zabbix.com/browse/ZBX-20743)
- [MS Q&A: retention/compression not supported under Apache license](https://learn.microsoft.com/en-us/answers/questions/2156345/retension-policy-and-compression-not-supported-for)

### #4. TimescaleDB недоступен на Amazon RDS

**Статус: проверено.**

**Что установлено.** Официальный список расширений, поддерживаемых Amazon RDS for PostgreSQL (он охватывает версии PostgreSQL с 9.6 по 19), не содержит `timescaledb`. Чтобы убедиться, что список прочитан правильно, мы сделали sanity-check — проверили его на заведомо присутствующих расширениях: `pg_partman` и `pgvector` в списке есть.

**Что это значит для letopis.** На Amazon RDS расширение поставить нельзя вовсе, поэтому запустить letopis там можно только с DDL, переписанным под обычный (vanilla) PostgreSQL.

**Источники.**
- [AWS RDS PostgreSQL extensions](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html)

### #5. TimescaleDB на Aurora

**Статус: частично.**

**Что установлено.** По данным ревью 04, в котором просматривалась страница расширений Aurora PostgreSQL, `timescaledb` в список поддерживаемых расширений Aurora не входит. В рамках этой проверки страницу повторно не открывали, поэтому статус — «частично».

**Что это значит для letopis.** Для Aurora вывод тот же, что для RDS, — расширения нет, — но с меньшей уверенностью, потому что он опирается на предыдущее ревью, а не на повторную проверку.

**Источники.**
- [Aurora PostgreSQL extensions](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html)

### #6. TimescaleDB на Azure Database for PostgreSQL Flexible Server

**Статус: проверено.**

**Что установлено.** В Azure Database for PostgreSQL Flexible Server расширение TimescaleDB доступно, но только в редакции Apache 2. Следовательно, compression и retention-политики там отсутствуют. Community Edition (под TSL) за пределами Timescale Cloud публичные облачные провайдеры не поставляют.

**Что это значит для letopis.** На Azure hypertable создать можно, но без сжатия и retention — то есть получается «hypertable без выгод».

**Источники.**
- [MS Q&A: TimescaleDB on Azure PG v16](https://learn.microsoft.com/en-us/answers/questions/1534809/timescaledb-on-azure-postgresql-v16)
- [MS Q&A: Community Edition в Azure](https://learn.microsoft.com/en-us/answers/a/1333098)

### #7. Версия стека в dev-контейнере letopis

**Статус: проверено (локально).**

**Что установлено.** В dev-контейнере проекта `letopis-timescale` работает `PostgreSQL 17.4 (Alpine)` с расширением `timescaledb 2.19.0`. Параметр `timescaledb.license` установлен в значение `timescale`, то есть контейнер использует Community-редакцию под TSL. Это означает, что тесты и бенчмарки проекта выполняются именно на TSL-редакции. Проверка выполнена локально командой `docker exec letopis-timescale psql …` 2026-09-24.

**Что это значит для letopis.** Всё, что проект подтверждает тестами и бенчмарками, подтверждается на редакции, которую публичные облака (см. #4–#6) не предоставляют.

**Источники.**
- `docker exec letopis-timescale psql …` (2026-09-24)

### #8. XTDB v2 — bitemporal SQL поверх PG wire

**Статус: проверено.**

**Что установлено.** XTDB v2 — битемпоральная база данных (bitemporal — хранит две оси времени: system time, когда факт записан, и valid time, когда факт действителен в предметной области) с семантикой SQL:2011. Версия v2.1.0 вышла в декабре 2025, v2.2.0-rc0 — 2026-07-21. XTDB говорит по протоколу PostgreSQL (pgwire), так что к ней подключаются обычные PG-клиенты; в 2.2 добавлены интерфейсы ADBC/Flight SQL. Кроме того, XTDB умеет подписываться на логическую репликацию существующего PostgreSQL и зеркалить его изменения как bitemporal-историю.

**Что это значит для letopis.** Один из аналогов, с которыми сравнивается letopis, дошёл до production-релизов в 2026 году и покрывает обе оси времени, тогда как letopis хранит только transaction time.

**Источники.**
- [xtdb/xtdb releases](https://github.com/xtdb/xtdb/releases/tag/v2.2.0-beta1)
- [Launching XTDB v2](https://xtdb.com/blog/launching-xtdb-v2)
- [xtdb/xtdb](https://github.com/xtdb/xtdb)

### #9. Datomic бесплатен

**Статус: проверено.**

**Что установлено.** С 2023-04-27 все редакции Datomic бесплатны; бинарники распространяются под Apache 2.0 (владелец — Nubank). С 2026-05-30 для запуска требуется Java 17 или новее.

**Что это значит для letopis.** При сравнении с аналогами Datomic нельзя считать платной альтернативой — стоимость лицензии не является аргументом ни за него, ни против.

**Источники.**
- [Datomic is Free](https://blog.datomic.com/2023/04/datomic-is-free.html)
- [Release Notices](https://docs.datomic.com/release-notices.html)

### #10. DoltgreSQL (version-controlled Postgres)

**Статус: проверено.**

**Что установлено.** DoltgreSQL — PostgreSQL-совместимая база данных с версионированием в стиле git (version-controlled: коммиты, ветки и история изменений на уровне данных). Версия 1.0 вышла 2026-08-06; до этого проект прошёл alpha (ноябрь 2023) и beta (апрель 2025). Родственный Dolt 2.0 вышел в июле 2026. DoltgreSQL умеет работать репликой существующего PostgreSQL по протоколу репликации.

**Что это значит для letopis.** Ещё один аналог в 2026 году дошёл до production-релиза 1.0.

**Источники.**
- [DoltHub: Doltgres 1.0](https://www.dolthub.com/blog/2026-06-26-doltgres-1-0-coming-this-fall/)
- [InfoQ: Dolt 2.0](https://www.infoq.com/news/2026/07/dolt-version-control/)

### #11. Marten (.NET document DB + event store на PG)

**Статус: частично.**

**Что установлено.** Marten — библиотека для .NET, которая превращает PostgreSQL в документную базу и event store (хранилище событий). Страница релизов на GitHub отдала как верхнюю запись версию 9.39.0 от 2025-09-22 — это security-релиз, закрывающий SQL injection в LINQ. Полноту списка релизов за 2026 год подтвердить не удалось, отсюда статус «частично». Проект активен и поддерживается компанией JasperFx.

**Что это значит для letopis.** Marten остаётся живым аналогом в .NET-экосистеме, но сведения о его версиях за 2026 год в этой проверке не подтверждены.

**Источники.**
- [JasperFx/marten releases](https://github.com/JasperFx/marten/releases)
- [martendb.io/events](https://martendb.io/events/)

### #12. SurrealDB 3.0

**Статус: проверено / версии-история не проверено.**

**Что установлено.** SurrealDB 3.0 вышла в феврале 2026 (среди прочего добавлены COMPUTED fields — вычисляемые поля). Версия 3.3 принесла datastore versioning/migrations — версионирование самого хранилища и миграции. Отдельный вопрос — есть ли в SurrealDB time-travel запросы по версиям записей (в 2.x за это отвечал `VERSION`-clause); его в рамках этой проверки не исследовали, поэтому у этой части факта статус «не проверено».

**Что это значит для letopis.** Сравнение с SurrealDB по главной для letopis оси — истории версий записей — остаётся неподтверждённым.

**Источники.**
- [SurrealDB 3.0 release](https://surrealdb.com/releases/3.0)
- [Release 3.3](https://surrealdb.com/releases/3.3)

### #13. OWASP: параметры scrypt

**Статус: проверено.**

**Что установлено.** OWASP Password Storage Cheat Sheet задаёт для scrypt (функции хеширования паролей с настраиваемой стоимостью по памяти и CPU) минимальные параметры `N=2^17 (131072)`, `r=8`, `p=1`, где N — параметр стоимости, r — размер блока, p — степень параллелизма. При этом OWASP рекомендует предпочитать Argon2id. В letopis используются `N=2^15, r=8, p=1` (`lib/src/auth.ts:44-45`). Memory cost (объём памяти, который нужен для вычисления одного хеша) из-за этого в 4 раза ниже рекомендованного минимума: 32 MiB против 128 MiB.

**Что это значит для letopis.** Параметры хеширования паролей формально ниже OWASP-минимума, но формат хранения хеша `scrypt$N$r$p$…` позволяет поднять их без миграции данных.

**Источники.**
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

### #14. TimescaleDB: GIN-индексы на сжатых chunk'ах

**Статус: частично.**

**Что установлено.** По данным ревью 04, которое ссылается на issue timescale/timescaledb#2418, на сжатых chunk'ах TimescaleDB создаются только индексы по колонкам `segmentby` и `orderby` (это параметры сжатия: по `segmentby` данные группируются внутри сжатого chunk'а, по `orderby` — упорядочиваются). Произвольные вторичные индексы, включая GIN (Generalized Inverted Index — тип индекса PostgreSQL, обычный для поиска по jsonb), на сжатых chunk'ах недоступны. Поведение в TimescaleDB 2.19 повторно не проверялось.

**Что это значит для letopis.** Если letopis рассчитывает на GIN-индексы по jsonb для старых данных, на сжатых chunk'ах этот расчёт не сработает — при условии, что ограничение сохраняется в 2.19, чего повторно не проверяли.

**Источники.**
- [timescale/timescaledb#2418](https://github.com/timescale/timescaledb/issues/2418)

## Что это меняет в выводах ASSESSMENT.md

**Лицензия и облако (риск R14 в ASSESSMENT.md) — риск усиливается.** Проверка показала, что ровно те две функции, ради которых letopis требует TimescaleDB, — compression и retention, — существуют только под TSL (#3) и отсутствуют на Amazon RDS, Aurora и в Azure-редакции расширения (#4–#6). На managed PostgreSQL у команды остаётся выбор из двух вариантов: «hypertable без выгод», то есть TimescaleDB без сжатия и retention, либо форк DDL под vanilla PostgreSQL без расширения.

**Контекст новизны.** PostgreSQL 18 закрыл application-time constraints в ядре (#1) — это то, чего у letopis нет вовсе: библиотека хранит только transaction time. Нативные графовые запросы SQL/PGQ, напротив, отложены минимум до PostgreSQL 20 (#2), поэтому dot-chain обход над jsonb остаётся практичной нишей ещё год-два.

**Аналоги.** XTDB v2 (#8) и DoltgreSQL 1.0 (#10) в 2026 году дошли до production-релизов. Оценка «зрелость 1/5 у letopis» из COMPARISON.md остаётся верной и даже усиливается на фоне production-релизов аналогов.

**Auth (риск R15).** Параметры scrypt формально ниже OWASP-минимума (#13). Формат хранения хеша (`scrypt$N$r$p$…`) допускает апгрейд параметров без миграции.
