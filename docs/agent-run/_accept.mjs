/**
 * Агентский прогон (docs/agent-run.md): общая часть приёмочных скриптов accept-a, accept-b и accept-c.
 *
 * Пакеты приёмка берёт из каталога агента — той версии letopis, на которой он решал: `node_modules/letopis` и
 * postgres.js, которым пользуется сам letopis. Решение ставится на пустую схему `v2.accept_<версия>_<задача>`
 * вызовом `run(dsn, схема)`. Затем приёмка проверяет данные SQL суперпользователя по таблицам `entity` и `log`, а
 * поведение и права — подключениями пользователей. Пользователь входит паролем через сервис установки
 * (`auth.verifyPassword`) и работает прикладной ролью `letopis_accept` без обхода RLS.
 *
 * Запуск: node docs/agent-run/accept-<задача>.mjs <каталог агента> [--solution файл] [--schema v2.имя] [--drop]
 *   --solution — другой файл решения (по умолчанию <каталог>/solution-<задача>.mjs);
 *   --schema   — другая схема (по умолчанию v2.accept_<версия без точек>_<задача>);
 *   --drop     — удалить схему после проверки (по умолчанию остаётся для разбора).
 * DSN базы — AGENT_RUN_DSN, иначе postgres://postgres:test@localhost:15433/letopis.
 * Код выхода: 0 — сборка, run() и все проверки прошли; 1 — что-то не прошло; 2 — сбой приёмки (аргументы, база).
 * Последняя строка вывода — `RESULT {json}` для сводки в docs/checkpoint-<версия>.md.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ADMIN = process.env.AGENT_RUN_DSN ?? 'postgres://postgres:test@localhost:15433/letopis';
const APP_ROLE = 'letopis_accept';
const APP_PASSWORD = 'accept';
const RUN_TIMEOUT_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 3 * 60_000;

/** Провал проверки: ожидание не сбылось (в отличие от ошибки letopis с кодом). */
export class Fail extends Error {}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** JSON с ключами по алфавиту: сравнение без учёта порядка ключей, порядок массивов важен. */
export function canon(v) {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
    : x));
}

export function eq(actual, expected, what) {
  const a = canon(actual), e = canon(expected);
  if (a !== e) throw new Fail(`${what}: ожидалось ${e}, получено ${a}`);
}

export function errText(e) {
  const s = e?.code ? `${e.code}: ${e.message}` : String(e?.message ?? e);
  return s.replace(/\s+/g, ' ').slice(0, 400);
}

/** Коды ожидаемых отказов (rejects): какими кодами база и библиотека отклоняли запрещённое. */
const refusals = {};

/** Операция должна быть отклонена; code — ожидаемый код (без него подходит любой отказ). Возвращает код отказа. */
export async function rejects(op, code) {
  try {
    await op();
  } catch (e) {
    if (e instanceof Fail) throw e;
    if (code && e?.code !== code) throw new Fail(`ожидался отказ ${code}, получен ${errText(e)}`);
    if (e?.code === 'invalid_class') throw new Fail(`отказ invalid_class — класса нет, проверять нечего: ${errText(e)}`);
    const got = e?.code ?? 'без кода';
    refusals[got] = (refusals[got] ?? 0) + 1;
    return got;
  }
  throw new Fail(`ожидался отказ${code ? ` ${code}` : ''}, а операция прошла`);
}

/** Точка входа файла пакета по его package.json: exports['.'] (import | node | default), module, main. */
function entryOf(pkgDir) {
  const p = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  let e = p.exports;
  if (e && typeof e === 'object' && !Array.isArray(e) && '.' in e) e = e['.'];
  const pick = (x) => (typeof x === 'string' ? x
    : x && typeof x === 'object' ? (pick(x.import) ?? pick(x.node) ?? pick(x.default)) : undefined);
  return pathToFileURL(join(pkgDir, pick(e) ?? p.module ?? p.main ?? 'index.js')).href;
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Fail(`${what}: нет ответа за ${ms / 1000} с`)), ms); }),
  ]);
}

function parseArgs() {
  const out = { dir: null, solution: null, schema: null, drop: false };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--solution') out.solution = a[++i];
    else if (a[i] === '--schema') out.schema = a[++i];
    else if (a[i] === '--drop') out.drop = true;
    else if (!a[i].startsWith('--') && !out.dir) out.dir = a[i];
    else return { error: `неизвестный аргумент ${a[i]}` };
  }
  if (!out.dir) return { error: 'не указан каталог агента' };
  return out;
}

