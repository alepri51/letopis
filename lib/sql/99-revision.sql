-- letopis — штамп ревизии движка: последний оператор наката. Номер совпадает с DDL_REVISION в lib/src/types.ts
-- (проверяет check-docs); в штампе ещё версия пакета и хэш файлов ядра (engine, sql): connect() предупреждает, если
-- функции схемы ставила другая сборка той же ревизии. Схему другой ревизии setup() не обновляет — только demolish().
comment on schema @SCHEMA@ is 'letopis ddl_revision=12 engine=@ENGINE_VERSION@ sql=@ENGINE_SQL@';
