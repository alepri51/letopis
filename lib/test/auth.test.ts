/**
 * auth — креды, вход и сессии (план, §2.9, этап 5, п. 1–2; тест-план §7.7, 5.1–5.6). Креды вводятся
 * настоящими: пароли, ключи, одноразовые коды и коды TOTP. Сервис — подключение по ключу установки
 * (категория Service, права auth.* по правилам System).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, lt, SYSTEM_ID, type Engine } from './_engine.js';
import { appDsn } from './_harness.js';
import { account, session, sqlAs, sysadmin, type Acc } from './_access.js';
import { connect, totpCode, type Db } from '../src/index.js';

let e: Engine;
let S: string;
let svc: Db;
let anna: Acc;
let boris: Acc;
const dbs: Db[] = [];

const open = async (o: { token?: string; apiKey?: string }) => {
  const db = await connect({ dsn: appDsn(), schema: e.schema, max: 2, ...o });
  dbs.push(db);
  return db;
};
/** Чей это токен: аккаунт сессии или null. */
const whose = async (token: string): Promise<string | null> => {
  const [r] = await sqlAs(e, token)(`select account from ${S}.ctx()`);
  return (r?.account as string | null) ?? null;
};

before(async () => {
  e = await engine(import.meta.filename);
  S = e.S;
  svc = await open({ apiKey: e.serviceKey });
  anna = await account(e, 'Анна');
  boris = await account(e, 'Борис');
});

after(async () => {
  for (const d of dbs) await d.close();
  await e?.close();
});

test('5.1 PASSWORD: вход открывает сессию того же аккаунта; неверный пароль и неподтверждённый кред — отказ', async () => {
  await svc.auth.setPassword({ account: anna.id, identifier: 'anna@salon.ru', password: 'Сирень-2026!', confirmed: true });
  const ok = await svc.auth.verifyPassword({ identifier: 'anna@salon.ru', password: 'Сирень-2026!' });
  assert.equal(ok?.account, anna.id);
  assert.equal(await whose(ok!.token), anna.id);
  assert.equal(await svc.auth.verifyPassword({ identifier: 'anna@salon.ru', password: 'сирень-2026!' }), null);
  assert.equal(await svc.auth.verifyPassword({ identifier: 'nobody@salon.ru', password: 'Сирень-2026!' }), null);
  await svc.auth.setPassword({ account: boris.id, identifier: 'boris', password: 'Ключ#42', kind: 'LOGIN' });
  assert.equal(await svc.auth.verifyPassword({ identifier: 'boris', password: 'Ключ#42', kind: 'LOGIN' }), null, 'неподтверждённый');
  assert.equal((await svc.auth.verifyPassword({ identifier: 'boris', password: 'Ключ#42', kind: 'LOGIN', requireConfirmed: false }))?.account, boris.id);
  // хэш пароля — только сервису с правом auth.password
  const user = await open({ token: anna.token });
  await assert.rejects(user.auth.verifyPassword({ identifier: 'anna@salon.ru', password: 'Сирень-2026!' }), (err: { code?: string }) => err.code === 'acl_denied');
});

