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
  // гонка: две брони одного слота в одну секунду (две вкладки) — lock мастера ставит их в очередь, проходит одна
  const race = { ...slot, hour: 16 };
  const both = await Promise.all([call(cookie, '/api/book', { ...race, name: 'Гонка 1' }), call(cookie, '/api/book', { ...race, name: 'Гонка 2' })]);
  const raced = (await call(cookie, `/api/schedule?day=${day}`)).data.bookings.filter((b) => /^Гонка/.test(b.customer));
  check(both.map((x) => x.status).sort().join(',') === '200,409' && raced.length === 1, 'гонка двух броней на 16:00 — записана одна, вторая 409');

  const first = await call(cookie, '/api/book', slot);
  const afterBook = (await call(cookie, `/api/schedule?day=${day}`)).data;
  const mine = afterBook.bookings.find((b) => b.customer === 'Клиент сценария');
  check(first.status === 200 && !!mine, 'бронь на 15:00 записана');
  // панель «Под капотом»: какие версии записала бронь (журнал схемы) и что ушло в канал схемы
  const hood = (await call(cookie, '/api/trace')).data?.[0];
  check(hood?.title === 'Записать клиента' && hood.versions.some((v) => v.class === 'booking' && v.op === 'create' && v.label === '15:00')
    && hood.versions.some((v) => v.class === 'Customer') && hood.signals.includes('booking'), 'под капотом: бронь — версии booking и Customer, сигналы канала схемы');
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
  // в отменённых дня может лежать перенесённая бронь прошлого прогона — сверяем свою
  check(back.bookings.some((b) => b.id === mine.id) && !back.cancelled.some((b) => b.id === mine.id), 'возврат брони');

  // перенос: id брони — из ключа (мастер, время начала), поэтому перенос — rekey: новый id, у прежнего — надгробие
  const moved = await call(cookie, `/api/bookings/${mine.id}/move`, { day, hour: 17, staff: slot.staff });
  const afterMove = (await call(cookie, `/api/schedule?day=${day}`)).data;
  const there = afterMove.bookings.find((b) => b.customer === 'Клиент сценария');
  check(moved.status === 200 && there?.hour === 17 && there.id === moved.data.id && there.id !== mine.id
    && !afterMove.bookings.some((b) => b.id === mine.id) && !afterMove.cancelled.some((b) => b.id === mine.id), 'перенос на 17:00 — rekey: новый id, прежний слот свободен и не в отменённых');
  const hoodMove = (await call(cookie, '/api/trace')).data?.[0];
  check(hoodMove?.title === 'Перенести бронь' && hoodMove.versions.some((v) => v.class === 'booking' && v.op === 'rekey' && v.label === '17:00')
    && hoodMove.versions.some((v) => v.class === 'booking' && v.op === 'delete' && v.label === '15:00') && hoodMove.signals.includes('booking'),
  'под капотом: перенос — версия rekey на 17:00 и надгробие 15:00, сигнал booking');
  const taken = await call(cookie, `/api/bookings/${there.id}/move`, { day, hour: 16, staff: slot.staff });
  check(taken.status === 409 && /занят/.test(taken.data?.error ?? '') && (await call(cookie, `/api/schedule?day=${day}`)).data.bookings.some((b) => b.id === there.id && b.hour === 17),
    'перенос на занятый слот 16:00 — 409, бронь осталась на 17:00');
  const movedHist = (await call(cookie, `/api/bookings/${there.id}/history`)).data;
  check(movedHist.some((v) => v.id === mine.id && v.op === 'create' && v.start === '15:00') && movedHist.some((v) => v.id === there.id && v.op === 'rekey' && v.start === '17:00')
    && movedHist.some((v) => v.id === mine.id && v.op === 'delete' && v.reason === 'перенос брони'), 'история перенесённой брони — versions({ follow: true }): создание на 15:00, rekey на 17:00, надгробие прежнего id');
  check((await call(cookie, `/api/bookings/${mine.id}/restore`, {})).status === 409, 'надгробие переноса не возвращается — 409 (иначе у клиента две брони)');

  // отчёт дня — report(): брони дня по мастерам
  const rep = (await call(cookie, `/api/report?day=${day}`)).data;
  const sched = (await call(cookie, `/api/schedule?day=${day}`)).data;
  const ours = rep?.staff.find((m) => m.id === slot.staff);
  check(rep?.total === sched.total && rep.staff.reduce((n, m) => n + m.count, 0) === rep.total
    && ours?.count === sched.bookings.filter((b) => b.staff === slot.staff).length && ours.count >= 2, 'отчёт дня: брони по мастерам, сумма — все брони дня (у мастера — гонка и перенесённая)');

  // прайс: цена услуги — upsert по ключу [Item, note]; список — db.load({ existing: 'update' }) администраторским
  // подключением от имени вошедшей. Цены до сценария запоминаем и в конце возвращаем
  const before = (await call(cookie, '/api/price')).data;
  const cut = before[0];
  const p1 = (cut.price ?? 2000) + 100;
  const set1 = await call(cookie, `/api/price/${cut.id}`, { amount: p1 });
  const set2 = await call(cookie, `/api/price/${cut.id}`, { amount: p1 });
  const hoodSet = (await call(cookie, '/api/trace')).data;
  check(set1.status === 200 && ['created', 'updated'].includes(set1.data.upsert) && set2.data.upsert === 'unchanged' && set2.data.rev === set1.data.rev
    && (await call(cookie, '/api/price')).data.find((x) => x.id === cut.id)?.price === p1
    && hoodSet[1]?.versions.some((v) => v.class === 'price' && v.label === `базовая: ${p1} ₽`) && !hoodSet[0]?.versions.length,
  'цена услуги — upsert: создана или заменена целиком; те же данные — без новой версии');
  const want = new Map(before.map((x, i) => [x.id, (x.price ?? 1000 * (i + 1)) + 200]));
  const list = before.map((x) => `${x.name}; ${want.get(x.id)}`).join('\n');
  const loaded = await call(cookie, '/api/price/load', { text: list });
  check(loaded.status === 200 && loaded.data.rows === before.length && loaded.data.loaded + loaded.data.updated === before.length
    && (await call(cookie, '/api/price')).data.every((x) => x.price === want.get(x.id)), 'прайс списком — db.load({ existing: \'update\' }): цены записаны');
  const hoodLoad = (await call(cookie, '/api/trace')).data?.[0];
  check(hoodLoad?.title === 'Прайс списком' && hoodLoad.versions.filter((v) => v.class === 'price').length === before.length && hoodLoad.signals.includes('price'),
    'под капотом: загрузка — версии price от имени вошедшей (load({ as })), сигнал price');
  const same = await call(cookie, '/api/price/load', { text: list });
  check(same.status === 200 && same.data.skipped === before.length && same.data.loaded + same.data.updated === 0, 'тот же список ещё раз — без изменений: всё в skipped');
  // ReDoS: строка в 50 000 знаков из цифр и пробелов с неподходящим концом — отказ сразу, без перебора;
  // больше 1000 строк — тоже отказ
  const t0 = Date.now();
  const huge = await call(cookie, '/api/price/load', { text: `${cut.name}; 1${' '.repeat(50_000)}x` });
  const ms = Date.now() - t0;
  const many = await call(cookie, '/api/price/load', { text: `${cut.name}; 1\n`.repeat(1001) });
  check(huge.status === 422 && /длиннее 200/.test(huge.data?.error ?? '') && ms < 1000 && many.status === 422 && /1000 строк/.test(many.data?.error ?? ''),
    `прайс списком: строка в 50 000 знаков — отказ 422 за ${ms} мс, больше 1000 строк — отказ`);
  const unknown = await call(cookie, '/api/price/load', { text: `${cut.name}; 1\nМассаж спины; 3000` });
  check(unknown.status === 422 && /Массаж спины/.test(unknown.data?.error ?? '') && (await call(cookie, '/api/price')).data.find((x) => x.id === cut.id)?.price === want.get(cut.id),
    'неизвестная услуга в списке — 422, ничего не загружено');

  const other = await call('', '/api/login', SALONS[1].user);
  const otherDay = (await call(other.cookie, `/api/schedule?day=${day}`)).data;
  check(!otherDay.bookings.some((b) => b.customer === 'Клиент сценария'), 'другой салон чужую бронь не видит (арендаторы разделены)');
  const otherPrice = (await call(other.cookie, '/api/price')).data;
  const foreign = await call(other.cookie, '/api/price/load', { text: `${cut.name}; 1` });
  check(!otherPrice.some((x) => want.has(x.id)) && foreign.status === 422, 'другой салон — свой прайс: услуг «Локонов» в нём нет, загрузить им цену нельзя');

  // повторный прогон на тех же данных — убираем свои брони, цены — как до сценария
  await call(cookie, `/api/bookings/${there.id}/cancel`, {});
  for (const b of raced) await call(cookie, `/api/bookings/${b.id}/cancel`, {});
  const was = before.filter((x) => x.price !== null).map((x) => `${x.name}; ${x.price}`).join('\n');
  if (was) await call(cookie, '/api/price/load', { text: was });
} catch (e) {
  failures.push(String(e?.stack ?? e));
  console.log(`✗ сценарий упал: ${e?.stack ?? e}`);
} finally {
  server.close();
  await close();
}
console.log(failures.length ? `\nупало шагов: ${failures.length}` : '\nдень работы прошёл');
process.exit(failures.length ? 1 : 0);
