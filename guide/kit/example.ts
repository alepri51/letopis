/**
 * Исполняемый пример документации: шаги на настоящей базе.
 *
 * Раннер (`scripts/run-examples.ts`) ставит каждому примеру свою схему, выполняет шаги по очереди и после каждого
 * шага снимает данные таблиц `entity`, `log` и (по запросу) `secret`. Сайт показывает эти снимки пошагово.
 * Код шага, который видит читатель, — это тело функции `run` из исходника примера: что показано, то и исполнено.
 * Строки с комментарием `// скрыть` в показ не попадают.
 */
import type { ConnectOptions, Db, UpResult } from 'letopis';
import type postgres from 'postgres';

export interface Ctx {
  /** Полное имя схемы примера, например `v2.g_basics_01`. */
  schema: string;
  /** Результат установки: ключ сервиса, арендатор и его первый пользователь. */
  up: UpResult;
  /** Сервис приложения: вошёл по ключу (`connect({ apiKey })`). */
  svc: Db;
  /** Работа от имени первого пользователя в его арендаторе (`svc.as(user, { tenant })`). */
  db: Db;
  /** Администраторское подключение postgres.js (суперпользователь) — для сырого SQL в примерах про базу. */
  admin: postgres.Sql;
  /** Строки подключения: администратор и роль приложения. */
  dsn: { admin: string; app: string };
  /** Логин и пароль первого пользователя. */
  user: { login: string; password: string };
  /** Подключение, которое раннер сам закроет после примера (`connect` с теми же опциями). */
  connect: (opts: ConnectOptions) => Promise<Db>;
  /** Выполнить функцию и собрать предупреждения `console.warn`, которые она напечатала. */
  warnings: <T>(fn: () => Promise<T>) => Promise<{ result: T; warnings: string[] }>;
}

export interface Expect {
  /** Шаг обязан упасть с этим кодом ошибки (`LetopisError.code`). */
  error?: string;
  /** Своя проверка результата: бросить исключение, если не то. */
  check?: (result: any, ctx: Ctx) => void | Promise<void>;
}

/** entity, log, secret — строки таблиц; counts — сводка: сколько строк каких классов, версий каких действий, секретов каких видов. */
export type Table = 'entity' | 'log' | 'secret' | 'counts';

export interface Step {
  /** Что делаем — коротко, как заголовок шага. */
  title: string;
  /** Пояснение простым языком: что произойдёт и на что смотреть в данных (markdown). */
  text?: string;
  run: (ctx: Ctx) => Promise<unknown>;
  expect?: Expect;
}

export interface Example {
  title: string;
  /** Одна-две фразы: чему учит пример. */
  summary?: string;
  /** Пункты матрицы покрытия: `chain.create`, `db.auth`, `error.acl_denied`, `nuance.empty-update`. */
  covers: string[];
  /** Какие таблицы показывать (по умолчанию entity и log). */
  tables?: Table[];
  /** Классы, чьи строки показывать, даже если они служебные (например, `Class`). */
  classes?: string[];
  /**
   * Подготовка схемы: `tenant` (по умолчанию) — установка с арендатором «Ромашка», сервис и вход Анны;
   * `none` — пустая схема: пример сам вызывает `up()` (глава об установке); `ctx.up`, `ctx.svc`, `ctx.db` не заданы.
   */
  setup?: 'tenant' | 'none';
  steps: Step[];
}

export function example(def: Example): Example {
  return def;
}
