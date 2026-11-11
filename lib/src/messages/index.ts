/**
 * Каталог сообщений letopis: ключ → код ошибки, шаблон текста и, если нужно, своя подсказка «что делать». Здесь разделы
 * сливаются в MESSAGES (префикс ключа — имя раздела, ключи не повторяются), а render() подставляет параметры; ошибки и
 * тексты строит errors.ts — lerr, lmsg, lwarn.
 *
 * Как завести запись и бросить ошибку по ней (образцы: записи разделов api, query, access, sql-core, sql-write,
 * sql-time и места, которые их бросают).
 *
 * 1. Раздел — по файлу, где брошена ошибка:
 *      api — core, house, chain, typed, errors, internal;  write — write, tx, load;  query — sql, ops;
 *      time — watch, admin, cache, signals;  access — auth, acl;  model — model, registry, sync, cli, validate,
 *      jsonschema, uuid;  boot — up, pglite (и пропуск в house);  mcp — mcp, describe;  log — log (и тексты
 *      логирования из core, tx);  sql-core — sql/10, 15, 20, 30, 40;  sql-write — sql/60;  sql-access — sql/50, 80;
 *      sql-time — sql/70, 90, 95, 99.
 *    codes.ts — запись на каждый код: заголовок и подсказка. Новый код — ещё ErrorCode (types.ts), для кода базы —
 *    LT_NAMES (errors.ts) и error_catalog(), и строка таблицы «Ошибки» README с якорем `<a id="код"></a>`.
 * 2. Ключ — `<раздел>.<snake_case>`: что случилось, а не где (api.unknown_step, query.sort_field). Одно место — один
 *    ключ; одинаковый текст в разных разделах — разные ключи (api.validation_failed и sql-write.invalid_data).
 * 3. Запись — { code, ru, hint? }, поля в этом порядке:
 *    code — код ошибки места; код существующей записи не меняется (коды сверяет check:semver);
 *    ru — текст без префикса «letopis: <код>: »; значение — параметр {имя};
 *    hint — только если подсказка кода из codes.ts к месту не подходит (образцы: api.connect_schema,
 *    sql-access.member_invite_only).
 *    Параметр печатается как `${x}` в шаблонной строке; лучше скаляры (строка, число). Похожие имена — params.similar
 *    (массив из similar() в errors.ts): «— похожие: a, b» lerr допишет сам, в шаблон их не пишут.
 *    Текст с двумя формами (род, число) — две записи или параметр без грамматики, а не склейка слов в коде.
 * 4. Вызов в TS:
 *      throw lerr('api.unknown_step', { name, similar: similar(name, names) });
 *      throw lerr('api.closed');
 *      throw lerr('<раздел>.<ключ>', { cls }, { detail: { id }, cause: e });
 *    Текст не для ошибки (сообщение нарушения, описание) — lmsg(ключ, параметры); предупреждение — lwarn(ключ,
 *    параметры, { once }). Подкласс и помощник вида fail(текст) берут ключ так же (образец — ValidationError в
 *    errors.ts); new LetopisError(код, текст) с литеральным текстом не пишут.
 * 5. Вызов в SQL — перегрузка lt_fail(p_key text, p_params jsonb default '{}', p_detail jsonb default null)
 *    (lib/sql/15-errors.sql): код ошибки — из записи, текст база собирает из шаблона ru (его видит и сырой SQL), в
 *    DETAIL — поля p_detail и ещё key, params; их fromDbError переносит в поля ошибки (key, params):
 *      perform @SCHEMA@.lt_fail('sql-core.no_membership');
 *      perform @SCHEMA@.lt_fail('sql-write.invalid_data', jsonb_build_object('cls', NEW.class), jsonb_build_object('issues', bad));
 *    Параметры — jsonb_build_object со скалярами (список — array_to_string); без параметров — один аргумент, а не null
 *    (литерал без типа выбрал бы перегрузку lt_fail(имя, текст)). detail ошибки: без p_detail — {}, с p_detail =>
 *    'null' — detail нет. Свой SQLSTATE не из каталога — lt_raise(p_code, p_key, p_params, p_detail). В функциях,
 *    которые исполняет приложение (inc, links_patch: lt_fail ему не выдан), — raise (errcode — SQLSTATE кода,
 *    message — префикс «letopis: <код>: » и текст), только текст — lt_text(ключ, параметры) (она выдана приложению),
 *    а detail — jsonb_build_object('key', ключ, 'params', параметры)::text; без своих полей — ещё 'nodetail', true
 *    (detail нет, как у raise без detail).
 *    Разделы sql-* установщик кладёт в базу при каждом setup() (@MESSAGES@): новой ревизии не нужно.
 * 6. Затем cd lib && npm run typecheck, npm run check:docs (литеральные тексты в LetopisError, fail и lt_fail ловит
 *    сверка literals) и npm run api:contract.
 * 7. Особые места. Разделы каталога контракт API читает регэкспами: код — из поля code: в кавычках, текст ошибки — из
 *    строки с префиксом letopis и двоеточием; в комментариях их в таком виде не пишут. up.ts и pglite.ts бросают
 *    обычный Error с префиксом letopis.setup (у install() и checkServer() — letopis.up) и текстом lmsg(…) — подходящего
 *    кода нет. Сообщения нарушений (issues[].message: validate.ts, 30-validate.sql) — lmsg и lt_text с кодом
 *    invalid_data. Описания инструментов MCP и instructions — строки в mcp.ts рядом со схемами, тексты ответов —
 *    раздел mcp.
 */
