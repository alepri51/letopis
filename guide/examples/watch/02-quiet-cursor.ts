import { syncModels } from 'letopis';
import type { Db, Subscription, WatchEvent } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

// показания датчиков: свежие версии хранятся все (ярус all — сутки), старше — по одной в день
const Gauge = hub('Gauge', { name: z.string(), value: z.number() }, { key: ['name'], history: { all: '1 day', daily: 'forever' } });
let adm: Db, sub: Subscription, old: WatchEvent, saved: string;

export default example({
  title: 'Курсор подписки: подписка без событий не устаревает',
  summary:
    'Курсор старше яруса all политики хранения — cursor_expired: события после него могли проредиться. Время курсора ' +
    'подписки sub.cursor — время последнего события, а когда подписка догнала журнал, — время опроса, поэтому подписка, ' +
    'к которой сутки не было событий, работает дальше. Курсор события ev.cursor хранит время самого события: продолжать ' +
    'после перезапуска нужно с sub.cursor.',
  tables: [],
  covers: ['nuance.watch-subscription-cursor'],
  steps: [
    {
      title: 'Класс с политикой хранения и подписка на него',
      text:
        'Ярус `all` — сутки: версии моложе суток хранятся все, старше — `maintain()` прореживает. Подписке с курсором ' +
        'старше яруса продолжать нельзя — `cursor_expired`. Администраторское подключение `adm` понадобится загрузчику.',
      run: async ({ db, connect, dsn, schema, up }) => {
        adm = await connect({ dsn: dsn.admin, schema, token: up.tenant!.token!, allowBypassRls: true });
        await syncModels(adm, [Gauge], { apply: true });
        await db.refresh();
        sub = db.watch({ from: 'now', classes: ['Gauge'], pollMs: 100 });
        await sub.ready();
        return 'подписка ждёт событий';
      },
    },
    {
      title: 'Последнее событие — старше суток',
      text:
        'Чтобы не ждать сутки, событие пишет загрузчик задним числом (`$at` — 1 января 2026 года). Для подписки это то же, ' +
        'что событие, после которого больше суток ничего не происходило.',
      run: async () => {
        await adm.load({ Gauge: [{ name: 'Давление', value: 101, $rev: 1, $at: '2026-01-01T00:00:00Z' }] }, { withHistory: true });
        old = (await sub.next()).value;
        return { op: old.op, 'датчик': old.row.data.name, 'время события': old.at };
      },
    },
    {
      title: 'Новое событие приходит',
      text:
        'Догнав журнал, подписка ставит в свой курсор время опроса, а не время старого события. Поэтому следующее событие ' +
        'приходит, хотя предыдущее старше яруса `all`: прореживать после курсора нечего.',
      run: async ({ db }) => {
        await db.Gauge().create({ name: 'Влажность', value: 40 }).rows();
        const ev = (await sub.next()).value;
        saved = sub.cursor!;
        sub.close();
        return { op: ev.op, 'датчик': ev.row.data.name };
      },
    },
    {
      title: 'Курсор события хранит время события',
      text:
        '`ev.cursor` старого события помнит его время — 1 января. Новая подписка с него получает `cursor_expired`: между ' +
        'этим временем и «сейчас» больше суток, и события могли проредиться.',
      run: async ({ db }) => {
        const again = db.watch({ from: old.cursor, classes: ['Gauge'] });
        try { return await again.next(); } finally { again.close(); }
      },
      expect: { error: 'cursor_expired' },
    },
    {
      title: 'Продолжить с курсора подписки',
      text:
        'Сохранённый `sub.cursor` — позиция после последнего полученного события со свежим временем. Подписка с него ' +
        'получает ровно то, что случилось после, — новое показание.',
      run: async ({ db }) => {
        if (!saved) throw new Error('курсор подписки не сохранён: предыдущий шаг упал'); // скрыть
        await db.Gauge({ name: 'Влажность' }).update({ value: 42 }).rows();
        const again = db.watch({ from: saved, classes: ['Gauge'] });
        try {
          const ev = (await again.next()).value;
          return { op: ev.op, 'датчик': ev.row.data.name, 'значение': ev.row.data.value };
        } finally { again.close(); }
      },
    },
  ],
});
