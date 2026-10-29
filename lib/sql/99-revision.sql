-- letopis 1.0 — штамп ревизии движка (план, §2.2, этап 1, п. 11): последний оператор наката.
-- Номер совпадает с DDL_REVISION в lib/src/types.ts (проверяет check-docs). С 1.4 в штампе ещё версия пакета и хэш
-- файлов ядра (engine, sql): connect() предупреждает, если функции схемы ставила другая версия движка той же ревизии.
comment on schema @SCHEMA@ is 'letopis ddl_revision=7 engine=@ENGINE_VERSION@ sql=@ENGINE_SQL@';