test('5.1 APIKEY и KEYSECRET: проверяет база; неверный ключ или секрет — отказ', async () => {
  const { key } = await svc.auth.issueApiKey({ account: anna.id, name: 'интеграция' });
  assert.match(key, /^lts_[0-9a-f]{48}$/);
  const r = await svc.auth.verifyApiKey(key);
  assert.equal(r?.account, anna.id);
  assert.equal(await whose(r!.token), anna.id);
  const viaKey = await open({ apiKey: key });
  assert.equal((await viaKey.transaction((q) => q.unsafe(`select account from ${S}.ctx()`)))[0].account, anna.id);
  assert.equal(await svc.auth.verifyApiKey(key.slice(0, -1) + (key.endsWith('0') ? '1' : '0')), null);
  // ротация: второй ключ, отзыв первого — без простоя: гаснут только сессии отозванного ключа
  const second = await svc.auth.issueApiKey({ account: anna.id });
  const viaSecond = await open({ apiKey: second.key });
  const creds = await svc.auth.credentials(anna.id);
  const first = creds.find((c) => c.kind === 'APIKEY' && c.meta.name === 'интеграция')!;
  assert.equal(await svc.auth.revokeCredential(first.id), true);
  assert.equal(await svc.auth.verifyApiKey(key), null);
  assert.equal(await whose(r!.token), null, 'вход по отозванному ключу');
  assert.equal(await whose(viaKey.token!), null, 'подключение по отозванному ключу');
  assert.equal(await whose(viaSecond.token!), anna.id, 'подключение по второму ключу');
  assert.equal(await whose(anna.token), anna.id, 'сессия не по ключу');
  assert.equal((await svc.auth.verifyApiKey(second.key))?.account, anna.id);
  const ks = await svc.auth.issueKeySecret({ account: boris.id });
  assert.equal((await svc.auth.verifyKeySecret(ks.key, ks.secret))?.account, boris.id);
  assert.equal(await svc.auth.verifyKeySecret(ks.key, ks.secret + 'x'), null);
  assert.equal(await svc.auth.verifyKeySecret('0000000000000000', ks.secret), null);
});

test('5.1 OTP, TOTP и внешняя identity', async () => {
  const { code } = await svc.auth.issueOtp({ account: anna.id, identifier: '+7 900 123-45-67' });
  assert.match(code, /^\d{6}$/);
  assert.equal(await svc.auth.verifyOtp({ identifier: '+7 900 123-45-67', code: code === '000000' ? '111111' : '000000' }), null);
  const ok = await svc.auth.verifyOtp({ identifier: '+7 900 123-45-67', code });
  assert.equal(ok?.account, anna.id);
  const { secret, uri } = await svc.auth.enrollTotp({ account: boris.id, issuer: 'Салон', label: 'boris@salon.ru' });
  assert.match(uri, /^otpauth:\/\/totp\/boris%40salon\.ru\?secret=[A-Z2-7]+&issuer=%D0%A1/);
  assert.equal(await svc.auth.totpEnabled(boris.id), false);
  assert.equal(await svc.auth.verifyTotp({ account: boris.id, code: '000000' === totpCode(secret) ? '111111' : '000000' }), false);
  assert.equal(await svc.auth.verifyTotp({ account: boris.id, code: totpCode(secret) }), true);
  assert.equal(await svc.auth.totpEnabled(boris.id), true);
  await svc.auth.link({ account: boris.id, kind: 'TELEGRAM', identifier: '777000111', confirmed: true });
  const tg = await svc.auth.lookup({ kind: 'TELEGRAM', identifier: '777000111' });
  assert.equal(tg?.account, boris.id);
  assert.equal(await whose(tg!.token), boris.id);
  assert.equal(await svc.auth.lookup({ kind: 'TELEGRAM', identifier: '000' }), null);
  await svc.auth.link({ account: anna.id, kind: 'GOOGLE', identifier: 'g-1' });
  assert.equal(await svc.auth.lookup({ kind: 'GOOGLE', identifier: 'g-1' }), null, 'неподтверждённая связка');
  assert.equal((await svc.auth.lookup({ kind: 'GOOGLE', identifier: 'g-1', requireConfirmed: false }))?.account, anna.id);
});

