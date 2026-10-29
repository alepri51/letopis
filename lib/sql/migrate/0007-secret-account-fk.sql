-- Ревизия 7 (1.4.1-alpha.0, решение владельца): строки secret принадлежат аккаунту — строке entity. Удалённый аккаунт
-- уносит свои строки каскадом внешнего ключа: сессии, хэши паролей и ключей, секреты TOTP, внешние учётные записи. До
-- ревизии 7 удаление аккаунта лишь помечало их deleted_at, а maintain() убирает только сессии и коды OTP — остальное
-- хранилось вечно. Сначала стираются строки, чьих аккаунтов в entity уже нет, затем ставится ключ (как в 10-core.sql).
delete from @SCHEMA@.secret s where not exists (select 1 from @SCHEMA@.entity e where e.id = s.account);
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = '@SCHEMA@.secret'::regclass and conname = 'secret_account_fkey') then
    alter table @SCHEMA@.secret add constraint secret_account_fkey
      foreign key (account) references @SCHEMA@.entity (id) on delete cascade;
  end if;
end $$;
