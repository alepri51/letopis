/**
 * Раздел access: auth.ts, acl.ts — вход, креды, сессии, права.
 */
import type { Section, Text } from './types.js';

/**
 * Подсказка неверного вызова db.acl: общая подсказка invalid_data — про issues, а у этих ошибок их нет. Параметр what в
 * записях db.acl — метод (grant, deny, revoke, roles), с которого начинается текст.
 */
const ACL_CALL: Text = {
  ru: 'исправить аргумент по тексту ошибки; вызовы db.acl — README, «Выдать право»',
  en: 'fix the argument as the error text says; the db.acl calls are in README, "Granting a permission"',
};

export const access = {
  // auth.ts, switch(): фасад db.as() арендатора не меняет
  'access.switch_not_root': {
    code: 'invalid_query',
    ru: 'auth.switch() — от корня подключения: при имперсонации арендатора задаёт db.as(…, { tenant })',
    en: 'auth.switch() works only on the connection root: with impersonation the tenant is set by db.as(…, { tenant })',
    hint: {
      ru: 'сменить арендатора корня — db.auth.switch(); фасаду db.as() арендатора задают при создании: db.as(аккаунт, { tenant })',
      en: 'switch the tenant of the root with db.auth.switch(); a db.as() facade gets its tenant when created: db.as(account, { tenant })',
    },
  },
  // acl.ts, roleName: роль в grant, deny, revoke или в списке db.acl.roles — не строка; type — её тип
  'access.role_not_string': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: role — строка, а не {type}',
    en: 'db.acl.{what}: role is a string, not {type}',
    hint: ACL_CALL,
  },
  // acl.ts, roleName: имя роли пустое, с запятой или фигурной скобкой, с «!» в начале или с пробелом по краям
  'access.bad_role_name': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: роль {role} — непустая строка без запятых и фигурных скобок, без «!» в начале и пробелов по краям',
    en: 'db.acl.{what}: role {role} is a non-empty string without commas or curly braces, with no "!" at the start and no spaces at the ends',
    hint: ACL_CALL,
  },
  // acl.ts, classItem: условие цели правила — на колонку не из списка
  'access.bad_condition_column': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: условие на колонку {column} — условие ставят на {columns}',
    en: 'db.acl.{what}: a condition on column {column} — conditions are set on {columns}',
    hint: ACL_CALL,
  },
  // acl.ts, classItem: цель read, write или delete — не имя класса, не звёздочка и не объект с полем class
  'access.bad_rule_target': {
    code: 'invalid_data',
    ru: "db.acl.{what}: цель {target} — имя класса, '*' (все классы) или { class, …условие на строки }",
    en: "db.acl.{what}: target {target} is a class name, '*' (all classes) or { class, …row condition }",
    hint: ACL_CALL,
  },
  // acl.ts, apiItem: цель api — не маска эндпоинта
  'access.bad_endpoint_mask': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: api {endpoint} — маска эндпоинта: сегменты через «.», {a,b} — любой из, * — хвост',
    en: 'db.acl.{what}: api {endpoint} is an endpoint mask: segments separated by ".", {a,b} — any of them, * — the tail',
    hint: ACL_CALL,
  },
  // acl.ts, parse: описание правила grant, deny или revoke — не объект
  'access.rule_spec_not_object': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: нужен объект { role, read | write | delete | api }',
    en: 'db.acl.{what}: an object { role, read | write | delete | api } is expected',
    hint: ACL_CALL,
  },
  // acl.ts, parse: лишнее поле в описании правила (у revoke нет и weight)
  'access.unknown_rule_field': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: поле {field} — допустимы {fields}',
    en: 'db.acl.{what}: field {field} — allowed fields are {fields}',
    hint: ACL_CALL,
  },
  // acl.ts, parse: weight — не целое от 1 до 999
  'access.bad_rule_weight': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: weight — целое от 1 до 999: вес правила арендатора (от 1000 — административный слой System)',
    en: 'db.acl.{what}: weight is an integer from 1 to 999: the weight of a tenant rule (1000 and above is the System admin layer)',
    hint: ACL_CALL,
  },
  // acl.ts, parse: в описании правила нет ни read, ни write, ни delete, ни api
  'access.no_rule_operations': {
    code: 'invalid_data',
    ru: 'db.acl.{what}: нужна хотя бы одна операция: read, write, delete или api',
    en: 'db.acl.{what}: at least one operation is required: read, write, delete or api',
    hint: ACL_CALL,
  },
  // acl.ts, makeAcl: db.acl без фасада подключения, а grant, deny, revoke, roles и list идут его цепочками
  'access.no_facade': {
    code: 'invalid_query',
    ru: 'db.acl: запись правил — от фасада подключения',
    en: 'db.acl: rules are written only through a connection facade',
  },
  // acl.ts, roles(): аккаунт — не id и не строка с полем id
  'access.bad_account': {
    code: 'invalid_data',
    ru: 'db.acl.roles: аккаунт — id или строка с полем id',
    en: 'db.acl.roles: the account is an id or a row with an id field',
    hint: ACL_CALL,
  },
  // acl.ts, roles(): у фасада нет рабочего арендатора — подключение без сессии
  'access.no_session_tenant': {
    code: 'no_session',
    ru: 'db.acl.roles: нет арендатора сессии',
    en: 'db.acl.roles: the session has no tenant',
  },
  // acl.ts, roles(): роли — не массив и не null
  'access.roles_not_array': {
    code: 'invalid_data',
    ru: 'db.acl.roles: роли — массив строк или null (снять членство)',
    en: 'db.acl.roles: roles is an array of strings or null (to remove the membership)',
    hint: ACL_CALL,
  },
  // acl.ts, roles(): роль в списке повторяется
  'access.duplicate_roles': {
    code: 'invalid_data',
    ru: 'db.acl.roles: роли повторяются',
    en: 'db.acl.roles: duplicate roles',
    hint: ACL_CALL,
  },
  // auth.ts, verifyHash: scrypt отверг N, r, p из строки хэша — недопустимы или требуют больше 64 МБ памяти
  'access.bad_scrypt_params': {
    code: 'invalid_data',
    ru: 'хэш пароля: параметры scrypt N={N}, r={r}, p={p} недопустимы или требуют больше 64 МБ памяти',
    en: 'password hash: the scrypt parameters N={N}, r={r}, p={p} are invalid or need more than 64 MB of memory',
    hint: {
      ru: 'хэш с такими параметрами не проверить: задать пароль заново — auth.setPassword()',
      en: 'a hash with such parameters cannot be checked: set the password again with auth.setPassword()',
    },
  },
  // auth.ts, base32Decode: в секрете TOTP (totpCode) знак не из алфавита base32
  'access.bad_totp_secret': {
    code: 'invalid_data',
    ru: 'секрет TOTP — не base32',
    en: 'the TOTP secret is not base32',
    hint: {
      ru: 'передать секрет из auth.enrollTotp() — строку base32 (A–Z, 2–7)',
      en: 'pass the secret from auth.enrollTotp() — a base32 string (A–Z, 2–7)',
    },
  },
} satisfies Section<'access'>;