test('5.2 выравнивание времени: «нет логина» и «неверный пароль» отвечают одинаково', async () => {
  await svc.auth.setPassword({ account: boris.id, identifier: 'timing@salon.ru', password: 'Верный-пароль-1', confirmed: true });
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const once = async (identifier: string) => {
    const t0 = performance.now();
    assert.equal(await svc.auth.verifyPassword({ identifier, password: 'Неверный-пароль-2' }), null);
    return performance.now() - t0;
  };
  // замеры парами вперемешку, а не двумя сериями подряд: медленный период машины (CI под нагрузкой)
  // достаётся обоим видам поровну. «Нет логина» в паре — первым, вторым, вторым, первым и снова: под
  // нагрузкой у времени вызова бывает период 4 (scrypt идёт по кругу через четыре потока пула libuv,
  // один из них медленнее), и так каждый вид попадает на каждую позицию одинаково часто (при простом
  // чередовании медленный поток доставался бы одному виду). Первые четыре пары — разогрев.
  const missing: number[] = [];
  const wrong: number[] = [];
  for (let i = 0; i < 44; i++) {
    const order = i % 4 === 0 || i % 4 === 3 ? [missing, wrong] : [wrong, missing];
    for (const xs of order) {
      const t = await once(xs === missing ? 'nobody-timing@salon.ru' : 'timing@salon.ru');
      if (i >= 4) xs.push(t);
    }
  }
  const m = median(missing);
  const w = median(wrong);
  // без выравнивания «нет логина» — только запрос к базе (единицы мс), «неверный пароль» — ещё scrypt
  // (около 100 мс): медианы расходятся на 95% и больше; при замерах вперемешку — на единицы процентов,
  // и под нагрузкой процессора тоже
  assert.ok(Math.abs(m - w) / Math.max(m, w) <= 0.25, `медианы ${m.toFixed(1)} и ${w.toFixed(1)} мс`);
});

test('5.3 регистр идентификатора: вход без учёта регистра; привязка того же идентификатора другому — отказ', async () => {
  const ok = await svc.auth.verifyPassword({ identifier: 'Anna@Salon.ru', password: 'Сирень-2026!' });
  assert.equal(ok?.account, anna.id);
  await assert.rejects(svc.auth.setPassword({ account: boris.id, identifier: 'ANNA@salon.ru', password: 'x' }), (err: { code?: string }) => err.code === 'acl_denied');
  await assert.rejects(svc.auth.link({ account: anna.id, kind: 'TELEGRAM', identifier: '777000111' }), (err: { code?: string }) => err.code === 'acl_denied');
  // отказ не раскрывает, занят ли идентификатор: тот же текст, что без права
  const user = await open({ token: boris.token });
  const busy = await user.auth.link({ account: boris.id, kind: 'TELEGRAM', identifier: '777000111' }).catch((x: Error) => x.message);
  const noRight = await user.auth.link({ account: anna.id, kind: 'VK', identifier: 'free-id' }).catch((x: Error) => x.message);
  assert.equal(busy, noRight);
});

test('5.4 OTP: истёкший код, перебор, повтор успешного', async () => {
  const exp = await svc.auth.issueOtp({ account: anna.id, identifier: 'exp@salon.ru', ttl: 1 });
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(await svc.auth.verifyOtp({ identifier: 'exp@salon.ru', code: exp.code }), null);
  // лимит попыток задаёт выпуск кода (сервис), а не вход: вызывающий вход его не расширит
  const { code } = await svc.auth.issueOtp({ account: anna.id, identifier: 'brute@salon.ru', maxAttempts: 3 });
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 3; i++) assert.equal(await svc.auth.verifyOtp({ identifier: 'brute@salon.ru', code: wrong }), null);
  assert.equal(await svc.auth.verifyOtp({ identifier: 'brute@salon.ru', code }), null, 'после лимита код сожжён');
  const fresh = await svc.auth.issueOtp({ account: anna.id, identifier: 'once@salon.ru' });
  assert.equal((await svc.auth.verifyOtp({ identifier: 'once@salon.ru', code: fresh.code }))?.account, anna.id);
  assert.equal(await svc.auth.verifyOtp({ identifier: 'once@salon.ru', code: fresh.code }), null, 'повтор успешного кода');
  // выпуск кода — только сервису с правом auth.otp
  const user = await open({ token: await session(e, anna.id) });
  await assert.rejects(user.auth.issueOtp({ account: anna.id, identifier: 'self@salon.ru' }), (err: { code?: string }) => err.code === 'acl_denied');
});

