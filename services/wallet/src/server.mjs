/**
 * Сервис-пример «Кошелёк и биллинг» на letopis.
 *
 * - Баланс — агрегат базы: сумма операций Movement (aggregate sum), правило min(0) проверяет база над итогом.
 * - Операция — строка Movement с ключом [Wallet, opId]: повтор после потери ответа база отклоняет (exists),
 *   сервис сверяет «отпечаток» и отвечает «уже было» — деньги не спишутся дважды.
 * - Перевод — db.begin(): блокировки кошельков в порядке id (без взаимных блокировок), две операции, commit.
 * - Выписка за месяц — производный класс Statement, его пишет проектор statement из журнала операций.
 * - Пополнение тестовой картой (проверка Луна); номер карты не хранится — только последние 4 цифры.
 * - Живое обновление (watch → SSE) и панель «Под капотом» (onQuery), как в салоне.
 */
import express from 'express';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { up, connect, createTenant, syncModels, LetopisError } from 'letopis';
import { hub, link, one } from 'letopis/model';
import { z } from 'zod';

const ENV = {
  admin: process.env.ADMIN_DSN ?? 'postgres://postgres:guide@127.0.0.1:15440/letopis',
  app: process.env.APP_DSN ?? 'postgres://wallet_app:wallet-app-secret@127.0.0.1:15440/letopis',
  schema: process.env.SCHEMA ?? 'wallet',
  serviceKey: process.env.SERVICE_KEY ?? 'lts_' + 'b2c3d4e5f6a70819'.repeat(2),
  port: Number(process.env.PORT ?? 8082),
};
export const OPERATOR = { name: 'Ольга', login: 'admin@kopeika.ru', password: 'Kopeika-2026!' };

// ---------- модель ----------
const Wallet = hub('Wallet', { number: z.string(), owner: z.string(), balance: z.number().int().min(0) }, {
  key: ['number'],
  aggregate: { balance: { sum: 'amount', of: 'Movement', via: 'Wallet' } }, // баланс считает база
});
const Movement = link('Movement', {
  opId: z.string(), kind: z.enum(['topup', 'debit', 'transfer']), amount: z.number().int(),
  card4: z.string().optional(), note: z.string().optional(),
}, { ends: { Wallet }, key: ['Wallet', 'opId'] });
const Statement = hub('Statement', { month: z.string(), topup: z.number().int(), debit: z.number().int(), count: z.number().int() }, {
  ends: { Wallet: one(Wallet).onDelete('cascade') }, key: ['Wallet', 'month'], derivedBy: 'statement', history: false,
});

