-- Ревизия 6 (план 1.1, этап 1б): пути изменения версии в журнале — для быстрого blame.
-- Старые версии остаются с null: blame досчитывает их сравнением соседних версий.
alter table @SCHEMA@.log add column if not exists changed jsonb;