test('5.5 TOTP: первая проверка включает фактор, повтор того же шага — отказ; проверяет сервис', async () => {
  const user = await open({ token: await session(e, anna.id, { methods: ['PASSWORD'] }) });
  const { secret } = await user.auth.enrollTotp({ account: anna.id });
  const code = totpCode(secret);
  // сам пользователь коды не проверяет: счётчик неудач снимался бы откатом к точке сохранения
  await assert.rejects(user.auth.verifyTotp({ account: anna.id, code }), (err: { code?: string }) => err.code === 'acl_denied');
  assert.equal(await svc.auth.verifyTotp({ account: anna.id, code }), true);
  assert.equal(await user.auth.totpEnabled(anna.id), true);
  assert.equal(await svc.auth.verifyTotp({ account: anna.id, code }), false, 'повтор шага');
});

test('5.6 гашение сессий: срок, выход, выход везде, отключение, смена пароля, удаление креда, удаление аккаунта', async () => {
  const u = await account(e, 'Вера');
  const alive = async (t: string) => (await whose(t)) === u.id;
  // срок
  const short = await session(e, u.id, {}, '1 second');
  assert.equal(await alive(short), true);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(await alive(short), false, 'срок');
  // выход
  const t1 = await session(e, u.id);
  assert.equal(await (await open({ token: t1 })).auth.revoke(), true);
  assert.equal(await alive(t1), false, 'выход');
  // выход везде
  const a1 = await session(e, u.id);
  const a2 = await session(e, u.id);
  // гаснут все незагашенные, в том числе просроченные: первая сессия аккаунта, short, a1, a2
  assert.equal(await (await open({ token: a1 })).auth.revokeAll(), 4);
  assert.equal(await alive(a1) || await alive(a2), false, 'выход везде');
  // смена пароля собой (после недавнего входа): текущая жива, остальные погашены
  const cur = await session(e, u.id);
  const other = await session(e, u.id);
  const self = await open({ token: cur });
  await e.sql.unsafe(`update ${S}.secret set meta = meta || '{"methods": ["PASSWORD"]}' where kind = 'SESSION' and material = sha256(convert_to($1, 'UTF8'))`, [cur]);
  await self.auth.setPassword({ account: u.id, identifier: 'vera@salon.ru', password: 'Первый-1' });
  await self.auth.setPassword({ account: u.id, identifier: 'vera@salon.ru', password: 'Второй-2' });
  assert.equal(await alive(cur), true, 'текущая сессия при смене пароля');
  assert.equal(await alive(other), false, 'смена пароля');
  // удаление креда: остальные погашены
  const other2 = await session(e, u.id);
  const cred = (await self.auth.credentials(u.id)).find((c) => c.kind === 'PASSWORD')!;
  assert.equal(await self.auth.revokeCredential(cred.id), true);
  assert.equal(await alive(cur), true);
  assert.equal(await alive(other2), false, 'удаление креда');
  // отключение аккаунта системным администратором: все сессии гаснут и не оживают после включения
  const admin = await sysadmin(e);
  const raw = sqlAs(e, admin.token);
  await raw(`update ${S}.entity set data = ${S}.merge(data, '{"enabled": false}') where id = $1`, [u.id]);
  assert.equal(await alive(cur), false, 'enabled = false');
  await raw(`update ${S}.entity set data = ${S}.merge(data, '{"enabled": true}') where id = $1`, [u.id]);
  assert.equal(await alive(cur), false, 'погашенная сессия не оживает');
  // удаление аккаунта: сессии гаснут, креды удаляются — идентификатор свободен
  const last = await session(e, u.id);
  await svc.auth.setPassword({ account: u.id, identifier: 'vera-del@salon.ru', password: 'Третий-3' });
  await raw(`delete from ${S}.entity where id = $1`, [u.id]);
  assert.equal(await alive(last), false, 'удаление аккаунта');
  await svc.auth.setPassword({ account: boris.id, identifier: 'vera-del@salon.ru', password: 'Четвёртый-4' });
  void SYSTEM_ID;
});

