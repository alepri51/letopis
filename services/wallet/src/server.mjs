/**
 * Сервис-пример «Кошелёк и биллинг» на letopis.
 *
 * - Модель (src/models.mjs) — классы арендатора: при каждом запуске их пишет syncModels администраторского подключения
 *   в сессии оператора, а не сессия пользователя.
 * - Баланс — поле счёта. Операция — один план записи: строка Movement и приращение баланса inc(amount) одной
 *   транзакцией; правило min(0) база проверяет над итогом приращения, уход в минус — invalid_data.
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
 * - Выписка за месяц — обычный запрос на чтение: операции сессии, сведённые по счёту и месяцу (group by под RLS).
 *   Отдельного класса и процесса нет: выписка всегда совпадает с операциями.
 * - Пополнение тестовой картой (проверка Луна); номер карты не хранится — только последние 4 цифры.
 * - Живое обновление (watch → SSE) и панель «Под капотом», как в салоне: цепочки, запросы (onQuery), записанные
 *   версии и сигналы записанных классов.
 */
import express from 'express';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { up, connect, createTenant, syncModels, inc, LetopisError } from 'letopis';
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
/** Окно «без порядка блокировок»: пауза между замками перевода — встречный перевод успевает взять свой первый замок. */
const RACE_MS = 2000;

// ---------- модель (src/models.mjs) ----------
const { Wallet, Movement } = walletModels(model, z);

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
/** Нехватка средств: invalid_data по правилу minimum поля balance (min(0) над итогом inc), а не другая ошибка данных. */
const short = (e) => e instanceof LetopisError && e.code === 'invalid_data'
  && (e.issues ?? e.detail?.issues ?? []).some((i) => i?.path?.at?.(-1) === 'balance' && i.keyword === 'minimum');

