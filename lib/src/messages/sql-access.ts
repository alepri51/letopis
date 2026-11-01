/**
 * Раздел sql-access: lib/sql/50-acl.sql, lib/sql/80-auth.sql — права, креды, вход. Русский текст собирает база из этих же записей:
 * установщик кладёт разделы sql-* в message_catalog() (lib/sql/15-errors.sql), ключ и параметры уходят в DETAIL.
 */
import type { Section } from './types.js';

export const sqlAccess = {
  // 50-acl.sql (acl_check, acl_require), 80-auth.sql (auth_session_required, auth_can_manage, auth_switch): сессии нет
  'sql-access.no_session': {
    code: 'no_session',
    ru: 'нет действующей сессии',
    en: 'no active session',
  },
  // 50-acl.sql, acl_subject(); 80-auth.sql, auth_switch(): аккаунт не член арендатора-цели
  'sql-access.no_membership': {
    code: 'tenant_denied',
    ru: 'нет членства в арендаторе',
    en: 'no membership in the tenant',
  },
  // 50-acl.sql, acl_plan(): op — переданная операция
  'sql-access.acl_bad_op': {
    code: 'invalid_data',
    ru: 'операция {op}: нужна READ, WRITE или DELETE',
    en: 'operation {op}: READ, WRITE or DELETE is required',
  },
  // 50-acl.sql, acl_subject()
  'sql-access.account_unavailable': {
    code: 'target_not_found',
    ru: 'аккаунт не найден или отключён',
    en: 'account not found or disabled',
  },
  // 50-acl.sql, acl_require(): endpoint — эндпоинт API
  'sql-access.no_right': {
    code: 'acl_denied',
    ru: 'нет права {endpoint}',
    en: 'no {endpoint} right',
  },
  // 50-acl.sql, acl_api_for(): message решения по эндпоинту без подходящего правила — текст не для ошибки (lt_text)
  'sql-access.default_deny': {
    code: 'acl_denied',
    ru: 'нет подходящего правила (запрет по умолчанию)',
    en: 'no matching rule (denied by default)',
  },
  // 80-auth.sql (auth_can_manage, auth_set_password, auth_link): нет недавнего входа и права auth.credential
  'sql-access.bind_denied': {
    code: 'acl_denied',
    ru: 'привязка отклонена: нужен недавний вход или право auth.credential',
    en: 'binding rejected: a recent sign-in or the auth.credential right is required',
  },
  // 80-auth.sql, auth_guard()
  'sql-access.self_or_sysadmin': {
    code: 'acl_denied',
    ru: 'креды и сессии этого аккаунта меняет только он сам или системный администратор',
    en: 'only the account itself or a system administrator changes the credentials and sessions of this account',
  },
  // 80-auth.sql, issue_session()
  'sql-access.no_sessions_for_account': {
    code: 'acl_denied',
    ru: 'сессии для этого аккаунта не выпускаются',
    en: 'sessions are not issued for this account',
  },
  // 80-auth.sql, auth_set_password()
  'sql-access.password_args': {
    code: 'invalid_data',
    ru: 'пароль: вид, идентификатор и хэш scrypt$… обязательны',
    en: 'password: kind, identifier and scrypt$… hash are required',
  },
  // 80-auth.sql, auth_issue_apikey(): SQLSTATE 40001 — повторяемый конфликт
  'sql-access.apikey_prefix_conflict': {
    code: 'conflict',
    ru: 'не удалось выпустить ключ с уникальным префиксом',
    en: 'failed to issue a key with a unique prefix',
  },
  // 80-auth.sql, auth_issue_otp()
  'sql-access.otp_args': {
    code: 'invalid_data',
    ru: 'код: вид OTP или OTP_<имя>, идентификатор, 4–10 знаков',
    en: 'code: kind OTP or OTP_<name>, identifier, 4–10 characters',
  },
  // 80-auth.sql, auth_issue_otp()
  'sql-access.account_not_found': {
    code: 'target_not_found',
    ru: 'аккаунт не найден',
    en: 'account not found',
  },
  // 80-auth.sql, auth_issue_otp()
  'sql-access.otp_sysadmin_only': {
    code: 'acl_denied',
    ru: 'коды входа для System, сервисов и системных администраторов выпускает только системный администратор',
    en: 'sign-in codes for System, services and system administrators are issued only by a system administrator',
  },
  // 80-auth.sql, auth_link()
  'sql-access.identity_args': {
    code: 'invalid_data',
    ru: 'identity: вид (TELEGRAM, GOOGLE, …) и идентификатор обязательны',
    en: 'identity: kind (TELEGRAM, GOOGLE, …) and identifier are required',
  },
  // 80-auth.sql, auth_revoke_credential()
  'sql-access.last_service_key': {
    code: 'acl_denied',
    ru: 'последний действующий ключ сервиса не отзывается: сначала выпустите новый',
    en: 'the last active key of a service cannot be revoked: issue a new one first',
  },
  // 80-auth.sql, auth_switch()
  'sql-access.switch_impersonating': {
    code: 'acl_denied',
    ru: 'auth.switch — для собственной сессии, не при имперсонации',
    en: 'auth.switch is for your own session, not during impersonation',
  },
} satisfies Section<'sql-access'>;
