/**
 * Пример, запущенный сам: `npx tsx basics/01-first-object.ts` из каталога examples/.
 *
 * Готовит схему так же, как раннер снимков (`runner.ts`): установка с арендатором «Ромашка» и пользователем Анной,
 * сервис по ключу, работа от имени Анны (`setup: 'none'` — пустая схема, пример ставит её сам). Затем выполняет шаги
 * подряд и печатает результат каждого. Схема — `v2.x_<глава>_<файл>`; после прогона она остаётся, чтобы заглянуть в
 * таблицы, и пересоздаётся при следующем запуске. Код выхода 1 — шаг упал не так, как задумано.
 */
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { up, connect } from 'letopis';
import type { ConnectOptions, Db } from 'letopis';
import { ADMIN_DSN, appDsn, ensureAppRole, ensureDatabase, adminSql, ident } from './db.ts';
import type { Ctx, Example } from '../_shared/example.ts';

const EXAMPLES = fileURLToPath(new URL('..', import.meta.url));
const USER = { name: 'Анна', login: 'anna@romashka.ru', password: 'Ромашка-2026!' };

/** Значение для печати: даты — ISO, bigint — число, байты — hex. */
function plain(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  if (Buffer.isBuffer(v)) return v.toString('hex');
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

export async function runDirect(ex: Example): Promise<void> {
  const file = process.argv[1] ?? 'example.ts';
  const id = relative(EXAMPLES, file).split(sep).join('/').replace(/\.ts$/, '');
  const schema = `v2.x_${id.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`.slice(0, 60);
  let code = 0;
  await ensureDatabase();
  const admin = adminSql();
  const opened: Db[] = [];
  const track = async (opts: ConnectOptions) => {
    if (opts.dsn === appDsn()) await ensureAppRole(admin).catch(() => {});
    const d = await connect(opts);
    opened.push(d);
    return d;
  };
  const warnings: Ctx['warnings'] = async (fn) => {
    const seen: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void seen.push(a.map(String).join(' '));
    try {
      return { result: await fn(), warnings: seen };
    } finally {
      console.warn = orig;
    }
  };
  try {
    const ctx = { schema, admin, dsn: { admin: ADMIN_DSN, app: appDsn() }, user: USER, connect: track, warnings } as unknown as Ctx;
    if ((ex.setup ?? 'tenant') === 'tenant') {
      const r = await up({ dsn: ADMIN_DSN, schema, fresh: true, quiet: true, tenant: { name: 'Ромашка', user: USER } });
      await ensureAppRole(admin);
      const svc = await track({ dsn: appDsn(), schema: r.schema, apiKey: r.serviceKey! });
      const login = await svc.auth.verifyPassword({ identifier: USER.login, password: USER.password });
      Object.assign(ctx, { up: r, svc, db: await svc.as(login!.account, { tenant: r.tenant!.tenant }) });
    } else {
      await admin.unsafe(`drop schema if exists ${ident(schema)} cascade`);
    }
    console.log(`${ex.title}\nсхема: ${schema}`);
    for (const [i, step] of ex.steps.entries()) {
      console.log(`\n— Шаг ${i + 1}. ${step.title.replace(/^\d+\.\s*/, '')}`);
      try {
        const result = await step.run(ctx);
        if (step.expect?.error) {
          console.log(`ожидалась ошибка ${step.expect.error}, а шаг прошёл`);
          code = 1;
        }
        await step.expect?.check?.(result, ctx);
        console.log(JSON.stringify(plain(result), null, 2) ?? '');
      } catch (e) {
        const err = e as { code?: string; key?: string; message: string };
        if (step.expect?.error && step.expect.error === err.code) {
          console.log(`отказ, как и задумано: ${err.code}${err.key ? ` (${err.key})` : ''} — ${err.message}`);
        } else {
          console.log(`шаг упал: ${err.code ?? ''} ${(e as Error).stack ?? err.message}`);
          code = 1;
          break;
        }
      }
    }
  } catch (e) {
    console.error((e as Error).stack ?? String(e));
    code = 1;
  } finally {
    for (const d of opened.reverse()) await d.close().catch(() => {});
    await admin.end({ timeout: 5 }).catch(() => {});
  }
  // пулы и подписки держат процесс открытым — выходим явно
  process.exit(code);
}
