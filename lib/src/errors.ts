/**
 * Ошибки letopis 1.0 (план, §7.1, этап 2, п. 10). Текст — «letopis: <код>: <сообщение>», как у ошибок
 * базы; код — имя из каталога (`error_catalog()` в lib/sql/15-errors.sql) или код самой библиотеки.
 */

/** Нарушение правила данных: путь, ключевое слово JSON Schema, сообщение. Один формат для Zod, валидатора и базы. */
export interface Issue {
  path: (string | number)[];
  keyword: string;
  message: string;
}

export class LetopisError extends Error {
  readonly code: string;
  readonly detail: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(`letopis: ${code}: ${message}`);
    this.name = 'LetopisError';
    this.code = code;
    this.detail = detail;
  }
}

/** Охранник снесённого API (план, этап 3, п. 11): понятная ошибка с версией и заменой. */
export function removed(name: string, replacement: string): LetopisError {
  return new LetopisError('removed', `${name} снят в 1.0.0 — ${replacement}`);
}

/** Метод зарезервирован, но появится на следующем этапе плана. */
export function notYet(name: string, stage: number): LetopisError {
  return new LetopisError('not_implemented', `${name} появится на этапе ${stage} плана 1.0`);
}

/** Данные не проходят описание класса (`invalid_data`). */
export class ValidationError extends LetopisError {
  readonly issues: Issue[];
  constructor(cls: string, issues: Issue[]) {
    super('invalid_data', `данные не проходят описание класса ${cls}`, { issues });
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/** Код SQLSTATE класса LT → имя ошибки letopis (каталог error_catalog() в базе). */
const LT_NAMES: Record<string, string> = {
  LT001: 'no_session', LT002: 'target_not_found', LT003: 'invalid_data', LT004: 'undeclared_end', LT005: 'tenant_denied',
  LT006: 'acl_denied', LT007: 'id_mismatch', LT008: 'id_from_db', LT009: 'immutable_key', LT010: 'invalid_class',
  LT011: 'use_reclass', LT012: 'reclass_denied', LT013: 'tightening_conflict', LT014: 'isolation_level',
  LT015: 'recreated_in_statement', LT016: 'cursor_expired', LT017: 'delete_restricted', LT018: 'not_deleted',
  LT019: 'reset_disabled', LT020: 'confirm_mismatch', LT021: 'derived_class', LT022: 'aggregate_field',
  LT023: 'projector_pending',
};

/**
 * Ошибка базы → LetopisError (ValidationError для invalid_data с нарушениями). Детали из DETAIL
 * (JSON) переносятся в detail; прочие ошибки возвращаются как есть.
 */
export function fromDbError(e: unknown): unknown {
  const err = e as { code?: string; message?: string; detail?: string; routine?: string };
  // новые значения строки не проходят условие ACL (политика RLS WITH CHECK) — отказ по правам; upsert,
  // которому существующую строку менять нельзя («USING expression»), остаётся 42501 (§2.5). Признак —
  // функция сервера, а не текст: текст зависит от языка сервера
  if (err.code === '42501' && err.routine === 'ExecWithCheckOptions' && !/USING/.test(err.message ?? '')) {
    return Object.assign(new LetopisError('acl_denied', 'новые значения строки запрещают правила доступа'), { cause: e });
  }
  const name = err.code ? LT_NAMES[err.code] : undefined;
  if (!name) return e;
  let detail: unknown;
  try {
    detail = err.detail ? JSON.parse(err.detail) : undefined;
  } catch {
    detail = err.detail;
  }
  const text = (err.message ?? '').replace(/^letopis: [a-z_]+: /, '');
  const issues = (detail as { issues?: Issue[] } | undefined)?.issues;
  if (name === 'invalid_data' && Array.isArray(issues)) {
    const cls = /класса (\S+)/.exec(text)?.[1] ?? '?';
    const v = new ValidationError(cls, issues);
    // текст базы целиком: в нём бывает больше, чем имя класса (у проектора — арендатор и id строки)
    return Object.assign(v, { cause: e, ...(text ? { message: `letopis: invalid_data: ${text}` } : {}) });
  }
  return Object.assign(new LetopisError(name, text, detail), { cause: e });
}
