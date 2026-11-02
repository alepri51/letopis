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
  },
  // 50-acl.sql, acl_subject(); 80-auth.sql, auth_switch(): аккаунт не член арендатора-цели
  'sql-access.no_membership': {
    code: 'tenant_denied',
    ru: 'нет членства в арендаторе',
  },
  // 50-acl.sql, acl_plan(): op — переданная операция
  'sql-access.acl_bad_op': {
    code: 'invalid_data',
    ru: 'операция {op}: нужна READ, WRITE или DELETE',
  },
  // 50-acl.sql, acl_subject()
  'sql-access.account_unavailable': {
    code: 'target_not_found',
    ru: 'аккаунт не найден или отключён',
  },
  // 50-acl.sql, acl_require(): endpoint — эндпоинт API
  'sql-access.no_right': {
    code: 'acl_denied',
    ru: 'нет права {endpoint}',
  },
  // 50-acl.sql, acl_api_for(): message решения по эндпоинту без подходящего правила — текст не для ошибки (lt_text)
  'sql-access.default_deny': {
    code: 'acl_denied',
    ru: 'нет подходящего правила (запрет по умолчанию)',
  },
  // 80-auth.sql (auth_can_manage, auth_set_password, auth_link): нет недавнего входа и права auth.credential
  'sql-access.bind_denied': {
    code: 'acl_denied',
    ru: 'привязка отклонена: нужен недавний вход или право auth.credential',
  },
  // 80-auth.sql, auth_guard()
  'sql-access.self_or_sysadmin': {
    code: 'acl_denied',
    ru: 'креды и сессии этого аккаунта меняет только он сам или системный администратор',
  },
  // 80-auth.sql, issue_session()
  'sql-access.no_sessions_for_account': {
    code: 'acl_denied',
    ru: 'сессии для этого аккаунта не выпускаются',
  },
  // 80-auth.sql, auth_set_password()
  'sql-access.password_args': {
    code: 'invalid_data',
    ru: 'пароль: вид, идентификатор и хэш scrypt$… обязательны',
  },
  // 80-auth.sql, auth_issue_apikey(): SQLSTATE 40001 — повторяемый конфликт
  'sql-access.apikey_prefix_conflict': {
    code: 'conflict',
    ru: 'не удалось выпустить ключ с уникальным префиксом',
  },
  // 80-auth.sql, auth_issue_otp()
  'sql-access.otp_args': {
    code: 'invalid_data',
    ru: 'код: вид OTP или OTP_<имя>, идентификатор, 4–10 знаков',
  },
  // 80-auth.sql, auth_issue_otp()
  'sql-access.account_not_found': {
    code: 'target_not_found',
    ru: 'аккаунт не найден',
  },
  // 80-auth.sql, auth_issue_otp()
  'sql-access.otp_sysadmin_only': {
    code: 'acl_denied',
    ru: 'коды входа для System, сервисов и системных администраторов выпускает только системный администратор',
  },
  // 80-auth.sql, auth_link()
  'sql-access.identity_args': {
    code: 'invalid_data',
    ru: 'identity: вид (TELEGRAM, GOOGLE, …) и идентификатор обязательны',
  },
  // 80-auth.sql, auth_revoke_credential()
  'sql-access.last_service_key': {
    code: 'acl_denied',
    ru: 'последний действующий ключ сервиса не отзывается: сначала выпустите новый',
  },
  // 80-auth.sql, auth_switch()
  'sql-access.switch_impersonating': {
    code: 'acl_denied',
    ru: 'auth.switch — для собственной сессии, не при имперсонации',
  },
} satisfies Section<'sql-access'>;
