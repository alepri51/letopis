/**
 * Пример, запущенный сам: `npx tsx basics/01-first-object.ts` из каталога examples/.
 *
 * Готовит дом так же, как раннер снимков (`prepare.ts`): `setup()` с моделями примера, консьерж, квартира
 * «Ромашка» и её owner Анна (`setup: 'none'` — дома нет, пример строит его сам). Затем выполняет шаги подряд и печатает
 * результат каждого. Дом — `x_<глава>_<файл>`; после прогона он остаётся, чтобы заглянуть в таблицы (схема
 * `v2.x_…`), и строится заново при следующем запуске. Код выхода 1 — шаг упал не так, как задумано.
 */
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDatabase, adminSql, houseName } from './db.ts';
import { houses, prepare } from './prepare.ts';
import type { Example } from '../_shared/example.ts';

const EXAMPLES = fileURLToPath(new URL('..', import.meta.url));

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
  const name = houseName('x_', id);
  let code = 0;
  await ensureDatabase();
  const admin = adminSql();
  const hs = houses();
  try {
    const ctx = await prepare(ex, name, admin, hs);
    console.log(`${ex.title}\nдом: ${name} (схема v2.${name})`);
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
    await hs.close();
    await admin.end({ timeout: 5 }).catch(() => {});
  }
  // пулы и подписки держат процесс открытым — выходим явно
  process.exit(code);
}
