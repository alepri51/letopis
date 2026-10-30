/**
 * Сценарий «день работы» кошелька: сервис в этом же процессе, шаги — через его JSON API (как интерфейс).
 *   ADMIN_DSN=… APP_DSN=… node scenario.mjs        Код выхода 1 — сбой.
 * «Чужая транзакция», которая держит строки выписки (проверка lockTimeout и lockRetries проектора), — прямое
 * подключение администратора по ADMIN_DSN: так её держал бы отчёт или сеанс psql.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  check(over.status === 422 && (await balance('W-2')) === b2, 'списание больше баланса — отказ, баланс прежний');
  const tr = await call(cookie, '/api/transfer', { from: w1.id, to: w2.id, amount: 30000, opId: `x-${run}` });
  check(tr.data?.result === 'проведено' && (await balance('W-1')) === b1 + 70000 && (await balance('W-2')) === b2 + 30000, 'перевод 300 ₽ W-1 → W-2 одной транзакцией');
  // панель «Под капотом»: перевод записал две операции и два баланса (агрегат), сигналы — в канале схемы
  const hood = (await call(cookie, '/api/trace')).data?.[0];
  check(hood?.title === `Перевод x-${run}` && hood.versions.filter((v) => v.class === 'Movement' && v.op === 'create').length === 2
    && hood.versions.filter((v) => v.class === 'Wallet' && v.fields.join() === 'balance').length === 2 && hood.signals.includes('Movement'),
    'под капотом: перевод — версии двух Movement и баланса двух Wallet, сигналы канала схемы');
  const hist = (await call(cookie, `/api/wallets/${w1.id}/history`)).data;
  check(hist.at(-1).reason === `transfer x-${run}`, 'история баланса W-1: последняя версия — перевод с причиной');

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

  // проектор выписки: дождаться, пока он догонит журнал, и запомнить пополнения W-1 за месяц
  const statusOf = async () => (await call(cookie, '/api/statement')).data;
  const month = new Date().toISOString().slice(0, 7);
  const topups = async () => (await call(cookie, '/api/wallets')).data.statements.find((s) => s.wallet === 'W-1' && s.month === month)?.topup ?? 0;
  let st = await statusOf();
  for (let i = 0; i < 40 && (st.lag > 0 || st.failed); i++) { await sleep(250); st = await statusOf(); }
  check(st.state === 'running' && !st.failed && st.options.lockTimeout === 1000 && st.options.lockRetries === 3,
    'проектор выписки: status() — running, догнал журнал; lockTimeout 1000 мс, lockRetries 3');
  const t0 = await topups();
  const rb = await call(cookie, '/api/statement/rebuild', {});
  check(rb.status === 200 && rb.data.created > 0 && (await topups()) === t0, 'перестроить выписку — rebuild(): строки построены заново, итоги те же');

  // чужая транзакция держит строки выписки, когда пачка проектора до них доходит: пачка упирается в lockTimeout, после
  // lockRetries проходов подряд арендатор выбывает (55P03); после её конца rebuild({ tenant }) возвращает его. Журнал
  // проектор читает ниже горизонта — самой старой незавершённой транзакции, поэтому порядок такой: третья транзакция
  // держит горизонт, пополнение, чужая транзакция берёт строки выписки (for update), горизонт отпущен — пачка доходит
  // до пополнения и встаёт на строке выписки
  const adminDsn = process.env.ADMIN_DSN ?? 'postgres://postgres:guide@127.0.0.1:15440/letopis';
  const sessions = [postgres(adminDsn, { max: 1, onnotice: () => {} }), postgres(adminDsn, { max: 1, onnotice: () => {} })];
  /** Открыть транзакцию с оператором text и держать её до release(). */
  const hold = async (sql, text) => {
    let release = () => {};
    let ready;
    const opened = new Promise((r) => { ready = r; });
    const done = sql.begin(async (q) => {
      await q.unsafe(text);
      await new Promise((r) => { release = r; ready(); });
    });
    await Promise.race([opened, done]);
    return { release: () => release(), done };
  };
  const horizon = await hold(sessions[0], 'select pg_current_xact_id()');
  await call(cookie, '/api/topup', { wallet: w1.id, amount: 700, card, opId: `ph-${run}` });
  const rows = await hold(sessions[1], `select id from "${schema}".entity where class = 'Statement' for update`);
  horizon.release();
  await horizon.done;
  for (let i = 0; i < 60 && !st.failed; i++) { await sleep(250); st = await statusOf(); }
  check(st.failed?.code === '55P03', `строки выписки держит чужая транзакция — после ${st.options.lockRetries} проходов дольше lockTimeout арендатор выбыл (status().failed, 55P03)`);
  rows.release();
  await rows.done;
  for (const sql of sessions) await sql.end({ timeout: 2 });
  const fix = await call(cookie, '/api/statement/rebuild', {});
  const hoodFix = (await call(cookie, '/api/trace')).data?.[0];
  check(fix.status === 200 && !(await statusOf()).failed && (await topups()) === t0 + 700 && hoodFix?.lines.some((l) => l.startsWith('statement.rebuild({ tenant })')),
    'перестроить выписку — rebuild({ tenant }): отметка выбывшего снята, пополнение 7 ₽ в выписке');

  // целостность — после всех записей сценария, обрывов и перестроек
  const v = await call(cookie, '/api/admin/verify');
  check(v.status === 200 && v.data.ok === true && v.data.issues.length === 0 && v.data.checked > 0 && /^[0-9a-f]{64}$/.test(v.data.anchor),
    'verify({ data: true }) — нарушений нет: цепочки хэшей, данные, balance равен сумме операций');
} catch (e) {
  failures.push(String(e?.stack ?? e));
  console.log(`✗ сценарий упал: ${e?.stack ?? e}`);
} finally {
  server.close();
  await close();
}
console.log(failures.length ? `\nупало шагов: ${failures.length}` : '\nдень работы прошёл');
process.exit(failures.length ? 1 : 0);