test('недавний вход: свой кред без недавнего входа — отказ; сигналы гашения сессий без данных', async () => {
  const u = await account(e, 'Глеб');
  const old = await session(e, u.id);
  await e.sql.unsafe(`update ${S}.secret set meta = meta || jsonb_build_object('login_at', now() - interval '1 hour')
    where kind = 'SESSION' and material = sha256(convert_to($1, 'UTF8'))`, [old]);
  await assert.rejects((await open({ token: old })).auth.setPassword({ account: u.id, identifier: 'gleb@salon.ru', password: 'x' }),
    (err: { code?: string }) => err.code === 'acl_denied');
  // 7.3.1 №28 (сессии): сигнал — только начало хэша токена
  const seen: string[] = [];
  const l = await e.sql.listen(e.schema, (p) => seen.push(p));
  await sqlAs(e, old)(`select ${S}.auth_logout()`);
  for (let i = 0; i < 50 && !seen.some((x) => x.startsWith('session:')); i++) await new Promise((r) => setTimeout(r, 20));
  await l.unlisten();
  const sig = seen.find((x) => x.startsWith('session:'));
  assert.match(sig ?? '', /^session:[0-9a-f]{16}$/);
  assert.ok(!seen.some((x) => x.includes(u.id) || x.includes(old)), 'ни id, ни токена в сигналах');
  await assert.rejects(sqlAs(e, null)(`select ${S}.auth_logout()`), lt('no_session'));
});

test('ревью этапа 5: креды привилегированных аккаунтов, самоподтверждение, окно и блокировка TOTP, предел продления, лимит OTP', async () => {
  const admin = await sysadmin(e);
  const adminDb = await open({ token: admin.token });
  const svc2 = await account(e, 'Другой сервис', { categories: ['Service'] });
  // сервис не привязывает себе вход под System, другим сервисом или системным администратором
  for (const [label, target] of [['System', SYSTEM_ID], ['сервис', svc2.id], ['администратор', admin.id]]) {
    await assert.rejects(svc.auth.setPassword({ account: target, identifier: `x-${label}@salon.ru`, password: 'p' }), (err: { code?: string }) => err.code === 'acl_denied', label);
    await assert.rejects(svc.auth.issueApiKey({ account: target }), (err: { code?: string }) => err.code === 'acl_denied', label);
    await assert.rejects(svc.auth.issueOtp({ account: target, identifier: `otp-${label}` }), (err: { code?: string }) => err.code === 'acl_denied', label);
  }
  // системный администратор — может
  assert.match((await adminDb.auth.issueApiKey({ account: admin.id })).key, /^lts_/);
  // свой кред аккаунт сам не подтверждает
  const u = await account(e, 'Дина');
  const self = await open({ token: await session(e, u.id, { methods: ['PASSWORD'] }) });
  await self.auth.setPassword({ account: u.id, identifier: 'dina@salon.ru', password: 'Свой-1', confirmed: true });
  assert.equal(await svc.auth.verifyPassword({ identifier: 'dina@salon.ru', password: 'Свой-1' }), null, 'не подтверждён');
  await self.auth.link({ account: u.id, kind: 'TELEGRAM', identifier: 'dina-tg', confirmed: true });
  assert.equal(await svc.auth.lookup({ kind: 'TELEGRAM', identifier: 'dina-tg' }), null, 'связка не подтверждена');
  // TOTP: окно не шире шага; пять неудач — блокировка
  const { secret } = await self.auth.enrollTotp({ account: u.id });
  assert.equal(await svc.auth.verifyTotp({ account: u.id, code: totpCode(secret, Date.now() + 5 * 30_000), window: 100 }), false, 'окно ограничено');
  for (let i = 0; i < 4; i++) await svc.auth.verifyTotp({ account: u.id, code: '000000' === totpCode(secret) ? '111111' : '000000' });
  assert.equal(await svc.auth.verifyTotp({ account: u.id, code: totpCode(secret) }), false, 'после пяти неудач — блокировка');
  // недавний вход по ключу API не даёт менять креды; при включённом TOTP нужен пройденный TOTP
  const viaKey = await open({ token: await session(e, u.id, { methods: ['APIKEY'] }) });
  await assert.rejects(viaKey.auth.issueApiKey({ account: u.id }), (err: { code?: string }) => err.code === 'acl_denied');
  // продление — не дольше срока, выданного при входе
  const exp = await self.auth.refresh({ ttl: 10 * 365 * 24 * 3600 });
  assert.ok(Date.parse(exp) < Date.now() + 8 * 24 * 3600 * 1000, exp);
  // лимит попыток OTP задаёт выпуск и ограничен десятью
  await svc.auth.issueOtp({ account: u.id, identifier: 'dina-otp', maxAttempts: 1000 });
  const [m] = await e.sql.unsafe(`select meta->>'max_attempts' as m from ${S}.secret where kind = 'OTP' and ident = 'dina-otp' and deleted_at is null`);
  assert.equal(m.m, '10');
});