/** Проверка номера карты по алгоритму Луна (тестовые карты: 4242 4242 4242 4242, 5555 5555 5555 4444). */
export function luhn(card) {
  const digits = String(card).replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

export async function createApp() {
  const admin = postgres(ENV.admin, { max: 2, onnotice: () => {} });
  const r = await up({ dsn: ENV.admin, schema: ENV.schema, serviceKey: ENV.serviceKey, quiet: true });
  const appUrl = new URL(ENV.app);
  await admin.unsafe(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${appUrl.username}') then
    create role ${appUrl.username} login password '${decodeURIComponent(appUrl.password)}'; end if; end $$`);
  await admin.unsafe(`grant letopis_app to ${appUrl.username}`);
  const als = new AsyncLocalStorage();
  const svc = await connect({
    dsn: ENV.app, schema: r.schema, apiKey: ENV.serviceKey,
    onQuery: (e) => als.getStore()?.queries.push({ mode: e.mode, classes: e.classes.join(', '), rows: e.rows, ms: Math.round(e.ms) }),
  });
  const t = await createTenant(admin, r.schema, { name: 'Копейка', user: OPERATOR });
  // модель: обычные классы — сессией оператора, производный Statement — администраторским подключением
  const adm = await connect({ dsn: ENV.admin, schema: r.schema, token: t.token, allowBypassRls: true });
  const opDb = await svc.as(t.user, { tenant: t.tenant });
  await syncModels(opDb, [Wallet, Movement], { apply: true });
  await syncModels(adm, [Wallet, Movement, Statement], { apply: true });
  await opDb.refresh();
  if (!(await opDb.Wallet().count())) {
    await opDb.Wallet().create({ number: 'W-1', owner: 'Анна' }).rows();
    await opDb.Wallet().create({ number: 'W-2', owner: 'Борис' }).rows();
  }
  // проектор выписки: месяц × кошелёк — сумма пополнений, списаний и число операций
  const statement = adm.projector('statement', {
    from: ['Movement'], into: ['Statement'], version: 1, withBefore: true,
    handle(changes, out) {
      for (const c of changes) {
        if (c.op === 'purge' || c.op === 'trim' || c.op === 'reset') continue;
        const part = (row, sign) => {
          const a = Number(row.data.amount) * sign;
          out.inc('Statement', { Wallet: row.links.Wallet, month: String(row.at).slice(0, 7) },
            { topup: a > 0 && row.data.kind !== 'debit' ? a : 0, debit: a < 0 ? -a : 0, count: sign }, { tenant: c.tenant });
        };
        if (c.before) part(c.before, -1);
        if (!c.row.$deleted) part(c.row, 1);
      }
    },
  });
  const follow = statement.run().catch((e) => console.error('проектор выписки остановлен:', e.message));

  // ---------- операции ----------
  async function operate(db, wallet, { opId, kind, amount, card4, note }, lines) {
    lines.push(`db.Wallet(кошелёк).Movement().create({ opId: '${opId}', kind: '${kind}', amount: ${amount} })`);
    try {
      await db.Wallet(wallet).Movement().create({ opId, kind, amount, ...(card4 ? { card4 } : {}), ...(note ? { note } : {}) }, { reason: `${kind} ${opId}` }).rows();
      lines.push('баланс пересчитала база (агрегат)');
      return 'проведено';
    } catch (e) {
      if (!(e instanceof LetopisError) || e.code !== 'exists') throw e;
      // повтор: тот ли это запрос? отпечаток — вид и сумма уже записанной операции
      const m = await db.Movement(await db.idOf('Movement', { Wallet: wallet, opId })).first();
      lines.push(`exists — операция ${opId} уже записана; сверили отпечаток`);
      if (m && m.data.kind === kind && m.data.amount === amount) return 'уже было';
      throw new LetopisError('conflict', `opId ${opId} уже занят другой операцией`);
    }
  }

  async function transfer(db, from, to, amount, opId, lines) {
    const tr = await db.begin({ reason: `transfer ${opId}` });
    try {
      // блокировки в порядке id: два встречных перевода не заблокируют друг друга
      for (const id of [from, to].sort()) await tr.lock('wallet', id);
      lines.push(`db.begin(); tr.lock('wallet', …) в порядке id`);
      await tr.Wallet(from).Movement().create({ opId: `${opId}-out`, kind: 'transfer', amount: -amount }).rows();
      await tr.Wallet(to).Movement().create({ opId: `${opId}-in`, kind: 'transfer', amount }).rows();
      await tr.commit();
      lines.push('две операции и commit — баланс обоих пересчитала база');
      return 'проведено';
    } catch (e) {
      await tr.rollback().catch(() => {});
      if (e instanceof LetopisError && e.code === 'exists') return 'уже было';
      throw e;
    }
  }

  // ---------- веб: сессии, журнал «под капотом», API ----------
  const sessions = new Map();
  const sidOf = (req) => /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
  async function act(s, title, fn) {
    const entry = { at: new Date().toISOString().slice(11, 19), title, lines: [], queries: [], error: null };
    try { return await als.run(entry, () => fn(entry.lines)); } catch (e) { entry.error = e.code ? `${e.code}: ${e.message}` : e.message; throw e; }
    finally { s.trace.unshift(entry); s.trace.length = Math.min(s.trace.length, 12); }
  }
  const fail = (res, e) => res.status(e.code === 'invalid_data' ? 422 : e.code === 'conflict' ? 409 : 400)
    .json({ error: e.code === 'invalid_data' ? 'Недостаточно средств: баланс не может стать отрицательным' : `${e.code ?? ''} ${e.message}` });

  const app = express();
  app.use(express.json());
  app.post('/api/login', async (req, res) => {
    const { login: id = '', password = '' } = req.body ?? {};
    const login = await svc.auth.verifyPassword({ identifier: String(id), password: String(password) });
    if (!login || id !== OPERATOR.login) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const sid = randomBytes(24).toString('hex');
    sessions.set(sid, { db: await svc.as(login.account, { tenant: t.tenant }), name: OPERATOR.name, trace: [] });
    res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/`);
    res.json({ salon: 'Копейка', name: OPERATOR.name });
  });
  app.get('/logout', (req, res) => { sessions.delete(sidOf(req)); res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/'); res.redirect('/'); });
  const auth = (req, res, next) => { const s = sessions.get(sidOf(req)); if (!s) return res.status(401).json({ error: 'нужен вход' }); req.s = s; next(); };
  app.get('/api/me', auth, (req, res) => res.json({ salon: 'Копейка', name: req.s.name }));

  app.get('/api/wallets', auth, async (req, res) => {
    const db = req.s.db;
    const wallets = await db.Wallet().sort('data.number').rows();
    const movements = await db.Movement().sort('at', 'desc').limit(12).rows();
    const statements = await db.Statement().rows().catch(() => []);
    const number = new Map(wallets.map((w) => [w.id, w.data.number]));
    res.json({
      wallets: wallets.map((w) => ({ id: w.id, number: w.data.number, owner: w.data.owner, balance: w.data.balance })),
      movements: movements.map((m) => ({ id: m.id, wallet: number.get(m.links.Wallet), opId: m.data.opId, kind: m.data.kind, amount: m.data.amount, card4: m.data.card4 ?? '', at: String(m.at).slice(11, 19) })),
      statements: statements.map((s) => ({ wallet: number.get(s.links.Wallet), month: s.data.month, topup: s.data.topup, debit: s.data.debit, count: s.data.count })),
    });
  });
  app.post('/api/topup', auth, async (req, res) => {
    const { wallet, amount, card, opId, lose } = req.body ?? {};
    if (!luhn(card)) return res.status(422).json({ error: 'Номер карты не прошёл проверку (алгоритм Луна)' });
    try {
      const result = await act(req.s, `Пополнение ${opId}`, (lines) => operate(req.s.db, wallet, { opId, kind: 'topup', amount: Number(amount), card4: String(card).replace(/\D/g, '').slice(-4) }, lines));
      // режим «потерять ответ»: операция проведена, но клиент ответа не получает — и повторяет её с тем же opId
      if (lose) return res.status(504).json({ error: 'Ответ потерян (имитация сбоя сети) — повторите операцию', lost: true });
      res.json({ result });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/debit', auth, async (req, res) => {
    const { wallet, amount, opId } = req.body ?? {};
    try { res.json({ result: await act(req.s, `Списание ${opId}`, (lines) => operate(req.s.db, wallet, { opId, kind: 'debit', amount: -Number(amount) }, lines)) }); }
    catch (e) { fail(res, e); }
  });
  app.post('/api/transfer', auth, async (req, res) => {
    const { from, to, amount, opId } = req.body ?? {};
    try { res.json({ result: await act(req.s, `Перевод ${opId}`, (lines) => transfer(req.s.db, from, to, Number(amount), opId, lines)) }); }
    catch (e) { fail(res, e); }
  });
  app.get('/api/wallets/:id/history', auth, async (req, res) => {
    const versions = await act(req.s, 'История баланса', () => req.s.db.Wallet(req.params.id).versions());
    res.json(versions.map((v) => ({ rev: v.rev, op: v.op, balance: v.data.balance, reason: v.reason ?? '', at: String(v.at).slice(11, 19) })));
  });
  app.get('/api/trace', auth, (req, res) => res.json(req.s.trace));
  app.get('/api/events', auth, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const sub = req.s.db.watch({ from: 'now', classes: ['Wallet', 'Movement'] });
    req.on('close', () => sub.return?.());
    await sub.ready();
    res.write('event: ready\ndata: {}\n\n');
    try { for await (const ev of sub) res.write(`event: changed\ndata: ${JSON.stringify({ op: ev.op })}\n\n`); } catch { /* клиент ушёл */ }
  });
  const webDist = new URL('../web/dist/', import.meta.url);
  app.use(express.static(fileURLToPath(webDist)));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(fileURLToPath(new URL('index.html', webDist))));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

  return {
    app, schema: r.schema,
    close: async () => { await statement.stop?.(); await follow; await adm.close(); await svc.close(); await admin.end({ timeout: 2 }); },
  };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) {
  const { app, schema } = await createApp();
  app.listen(ENV.port, '0.0.0.0', () => console.log(`wallet: http://127.0.0.1:${ENV.port}/ (схема ${schema})`));
}
