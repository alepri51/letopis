import { syncModels } from 'letopis';
import type { Db, ProjectorChange, ProjectorOut } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

const Sale = hub('Sale', { day: z.string(), amount: z.number().int() }, {});
// витрина: карточка на каждую продажу, ключ — id продажи
const SaleCard = hub('SaleCard', { sale: z.string(), day: z.string(), amount: z.number().int(), size: z.string() }, {
  key: ['sale'], derivedBy: 'cards', history: false,
});
let adm: Db, small: { id: string };
// карточка продажи заменяется целиком: правка продажи — новая карточка, удаление — карточки нет
const handle = (changes: ProjectorChange[], out: ProjectorOut) => {
  for (const c of changes) {
    if (c.row.$deleted) out.delete('SaleCard', { sale: c.id }, { tenant: c.tenant });
    else {
      const amount = Number(c.row.data.amount);
      out.upsert('SaleCard', { sale: c.id, day: String(c.row.data.day), amount, size: amount >= 200 ? 'крупная' : 'обычная' }, { tenant: c.tenant });
    }
  }
};
const cards = (db: Db) => db.SaleCard().sort('data.amount').rows().then((rows) => rows.map((r) => `${r.data.amount} — ${r.data.size}`));

export default example({
  title: 'Проектор как процесс: run() в фоне, stop(), close(), out.upsert и служебные методы',
  summary:
    'run() без once не завершается сам: догоняет журнал и ждёт новых изменений, пока его не остановят. stop() ' +
    'завершает работу — промис run() выполняется с отчётом; close() отключает проектор от сигналов базы. ' +
    'out.upsert заменяет строку результата целиком. intoOf, keyOf и foldKey — служебные методы, на которых работает out.',
  tables: ['entity'],
  classes: ['Sale', 'SaleCard'],
  covers: ['nuance.projector-run-stop', 'error.projector_busy'],
  steps: [
    {
      title: 'Витрина продаж: карточка на каждую продажу',
      text:
        'Проектор `cards` пишет на каждую продажу карточку — `out.upsert` с ключом `sale` (id продажи). Первый ' +
        '`run({ once: true })` строит витрину по уже записанным продажам, следующий — догоняет журнал.',
      run: async ({ db, connect, dsn, schema, up }) => {
        adm = await connect({ dsn: dsn.admin, schema, token: up.tenant!.token!, allowBypassRls: true });
        await syncModels(adm, [Sale, SaleCard], { apply: true });
        await db.refresh();
        const p = adm.projector('cards', { from: ['Sale'], into: ['SaleCard'], version: 1, handle });
        [small] = await db.Sale().create({ day: '2026-10-30', amount: 100 }).rows();
        await p.run({ once: true });
        await db.Sale().create({ day: '2026-10-30', amount: 250 }).rows();
        const report = await p.run({ once: true });
        p.close();
        return { 'изменений во втором проходе': report.changes, 'карточки': await cards(db) };
      },
    },
    {
      title: 'run() в фоне подхватывает правку, stop() его завершает',
      text:
        '`run()` без `once` работает, пока его не остановят: правка продажи будит проектор сигналом, и `out.upsert` ' +
        'заменяет карточку целиком — без нового вызова. Ждём, пока это случится, и вызываем `stop()`: промис `run()` ' +
        'выполняется с отчётом. `close()` отключает проектор от сигналов — процесс, который больше не запускает `run()`, ' +
        'должен его вызвать.',
      run: async ({ db }) => {
        const p = adm.projector('cards', { from: ['Sale'], into: ['SaleCard'], version: 1, handle });
        const running = p.run();
        await db.Sale(small).update({ amount: 300 }).rows();
        // ждём результат проектора, а не время: читаем витрину, пока карточка не изменится (не дольше 10 с)
        for (let i = 0; i < 200 && !(await cards(db)).includes('300 — крупная'); i++) await new Promise((r) => setTimeout(r, 50));
        p.stop();
        const report = await running;
        p.close();
        return { 'карточки': await cards(db), 'изменений за работу run()': report.changes, 'карточек заменено': report.updated };
      },
    },
    {
      title: 'Служебные методы: имя, классы результата, ключ',
      text:
        '`name` — имя проектора, оно же стоит в `derivedBy` его классов. `intoOf(арендатор, класс)` — пишет ли проектор ' +
        'в этот класс, `keyOf` — поля ключа класса результата, `foldKey` — ключ, по которому `out.inc` складывает ' +
        'приращения одной строки (у строки не только с полями ключа — `null`). Ответы опираются на классы, которые ' +
        'проектор прочёл при последнем `run()`, `rebuild()` или `status()`: у нового проектора до них `intoOf` — `false`.',
      run: async ({ up }) => {
        const t = up.tenant!.tenant;
        const p = adm.projector('cards', { from: ['Sale'], into: ['SaleCard'], version: 1, handle });
        const before = p.intoOf(t, 'SaleCard');
        const state = (await p.status()).state;
        const r = {
          name: p.name, 'состояние': state, 'intoOf до status()': before,
          'intoOf SaleCard / Sale': [p.intoOf(t, 'SaleCard'), p.intoOf(t, 'Sale')],
          'keyOf SaleCard': p.keyOf(t, 'SaleCard'),
          'foldKey { sale }': p.foldKey(t, 'SaleCard', { sale: small.id }),
          'foldKey { sale, amount }': p.foldKey(t, 'SaleCard', { sale: small.id, amount: 1 }),
        };
        p.close();
        return r;
      },
    },
    {
      title: 'Перестройка во время прохода — projector_busy',
      text:
        'Пачку проектора пишет один процесс: проход держит замок проектора, пока его `handle` не закончит работу. ' +
        'Здесь `handle` первого процесса ждёт, а второй в это время вызывает `rebuild()` — и сразу получает ' +
        '`projector_busy`. Что делать — дождаться конца прохода и повторить.',
      run: async ({ db }) => {
        let entered!: () => void, release!: () => void;
        const inside = new Promise<void>((r) => { entered = r; });
        const gate = new Promise<void>((r) => { release = r; });
        const slow = adm.projector('cards', { from: ['Sale'], into: ['SaleCard'], version: 1, handle: async (changes, out) => {
          entered();
          await gate; // проход стоит внутри handle — замок проектора занят
          handle(changes, out);
        } });
        await db.Sale().create({ day: '2026-10-30', amount: 50 }).rows();
        const pass = slow.run({ once: true });
        await inside;
        try {
          return await adm.projector('cards', { from: ['Sale'], into: ['SaleCard'], version: 1, handle }).rebuild();
        } finally {
          release();
          await pass;
          slow.close();
        }
      },
      expect: { error: 'projector_busy' },
    },
  ],
});
