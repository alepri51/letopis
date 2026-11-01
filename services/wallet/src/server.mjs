/**
 * Сервис-пример «Кошелёк и биллинг» на letopis.
 *
 * - Модель (src/models.mjs) — классы арендатора: при каждом запуске их пишет syncModels администраторского подключения
 *   в сессии оператора, а не сессия пользователя.
 * - Баланс — агрегат базы: сумма операций Movement (aggregate sum), правило min(0) проверяет база над итогом.
 * - Операция — строка Movement с ключом [Wallet, opId]: повтор после потери ответа база отклоняет (exists),
 *   сервис сверяет «отпечаток» и отвечает «уже было» — деньги не спишутся дважды.
 * - Перевод — db.begin(): блокировки кошельков в порядке id (без взаимных блокировок), две операции, commit. Режим «без
 *   порядка блокировок» ловит настоящую взаимную блокировку встречных переводов: PostgreSQL прерывает один блок (40P01),
 *   повторов внутри db.begin() библиотека не делает — сервис повторяет блок целиком.
 * - Обрыв связи с базой на COMMIT — на деле, через TCP-прокси (src/proxy.mjs): commit_unknown, исход сервис выясняет
 *   повтором той же операции с тем же opId.
 * - Смена владельца — update({ owner }, { rev }) по прочитанной версии счёта: устаревшая версия — conflict, 409.
 * - Счёт с операциями не удаляется: конец Wallet у Movement — restrict (правило по умолчанию), база отвечает
 *   delete_restricted.
 * - Выписка за месяц — производный класс Statement, его пишет проектор statement из журнала операций (lockTimeout,
 *   lockRetries); status() и «перестроить выписку» (rebuild).
 * - Проверка целостности — verify({ data: true }): цепочки хэшей, данные и агрегат balance против суммы операций.
 * - Пополнение тестовой картой (проверка Луна); номер карты не хранится — только последние 4 цифры.
 * - Живое обновление (watch → SSE) и панель «Под капотом», как в салоне: цепочки, запросы (onQuery), записанные
 *   версии и сигналы записанных классов.
 */
import express from 'express';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { up, connect, createTenant, syncModels, LetopisError } from 'letopis';
import * as model from 'letopis/model';
import { z } from 'zod';
import { walletModels } from './models.mjs';
import { commitProxy } from './proxy.mjs';
// общее у четырёх сервисов-примеров: журнал «под капотом», веб-сессии по cookie, подписка → SSE
import { createTrace } from '../../shared/trace.mjs';
import { createSessions } from '../../shared/sessions.mjs';
import { eventStream } from '../../shared/events.mjs';

const ENV = {
  admin: process.env.ADMIN_DSN ?? 'postgres://postgres:guide@127.0.0.1:15440/letopis',
  app: process.env.APP_DSN ?? 'postgres://wallet_app:wallet-app-secret@127.0.0.1:15440/letopis',
  schema: process.env.SCHEMA ?? 'wallet',
  serviceKey: process.env.SERVICE_KEY ?? 'lts_' + 'b2c3d4e5f6a70819'.repeat(2),
  port: Number(process.env.PORT ?? 8082),
  // по умолчанию только эта машина: у демо известный пароль; в контейнере compose задаёт HOST=0.0.0.0
  host: process.env.HOST ?? '127.0.0.1',
};
export const OPERATOR = { name: 'Ольга', login: 'admin@kopeika.ru', password: 'Kopeika-2026!' };
/**
 * Проектор выписки: чужую блокировку строки выписки пачка ждёт не дольше lockTimeout (дольше — откат, проход пропущен,
 * курсор стоит), а после lockRetries таких проходов подряд арендатор выбывает (status().failed, код 55P03) до
 * rebuild({ tenant }). Секунда и три прохода — чтобы сбой было видно за несколько секунд.
 */
export const STATEMENT = { lockTimeout: 1000, lockRetries: 3 };
/** Окно «без порядка блокировок»: пауза между замками перевода — встречный перевод успевает взять свой первый замок. */
const RACE_MS = 2000;