test('TOTP при входе: verifyPassword и lookup с кодом выдают сессию со способом TOTP — свои креды пользователь меняет сам; без кода — как раньше; неверный и повторный код — отказ, счётчик общий с verifyTotp', async () => {
  const denied = (err: { code?: string }) => err.code === 'acl_denied';
  const methods = async (token: string) => (await e.sql.unsafe(`select meta->'methods' as m from ${S}.secret
    where kind = 'SESSION' and material = sha256(convert_to($1, 'UTF8'))`, [token]))[0]?.m;
  const fails = async (acc: string) => Number((await e.sql.unsafe(`select coalesce(meta->>'fails', '0') as f from ${S}.secret
    where account = $1 and kind = 'TOTP' and deleted_at is null`, [acc]))[0].f);
  // коды TOTP — по часам базы: шаги считает она; окно проверки — шаг в каждую сторону
  const dbNow = async () => Number((await e.sql`select extract(epoch from clock_timestamp()) * 1000 as ms`)[0].ms);
  const code = async (secret: string, step = 0) => totpCode(secret, await dbNow() + step * 30_000);
  const wrong = async (secret: string) => {
    const now = await dbNow();
    const near = [-1, 0, 1].map((k) => totpCode(secret, now + k * 30_000));
    return ['000000', '111111', '222222', '333333'].find((c) => !near.includes(c))!;
  };
  const u = await account(e, 'Зоя');
  await svc.auth.setPassword({ account: u.id, identifier: 'zoya@salon.ru', password: 'Зоя-пароль-1', confirmed: true });
  // TOTP подключает сам пользователь после входа по паролю; фактор включает первая проверка кода сервисом
  const first = (await svc.auth.verifyPassword({ identifier: 'zoya@salon.ru', password: 'Зоя-пароль-1' }))!;
  const { secret } = await (await open({ token: first.token })).auth.enrollTotp({ account: u.id });
  assert.equal(await svc.auth.verifyTotp({ account: u.id, code: await code(secret, -1) }), true);
  // без кода — как раньше: сессия без отметки TOTP, свои креды по ней не меняются
  const plain = (await svc.auth.verifyPassword({ identifier: 'zoya@salon.ru', password: 'Зоя-пароль-1' }))!;
  assert.deepEqual(await methods(plain.token), ['PASSWORD']);
  await assert.rejects((await open({ token: plain.token })).auth.setPassword({ account: u.id, identifier: 'zoya@salon.ru', password: 'Зоя-пароль-2' }), denied);
  // код проверяется только после верного пароля: неверный пароль счётчик неудач TOTP не трогает
  assert.equal(await svc.auth.verifyPassword({ identifier: 'zoya@salon.ru', password: 'Зоя-пароль-0', totp: await wrong(secret) }), null);
  assert.equal(await fails(u.id), 0);
  // неверный код — вход не состоялся, неудача засчитана, как у verifyTotp
  assert.equal(await svc.auth.verifyPassword({ identifier: 'zoya@salon.ru', password: 'Зоя-пароль-1', totp: await wrong(secret) }), null);
  assert.equal(await fails(u.id), 1);
  // пароль и код — сессия со способами PASSWORD и TOTP: 10 минут пользователь меняет свои креды сам
  const totp = await code(secret);
  const login = (await svc.auth.verifyPassword({ identifier: 'zoya@salon.ru', password: 'Зоя-пароль-1', totp }))!;
  assert.equal(login.account, u.id);
  assert.deepEqual(await methods(login.token), ['PASSWORD', 'TOTP']);
  assert.equal(await fails(u.id), 0, 'удача сбрасывает счётчик');
  const self = await open({ token: login.token });
  await self.auth.setPassword({ account: u.id, identifier: 'zoya@salon.ru', password: 'Зоя-пароль-2' });
  assert.match((await self.auth.issueApiKey({ account: u.id, name: 'свой' })).key, /^lts_/);
  // повтор того же кода — отказ
  assert.equal(await svc.auth.verifyPassword({ identifier: 'zoya@salon.ru', password: 'Зоя-пароль-2', totp }), null, 'повтор кода');
  // вход по внешней учётной записи — так же
  await svc.auth.link({ account: u.id, kind: 'TELEGRAM', identifier: 'zoya-tg', confirmed: true });
  assert.deepEqual(await methods((await svc.auth.lookup({ kind: 'TELEGRAM', identifier: 'zoya-tg' }))!.token), ['TELEGRAM']);
  assert.equal(await svc.auth.lookup({ kind: 'TELEGRAM', identifier: 'zoya-tg', totp: await wrong(secret) }), null);
  const tg = (await svc.auth.lookup({ kind: 'TELEGRAM', identifier: 'zoya-tg', totp: await code(secret, 1) }))!;
  assert.deepEqual(await methods(tg.token), ['TELEGRAM', 'TOTP']);
  await (await open({ token: tg.token })).auth.link({ account: u.id, kind: 'VK', identifier: 'zoya-vk' });
  // код без подключённого TOTP — отказ; счётчик общий с verifyTotp: пять неудач подряд (проверка и вход
  // вперемешку) закрывают проверку на 5 минут — и верный код не пускает
  const v = await account(e, 'Ия');
  await svc.auth.setPassword({ account: v.id, identifier: 'iya@salon.ru', password: 'Ия-пароль-1', confirmed: true });
  assert.equal(await svc.auth.verifyPassword({ identifier: 'iya@salon.ru', password: 'Ия-пароль-1', totp: '123456' }), null, 'TOTP не подключён');
  const { secret: s2 } = await svc.auth.enrollTotp({ account: v.id });
  for (let i = 0; i < 2; i++) assert.equal(await svc.auth.verifyTotp({ account: v.id, code: await wrong(s2) }), false);
  for (let i = 0; i < 3; i++) assert.equal(await svc.auth.verifyPassword({ identifier: 'iya@salon.ru', password: 'Ия-пароль-1', totp: await wrong(s2) }), null);
  assert.equal(await svc.auth.verifyPassword({ identifier: 'iya@salon.ru', password: 'Ия-пароль-1', totp: await code(s2) }), null, 'блокировка');
  assert.equal(await svc.auth.verifyTotp({ account: v.id, code: await code(s2) }), false, 'блокировка общая');
});

