-- letopis 3.0.0 — ревизия 11. Новые тела функций входа и кредов (20-context.sql, 80-auth.sql): вход по ключу
-- (login_apikey, auth_login_apikey, login_keysecret) берёт строку ключа for share, отзыв (auth_revoke_credential) —
-- for update: сессия, открытая параллельно с отзывом, гаснет вместе с ключом; отключённые (meta.enabled = false) OTP
-- и TOTP не принимаются (login_otp, auth_verify_totp, auth_totp_enabled); отключение креда (auth_set_flags) берёт его
-- строку for update и гасит его сессии, последний ключ сервиса не отключается. Сигнатуры те же: тела ставит повторный
-- накат файлов ядра сразу после миграции. Снимать и переносить нечего; оператор ниже — чтобы файл не был пустым запросом.
select 1;
