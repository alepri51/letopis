/**
 * Раздел access: auth.ts, acl.ts — вход, креды, сессии, права.
 */
import type { Section } from './types.js';

/**
 * Подсказка неверного вызова db.acl: общая подсказка invalid_data — про issues, а у этих ошибок их нет. Параметр what в
 * записях db.acl — метод (grant, deny, revoke, roles), с которого начинается текст.
 */
const ACL_CALL = 'исправить аргумент по тексту ошибки; вызовы db.acl — README, «Выдать право»';

export const access = {
  // auth.ts, switch(): фасад db.as() арендатора не меняет
  'access.switch_not_root': {
    code: 'invalid_query',
    ru: 'auth.switch() — от корня подключения: при имперсонации арендатора задаёт db.as(…, { tenant })',
    hint: 'сменить арендатора корня — db.auth.switch(); фасаду db.as() арендатора задают при создании: db.as(аккаунт, { tenant })',
  },
  // acl.ts, roleName: роль в grant, deny, revoke или в списке db.acl.roles — не строка; type — её тип
  'access.role_not_string': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: role — строка, а не {type}',
    hint: ACL_CALL,
  },
  // acl.ts, roleName: имя роли пустое, с запятой или фигурной скобкой, с «!» в начале или с пробелом по краям
  'access.bad_role_name': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: роль {role} — непустая строка без запятых и фигурных скобок, без «!» в начале и пробелов по краям',
    hint: ACL_CALL,
  },
  // acl.ts, classItem: условие цели правила — на колонку не из списка
  'access.bad_condition_column': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: условие на колонку {column} — условие ставят на {columns}',
    hint: ACL_CALL,
  },
  // acl.ts, classItem: цель read, write или delete — не имя класса, не звёздочка и не объект с полем class
  'access.bad_rule_target': {
    code: 'invalid_data',
    ru: "db.acl.{what}: цель {target} — имя класса, '*' (все классы) или { class, …условие на строки }",
    hint: ACL_CALL,
  },
  // acl.ts, apiItem: цель api — не маска эндпоинта
  'access.bad_endpoint_mask': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: api {endpoint} — маска эндпоинта: сегменты через «.», {a,b} — любой из, * — хвост',
    hint: ACL_CALL,
  },
  // acl.ts, parse: описание правила grant, deny или revoke — не объект
  'access.rule_spec_not_object': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: нужен объект { role, read | write | delete | api }',
    hint: ACL_CALL,
  },
  // acl.ts, parse: лишнее поле в описании правила (у revoke нет и weight)
  'access.unknown_rule_field': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: поле {field} — допустимы {fields}',
    hint: ACL_CALL,
  },
  // acl.ts, parse: weight — не целое от 1 до 999
  'access.bad_rule_weight': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: weight — целое от 1 до 999: вес правила арендатора (от 1000 — административный слой System)',
    hint: ACL_CALL,
  },
  // acl.ts, parse: кому правило — нет ни role, ни everyone, есть оба или everyone не true
  'access.rule_who': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: кому правило — ровно одно из role (роль членства) и everyone: true (все аккаунты арендатора)',
    hint: ACL_CALL,
  },
  // acl.ts, parse: в описании правила нет ни read, ни write, ни delete, ни api
  'access.no_rule_operations': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: нужна хотя бы одна операция: read, write, delete или api',
    hint: ACL_CALL,
  },
  // acl.ts, makeAcl: db.acl без фасада подключения, а grant, deny, revoke, roles и list идут его цепочками
  'access.no_facade': {
    code: 'invalid_query',
    ru: 'db.acl: запись правил — от фасада подключения',
  },
  // acl.ts, roles(): аккаунт — не id и не строка с полем id
  'access.bad_account': {
    code: 'invalid_data',
    ru: 'db.acl.roles: аккаунт — id или строка с полем id',
    hint: ACL_CALL,
  },
  // acl.ts, roles() и list(): у фасада нет рабочего арендатора — подключение без сессии; what — метод
  'access.no_session_tenant': {
    code: 'no_session',
    ru: 'db.acl.{what}: нет арендатора сессии',
  },
  // acl.ts, roles(): роли — не массив и не null
  'access.roles_not_array': {
    code: 'invalid_data',
    ru: 'db.acl.roles: роли — массив строк или null (снять членство)',
    hint: ACL_CALL,
  },
  // acl.ts, roles(): роль в списке повторяется
  'access.duplicate_roles': {
    code: 'invalid_data',
    ru: 'db.acl.roles: роли повторяются',
    hint: ACL_CALL,
  },
  // auth.ts, verifyHash: scrypt отверг N, r, p из строки хэша — недопустимы или требуют больше 64 МБ памяти
  'access.bad_scrypt_params': {
    code: 'invalid_data',
    ru: 'хэш пароля: параметры scrypt N={N}, r={r}, p={p} недопустимы или требуют больше 64 МБ памяти',
    hint: 'хэш с такими параметрами не проверить: задать пароль заново — auth.setPassword()',
  },
  // auth.ts, base32Decode: в секрете TOTP (totpCode) знак не из алфавита base32
  'access.bad_totp_secret': {
    code: 'invalid_data',
    ru: 'секрет TOTP — не base32',
    hint: 'передать секрет из auth.enrollTotp() — строку base32 (A–Z, 2–7)',
  },
  // auth.ts, issueOtp (3.0.1): maxAttempts не целое или вне 1–10 (раньше база молча приводила к пределу); value — как передан
  'access.bad_max_attempts': {
    code: 'invalid_data',
    ru: 'issueOtp: maxAttempts {value} — целое от 1 до 10',
    hint: 'maxAttempts — число неверных попыток до того, как код сгорит: целое от 1 до 10 (по умолчанию 5)',
  },
  // auth.ts, ttlOf (3.0.1): срок ttl (sessionFor, issueOtp, issueApiKey, verifyPassword, lookup, refresh, createTenant) — не
  // число секунд, не короткая форма и не интервал PostgreSQL; where — вызов, value — как передан
  'access.bad_ttl': {
    code: 'invalid_data',
    ru: "{where}: ttl {value} — нужно число секунд, '15m' или интервал PostgreSQL '15 minutes'",
    hint: "срок ttl больше нуля: число секунд (600), короткая форма '30s', '15m', '2h', '1d' или интервал PostgreSQL '15 minutes'",
  },
} satisfies Section<'access'>;
