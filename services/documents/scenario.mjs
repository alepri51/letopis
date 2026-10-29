/**
 * Сценарий «день работы» документов: сервис в этом же процессе, шаги — через его JSON API (как интерфейс).
 *   ADMIN_DSN=… APP_DSN=… node scenario.mjs        Код выхода 1 — сбой. Схема своя и с нуля (documents_scenario).
 */
process.env.SCHEMA ??= 'documents_scenario';
process.env.FRESH ??= '1';
const { createApp, USERS } = await import('./src/server.mjs');

const { app, close } = await createApp();
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
  check(list.docs.length === 14 && list.docs.some((d) => d.archived), 'реестр: 12 архивных договоров и 2 черновика', list.docs.length);
  const party = list.parties[0].id;
  const d = (await call(lawyer, '/api/docs', { number: 'Д-777', title: 'Охрана офиса', amount: 30000, body: 'Пост 24/7', party })).data;
  check(d.class === 'Draft' && d.rev === 1, 'юрист создал черновик Д-777', d);
  check((await call(lawyer, '/api/docs', { number: 'Д-777', title: 'Дубль', amount: 1, body: 'x', party })).status === 422, 'второй документ с тем же номером — отказ (ключ)');
  check((await call(lawyer, `/api/docs/${d.id}/update`, { title: d.title, amount: 28000, body: d.body, rev: 9, reason: 'скидка' })).status === 409, 'правка по устаревшей версии — 409');
  const u = (await call(lawyer, `/api/docs/${d.id}/update`, { title: d.title, amount: 28000, body: d.body, rev: 1, reason: 'скидка' })).data.doc;
  await call(lawyer, `/api/docs/${d.id}/review`, { rev: u.rev });
  const c = (await call(head, `/api/docs/${d.id}/sign`, {})).data.doc;
  check(c?.class === 'Contract' && c.id !== d.id && c.signedBy === USERS.head.name, 'руководитель подписал: договор с новым id (reclass)', c);
  const n = (await call(head, `/api/docs/${c.id}/renumber`, { number: 'Д-2026-777' })).data.doc;
  check(n?.number === 'Д-2026-777' && n.id !== c.id, 'смена номера: новый id (rekey)', n);
  const h = (await call(head, `/api/docs/${n.id}`)).data.versions;
  const ops = h.map((v) => v.op).join(',');
  check(ops.startsWith('create,update,update,reclass') && ops.includes('rekey') && h.some((v) => v.who === USERS.lawyer.name) && h.some((v) => v.who === USERS.head.name),
    'лента версий через reclass и rekey: оба автора и причины', ops);
  const diff = (await call(head, `/api/docs/${n.id}/diff?from=${encodeURIComponent(h[0].at)}&to=${encodeURIComponent(h.at(-1).at)}`)).data.changes;
  check(diff.some((x) => x.field === 'data.amount' && x.before === 30000 && x.after === 28000) && diff.some((x) => x.field === 'data.number'), 'сравнение первой и последней версии: сумма и номер', diff);
  const blame = (await call(head, `/api/docs/${n.id}/blame`)).data.fields;
  check(blame.find((b) => b.field === 'data.amount')?.who === USERS.lawyer.name, 'кто менял: сумму — юрист', blame);
  const then = (await call(head, `/api/docs/${h[0].id}/asof?at=${encodeURIComponent(h[0].at)}`)).data.doc;
  check(then?.number === 'Д-777' && then.amount === 30000 && then.class === 'Draft', 'машина времени: документ на момент создания', then);
  const pv = (await call(head, `/api/docs/${n.id}/delete`, {})).data;
  check(Array.isArray(pv.preview) && (await call(head, `/api/docs/${n.id}`)).status === 200, 'удаление без подтверждения — только превью', pv);
  await call(head, `/api/docs/${n.id}/delete`, { confirm: true });
  check((await call(head, '/api/trash')).data.some((x) => x.id === n.id), 'удалённый — в корзине');
  await call(head, `/api/trash/${n.id}/restore`, {});
  check((await call(head, `/api/docs/${n.id}`)).status === 200, 'восстановлен с прежним id');
  await call(head, `/api/docs/${n.id}/delete`, { confirm: true });
  await call(head, `/api/trash/${n.id}/purge`, {});
  check(!(await call(head, '/api/trash')).data.some((x) => x.id === n.id), 'стёрт навсегда (purge) — в корзине его нет');
  await call(head, `/api/parties/${party}/anonymize`, {});
  const p2 = (await call(head, '/api/docs')).data.parties.find((x) => x.id === party);
  check(p2?.passport === '[erased]' && p2.anonymized, 'контрагент обезличен: паспорт затёрт', p2);
  const arch = list.docs.find((x) => x.archived);
  const trimmed = (await call(head, `/api/docs/${arch.id}/trim`, {})).data.trimmed;
  check(trimmed >= 1 && (await call(head, `/api/docs/${arch.id}`)).data.versions[0].op === 'trim', `обрезка истории архивного договора: стёрто версий ${trimmed}`);
  check((await call(head, '/api/admin/verify')).data.ok, 'журнал цел');
  const bad = (await call(head, '/api/admin/corrupt', {})).data;
  const v2 = (await call(head, '/api/admin/verify')).data;
  check(!v2.ok && v2.issues.some((i) => i.number === bad.number && /хэш/.test(i.problem)), `порча записи ${bad.number} v${bad.rev} найдена verify`, v2.issues);
  await call(head, '/api/admin/repair', {});
  check((await call(head, '/api/admin/verify')).data.ok, 'запись возвращена — журнал снова цел');
  const m = (await call(head, '/api/admin/maintain', { days: 400 })).data;
  check(m.thinned > 0, `прореживание «через 400 дней»: удалено версий ${m.thinned}`, m);
} catch (e) {
  failures.push(String(e?.stack ?? e));
  console.log(`✗ сценарий упал: ${e?.stack ?? e}`);
} finally {
  server.close();
  await close();
}
console.log(failures.length ? `\nупало шагов: ${failures.length}` : '\nдень работы прошёл');
process.exit(failures.length ? 1 : 0);