import { access } from './access.js';
import { api } from './api.js';
import { boot } from './boot.js';
import { codes } from './codes.js';
import { log } from './log.js';
import { mcp } from './mcp.js';
import { model } from './model.js';
import { query } from './query.js';
import { sqlAccess } from './sql-access.js';
import { sqlCore } from './sql-core.js';
import { sqlTime } from './sql-time.js';
import { sqlWrite } from './sql-write.js';
import { time } from './time.js';
import { write } from './write.js';
import type { ErrorCode, Msg, Params } from './types.js';

export type { ErrorCode, Msg, Params, Section } from './types.js';
/** Каталог событий логирования (не сообщения об ошибках — в MESSAGES не входит). */
export { LOG_EVENTS, type LogEventInfo, type LogEventLevel, type LogEventName } from './log.js';

/** Разделы каталога: имя — префикс ключа и имя файла. */
const SECTIONS = {
  codes, api, write, query, time, access, model, boot, mcp, log,
  'sql-core': sqlCore, 'sql-write': sqlWrite, 'sql-access': sqlAccess, 'sql-time': sqlTime,
} as const;

/** Разделы, которые установщик кладёт в базу (message_catalog() в lib/sql/15-errors.sql). */
export const SQL_SECTIONS = ['sql-core', 'sql-write', 'sql-access', 'sql-time'] as const;

type All = typeof codes & typeof api & typeof write & typeof query & typeof time & typeof access & typeof model
  & typeof boot & typeof mcp & typeof log & typeof sqlCore & typeof sqlWrite & typeof sqlAccess & typeof sqlTime;
/** Ключ каталога: опечатку в lerr('…') ловит проверка типов. */
export type MsgKey = keyof All;

function merge(sections: Readonly<Record<string, Readonly<Record<string, Msg>>>>): Record<string, Msg> {
  const out: Record<string, Msg> = {};
  for (const [name, section] of Object.entries(sections)) {
    for (const [key, m] of Object.entries(section)) {
      if (!key.startsWith(`${name}.`)) throw new Error(`letopis: ключ каталога ${key} — не из раздела ${name}`);
      if (Object.hasOwn(out, key)) throw new Error(`letopis: ключ каталога ${key} повторяется`);
      out[key] = m;
    }
  }
  return out;
}

/** Все записи каталога по ключу. */
export const MESSAGES = merge(SECTIONS) as Readonly<Record<MsgKey, Msg>>;

/** Запись по ключу из любого источника (DETAIL базы, вызов из JS); нет такой — undefined. */
export function msgOf(key: string): Msg | undefined {
  return Object.hasOwn(MESSAGES, key) ? MESSAGES[key as MsgKey] : undefined;
}

/** Подпись кода: заголовок и подсказка «что делать» (codes.ts). */
export function codeOf(code: string): (Msg & { hint: string }) | undefined {
  return msgOf(`codes.${code}`) as (Msg & { hint: string }) | undefined;
}

/** Суффикс похожих имён (params.similar) — его дописывает lerr. */
export const SIMILAR = ' — похожие: {similar}';

/**
 * Шаблон с параметрами: `{имя}` → значение, напечатанное как в шаблонной строке JS (`${x}`), поэтому перенос текста
 * `…${x}…` в шаблон `…{x}…` его не меняет. `{имя}` без такого параметра остаётся как есть; так же — lt_text() в базе
 * (там null — пусто, как у format('%s')).
 */
export function render(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k: string) => (Object.hasOwn(params, k) ? String(params[k]) : m));
}

/** Разделы sql-* для базы: ключ → имя ошибки и русский шаблон (установщик подставляет в @MESSAGES@). */
export function sqlCatalog(): Record<string, { name: ErrorCode; ru: string }> {
  const out: Record<string, { name: ErrorCode; ru: string }> = {};
  for (const s of SQL_SECTIONS) {
    for (const [key, m] of Object.entries(SECTIONS[s] as Readonly<Record<string, Msg>>)) out[key] = { name: m.code, ru: m.ru };
  }
  return out;
}
