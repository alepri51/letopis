/**
 * Раздел api: index.ts, chain.ts, typed.ts, errors.ts, internal.ts — подключение, фасад, цепочки, батч, ошибки.
 */
import type { Section } from './types.js';

export const api = {
  // errors.ts, ValidationError: данные не проходят проверку на TypeScript (из базы — sql-write.invalid_data)
  'api.validation_failed': {
    code: 'invalid_data',
    ru: 'данные не проходят описание класса {cls}',
    en: 'the data does not match the description of class {cls}',
  },
  // chain.ts: шаг цепочки — не класс, не алиас и не роль реестра сессии; похожие имена — params.similar
  'api.unknown_step': {
    code: 'invalid_class',
    ru: 'класс или роль {name} не найдены',
    en: 'class or role {name} not found',
  },
  // index.ts: connect({ schema })
  'api.connect_schema': {
    code: 'invalid_data',
    ru: 'connect: схема {schema} — нужно v<N>.<имя>',
    en: 'connect: schema {schema} — expected v<N>.<name>',
    hint: {
      ru: 'имя схемы — v<N>.<имя>, как у up({ schema }): например, v2.salon',
      en: 'the schema name is v<N>.<name>, as in up({ schema }): for example, v2.salon',
    },
  },
  // errors.ts: опция lang у connect(), createMcpServer() и CLI (--lang)
  'api.bad_lang': {
    code: 'invalid_data',
    ru: "{where}: lang — 'ru' или 'en', а не {lang}",
    en: "{where}: lang is 'ru' or 'en', not {lang}",
    hint: {
      ru: "передать lang: 'ru' (по умолчанию) или 'en'",
      en: "pass lang: 'ru' (the default) or 'en'",
    },
  },
  // errors.ts, checkOptions: неизвестная опция connect(), up(), load(), проектора, watch(), createMcpServer() — в 1.5
  // предупреждение (lwarn), в 2.0 — ошибка
  'api.unknown_option': {
    code: 'invalid_data',
    ru: 'неизвестная опция {where}({ {name} })',
    en: 'unknown option {where}({ {name} })',
    hint: {
      ru: 'проверить имя опции: похожие названы в тексте, все опции — в README, «Справочник API»',
      en: 'check the option name: similar ones are named in the text, all options are in README, "API reference"',
    },
  },
} satisfies Section<'api'>;
