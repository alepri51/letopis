-- letopis 2.1.0 — ревизия 9 (план 2.1, A1, A3, A5). Миграция снимает функции, чью сигнатуру или вид результата меняет
-- ревизия: create or replace их не заменит (новый аргумент дал бы вторую перегрузку и неоднозначный вызов restore(id),
-- новый вид результата PostgreSQL не принимает). Новые функции и права ставит повторный накат файлов ядра сразу после
-- миграции (90-time.sql, 80-auth.sql); новая auth_logout_token(text) и validate_row(text, jsonb) — тоже он.
drop function if exists @SCHEMA@.restore(uuid);
drop function if exists @SCHEMA@.auth_tenants();