export async function createApp() {
  const admin = postgres(ENV.admin, { max: 2, onnotice: () => {} });
  // роль приложения заводит up({ login }): имя и пароль квотирует база, повтор обновляет пароль (план 2.0, 7.6 №7, 7.9 №4)
  const appUrl = new URL(ENV.app);
  const r = await up({ dsn: ENV.admin, schema: ENV.schema, upgrade: true, serviceKey: ENV.serviceKey, quiet: true,
    login: { user: decodeURIComponent(appUrl.username), password: decodeURIComponent(appUrl.password) } });
  // журнал «под капотом»: запросы к базе, записанные версии и сигналы текущего действия
  const trace = await createTrace({ admin, schema: r.schema, size: 12 });
  const svc = await connect({ dsn: ENV.app, schema: r.schema, apiKey: ENV.serviceKey, onQuery: trace.onQuery });
  // сессия createTenant оператора — только на запись модели при запуске (ниже), потом она погашена: срок короткий
  const t = await createTenant(admin, r.schema, { name: 'Копейка', user: { ...OPERATOR, ttl: '10 minutes' } });
  // модель — классы арендатора «Копейка»: при каждом запуске их пишет syncModels администраторского подключения в сессии
  // оператора, сессия пользователя модель не пишет. Не System: классы System syncModels пропускает, а сид установки уже
  // существующий класс не меняет — изменение модели до работающей установки так не дошло бы. Подключение — только на эту
  // запись: потом revoke и close, как syncCompany в helpdesk
  const boot = await connect({ dsn: ENV.admin, schema: r.schema, token: t.token, allowBypassRls: true, listen: false, refreshSession: false });
  try {
    await syncModels(boot, [Wallet, Movement], { apply: true });
  } finally {
    await boot.auth.revoke().catch(() => {});
    await boot.close();
  }
  const opDb = await svc.as(t.user, { tenant: t.tenant });
  if (!(await opDb.Wallet().count())) {
    await opDb.Wallet().create({ number: 'W-1', owner: 'Анна', balance: 0 }).rows();
    await opDb.Wallet().create({ number: 'W-2', owner: 'Борис', balance: 0 }).rows();
  }

  // ---------- операции ----------
  /**
   * Операция — один план записи: строка Movement и приращение баланса её счёта inc(amount), одна транзакция. inc
   * прибавляет внутри UPDATE над заблокированной строкой счёта: параллельные операции не теряются, а min(0) баланса база
   * проверяет над итогом — списание сверх баланса откатывает весь план вместе с Movement. check — подключение для сверки
   * отпечатка повтора (по умолчанию то же, что пишет).
   */
  async function operate(db, wallet, { opId, kind, amount, card4, note }, lines, check = db) {
    const reason = `${kind} ${opId}`;
    lines.push(`db.Wallet(кошелёк).Movement().create({ opId: '${opId}', kind: '${kind}', amount: ${amount} }).Wallet().update({ balance: inc(${amount}) }) — один план, одна транзакция`);
    try {
      await db.Wallet(wallet).Movement().create({ opId, kind, amount, ...(card4 ? { card4 } : {}), ...(note ? { note } : {}) }, { reason })
        .Wallet().update({ balance: inc(amount) }, { reason }).rows();
      lines.push('записаны операция и новый баланс счёта');
      return 'проведено';
    } catch (e) {
      if (short(e)) lines.push('invalid_data — balance: minimum: баланс ушёл бы в минус, план откатился целиком, операции нет');
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
        // каждая операция — Movement и inc баланса своего счёта; min(0) отправителя база проверит над итогом
        await tr.Wallet(from).Movement().create({ opId: `${opId}-out`, kind: 'transfer', amount: -amount })
          .Wallet().update({ balance: inc(-amount) }).rows();
        await tr.Wallet(to).Movement().create({ opId: `${opId}-in`, kind: 'transfer', amount })
          .Wallet().update({ balance: inc(amount) }).rows();
        await tr.commit();
        lines.push(`tr.Wallet(${name(from)}).Movement().create({ amount: −${amount} }).Wallet().update({ balance: inc(−${amount}) }), то же для ${name(to)} с +${amount}; tr.commit()`);
        return 'проведено';
      } catch (e) {
        await tr.rollback().catch(() => {});
        if (e instanceof LetopisError && e.code === 'exists') return 'уже было';
        if (short(e)) lines.push(`invalid_data — balance: minimum: у ${name(from)} не хватает средств; tr.rollback() — ни одной операции`);
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
  // коды ошибок → HTTP: ошибки данных — 422 (нехватка средств, min(0) баланса, — своим текстом), конфликт версии и помехи
  // удалению — 409; text — свой текст
  const fail = (res, e, text) => res.status(e.code === 'invalid_data' ? 422 : e.code === 'conflict' || e.code === 'delete_restricted' ? 409 : 400)
    .json({ error: text ?? (short(e) ? 'Недостаточно средств: баланс не может стать отрицательным' : `${e.code ?? ''} ${e.message}`), code: e.code });
  const S = `"${r.schema.replace(/"/g, '""')}"`;
  /**
   * Выписка по месяцам — обычный запрос на чтение в транзакции сессии (db.transaction): RLS оставляет операции только её
   * арендатора, сводку по счёту и месяцу (group by) считает база. Месяц — по времени записи операции (UTC): операции не
   * правят. Пополнено — приходы (пополнения и входящие переводы), списано — расходы (списания и исходящие переводы).
   */
  const statementOf = (db) => db.transaction((q) => q.unsafe(`select links->>'Wallet' as wallet, to_char(created_at at time zone 'UTC', 'YYYY-MM') as month,
      sum(greatest((data->>'amount')::bigint, 0))::text as topup, sum(greatest(-(data->>'amount')::bigint, 0))::text as debit, count(*)::int as count
    from ${S}.entity where class = 'Movement' group by 1, 2`));

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
    const statements = await statementOf(db);
    const number = new Map(wallets.map((w) => [w.id, w.data.number]));
    res.json({
      // rev — версия счёта: по ней правится владелец ({ rev }); растёт и от операций — баланс тоже поле счёта
      wallets: wallets.map((w) => ({ id: w.id, number: w.data.number, owner: w.data.owner, balance: w.data.balance, rev: w.rev })),
      // at — момент версии целиком (ISO, UTC): местное время показывает браузер, как в «Под капотом»
      movements: movements.map((m) => ({ id: m.id, wallet: number.get(m.links.Wallet), opId: m.data.opId, kind: m.data.kind, amount: m.data.amount, card4: m.data.card4 ?? '', at: m.at })),
      // порядок — месяц (новые сверху), в месяце — номер счёта: номер — поле Wallet, а не операции, поэтому сортировка
      // здесь, а не в запросе
      statements: statements.map((s) => ({ wallet: number.get(s.wallet) ?? '', month: s.month, topup: Number(s.topup), debit: Number(s.debit), count: s.count }))
        .sort((a, b) => String(b.month).localeCompare(String(a.month)) || a.wallet.localeCompare(b.wallet, 'ru', { numeric: true })),
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
    res.json(versions.map((v) => ({ rev: v.rev, op: v.op, balance: v.data.balance, reason: v.reason ?? '', at: v.at })));
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
  app.get('/api/trace', auth, trace.serve);
  app.get('/api/events', auth, eventStream((s) => s.db, ['Wallet', 'Movement']));
  const webDist = new URL('../web/dist/', import.meta.url);
  app.use(express.static(fileURLToPath(webDist)));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(fileURLToPath(new URL('index.html', webDist))));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

  return {
    app, schema: r.schema,
    close: async () => { await svc.close(); await admin.end({ timeout: 2 }); },
  };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) {
  const { app, schema } = await createApp();
  app.listen(ENV.port, ENV.host, () => console.log(`wallet: http://127.0.0.1:${ENV.port}/ (схема ${schema})`));
}
