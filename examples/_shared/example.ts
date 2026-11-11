/**
 * Исполняемый пример документации: шаги на настоящей базе.
 *
 * Раннер (`run.ts`, ядро — `_runner/runner.ts`) строит каждому примеру свой дом, выполняет шаги по очереди и после
 * каждого шага снимает данные таблиц `entity`, `log` и (по запросу) `secret`. Сайт показывает эти снимки пошагово.
 * Код шага, который видит читатель, — это тело функции `run` из исходника примера: что показано, то и исполнено.
 * Строки с комментарием `// скрыть` в показ не попадают.
 *
 * Файл примера — ещё и самостоятельный скрипт: `npx tsx basics/01-first-object.ts` (из каталога examples/) сам
 * готовит дом так же, как раннер, выполняет шаги подряд и печатает результат каждого (`_runner/direct.ts`).
 */
import type { AnyModel } from 'letopis/model';
import type { House, HouseOptions, Room } from 'letopis';
import type postgres from 'postgres';

export interface Ctx {
  /** Имя дома примера (`g_basics_01_first_object`): `setup(ADMIN_DSN, name)`; схема дома — `v2.<name>`. */
  name: string;
  /** Схема дома, `v2.<name>`, — для сырого SQL мастер-ключом. */
  schema: string;
  /** Мастер-ключ: строка подключения администратора PostgreSQL. */
  ADMIN_DSN: string;
  /** Пропуск консьержа — его отдал `setup()`. */
  pass: string;
  /** Консьерж с почтальоном-заглушкой: `connect(pass, { postman })` (`_shared/postman.ts`). */
  db: House;
  /** Анна в квартире «Ромашка» (owner): корень квартиры, его отдал `db.accept(token)` по её приглашению. */
  me: Room;
  /** Ключ Анны: контакт (он же имя для входа) и пароль от «Ромашки». */
  annaKey: { email: string; password: string };
  /** SQL мастер-ключом (postgres.js, суперпользователь) — для примеров про саму базу. */
  admin: postgres.Sql;
  /** Консьерж, которого раннер сам закроет после примера (`connect` с тем же пропуском и опциями). */
  connect: (pass: string, opts?: HouseOptions) => Promise<House>;
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
  /** Пункты матрицы покрытия: `chain.create`, `house.open`, `error.acl_denied`, `nuance.empty-update`. */
  covers: string[];
  /** Какие таблицы показывать (по умолчанию entity и log). */
  tables?: Table[];
  /** Классы, чьи строки показывать, даже если они служебные (например, `Class`). */
  classes?: string[];
  /**
   * Подготовка: `tenant` (по умолчанию) — дом с моделями `models`, консьерж с почтальоном-заглушкой, квартира
   * «Ромашка» и её owner Анна, вошедшая по приглашению; `none` — дома нет: пример строит его сам (`setup(ADMIN_DSN, name)`, глава об установке),
   * `ctx.pass`, `ctx.db`, `ctx.me` не заданы.
   */
  setup?: 'tenant' | 'none';
  /** Модели дома: их записывает `setup(ADMIN_DSN, name, { models })` при подготовке (у `setup: 'none'` не действует). */
  models?: readonly AnyModel[];
  steps: Step[];
}

/** Метка «пример загружен раннером»: её ставит `_runner/runner.ts`, и `example()` тогда сам ничего не запускает. */
export const RUNNER = Symbol.for('letopis.examples.runner');

export function example(def: Example): Example {
  // файл запущен сам (`npx tsx <глава>/<файл>.ts`), а не загружен раннером или песочницей — выполнить шаги подряд
  if (!(globalThis as Record<symbol, unknown>)[RUNNER]) {
    setImmediate(() => {
      if ((globalThis as Record<symbol, unknown>)[RUNNER]) return;
      void import('../_runner/direct.ts').then((m) => m.runDirect(def));
    });
  }
  return def;
}
