/**
 * Сценарий «день работы» документов: сервис в этом же процессе, шаги — через его JSON API (как интерфейс).
 *   ADMIN_DSN=… APP_DSN=… node scenario.mjs        Код выхода 1 — сбой. Схема своя и с нуля (documents_scenario).
 * Простой сервиса дольше срока сессии — без ожидания: срок сессий createTenant руководителя истекает в базе отдельным
 * подключением по ADMIN_DSN.
 */
import postgres from 'postgres';

process.env.SCHEMA ??= 'documents_scenario';
process.env.FRESH ??= '1';
const { createApp, USERS } = await import('./src/server.mjs');

const { app, schema, close } = await createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const failures = [];
const check = (ok, what, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${what}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  if (!ok) failures.push(what);
};
const call = async (cookie, path, body) => {
  const r = await fetch(`${base}${path}`, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0], data: await r.json().catch(() => null) };
};
try {
  check((await call('', '/api/login', { login: USERS.lawyer.login, password: 'неверный' })).status === 401, 'неверный пароль — 401');
  const lawyer = (await call('', '/api/login', USERS.lawyer)).cookie;
  const head = (await call('', '/api/login', USERS.head)).cookie;
  const info = (await call(head, '/api/admin/info')).data;
  check(info.archive?.initial && info.archive.loaded === 15 && info.archive.versions === 51, 'архив залит первой заливкой с историей: 15 объектов, 51 версия', info.archive);
  const list = (await call(lawyer, '/api/docs')).data;
  check(list.docs.length === 14 && list.docs.filter((d) => d.archived).length === 12, 'реестр: 12 архивных договоров и 2 черновика', list.docs.length);
  const party = list.parties[0].id;
  const d = (await call(lawyer, '/api/docs', { number: 'Д-777', title: 'Охрана офиса', amount: 30000, body: 'Пост 24/7', party })).data;
  check(d.class === 'Draft' && d.rev === 1, 'юрист создал черновик Д-777', d);
  check((await call(lawyer, '/api/docs', { number: 'Д-777', title: 'Дубль', amount: 1, body: 'x', party })).status === 422, 'второй черновик с тем же номером — отказ (ключ)');
  check((await call(lawyer, `/api/docs/${d.id}/update`, { title: d.title, amount: 28000, body: d.body, rev: 9, reason: 'скидка' })).status === 409, 'правка по устаревшей версии — 409');
  const u = (await call(lawyer, `/api/docs/${d.id}/update`, { title: d.title, amount: 28000, body: d.body, rev: 1, reason: 'скидка' })).data.doc;
  // панель «Под капотом»: правка записала версию 2, изменённое поле — только сумма; сигналы — в канале схемы
  const hood = (await call(lawyer, '/api/trace')).data?.[0];
  check(hood?.title === 'Правка документа' && hood.versions.length === 1 && hood.versions[0].class === 'Draft' && hood.versions[0].rev === 2
    && hood.versions[0].fields.join() === 'amount' && hood.versions[0].reason === 'скидка' && hood.signals.length > 0, 'под капотом: правка — версия Draft 2 с изменённой суммой, сигналы канала схемы', hood);
  check((await call(lawyer, `/api/docs/${d.id}/review`, { rev: u.rev })).data?.doc?.status === 'review', 'черновик отправлен на согласование');

  // подписание: договор — новый объект (класс входит в id), черновик удалён той же транзакцией
  const signer = `подписан: ${USERS.head.name}`;
  const c = (await call(head, `/api/docs/${d.id}/sign`, {})).data.doc;
  check(c?.class === 'Contract' && c.id !== d.id && c.rev === 1 && c.number === 'Д-777' && c.amount === 28000 && c.signedBy === USERS.head.name && c.party === party,
    'руководитель подписал: договор — новый объект с новым id, данные черновика', c);
  const hoodSign = (await call(head, '/api/trace')).data?.[0];
  check(hoodSign?.lines.some((l) => l.startsWith('db.begin(')) && hoodSign.lines.includes('tr.commit()')
    && hoodSign.versions.some((v) => v.class === 'Contract' && v.op === 'create' && v.rev === 1 && v.reason === signer)
    && hoodSign.versions.some((v) => v.class === 'Draft' && v.op === 'delete' && v.reason === signer),
  'под капотом: одна транзакция — create Contract и delete Draft с причиной подписания', hoodSign);
  check((await call(head, `/api/docs/${d.id}`)).status === 404, 'черновика больше нет: его id — надгробие');
  const h = (await call(head, `/api/docs/${c.id}`)).data.versions;
  const ops = h.map((v) => `${v.class}:${v.op}`).join(',');
  check(ops === 'Draft:create,Draft:update,Draft:update,Contract:create,Draft:delete' && h.every((v, i) => i === 0 || h[i - 1].at <= v.at)
    && h.some((v) => v.who === USERS.lawyer.name) && h.some((v) => v.who === USERS.head.name) && h.slice(-2).every((v) => v.reason === signer),
  'лента договора — версии черновика и договора по времени: оба автора и причины', ops);
  const then = (await call(head, `/api/docs/${h[0].id}/asof?at=${encodeURIComponent(h[0].at)}`)).data.doc;
  check(then?.number === 'Д-777' && then.amount === 30000 && then.class === 'Draft', 'машина времени: документ на момент создания — черновик', then);
  const signedAt = h.find((v) => v.class === 'Contract');
  const now = (await call(head, `/api/docs/${signedAt.id}/asof?at=${encodeURIComponent(signedAt.at)}`)).data.doc;
  check(now?.class === 'Contract' && now.amount === 28000, 'машина времени: на момент подписания — договор', now);

  // надгробие подписанного черновика — не удаление: в корзине его нет, вернуть нельзя
  check(!(await call(head, '/api/trash')).data.some((x) => x.id === d.id) && (await call(head, '/api/stats')).data.deleted === 0, 'подписанного черновика в корзине нет');
  const back = await call(head, `/api/trash/${d.id}/restore`, {});
  check(back.status === 409 && back.data?.code === 'signed', 'вернуть подписанный черновик — 409: с одним номером стало бы два документа', back);
  check((await call(lawyer, '/api/docs', { number: 'Д-777', title: 'Снова черновик', amount: 1, body: 'x', party })).status === 422, 'новый черновик с номером договора — отказ');

  // удаление с превью, корзина, восстановление с прежним id
  const pv = (await call(head, `/api/docs/${c.id}/delete`, {})).data;
  check(Array.isArray(pv.preview) && pv.preview.some((p) => p.id === c.id && p.action === 'delete') && (await call(head, `/api/docs/${c.id}`)).status === 200,
    'удаление без подтверждения — только превью', pv);
  check((await call(head, `/api/docs/${c.id}/delete`, { confirm: true })).status === 400, 'удаление без показанного превью — отказ');
  await call(head, `/api/docs/${c.id}/delete`, { confirm: true, expect: pv.preview });
  const trash = (await call(head, '/api/trash')).data;
  check(trash.some((x) => x.id === c.id && x.who === USERS.head.name) && !trash.some((x) => x.id === d.id) && (await call(head, '/api/stats')).data.deleted === 1,
    'удалённый договор — в корзине, надгробия черновика там нет', trash);
  check((await call(head, `/api/trash/${c.id}/restore`, {})).status === 200, 'договор восстановлен');
  const restored = (await call(head, `/api/docs/${c.id}`)).data;
  check(restored?.doc?.id === c.id && restored.versions.at(-1).op === 'restore' && restored.versions.at(-2).op === 'delete', 'восстановлен с прежним id: в ленте delete и restore', restored?.versions?.map((v) => v.op));

  // архивный договор: история из первой заливки — четыре версии с агентом загрузки
  const arch = list.docs.find((x) => x.archived);
  const ah = (await call(head, `/api/docs/${arch.id}`)).data.versions;
  check(ah.length === 4 && ah.every((v) => v.class === 'Contract' && v.agent === 'перенос архива'), 'архивный договор: четыре версии первой заливки с агентом', ah);

  // простой дольше срока сессии руководителя — без ожидания: срок его сессий createTenant (без methods; веб-сессии входа
  // по паролю не трогаются) истекает в базе. maintain() идёт администраторским подключением без сессии и удаляет их
  // (план 2.0, 7.6 №5)
  const sql = postgres(process.env.ADMIN_DSN ?? 'postgres://postgres:guide@127.0.0.1:15440/letopis', { max: 1, onnotice: () => {} });
  const S = `"${schema.replace(/"/g, '""')}"`;
  const expired = await sql.unsafe(`update ${S}.secret set expires_at = clock_timestamp() - interval '1 second'
    where kind = 'SESSION' and not (meta ? 'methods') and account = (select account from ${S}.secret where kind = 'PASSWORD' and ident = $1)`, [USERS.head.login])
    .finally(() => sql.end({ timeout: 2 }));
  const m = await call(head, '/api/admin/maintain', {});
  check(m.status === 200 && m.data.skipped === false && m.data.sessions >= expired.count && expired.count >= 1,
    `обслуживание после простоя (истекло сессий createTenant: ${expired.count}): maintain() удалил сессий ${m.data?.sessions}`, m.data);
  const after = await call(head, `/api/docs/${c.id}/update`, { title: c.title, amount: 27000, body: c.body, rev: restored.doc.rev, reason: 'после простоя' });
  check(after.status === 200 && after.data.doc.rev === restored.doc.rev + 1, 'после простоя правка руководителя проходит: веб-сессия своя', after.data);
} catch (e) {
  failures.push(String(e?.stack ?? e));
  console.log(`✗ сценарий упал: ${e?.stack ?? e}`);
} finally {
  server.close();
  await close();
}
console.log(failures.length ? `\nупало шагов: ${failures.length}` : '\nдень работы прошёл');
process.exit(failures.length ? 1 : 0);