test('ключи сервиса: по сессии своего ключа сервис выпускает и отзывает свои APIKEY и KEYSECRET, последний — нет; ротация без простоя: отзыв ключа гасит только его сессии', async () => {
  // Тест последний в файле: ключ установки отзывается, дальше подключение svc работает по новому ключу.
  const denied = (err: { code?: string }) => err.code === 'acl_denied';
  const [{ id: svcId }] = await e.sql.unsafe(`select id from ${S}.entity where class = 'Account' and data->'categories' ? 'Service'`) as unknown as { id: string }[];
  const meta = async (token: string) => (await e.sql.unsafe(`select meta from ${S}.secret
    where kind = 'SESSION' and material = sha256(convert_to($1, 'UTF8'))`, [token]))[0]?.meta;
  const old = (await svc.auth.credentials(svcId)).find((c) => c.kind === 'APIKEY' && c.ident === e.serviceKey.slice(0, 12))!;
  // сессия по ключу помнит его id
  assert.equal((await meta(svc.token!)).cred, old.id);
  // последний действующий ключ не отзывается: сервис остался бы без входа
  await assert.rejects(svc.auth.revokeCredential(old.id),
    (err: Error & { code?: string }) => err.code === 'acl_denied' && /последний действующий ключ сервиса/.test(err.message));
  // пара «ключ + секрет»: выпуск себе, вход, отзыв — гаснет только её сессия
  const ks = await svc.auth.issueKeySecret({ account: svcId, name: 'пара' });
  const byPair = (await svc.auth.verifyKeySecret(ks.key, ks.secret))!;
  assert.equal(byPair.account, svcId);
  assert.equal((await meta(byPair.token)).cred, ks.id);
  assert.equal(await svc.auth.revokeCredential(ks.id), true);
  assert.equal(await whose(byPair.token), null, 'сессия по отозванной паре');
  assert.equal(await whose(svc.token!), svcId, 'сессия по ключу жива');
  // только ключи и только свои: пароль себе сервис не задаёт, ключи другого сервиса не выпускает и не отзывает
  await assert.rejects(svc.auth.setPassword({ account: svcId, identifier: 'svc@salon.ru', password: 'Сервис-1' }), denied);
  const other = await account(e, 'Сервис-2', { categories: ['Service'] });
  await assert.rejects(svc.auth.issueApiKey({ account: other.id }), denied);
  const admin = await open({ token: (await sysadmin(e, 'admin-keys')).token });
  const otherKey = await admin.auth.issueApiKey({ account: other.id });
  await assert.rejects(svc.auth.revokeCredential(otherKey.id), denied);
  // и только по сессии своего ключа: сессия сервиса без входа по ключу своих ключей не выпускает
  await assert.rejects((await open({ token: await session(e, svcId) })).auth.issueApiKey({ account: svcId }), denied);
  // ротация без простоя: 1) сервис выпускает себе новый ключ; 2) второе подключение входит по нему
  const fresh = await svc.auth.issueApiKey({ account: svcId, name: 'ротация' });
  const next = await open({ apiKey: fresh.key });
  assert.equal((await meta(next.token!)).cred, fresh.id);
  const stale = await open({ apiKey: e.serviceKey });   // ещё одно подключение по старому ключу
  const plain = await session(e, svcId);                // сессия сервиса не по ключу
  const legacy = await session(e, svcId, { methods: ['APIKEY'] });   // по ключу, но без отметки креда (открыта до неё)
  // 3) сервис отзывает старый ключ (keepCurrent: false — своё подключение по старому ключу тоже гасит)
  assert.equal(await svc.auth.revokeCredential(old.id, { keepCurrent: false }), true);
  // 4) подключение по новому ключу работает, по старому — no_session; прочие сессии отзыв ключа не трогает
  assert.deepEqual((await next.auth.credentials(svcId)).filter((c) => c.kind === 'APIKEY').map((c) => c.id), [fresh.id]);
  await assert.rejects(svc.auth.credentials(svcId), lt('no_session'));
  await assert.rejects(stale.auth.credentials(svcId), lt('no_session'));
  await assert.rejects(open({ apiKey: e.serviceKey }), lt('no_session'));
  assert.equal(await whose(plain), svcId);
  assert.equal(await whose(legacy), null, 'чей ключ у сессии без отметки, не узнать — она гаснет');
  // теперь последний — новый ключ
  await assert.rejects(next.auth.revokeCredential(fresh.id), denied);
  svc = next;
  assert.equal((await svc.auth.verifyApiKey(fresh.key))?.account, svcId);
});
