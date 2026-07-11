-- =============================================================================
-- Сид auth/ACL: System-аккаунт + Resource + Rule (перенос из legacy-дампа).
-- Тест-пользователи и их креденшелы НЕ переносятся.
-- Идемпотентен (ON CONFLICT).
-- =============================================================================

-- Системный аккаунт (фиксированный id из дампа)
INSERT INTO "<SCHEMA-NAME>"."Account" (id, categories, data, meta, avatar, enabled) VALUES
  ('2eba6d0a-1edd-4bb6-a85a-a703dab49035', '{System}', '{"id": "System", "name": "System"}', '{}', 'https://i.pravatar.cc/128?img=28', true)
  ON CONFLICT (id) DO NOTHING;

-- Ресурсы: субъекты (категории аккаунтов) и объекты (API-эндпоинты)
INSERT INTO "<SCHEMA-NAME>"."Resource" (alias, category, pattern, meta) VALUES
  ('anonymous:ACCOUNT',      'ACCOUNT', '{"categories": "{Anonymous,Shadow}"}',  '{"description": "Unauthenticated users (includes Anonymous and Shadow categories)"}'),
  ('authenticated:ACCOUNT',  'ACCOUNT', '{"categories": "!{Anonymous,Shadow}"}', '{"description": "Authenticated users (excludes Anonymous and Shadow)"}'),
  ('any:ACCOUNT',            'ACCOUNT', NULL,                                    '{"description": "All account categories (no pattern = match all)"}'),
  ('auth.user.password:API', 'API', '{"endpoint": "v2.auth.password.change"}',   '{"endpoints": ["v2.auth.password.change"], "description": "Change own password"}'),
  ('auth.user.session:API',  'API', '{"endpoint": "v2.auth.session.signout"}',   '{"endpoints": ["v2.auth.session.signout"], "description": "Logout (revoke session)"}'),
  ('auth.user.apikey:API',   'API', '{"endpoint": "v2.auth.apikey.*"}',          '{"endpoints": ["v2.auth.apikey.create", "v2.auth.apikey.list", "v2.auth.apikey.revoke"], "description": "Manage own API keys (auto-filtered by account)"}'),
  ('auth.user.basic:API',    'API', '{"endpoint": "v2.auth.basic.*"}',           '{"endpoints": ["v2.auth.basic.create", "v2.auth.basic.list", "v2.auth.basic.revoke"], "description": "Manage own Basic Auth credentials (auto-filtered by account)"}'),
  ('any:API',                'API', NULL,                                        '{"description": "All API endpoints (no pattern = match all, for default deny)"}'),
  ('chrono.user.events:API', 'API', '{"endpoint": "v2.chrono.*"}',               '{"endpoint": "v2.chrono.*", "description": "User event management (auto-filtered by account)"}'),
  ('auth.anonymous:API',     'API', '{"endpoint": "v2.auth.password.{signup,signin,reset.*,email.*}"}', '{"endpoints": ["v2.auth.password.signup", "v2.auth.password.signin", "v2.auth.password.reset.request", "v2.auth.password.reset.complete", "v2.auth.password.email.verify", "v2.auth.password.email.resend"], "description": "Anonymous auth endpoints (signup, signin, reset, email verification)"}'),
  ('auth.telegram:API',      'API', '{"endpoint": "v2.auth.telegram.{initiate,poll}"}', '{"endpoints": ["v2.auth.telegram.initiate", "v2.auth.telegram.poll"], "description": "Telegram passwordless login (initiate, long polling)"}'),
  ('payment.callback:API',   'API', '{"endpoint": "v2.payment.callback.*"}',     '{"endpoints": ["v2.payment.callback.yookassa", "v2.payment.callback.robokassa"], "description": "Payment provider webhooks (YOOKASSA, ROBOKASSA)"}'),
  ('shop:API',               'API', '{"endpoint": "booking.*"}',                 '{"description": "Booking service endpoints"}'),
  ('payment:API',            'API', '{"endpoint": "v2.payment.*"}',              '{"endpoints": ["v2.payment.create"], "description": "Create payment (authenticated users only)"}'),
  ('billing:API',            'API', '{"endpoint": "v2.billing.*"}',              NULL),
  ('geo:API',                'API', '{"endpoint": "v2.geo.*"}',                  NULL)
  ON CONFLICT (alias) DO UPDATE SET category = EXCLUDED.category, pattern = EXCLUDED.pattern, meta = EXCLUDED.meta;

-- Правила: субъект → объект → allow|deny (weight — приоритет)
INSERT INTO "<SCHEMA-NAME>"."Rule" (account, resource, permission, weight, meta, enabled) VALUES
  ('authenticated:ACCOUNT', 'auth.user.password:API', 'allow',  90, '{"description": "Users can change their own password"}', true),
  ('authenticated:ACCOUNT', 'auth.user.session:API',  'allow',  90, '{"description": "Users can logout (revoke their session)"}', true),
  ('authenticated:ACCOUNT', 'auth.user.apikey:API',   'allow',  90, '{"description": "Users can manage their own API keys (service auto-filters by ctx.meta.$account.id)"}', true),
  ('authenticated:ACCOUNT', 'auth.user.basic:API',    'allow',  90, '{"description": "Users can manage their own Basic Auth (service auto-filters by ctx.meta.$account.id)"}', true),
  ('any:ACCOUNT',           'any:API',                'deny',    0, '{"code": 403, "message": "Access denied - default for any ACCOUNT to any API"}', true),
  ('authenticated:ACCOUNT', 'chrono.user.events:API', 'allow',  90, '{"description": "Users can manage their own scheduled events (filtered by ctx.meta.$account.id)"}', true),
  ('any:ACCOUNT',           'auth.anonymous:API',     'allow', 105, '{"description": "Anonymous users can signup, signin, reset password, use OTP"}', true),
  ('anonymous:ACCOUNT',     'auth.telegram:API',      'allow', 105, '{"description": "Anonymous users can login via Telegram (initiate, poll)"}', true),
  ('authenticated:ACCOUNT', 'payment:API',            'allow',  90, '{"description": "Users can create payments (uses ctx.meta.$account.id)"}', true),
  ('authenticated:ACCOUNT', 'shop:API',               'allow',  90, '{"description": "Users can access booking"}', true),
  ('authenticated:ACCOUNT', 'billing:API',            'allow',  90, '{"description": "Users can access billing (uses ctx.meta.$account.id)"}', true),
  ('authenticated:ACCOUNT', 'geo:API',                'allow',  90, '{"description": "Users can access geo (uses ctx.meta.$account.id)"}', true)
  ON CONFLICT (account, resource) DO UPDATE SET permission = EXCLUDED.permission, weight = EXCLUDED.weight, meta = EXCLUDED.meta, enabled = EXCLUDED.enabled;
