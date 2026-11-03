/**
 * Каталог сообщений letopis (план 2.0, этап 3, п. 3) — типы записей. Как перевести место на ключ и вызывать — шапка
 * index.ts.
 */

/**
 * Коды ошибок letopis: каталог базы (SQLSTATE LT001–LT018, `error_catalog()` в lib/sql/15-errors.sql, `LT_NAMES` в
 * errors.ts) и коды самой библиотеки. Новый код — сюда, в codes.ts (заголовок и подсказка) и в раздел «Ошибки» README
 * (с якорем `<a id="код"></a>`). `internal` — внутренняя ошибка базы: SQLSTATE XX000 с ключом каталога в DETAIL
 * (`lt_raise('XX000', ключ, …)`, fromDbError).
 */
export type ErrorCode =
  | 'no_session' | 'target_not_found' | 'invalid_data' | 'undeclared_end' | 'tenant_denied' | 'acl_denied'
  | 'id_mismatch' | 'id_from_db' | 'immutable_key' | 'invalid_class' | 'use_reclass' | 'reclass_denied'
  | 'tightening_conflict' | 'isolation_level' | 'recreated_in_statement' | 'cursor_expired' | 'delete_restricted'
  | 'not_deleted'
  | 'exists' | 'duplicate' | 'deleted' | 'conflict' | 'rev_ambiguous' | 'tx_required' | 'lock_unsupported'
  | 'commit_unknown' | 'tx_rolled_back' | 'no_key' | 'no_path' | 'invalid_query' | 'admin_required'
  | 'not_empty' | 'class_not_loadable' | 'bypass_rls'
  | 'user_session_required' | 'confirmation_required' | 'internal';

/**
 * Запись каталога: код ошибки, шаблон текста (`ru`), `{имя}` в шаблоне — параметр. `hint` — своя подсказка «что делать»;
 * без неё ошибка берёт подсказку своего кода из codes.ts. Поля — в этом порядке: code, ru, hint.
 */
export interface Msg {
  code: ErrorCode;
  ru: string;
  hint?: string;
}

/**
 * Параметры шаблона: `{имя}` → значение, напечатанное как в шаблонной строке JS (`${x}`). `similar` (массив похожих
 * имён) дописывает к тексту «— похожие: …» сам `lerr`.
 */
export type Params = Readonly<Record<string, unknown>>;

/** Раздел каталога: ключи только вида `<раздел>.<snake_case>` — чужой префикс не пропустит проверка типов. */
export type Section<P extends string> = Record<`${P}.${string}`, Msg>;
