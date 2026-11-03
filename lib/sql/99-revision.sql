-- letopis 1.0 — штамп ревизии движка (план, §2.2, этап 1, п. 11): последний оператор наката.
-- Номер совпадает с DDL_REVISION в lib/src/types.ts (проверяет check-docs). С 1.4 в штампе ещё версия пакета и хэш
-- файлов ядра (engine, sql): connect() предупреждает, если функции схемы ставила другая версия движка той же ревизии.
-- Ревизия 8 — первая у 2.0 (план 2.0, редакция 2): схему ниже неё (letopis 1.x) up() и connect() отклоняют.
-- Ревизия 9 — 2.1.0: restore(id, rev), auth_logout_token(), auth_tenants() с именем, validate_row(); миграция 0009.
comment on schema @SCHEMA@ is 'letopis ddl_revision=9 engine=@ENGINE_VERSION@ sql=@ENGINE_SQL@';
