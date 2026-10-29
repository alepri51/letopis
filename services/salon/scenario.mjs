/**
 * Сценарий «день работы» салона: сервис поднимается в этом же процессе, шаги идут через его JSON API —
 * те же запросы, что шлёт интерфейс (React + shadcn/ui). Им же проверяется сервис в CI. Код выхода 1 — сбой.
 *
 *   ADMIN_DSN=… APP_DSN=… node scenario.mjs
 */
import { createApp, SALONS } from './src/server.mjs';

const { app, close } = await createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const failures = [];
const check = (ok, what) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failures.push(what); };

async function call(cookie, path, body) {
  const r = await fetch(`${base}${path}`, body === undefined
    ? { headers: { cookie } }
    : { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0], data: await r.json().catch(() => null) };
}

try {
  const bad = await call('', '/api/login', { login: SALONS[0].user.login, password: 'неверный' });
  check(bad.status === 401, 'неверный пароль — 401');

  const { cookie } = await call('', '/api/login', SALONS[0].user);
  check(cookie.startsWith('sid='), 'вход управляющей «Локонов»');
  const me = await call(cookie, '/api/me');
  check(me.data?.salon === 'Локоны', 'сессия знает салон');

  // день — завтра, чтобы не мешать ручным броням
  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const s = (await call(cookie, `/api/schedule?day=${day}`)).data;
  const slot = { day, hour: 15, staff: s.staff[0].id, service: s.services[0].id, name: 'Клиент сценария', phone: '+7 900 123-45-67' };

  const first = await call(cookie, '/api/book', slot);
  const afterBook = (await call(cookie, `/api/schedule?day=${day}`)).data;
  const mine = afterBook.bookings.find((b) => b.customer === 'Клиент сценария');
  check(first.status === 200 && !!mine, 'бронь на 15:00 записана');
  const again = await call(cookie, '/api/book', { ...slot, name: 'Второй клиент' });
  check(again.status === 409 && /уже занят/.test(again.data?.error ?? ''), 'повторная бронь того же слота — 409 «слот уже занят»');

  await call(cookie, `/api/bookings/${mine.id}/cancel`, {});
  const afterCancel = (await call(cookie, `/api/schedule?day=${day}`)).data;
  check(afterCancel.cancelled.some((b) => b.id === mine.id), 'отмена: бронь в списке отменённых');
  const hist = (await call(cookie, `/api/bookings/${mine.id}/history`)).data;
  // id брони — из ключа (мастер, время начала): повторный прогон на том же слоте продолжает историю прежнего
  // объекта, поэтому сверяем последние две версии
  const tail = hist.slice(-2);
  check(tail.map((v) => v.op).join(',') === 'create,delete' && tail[1].reason === 'отмена клиентом', 'история: создание и отмена с причиной');
  await call(cookie, `/api/bookings/${mine.id}/restore`, {});
  const back = (await call(cookie, `/api/schedule?day=${day}`)).data;
  check(back.bookings.some((b) => b.id === mine.id) && !back.cancelled.length, 'возврат брони');

  const other = await call('', '/api/login', SALONS[1].user);
  const otherDay = (await call(other.cookie, `/api/schedule?day=${day}`)).data;
  check(!otherDay.bookings.some((b) => b.customer === 'Клиент сценария'), 'другой салон чужую бронь не видит (арендаторы разделены)');

  // повторный прогон на тех же данных — убираем свою бронь
  await call(cookie, `/api/bookings/${mine.id}/cancel`, {});
} catch (e) {
  failures.push(String(e?.stack ?? e));
  console.log(`✗ сценарий упал: ${e?.stack ?? e}`);
} finally {
  server.close();
  await close();
}
console.log(failures.length ? `\nупало шагов: ${failures.length}` : '\nдень работы прошёл');
process.exit(failures.length ? 1 : 0);
