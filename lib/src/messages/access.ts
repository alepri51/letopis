/**
 * Раздел access: auth.ts, acl.ts — вход, креды, сессии, права.
 */
import type { Section } from './types.js';

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
} satisfies Section<'access'>;