// ---------- модель (src/models.mjs) ----------
const { Wallet, Movement, Statement } = walletModels(model, z);

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function createApp() {
  const admin = postgres(ENV.admin, { max: 2, onnotice: () => {} });
  // роль приложения заводит up({ login }): имя и пароль квотирует база, повтор обновляет пароль (план 2.0, 7.6 №7, 7.9 №4)
  const appUrl = new URL(ENV.app);
  const r = await up({ dsn: ENV.admin, schema: ENV.schema, upgrade: true, serviceKey: ENV.serviceKey, quiet: true,
    login: { user: decodeURIComponent(appUrl.username), password: decodeURIComponent(appUrl.password) } });
  // журнал «под капотом»: запросы к базе, записанные версии и сигналы текущего действия
  const trace = await createTrace({ admin, schema: r.schema, size: 12 });
  const svc = await connect({ dsn: ENV.app, schema: r.schema, apiKey: ENV.serviceKey, onQuery: trace.onQuery });
  const t = await createTenant(admin, r.schema, { name: 'Копейка', user: OPERATOR });
  // администраторское подключение в сессии оператора: модель, проектор выписки, verify
  const adm = await connect({ dsn: ENV.admin, schema: r.schema, token: t.token, allowBypassRls: true });
  // модель — классы арендатора «Копейка»: при каждом запуске их пишет syncModels этого подключения (производный Statement
  // иначе и не записать), сессия пользователя модель не пишет. Не System: классы System syncModels пропускает, а сид
  // установки уже существующий класс не меняет — изменение модели до работающей установки так не дошло бы
  await syncModels(adm, [Wallet, Movement, Statement], { apply: true });
  const opDb = await svc.as(t.user, { tenant: t.tenant });
  if (!(await opDb.Wallet().count())) {
    await opDb.Wallet().create({ number: 'W-1', owner: 'Анна' }).rows();
    await opDb.Wallet().create({ number: 'W-2', owner: 'Борис' }).rows();
  }
  // проектор выписки: месяц × кошелёк — сумма пополнений, списаний и число операций
  const statement = adm.projector('statement', {
    from: ['Movement'], into: ['Statement'], version: 1, withBefore: true, ...STATEMENT,
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
  /** check — подключение для сверки отпечатка повтора (по умолчанию то же, что пишет). */
  async function operate(db, wallet, { opId, kind, amount, card4, note }, lines, check = db) {
    lines.push(`db.Wallet(кошелёк).Movement().create({ opId: '${opId}', kind: '${kind}', amount: ${amount} })`);
    try {
      await db.Wallet(wallet).Movement().create({ opId, kind, amount, ...(card4 ? { card4 } : {}), ...(note ? { note } : {}) }, { reason: `${kind} ${opId}` }).rows();
      lines.push('баланс пересчитала база (агрегат)');
      return 'проведено';
    } catch (e) {
      if (!(e instanceof LetopisError) || e.code !== 'exists') throw e;
      // повтор: тот ли это запрос? отпечаток — вид и сумма уже записанной операции
      const m = await check.Movement(await check.idOf('Movement', { Wallet: wallet, opId })).first();
      lines.push(`exists — операция ${opId} уже записана; сверили отпечаток`);
      if (m && m.data.kind === kind && m.data.amount === amount) return 'уже было';
      throw new LetopisError('conflict', `opId ${opId} уже занят другой операцией`);
    }
  }

  // Обрыв связи с базой на COMMIT — на деле: на одну операцию своё подключение letopis через TCP-прокси (src/proxy.mjs) с
  // одним соединением и токеном сервиса. Прокси взводится, когда реестр арендатора уже прочитан (as()), — рвётся COMMIT
  // самой операции.
  const dbHost = appUrl.hostname === 'localhost' ? '127.0.0.1' : appUrl.hostname;
  /**
   * Операция, у которой связь с базой рвётся на COMMIT: point 'before' — COMMIT до базы не дошёл, 'after' — база его
   * выполнила, а ответа нет. Библиотека отвечает commit_unknown и сама не повторяет; сервис выясняет исход повтором той
   * же операции с тем же opId обычным подключением: «проведено» — в первый раз не записалось, exists («уже было») —
   * записалось. Ответ — итог повтора.
   */
  async function operateCut(s, wallet, op, point, lines) {
    const proxy = await commitProxy(Number(appUrl.port || 5432), dbHost);
    const url = new URL(ENV.app);
    url.hostname = '127.0.0.1';
    url.port = String(proxy.port);
    // COMMIT прокси узнаёт по тексту оператора — без подготовленных запросов; время — строкой, как у пула connect()
    const pool = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {},
      types: { timestamptz: { to: 1184, from: [1184], serialize: (v) => (v instanceof Date ? v.toISOString() : v), parse: (v) => v } } });
    let cut = null;
    let unknown = false;
    try {
      cut = await connect({ sql: pool, schema: r.schema, token: svc.token, listen: false, refreshSession: false });
      const db = await cut.as(s.account, { tenant: t.tenant });
      proxy.arm(point);
      lines.push(point === 'before' ? 'связь с базой — через TCP-прокси: он оборвёт её на COMMIT, не передав COMMIT базе'
        : 'связь с базой — через TCP-прокси: база выполнит COMMIT, а ответ прокси не передаст');
      await operate(db, wallet, op, lines, s.db);
      lines.push('связь не оборвалась — операция проведена с первого раза');
    } catch (e) {
      if (!(e instanceof LetopisError) || e.code !== 'commit_unknown') throw e;
      unknown = true;
      lines.push('commit_unknown — связь оборвалась во время COMMIT: записалась операция или нет, сервис не знает');
    } finally {
      await cut?.close().catch(() => {});
      await pool.end({ timeout: 1 }).catch(() => {});
      await proxy.close();
    }
    if (!unknown) return { result: 'проведено', unknown: null };
    lines.push(`повтор той же операции с тем же opId — обычным подключением:`);
    const result = await operate(s.db, wallet, op, lines);
    if (result === 'уже было') {
      lines.push('исход: COMMIT дошёл до базы — операция записалась с первого раза, повтор ничего не провёл');
      lines.push('сигнал первой попытки не ушёл (ответа на COMMIT не было): вкладки узнают о записи запасным опросом подписки');
    } else {
      lines.push('исход: COMMIT до базы не дошёл — первая попытка откатилась, операцию провёл повтор');
    }
    return { result, unknown: point };
  }

  /**
   * Перевод — явный блок db.begin(): замки обоих кошельков, две операции, commit. Замки — в порядке id: встречные
   * переводы не ждут друг друга по кругу. unordered — без порядка: сначала свой счёт и пауза RACE_MS между замками
   * (встречный перевод успевает взять свой); PostgreSQL находит взаимную блокировку и прерывает один из блоков (40P01).
   * Повторов внутри db.begin() библиотека не делает — сервис повторяет весь блок, до трёх попыток. stats.retries —
   * сколько раз повторил.
   */
  async function transfer(db, from, to, amount, opId, lines, { unordered = false, stats = { retries: 0 } } = {}) {
    const number = new Map((await db.Wallet([from, to]).rows()).map((w) => [w.id, w.data.number]));
    const name = (id) => number.get(id) ?? String(id).slice(0, 8);
    for (let attempt = 1; ; attempt++) {
      const tr = await db.begin({ reason: `transfer ${opId}` });
      let step = ''; // оператор блока, на котором его может прервать взаимная блокировка
      try {
        if (unordered) {
          await tr.lock('wallet', from);
          lines.push(`db.begin(); tr.lock('wallet', ${name(from)}) — без порядка блокировок: сначала свой счёт`);
          if (attempt === 1) {
            lines.push(`пауза ${RACE_MS / 1000} с между замками — встречный перевод успевает взять свой`);
            await sleep(RACE_MS);
          }
          const t0 = Date.now();
          step = `tr.lock('wallet', ${name(to)})`;
          await tr.lock('wallet', to);
          lines.push(`${step} — ждали ${Date.now() - t0} мс`);
          step = '';
        } else {
          // блокировки в порядке id: два встречных перевода не заблокируют друг друга
          const order = [from, to].sort();
          for (const id of order) await tr.lock('wallet', id);
          lines.push(`db.begin(); tr.lock('wallet', …): ${order.map(name).join(', ')} — в порядке id`);
        }
        await tr.Wallet(from).Movement().create({ opId: `${opId}-out`, kind: 'transfer', amount: -amount }).rows();
        await tr.Wallet(to).Movement().create({ opId: `${opId}-in`, kind: 'transfer', amount }).rows();
        await tr.commit();
        lines.push('две операции и commit — баланс обоих пересчитала база');
        return 'проведено';
      } catch (e) {
        await tr.rollback().catch(() => {});
        if (e instanceof LetopisError && e.code === 'exists') return 'уже было';
        // взаимная блокировка: PostgreSQL прервал этот блок, транзакция сломана — весь блок db.begin() заново
        if (e?.code === '40P01' && attempt < 3) {
          stats.retries++;
          lines.push(`40P01${step ? ` на ${step}` : ''} — взаимная блокировка: PostgreSQL прервал этот блок; tr.rollback() и весь блок db.begin() заново (попытка ${attempt + 1})`);
          await sleep(40 * attempt + Math.random() * 40);
          continue;
        }
        throw e;
      }
    }
  }

  // ---------- веб: сессии, журнал «под капотом», API ----------
  const web = createSessions(); // sid → { db, account, name, trace: [] }
  const { auth } = web;
  const { act } = trace;
  // коды ошибок → HTTP: нехватка средств (min(0) баланса) — 422, конфликт версии и помехи удалению — 409; text — свой текст
  const fail = (res, e, text) => res.status(e.code === 'invalid_data' ? 422 : e.code === 'conflict' || e.code === 'delete_restricted' ? 409 : 400)
    .json({ error: text ?? (e.code === 'invalid_data' ? 'Недостаточно средств: баланс не может стать отрицательным' : `${e.code ?? ''} ${e.message}`), code: e.code });
  const S = `"${r.schema.replace(/"/g, '""')}"`;

  const app = express();
  app.use(express.json());
  app.post('/api/login', async (req, res) => {
    const { login: id = '', password = '' } = req.body ?? {};
    const login = await svc.auth.verifyPassword({ identifier: String(id), password: String(password) });
    if (!login || id !== OPERATOR.login) return res.status(401).json({ error: 'Неверный логин или пароль' });
    web.open(res, { db: await svc.as(login.account, { tenant: t.tenant }), account: login.account, name: OPERATOR.name, trace: [] });
    res.json({ company: 'Копейка', name: OPERATOR.name });
  });
  app.get('/logout', async (req, res) => { await web.logout(req, res); res.redirect('/'); });
  // без входа — 200 и null, а не 401: страница входа открывается без ошибки в консоли браузера
  app.get('/api/me', (req, res) => { const s = web.get(req); res.json(s ? { company: 'Копейка', name: s.name } : null); });

  app.get('/api/wallets', auth, async (req, res) => {
    const db = req.s.db;
    const wallets = await db.Wallet().sort('data.number').rows();
    const movements = await db.Movement().sort('at', 'desc').limit(12).rows();
    const statements = await db.Statement().rows().catch(() => []);
    const number = new Map(wallets.map((w) => [w.id, w.data.number]));
    res.json({
      // rev — версия счёта: по ней правится владелец ({ rev }); растёт и от операций — баланс тоже поле счёта
      wallets: wallets.map((w) => ({ id: w.id, number: w.data.number, owner: w.data.owner, balance: w.data.balance, rev: w.rev })),
      movements: movements.map((m) => ({ id: m.id, wallet: number.get(m.links.Wallet), opId: m.data.opId, kind: m.data.kind, amount: m.data.amount, card4: m.data.card4 ?? '', at: String(m.at).slice(11, 19) })),
      statements: statements.map((s) => ({ wallet: number.get(s.links.Wallet), month: s.data.month, topup: s.data.topup, debit: s.data.debit, count: s.data.count })),
    });
  });
  app.post('/api/topup', auth, async (req, res) => {
    const { wallet, amount, card, opId, lose, cut } = req.body ?? {};
    if (!luhn(card)) return res.status(422).json({ error: 'Номер карты не прошёл проверку (алгоритм Луна)' });
    const op = { opId, kind: 'topup', amount: Number(amount), card4: String(card).replace(/\D/g, '').slice(-4) };
    try {
      // обрыв связи с базой на COMMIT (cut: before | after) — commit_unknown, исход выясняет повтор с тем же opId
      const { result, unknown } = cut === 'before' || cut === 'after'
        ? await act(req.s, `Пополнение ${opId} (обрыв ${cut === 'before' ? 'до' : 'после'} COMMIT)`, (lines) => operateCut(req.s, wallet, op, cut, lines))
        : { result: await act(req.s, `Пополнение ${opId}`, (lines) => operate(req.s.db, wallet, op, lines)), unknown: null };
      // открыт горизонт «чужой транзакции» — теперь она берёт строку выписки этого счёта (55P03 проектора)
      await grabStatement(req.s, wallet).catch((e) => console.error('чужая транзакция не взяла строку выписки:', e.message));
      // режим «потерять ответ»: операция проведена, но клиент ответа не получает — и повторяет её с тем же opId
      if (lose) return res.status(504).json({ error: 'Ответ потерян (имитация сбоя сети) — повторите операцию', lost: true });
      res.json({ result, unknown });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/debit', auth, async (req, res) => {
    const { wallet, amount, opId } = req.body ?? {};
    try { res.json({ result: await act(req.s, `Списание ${opId}`, (lines) => operate(req.s.db, wallet, { opId, kind: 'debit', amount: -Number(amount) }, lines)) }); }
    catch (e) { fail(res, e); }
  });
  app.post('/api/transfer', auth, async (req, res) => {
    const { from, to, amount, opId, unordered } = req.body ?? {};
    const stats = { retries: 0 };
    try {
      const result = await act(req.s, `Перевод ${opId}${unordered === true ? ' (без порядка блокировок)' : ''}`,
        (lines) => transfer(req.s.db, from, to, Number(amount), opId, lines, { unordered: unordered === true, stats }));
      res.json({ result, retries: stats.retries });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/wallets/:id/history', auth, async (req, res) => {
    const versions = await act(req.s, 'История баланса', () => req.s.db.Wallet(req.params.id).versions());
    res.json(versions.map((v) => ({ rev: v.rev, op: v.op, balance: v.data.balance, reason: v.reason ?? '', at: String(v.at).slice(11, 19) })));
  });
  // смена владельца по прочитанной версии: счёт успели изменить (другая вкладка или любая операция — баланс тоже поле
  // счёта) — conflict, ничего не записано
  app.post('/api/wallets/:id/owner', auth, async (req, res) => {
    const owner = String(req.body?.owner ?? '').trim();
    const rev = Number(req.body?.rev);
    if (!owner || owner.length > 60) return res.status(422).json({ error: 'Владелец — от 1 до 60 знаков' });
    if (!Number.isInteger(rev) || rev < 1) return res.status(422).json({ error: 'Нужна версия счёта rev — та, что прочитана вместе с ним' });
    try {
      const w = await act(req.s, 'Смена владельца', async (lines) => {
        lines.push(`db.Wallet(счёт).update({ owner: '${owner}' }, { rev: ${rev} }) — правка по прочитанной версии`);
        try {
          const [row] = await req.s.db.Wallet(req.params.id).update({ owner }, { rev, reason: 'смена владельца' }).rows();
          lines.push(`записано: версия ${row.rev}`);
          return row;
        } catch (e) {
          if (e instanceof LetopisError && e.code === 'conflict') lines.push(`conflict — счёт уже в версии ${e.detail?.rev}, а правили версию ${rev}: ничего не записано`);
          throw e;
        }
      });
      res.json({ rev: w.rev, owner: w.data.owner });
    } catch (e) {
      fail(res, e, e.code === 'conflict' ? `Счёт уже изменён: вы правили версию ${rev}, а сейчас — ${e.detail?.rev}. Перечитайте и повторите` : undefined);
    }
  });
  // удаление счёта: конец Wallet у Movement — restrict (правило по умолчанию), счёт с операциями база не удалит
  app.post('/api/wallets/:id/delete', auth, async (req, res) => {
    let blockers = 0;
    try {
      await act(req.s, 'Удаление счёта', async (lines) => {
        lines.push('db.Wallet(счёт).delete({ confirm: true }) — конец Wallet у Movement: restrict (по умолчанию)');
        try {
          await req.s.db.Wallet(req.params.id).delete({ confirm: true, reason: 'закрытие счёта' }).rows();
          lines.push('счёт удалён: операций у него не было');
        } catch (e) {
          if (!(e instanceof LetopisError) || e.code !== 'delete_restricted') throw e;
          blockers = (e.detail?.rows?.length ?? 0) + (e.detail?.others ?? 0);
          lines.push(`delete_restricted — на счёт ссылаются операции: ${blockers}; ничего не удалено`);
          throw e;
        }
      });
      res.json({ ok: true });
    } catch (e) {
      fail(res, e, e.code === 'delete_restricted'
        ? `Счёт с операциями удалить нельзя: на него ссылаются операции (${blockers}), связь Movement → Wallet — restrict. Операцию не удаляют, а отменяют встречной`
        : undefined);
    }
  });
  // проверка целостности (администраторское подключение): цепочки хэшей журнала, а с { data: true } — данные, концы,
  // арендаторы, владельцы, id и агрегаты: balance каждого счёта против суммы его операций
  app.get('/api/admin/verify', auth, async (req, res) => {
    try {
      const v = await act(req.s, 'Проверка целостности', async (lines) => {
        lines.push('adm.verify({ data: true }) — цепочки хэшей журнала, данные против описаний классов, balance против суммы операций');
        return adm.verify({ data: true });
      });
      const [{ n }] = await admin.unsafe(`select count(*)::int as n from ${S}.log`);
      const issues = v.issues.slice(0, 50);
      // подпись строки — номер счёта, ключ операции или месяц выписки из последней версии в журнале
      const label = new Map((await admin.unsafe(`select distinct on (id) id::text as id, coalesce(data->>'number', data->>'opId', data->>'month', '') as l
        from ${S}.log where id = any ($1::uuid[]) order by id, rev desc`, [[...new Set(issues.map((i) => i.id))]])).map((x) => [x.id, x.l]));
      res.json({ ok: v.ok, checked: n, anchor: v.anchor, issues: issues.map((i) => ({ id: i.id, rev: i.rev ?? null, class: i.class ?? '', problem: i.problem, label: label.get(i.id) || i.id.slice(0, 8) })) });
    } catch (e) { fail(res, e); }
  });
  // ---------- порча журнала в обход библиотеки — чтобы verify было что найти ----------
  // «Испортить запись журнала» меняет баланс в промежуточной версии счёта прямым UPDATE от суперпользователя, как правка
  // руками в SQL: хэш этой версии больше не сходится с цепочкой. «Вернуть как было» возвращает данные байт в байт.
  // Подделать сам баланс в entity так нельзя: триггеры entity включены и в режиме репликации (enable always), без
  // сессии они отказывают, а с ней — пишут версию и пересчитывают агрегат.
  let damaged = null; // { id, rev, data } — испорченная версия журнала
  app.post('/api/admin/corrupt', auth, async (req, res) => {
    if (damaged) return res.status(409).json({ error: 'Одна запись уже испорчена — сначала верните её' });
    try {
      const out = await act(req.s, 'Порча записи журнала', async (lines) => {
        // версия счёта, за которой есть следующая: её хэш входит в цепочку
        const [row] = await admin.unsafe(`select l.id, l.rev, l.data from ${S}.log l where l.tenant = $1 and l.class = 'Wallet' and l.op = 'update'
          and exists (select 1 from ${S}.log n where n.id = l.id and n.rev > l.rev) order by l.data->>'number', l.rev desc limit 1`, [t.tenant]);
        if (!row) return null;
        lines.push(`update log set data = jsonb_set(data, '{balance}', баланс + 1000 ₽) where id = счёт ${row.data.number} and rev = ${row.rev} — в обход библиотеки, от суперпользователя`);
        await admin.unsafe(`update ${S}.log set data = jsonb_set(data, '{balance}', to_jsonb((data->>'balance')::bigint + 100000)) where id = $1 and rev = $2`, [row.id, row.rev]);
        damaged = { id: row.id, rev: row.rev, data: row.data };
        return { label: row.data.number, rev: row.rev };
      });
      if (!out) return res.status(404).json({ error: 'У счетов ещё нет промежуточных версий — проведите две операции' });
      res.json(out);
    } catch (e) { fail(res, e); }
  });
  app.post('/api/admin/repair', auth, async (req, res) => {
    const d = damaged;
    if (!d) return res.status(409).json({ error: 'Испорченной записи нет' });
    try {
      await act(req.s, 'Вернуть запись журнала', async (lines) => {
        lines.push('update log set data = прежние данные версии — её хэш снова сходится с цепочкой');
        await admin.unsafe(`update ${S}.log set data = $3::jsonb where id = $1 and rev = $2`, [d.id, d.rev, d.data]);
      });
      damaged = null;
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ---------- «чужая транзакция» над строкой выписки: 55P03 проектора ----------
  // Проектор читает журнал ниже горизонта — самой старой незавершённой транзакции. Поэтому сначала транзакция-горизонт:
  // пока она открыта, проектор не видит новых операций. Следующее пополнение записывается, затем вторая транзакция
  // берёт строку выписки этого счёта за месяц (for update), а горизонт закрывается: пачка доходит до пополнения и ждёт
  // строку не дольше lockTimeout; после lockRetries таких проходов подряд арендатор выбывает (55P03). Горизонт стоит у
  // подписок и проекторов всех сервисов этой базы, поэтому сервис держит его недолго: горизонт — до пополнения (не
  // дольше 30 с), строку — пока арендатор не выбыл (не дольше 15 с). Подключения — отдельные, администратора: так строку
  // держал бы отчёт или сеанс psql.
  let hold = null; // { stage: 'armed' | 'rows', since, tx, timer, watch }
  /** Открыть транзакцию на своём подключении, выполнить text и держать её до release(). */
  const openTx = async (text, params = []) => {
    const sql = postgres(ENV.admin, { max: 1, onnotice: () => {} });
    let release = () => {};
    let ready;
    let rows = [];
    const opened = new Promise((r) => { ready = r; });
    const done = sql.begin(async (q) => {
      rows = await q.unsafe(text, params);
      await new Promise((r) => { release = r; ready(); });
    }).finally(() => sql.end({ timeout: 2 }));
    done.catch(() => {}); // ошибку получит тот, кто ждёт done; без обработчика оборванная транзакция уронила бы процесс
    await Promise.race([opened, done]);
    return { rows, release: () => release(), done };
  };
  const releaseHold = async () => {
    const h = hold;
    if (!h) return false;
    hold = null;
    clearTimeout(h.timer);
    clearInterval(h.watch);
    h.tx.release();
    await h.tx.done.catch(() => {});
    return true;
  };
  app.post('/api/admin/hold', auth, async (req, res) => {
    if (hold) return res.status(409).json({ error: 'Чужая транзакция уже открыта — отпустите её' });
    try {
      await act(req.s, 'Чужая транзакция: горизонт', async (lines) => {
        lines.push('begin; select pg_current_xact_id() — отдельное подключение администратора: пока транзакция открыта, проектор не видит операций новее неё');
        const tx = await openTx('select pg_current_xact_id()');
        hold = { stage: 'armed', since: Date.now(), tx, timer: setTimeout(() => { releaseHold().catch(() => {}); }, 30_000) };
        lines.push('дальше — пополнение: после него чужая транзакция займёт строку выписки этого счёта за месяц');
      });
      res.json({ stage: 'armed' });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/admin/hold/release', auth, async (_req, res) => {
    try { res.json({ released: await releaseHold() }); } catch (e) { fail(res, e); }
  });
  /** После пополнения при открытом горизонте: вторая транзакция берёт строку выписки, горизонт закрывается. */
  async function grabStatement(s, wallet) {
    const h = hold;
    if (h?.stage !== 'armed') return;
    hold = { ...h, stage: 'grabbing' };
    await act(s, 'Чужая транзакция: строка выписки', async (lines) => {
      const month = new Date().toISOString().slice(0, 7);
      lines.push(`begin; select … from entity where class = 'Statement' and Wallet = счёт and month = '${month}' for update — вторая транзакция берёт строку выписки`);
      const tx = await openTx(`select id from ${S}.entity where class = 'Statement' and tenant = $1 and links->>'Wallet' = $2 and data->>'month' = $3 for update`,
        [t.tenant, wallet, month]).catch(async (e) => { await releaseHold(); throw e; });
      clearTimeout(h.timer);
      h.tx.release();
      await h.tx.done.catch(() => {});
      lines.push('commit горизонта — пачка проектора доходит до пополнения и ждёт строку выписки не дольше lockTimeout');
      if (!tx.rows.length) {
        tx.release();
        await tx.done.catch(() => {});
        hold = null;
        lines.push(`строки выписки за ${month} у счёта ещё нет — проектор её вставит, ждать ему нечего; чужая транзакция закрыта`);
        return;
      }
      const cur = { stage: 'rows', since: Date.now(), tx };
      cur.timer = setTimeout(() => { if (hold === cur) releaseHold().catch(() => {}); }, 15_000);
      // арендатор выбыл — строку больше держать незачем: горизонт отпускается сразу
      cur.watch = setInterval(() => {
        statement.status().then((st) => { if (hold === cur && st.failed[t.tenant]) releaseHold().catch(() => {}); }, () => {});
      }, 250);
      hold = cur;
    });
  }

  // выписка: состояние проектора — status() (выбывший арендатор — только свой), опции; «перестроить» — rebuild
  app.get('/api/statement', auth, async (_req, res) => {
    try {
      const st = await statement.status();
      const f = st.failed[t.tenant];
      res.json({ state: st.state, version: st.version, cursor: st.cursor, at: st.at, lag: Math.round(st.lag), options: STATEMENT,
        failed: f ? { code: f.code, message: f.message.replaceAll(t.tenant, '«Копейка»') } : null,
        hold: hold ? { stage: hold.stage === 'rows' ? 'rows' : 'armed', since: new Date(hold.since).toISOString() } : null });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/statement/rebuild', auth, async (req, res) => {
    try {
      const rep = await act(req.s, 'Перестройка выписки', async (lines) => {
        const one = Boolean((await statement.status()).failed[t.tenant]);
        lines.push(one ? 'statement.rebuild({ tenant }) — арендатор выбыл: его строки Statement построены заново из текущих операций, отметка снята'
          : 'statement.rebuild() — атомарно: строки Statement удалены и построены заново из текущих операций одной транзакцией');
        for (let attempt = 1; ; attempt++) {
          try {
            const rep = await (one ? statement.rebuild({ tenant: t.tenant }) : statement.rebuild());
            lines.push(`перестроено: строк операций ${rep.changes}, строк выписки ${rep.created}`);
            return rep;
          } catch (e) {
            // пачку журнала пишет run() этого же процесса — дождаться её и повторить
            if (e instanceof LetopisError && e.code === 'projector_busy' && attempt < 30) {
              if (attempt === 1) lines.push('projector_busy — пачку пишет run(): ждём её конца');
              await sleep(100);
              continue;
            }
            if (e?.code === '55P03') lines.push(`55P03 — строки выписки держит чужая транзакция дольше lockTimeout (${STATEMENT.lockTimeout} мс)`);
            throw e;
          }
        }
      });
      res.json({ changes: rep.changes, created: rep.created });
    } catch (e) {
      if (e?.code === '55P03') return res.status(409).json({ error: 'Строки выписки держит чужая транзакция — перестройте после её конца', code: e.code });
      fail(res, e);
    }
  });
  app.get('/api/trace', auth, trace.serve);
  app.get('/api/events', auth, eventStream((s) => s.db, ['Wallet', 'Movement']));
  const webDist = new URL('../web/dist/', import.meta.url);
  app.use(express.static(fileURLToPath(webDist)));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(fileURLToPath(new URL('index.html', webDist))));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

  return {
    app, schema: r.schema,
    close: async () => { await releaseHold(); await statement.stop?.(); await follow; await adm.close(); await svc.close(); await admin.end({ timeout: 2 }); },
  };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) {
  const { app, schema } = await createApp();
  app.listen(ENV.port, ENV.host, () => console.log(`wallet: http://127.0.0.1:${ENV.port}/ (схема ${schema})`));
}
