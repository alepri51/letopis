/**
 * Сценарий «день работы» кошелька: сервис в этом же процессе, шаги — через его JSON API (как интерфейс).
 *   ADMIN_DSN=… APP_DSN=… node scenario.mjs        Код выхода 1 — сбой.
 */
import { createApp, OPERATOR } from './src/server.mjs';

const { app, close } = await createApp();
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
try {
  check((await call('', '/api/login', { login: OPERATOR.login, password: 'неверный' })).status === 401, 'неверный пароль — 401');
  const { cookie } = await call('', '/api/login', OPERATOR);
  const balance = async (n) => (await call(cookie, '/api/wallets')).data.wallets.find((w) => w.number === n).balance;
  const ws = (await call(cookie, '/api/wallets')).data.wallets;
  const [w1, w2] = [ws.find((w) => w.number === 'W-1'), ws.find((w) => w.number === 'W-2')];
  const b1 = await balance('W-1'), b2 = await balance('W-2');
  check((await call(cookie, '/api/topup', { wallet: w1.id, amount: 100000, card: '4242 4242 4241 4242', opId: `t-${run}` })).status === 422, 'карта с ошибкой в номере — отказ (Луна)');
  const lost = await call(cookie, '/api/topup', { wallet: w1.id, amount: 100000, card: '4242 4242 4242 4242', opId: `t-${run}`, lose: true });
  check(lost.status === 504 && (await balance('W-1')) === b1 + 100000, 'пополнение 1000 ₽ проведено, ответ «потерян»');
  const again = await call(cookie, '/api/topup', { wallet: w1.id, amount: 100000, card: '4242 4242 4242 4242', opId: `t-${run}` });
  check(again.data?.result === 'уже было' && (await balance('W-1')) === b1 + 100000, 'повтор того же opId — «уже было», баланс не удвоился');
  const over = await call(cookie, '/api/debit', { wallet: w2.id, amount: b2 + 1, opId: `d-${run}` });
  check(over.status === 422 && (await balance('W-2')) === b2, 'списание больше баланса — отказ, баланс прежний');
  const tr = await call(cookie, '/api/transfer', { from: w1.id, to: w2.id, amount: 30000, opId: `x-${run}` });
  check(tr.data?.result === 'проведено' && (await balance('W-1')) === b1 + 70000 && (await balance('W-2')) === b2 + 30000, 'перевод 300 ₽ W-1 → W-2 одной транзакцией');
  const hist = (await call(cookie, `/api/wallets/${w1.id}/history`)).data;
  check(hist.at(-1).reason === `transfer x-${run}`, 'история баланса W-1: последняя версия — перевод с причиной');
} catch (e) {
  failures.push(String(e?.stack ?? e));
  console.log(`✗ сценарий упал: ${e?.stack ?? e}`);
} finally {
  server.close();
  await close();
}
console.log(failures.length ? `\nупало шагов: ${failures.length}` : '\nдень работы прошёл');
process.exit(failures.length ? 1 : 0);
