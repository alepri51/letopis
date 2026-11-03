/**
 * Сценарий «день работы» кошелька: сервис в этом же процессе, шаги — через его JSON API (как интерфейс).
 *   ADMIN_DSN=… APP_DSN=… node scenario.mjs        Код выхода 1 — сбой.
 * Простой сервиса дольше срока сессии — без ожидания: срок сессий createTenant оператора истекает в базе отдельным
 * подключением по ADMIN_DSN.
 */
import postgres from 'postgres';
import { createApp, OPERATOR } from './src/server.mjs';

const { app, schema, close } = await createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const failures = [];
const check = (ok, what) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failures.push(what); };
const call = async (cookie, path, body) => {
  const r = await fetch(`${base}${path}`, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0], data: await r.json().catch(() => null) };
};
const run = Date.now().toString(36);
const card = '4242 4242 4242 4242';
try {
  check((await call('', '/api/login', { login: OPERATOR.login, password: 'неверный' })).status === 401, 'неверный пароль — 401');
  const { cookie } = await call('', '/api/login', OPERATOR);
  const balance = async (n) => (await call(cookie, '/api/wallets')).data.wallets.find((w) => w.number === n).balance;
  const ws = (await call(cookie, '/api/wallets')).data.wallets;
  const [w1, w2] = [ws.find((w) => w.number === 'W-1'), ws.find((w) => w.number === 'W-2')];
  const b1 = await balance('W-1'), b2 = await balance('W-2');
  check((await call(cookie, '/api/topup', { wallet: w1.id, amount: 100000, card: '4242 4242 4241 4242', opId: `t-${run}` })).status === 422, 'карта с ошибкой в номере — отказ (Луна)');
  const lost = await call(cookie, '/api/topup', { wallet: w1.id, amount: 100000, card, opId: `t-${run}`, lose: true });
  check(lost.status === 504 && (await balance('W-1')) === b1 + 100000, 'пополнение 1000 ₽ проведено, ответ «потерян»');
  const again = await call(cookie, '/api/topup', { wallet: w1.id, amount: 100000, card, opId: `t-${run}` });
  check(again.data?.result === 'уже было' && (await balance('W-1')) === b1 + 100000, 'повтор того же opId — «уже было», баланс не удвоился');
  const over = await call(cookie, '/api/debit', { wallet: w2.id, amount: b2 + 1, opId: `d-${run}` });
  const hoodOver = (await call(cookie, '/api/trace')).data?.[0];
  check(over.status === 422 && /^Недостаточно средств/.test(over.data?.error) && (await balance('W-2')) === b2
    && hoodOver?.lines.some((l) => l.startsWith('invalid_data — balance: minimum')) && !hoodOver.versions.length,
    'списание больше баланса — min(0) над итогом inc: отказ 422, план откатился целиком (ни операции, ни версии), баланс прежний');
  const tr = await call(cookie, '/api/transfer', { from: w1.id, to: w2.id, amount: 30000, opId: `x-${run}` });
  check(tr.data?.result === 'проведено' && (await balance('W-1')) === b1 + 70000 && (await balance('W-2')) === b2 + 30000, 'перевод 300 ₽ W-1 → W-2 одной транзакцией');
  // панель «Под капотом»: перевод записал две операции и два баланса (inc в том же плане), сигналы — в канале схемы
  const hood = (await call(cookie, '/api/trace')).data?.[0];
  check(hood?.title === `Перевод x-${run}` && hood.versions.filter((v) => v.class === 'Movement' && v.op === 'create').length === 2
    && hood.versions.filter((v) => v.class === 'Wallet' && v.fields.join() === 'balance').length === 2
    && hood.signals.includes('Movement') && hood.signals.includes('Wallet') && hood.lines.some((l) => l.includes('inc(')),
    'под капотом: перевод — версии двух Movement и баланса двух Wallet (inc), сигналы Movement и Wallet');
  const hist = (await call(cookie, `/api/wallets/${w1.id}/history`)).data;
  check(hist.at(-1).reason === `transfer x-${run}`, 'история баланса W-1: последняя версия — перевод с причиной');
  // время версии сервер отдаёт целиком, а местное показывает браузер: обрезка строки давала UTC без пометки пояса
  const moments = [...hist.map((v) => v.at), ...(await call(cookie, '/api/wallets')).data.movements.map((m) => m.at)];
  check(moments.length > 0 && moments.every((at) => String(at).length > 19 && !Number.isNaN(Date.parse(at))),
    `история баланса и последние операции: at — полный момент версии (${moments[0]})`);

  // гонка: два списания с W-2 в одну секунду, каждое больше половины баланса — база ставит их в очередь по счёту,
  // и второе упирается в min(0) посчитанного баланса: проходит одно
  const b2now = await balance('W-2');
  const part = Math.floor(b2now * 0.6);
  const both = await Promise.all([1, 2].map((k) => call(cookie, '/api/debit', { wallet: w2.id, amount: part, opId: `r${k}-${run}` })));
  check(both.map((x) => x.status).sort().join(',') === '200,422' && (await balance('W-2')) === b2now - part, 'гонка двух списаний с W-2 — прошло одно, второе отказ, баланс не ушёл в минус');

  // 40P01: встречные переводы без порядка блокировок — каждый берёт сначала свой счёт, между замками пауза; PostgreSQL
  // находит взаимную блокировку и прерывает один блок, сервис повторяет его целиком. В порядке id — без 40P01
  const pair = [await balance('W-1'), await balance('W-2')];
  const counter = (mode, k) => Promise.all([
    call(cookie, '/api/transfer', { from: w1.id, to: w2.id, amount: 5000, opId: `${k}1-${run}`, unordered: mode === 'unordered' }),
    call(cookie, '/api/transfer', { from: w2.id, to: w1.id, amount: 5000, opId: `${k}2-${run}`, unordered: mode === 'unordered' }),
  ]);
  const dead = await counter('unordered', 'u');
  const hood40 = (await call(cookie, '/api/trace')).data.slice(0, 2);
  check(dead.every((x) => x.data?.result === 'проведено') && dead.reduce((n, x) => n + x.data.retries, 0) >= 1
    && hood40.some((h) => h.lines.some((l) => l.startsWith('40P01'))) && (await balance('W-1')) === pair[0] && (await balance('W-2')) === pair[1],
  'встречные переводы без порядка блокировок — 40P01, сервис повторил блок db.begin() целиком: оба проведены, балансы сошлись');
  const ordered = await counter('ordered', 'o');
  check(ordered.every((x) => x.data?.result === 'проведено' && x.data.retries === 0) && (await balance('W-1')) === pair[0],
    'встречные переводы в порядке id — без 40P01: второй ждёт замка первого');

  // commit_unknown: связь с базой рвёт TCP-прокси — до COMMIT и после него; исход выясняет повтор с тем же opId
  const c0 = await balance('W-1');
  const cb = await call(cookie, '/api/topup', { wallet: w1.id, amount: 20000, card, opId: `cb-${run}`, cut: 'before' });
  check(cb.data?.unknown === 'before' && cb.data.result === 'проведено' && (await balance('W-1')) === c0 + 20000,
    'обрыв до COMMIT — commit_unknown; повтор с тем же opId провёл пополнение (в первый раз не записалось), +200 ₽ один раз');
  const ca = await call(cookie, '/api/topup', { wallet: w1.id, amount: 30000, card, opId: `ca-${run}`, cut: 'after' });
  const hoodCut = (await call(cookie, '/api/trace')).data?.[0];
  check(ca.data?.unknown === 'after' && ca.data.result === 'уже было' && (await balance('W-1')) === c0 + 50000
    && hoodCut?.lines.some((l) => l.startsWith('commit_unknown')) && hoodCut.versions.filter((v) => v.class === 'Movement').length === 1,
  'обрыв после COMMIT — commit_unknown; повтор с тем же opId — «уже было», +300 ₽ один раз, в «Под капотом» одна версия Movement');

  // { rev }: две вкладки (две сессии) прочитали W-1; первая сменила владельца — у второй версия устарела, 409
  const tab2 = (await call('', '/api/login', OPERATOR)).cookie;
  const read = async (c) => (await call(c, '/api/wallets')).data.wallets.find((w) => w.number === 'W-1');
  const [seen1, seen2] = [await read(cookie), await read(tab2)];
  const own1 = await call(cookie, `/api/wallets/${w1.id}/owner`, { owner: 'Анна Петрова', rev: seen1.rev });
  const own2 = await call(tab2, `/api/wallets/${w1.id}/owner`, { owner: 'Анна Сидорова', rev: seen2.rev });
  check(own1.status === 200 && own1.data.rev === seen1.rev + 1 && own2.status === 409 && own2.data?.code === 'conflict' && (await read(tab2)).owner === 'Анна Петрова',
    'смена владельца по версии: первая вкладка записала, вторая с устаревшей rev — 409 conflict, её правка не записана');
  // rev счёта растёт и от операций: баланс — его поле
  const r0 = (await read(cookie)).rev;
  await call(cookie, '/api/topup', { wallet: w1.id, amount: 100, card, opId: `rv-${run}` });
  const stale = await call(cookie, `/api/wallets/${w1.id}/owner`, { owner: seen1.owner, rev: r0 });
  const back = await call(cookie, `/api/wallets/${w1.id}/owner`, { owner: seen1.owner, rev: (await read(cookie)).rev });
  check(stale.status === 409 && back.status === 200 && (await read(cookie)).owner === seen1.owner,
    'после пополнения прочитанная rev устарела — 409; по свежей rev владелец вернулся');

  // restrict: конец Wallet у Movement — правило по умолчанию; счёт с операциями база не удаляет
  const del = await call(cookie, `/api/wallets/${w1.id}/delete`, {});
  check(del.status === 409 && del.data?.code === 'delete_restricted' && !!(await read(cookie)), 'удалить счёт с операциями нельзя — delete_restricted, 409, счёт на месте');

  // выписка — обычный запрос на чтение: сводка операций по счёту и месяцу, без отставания
  const month = new Date().toISOString().slice(0, 7);
  const statement = async () => (await call(cookie, '/api/wallets')).data;
  const topups = async () => (await statement()).statements.find((s) => s.wallet === 'W-1' && s.month === month)?.topup ?? 0;
  const t0 = await topups();
  await call(cookie, '/api/topup', { wallet: w1.id, amount: 700, card, opId: `st-${run}` });
  check((await topups()) === t0 + 700, 'выписка — обычный запрос: пополнение 7 ₽ в выписке за месяц сразу, без ожидания');
  // порядок выписки — месяц (новые сверху), в месяце — номер счёта
  const lines = (await statement()).statements;
  check(lines.length > 1 && lines.every((s, i) => i === 0 || lines[i - 1].month > s.month
    || (lines[i - 1].month === s.month && lines[i - 1].wallet.localeCompare(s.wallet, 'ru', { numeric: true }) < 0)),
    `выписка — по месяцам и номерам счетов (${lines.map((s) => `${s.month} ${s.wallet}`).join(', ')})`);
  // баланс каждого счёта равен сумме его операций: inc в одном плане с операцией ничего не теряет (гонки, 40P01, обрывы)
  const all = await statement();
  const sums = new Map();
  for (const s of all.statements) sums.set(s.wallet, (sums.get(s.wallet) ?? 0) + s.topup - s.debit);
  check(all.wallets.every((w) => sums.get(w.number) === w.balance),
    `баланс = сумма операций по выписке: ${all.wallets.map((w) => `${w.number} ${w.balance} = ${sums.get(w.number)}`).join(', ')}`);

  // простой дольше срока сессии оператора — без ожидания: срок её сессий createTenant (без methods; веб-сессия входа по
  // паролю не трогается) истекает в базе. Сервис держит подключение по ключу сервиса, а не по токену createTenant, —
  // операции и выписка идут как прежде (план 2.0, 7.6 №5)
  const sql = postgres(process.env.ADMIN_DSN ?? 'postgres://postgres:guide@127.0.0.1:15440/letopis', { max: 1, onnotice: () => {} });
  const S = `"${schema.replace(/"/g, '""')}"`;
  const expired = await sql.unsafe(`update ${S}.secret set expires_at = clock_timestamp() - interval '1 second'
    where kind = 'SESSION' and not (meta ? 'methods') and account = (select account from ${S}.secret where kind = 'PASSWORD' and ident = $1)`, [OPERATOR.login])
    .finally(() => sql.end({ timeout: 2 }));
  const t1 = await topups();
  const late = await call(cookie, '/api/topup', { wallet: w1.id, amount: 300, card, opId: `id-${run}` });
  check(late.data?.result === 'проведено' && (await topups()) === t1 + 300,
    `после простоя (истекло сессий createTenant: ${expired.count}): пополнение 3 ₽ проведено и сразу в выписке`);
} catch (e) {
  failures.push(String(e?.stack ?? e));
  console.log(`✗ сценарий упал: ${e?.stack ?? e}`);
} finally {
  server.close();
  await close();
}
console.log(failures.length ? `\nупало шагов: ${failures.length}` : '\nдень работы прошёл');
process.exit(failures.length ? 1 : 0);
