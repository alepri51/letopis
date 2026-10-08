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

/** Данные не проходят описание класса (`invalid_data`). */
export class ValidationError extends LetopisError {
  readonly issues: Issue[];
  constructor(cls: string, issues: Issue[]) {
    super('invalid_data', `данные не проходят описание класса ${cls}`, { issues });
    this.name = 'ValidationError';
    this.issues = issues;
  }
}