function bail(msg) {
  console.error(`приёмка: ${msg}`);
  console.error('запуск: node docs/agent-run/accept-<a|b|c>.mjs <каталог агента> [--solution файл] [--schema v2.имя] [--drop]');
  process.exit(2);
}

/**
 * Готовит приёмку: пакеты из каталога агента, сборку решения, пустую схему, run(), роль приложения.
 * opts: { task: 'a' | 'b' | 'c', title, exports: [имена функций решения] }.
 */
export async function start(opts) {
  const args = parseArgs();
  if (args.error) bail(args.error);
  const dir = resolve(args.dir);
  const pkgDir = join(dir, 'node_modules', 'letopis');
  if (!existsSync(join(pkgDir, 'package.json'))) bail(`в ${dir} нет node_modules/letopis`);
  const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  const tag = version.split('-')[0].replaceAll('.', '');
  const schema = args.schema ?? `v2.accept_${tag}_${opts.task}`;
  if (!/^v2\.[a-z0-9_]+$/.test(schema)) bail(`схема ${schema}: нужно имя вида v2.<строчные латинские буквы, цифры, _>`);
  const S = ident(schema);
  const L = await import(entryOf(pkgDir));
  const pgDir = existsSync(join(pkgDir, 'node_modules', 'postgres', 'package.json'))
    ? join(pkgDir, 'node_modules', 'postgres') : join(dir, 'node_modules', 'postgres');
  const postgres = (await import(entryOf(pgDir))).default;
  const appUrl = new URL(ADMIN);
  appUrl.username = APP_ROLE;
  appUrl.password = APP_PASSWORD;
  const app = appUrl.toString();

  const checks = [];
  const errors = {};
  const warnings = [];
  const opened = [];
  const result = {
    task: opts.task, title: opts.title, version, schema,
    solution: resolve(args.solution ?? join(dir, `solution-${opts.task}.mjs`)),
    build: { ok: false }, run: { ok: false },
  };
  const countError = (e) => {
    const code = e?.code;
    if (code && !(e instanceof Fail)) errors[code] = (errors[code] ?? 0) + 1;
  };
  process.on('unhandledRejection', (e) => {
    countError(e);
    console.error(`приёмка: необработанный отказ в решении — ${errText(e)}`);
  });

  console.log(`== Приёмка задачи ${opts.task} (${opts.title}) — letopis ${version}`);
  console.log(`каталог: ${dir}`);
  console.log(`решение: ${result.solution}`);
  console.log(`схема: ${schema}`);

  const sql = postgres(ADMIN, { max: 3, onnotice: () => {} });
  try {
    await sql`select 1`;
  } catch (e) {
    bail(`база ${appUrl.host} не отвечает: ${errText(e)}`);
  }

  // Сборка: файл есть, синтаксис верен, модуль импортируется и отдаёт нужные функции.
  let mod = null;
  const b = result.build;
  if (!existsSync(result.solution)) {
    b.error = 'файла решения нет';
  } else {
    const r = spawnSync(process.execPath, ['--check', result.solution], { encoding: 'utf8' });
    if (r.status !== 0) {
      b.error = `node --check: ${(r.stderr || r.stdout).trim().split('\n').slice(0, 6).join(' | ')}`;
    } else {
      try {
        mod = await import(pathToFileURL(result.solution).href);
      } catch (e) {
        countError(e);
        b.error = `импорт: ${errText(e)}`;
      }
    }
  }
  b.missing = opts.exports.filter((n) => typeof mod?.[n] !== 'function');
  b.ok = Boolean(mod) && b.missing.length === 0;
  if (mod && b.missing.length) b.error = `нет функций: ${b.missing.join(', ')}`;
  console.log(`сборка: ${b.ok ? 'ok' : `НЕТ — ${b.error}`}`);

  /** Вызов функции решения: тайм-аут, перехват process.exit и console.warn (предупреждения библиотеки). */
  async function call(name, ...params) {
    const realExit = process.exit;
    const realWarn = console.warn;
    process.exit = (c) => { throw new Fail(`решение вызвало process.exit(${c ?? ''})`); };
    console.warn = (...w) => {
      warnings.push(w.map(String).join(' ').slice(0, 300));
      realWarn(...w);
    };
    try {
      return await withTimeout(mod[name](...params), name === 'run' ? RUN_TIMEOUT_MS : CALL_TIMEOUT_MS, `${name}()`);
    } finally {
      process.exit = realExit;
      console.warn = realWarn;
    }
  }

  const ctx = {
    task: opts.task, version, tag, schema, S, L, sql, app, dir, mod, call, result,

    /** Запрос суперпользователем. */
    q: (text, params = []) => sql.unsafe(text, params),

    /** id арендатора по имени: ровно одна строка Account с таким data.name. */
    async tenantId(name) {
      const rows = await sql.unsafe(`select id from ${S}.entity where class = 'Account' and data->>'name' = $1`, [name]);
      if (rows.length !== 1) throw new Fail(`арендатор «${name}»: строк Account с таким именем — ${rows.length}, нужна одна`);
      return rows[0].id;
    },

    /** Живые строки класса в арендаторе. */
    live: (cls, tenant) => sql.unsafe(
      `select id, rev, data, links from ${S}.entity where class = $1 and tenant = $2::uuid order by id`, [cls, tenant]),

    /** Есть ли живая строка с этим id. */
    async isLive(id) {
      const [r] = await sql.unsafe(`select count(*)::int as n from ${S}.entity where id = $1`, [id]);
      return r.n > 0;
    },

    /** Все версии id из журнала по порядку. */
    versions: (id) => sql.unsafe(
      `select rev, op, data, links, reason, at from ${S}.log where id = $1 order by rev`, [id]),

    /** id из журнала класса в арендаторе, у которых в какой-либо версии поле данных равно значению. */
    async idsInLog(cls, tenant, field, value) {
      const rows = await sql.unsafe(`select distinct id from ${S}.log
        where class = $1 and tenant = $2::uuid and data->>($3::text) = $4::text`, [cls, tenant, field, String(value)]);
      return rows.map((r) => r.id);
    },

    /** id из журнала класса в арендаторе, у которых в какой-либо версии конец role указывает на target. */
    async idsLinkedInLog(cls, tenant, role, target) {
      const rows = await sql.unsafe(`select distinct id from ${S}.log
        where class = $1 and tenant = $2::uuid and (links->>($3::text) = $4::text
          or coalesce(links->($3::text), '[]'::jsonb) @> to_jsonb(array[$4::text]))`,
      [cls, tenant, role, target]);
      return rows.map((r) => r.id);
    },

    /** Объект удалён: живой строки нет, последняя версия в журнале — удаление. */
    async removed(id, what) {
      if (await ctx.isLive(id)) throw new Fail(`${what}: объект жив, а должен быть удалён`);
      const v = await ctx.versions(id);
      if (!v.length) throw new Fail(`${what}: в журнале нет версий`);
      if (v.at(-1).op !== 'delete') throw new Fail(`${what}: последняя версия — ${v.at(-1).op}, а не delete`);
    },

    /** Текущее время базы (для срезов asOf без расхождения часов). */
    async dbNow() {
      const [r] = await sql`select clock_timestamp() as t`;
      return new Date(r.t);
    },

    /** Подключение letopis прикладной ролью без обхода RLS. */
    async connect(token) {
      const db = await L.connect({ dsn: app, schema, token, listen: false, max: 2 });
      opened.push(db);
      return db;
    },

    /** Администраторское подключение (allowBypassRls) с сессией token. */
    async admin(token) {
      const db = await L.connect({ dsn: ADMIN, schema, token, allowBypassRls: true, listen: false, max: 2 });
      opened.push(db);
      return db;
    },

    /** Подключение сервиса установки: сессия сервисного аккаунта, выданная суперпользователем. */
    async service() {
      if (ctx._svc) return ctx._svc;
      const [svc] = await sql.unsafe(`select id from ${S}.entity
        where class = 'Account' and data->'categories' ? 'Service' order by created_at limit 1`);
      if (!svc) throw new Fail('в установке нет сервисного аккаунта');
      const [{ t }] = await sql.unsafe(`select ${S}.new_session($1::uuid, interval '2 hours', '{}'::jsonb) as t`, [svc.id]);
      ctx._svc = await ctx.connect(t);
      return ctx._svc;
    },

    /**
     * Вход пользователя паролем через сервис установки; tenantName — переключиться в этого арендатора.
     * Возвращает { db, account, token }.
     */
    async login(identifier, password, tenantName) {
      const svc = await ctx.service();
      const r = await svc.auth.verifyPassword({ identifier, password });
      if (!r) throw new Fail(`вход ${identifier}: verifyPassword вернул null — нет пароля или он другой`);
      const db = await ctx.connect(r.token);
      if (tenantName) await db.auth.switch(await ctx.tenantId(tenantName));
      return { db, account: r.account, token: r.token };
    },

    /**
     * Проверка: fn проходит, если не бросила. Возвращает её значение; при провале — undefined.
     * Ошибка letopis (с кодом), а не Fail, попадает в счётчик ошибок по кодам.
     */
    async check(id, title, fn) {
      try {
        const value = await fn();
        checks.push({ id, title, ok: true });
        console.log(`  ok    ${id.padEnd(4)} ${title}`);
        return value;
      } catch (e) {
        countError(e);
        const item = { id, title, ok: false, detail: errText(e) };
        if (e?.code && !(e instanceof Fail)) item.code = e.code;
        checks.push(item);
        console.log(`  FAIL  ${id.padEnd(4)} ${title} — ${item.detail}`);
        return undefined;
      }
    },

    /** Проверки, которые нельзя выполнить: нет предпосылки. */
    skip(items, reason) {
      for (const [id, title] of items) {
        checks.push({ id, title, ok: false, detail: `не выполнено: ${reason}` });
        console.log(`  FAIL  ${id.padEnd(4)} ${title} — не выполнено: ${reason}`);
      }
    },

    /** Итог: таблица, строка RESULT, закрытие подключений, код выхода. */
    async finish() {
      result.checks = checks.map(({ id, ok, code, detail }) => ({ id, ok, ...(code ? { code } : {}), ...(ok ? {} : { detail }) }));
      result.total = checks.length;
      result.passed = checks.filter((c) => c.ok).length;
      result.errors = errors;
      result.refusals = refusals;
      result.warnings = warnings.length;
      result.ok = result.build.ok && result.run.ok && result.passed === result.total;
      console.log(`итог: ${result.passed} из ${result.total}${result.ok ? ' — задача принята' : ''}`);
      if (Object.keys(errors).length) console.log(`ошибки letopis по кодам: ${Object.entries(errors).map(([k, n]) => `${k} ×${n}`).join(', ')}`);
      if (Object.keys(refusals).length) console.log(`ожидаемые отказы по кодам: ${Object.entries(refusals).map(([k, n]) => `${k} ×${n}`).join(', ')}`);
      if (warnings.length) console.log(`предупреждения библиотеки: ${warnings.length} (первое: ${warnings[0]})`);
      for (const db of opened.reverse()) await withTimeout(db.close(), 10_000, 'close').catch(() => {});
      if (args.drop) await sql.unsafe(`drop schema if exists ${S} cascade`).catch(() => {});
      await sql.end({ timeout: 5 }).catch(() => {});
      console.log(`RESULT ${JSON.stringify(result)}`);
      process.exit(result.ok ? 0 : 1);
    },
  };

  if (!b.ok) {
    result.run = { ok: false, error: 'не выполнялось: решение не собралось' };
    return ctx;
  }

  // run() на пустой схеме.
  await sql.unsafe(`drop schema if exists ${S} cascade`);
  const t0 = Date.now();
  try {
    await call('run', ADMIN, schema);
    result.run = { ok: true };
  } catch (e) {
    countError(e);
    result.run = { ok: false, error: errText(e), ...(e?.code && !(e instanceof Fail) ? { code: e.code } : {}) };
  }
  result.run.ms = Date.now() - t0;
  console.log(`run(): ${result.run.ok ? 'ok' : `ОШИБКА — ${result.run.error}`}, ${(result.run.ms / 1000).toFixed(1)} с`);

  // Роль приложения приёмки: LOGIN, только в letopis_app (роль появляется при up() решения).
  try {
    await sql.unsafe(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
        create role ${APP_ROLE} login password '${APP_PASSWORD}';
      end if;
    exception when duplicate_object then null; end $$`);
    await sql.unsafe(`grant letopis_app to ${APP_ROLE}`);
  } catch (e) {
    console.log(`приёмка: роль ${APP_ROLE} не готова — ${errText(e)}`);
  }
  return ctx;
}
