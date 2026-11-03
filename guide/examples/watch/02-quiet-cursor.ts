import { syncModels } from 'letopis';
import type { Db, Subscription, WatchEvent } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

// показания датчиков
const Gauge = hub('Gauge', { name: z.string(), value: z.number() }, { key: ['name'] });
let adm: Db, sub: Subscription, old: WatchEvent, saved: string;

export default example({
  title: 'Курсор подписки не устаревает',
  summary:
    'Журнал хранит каждую версию, поэтому курсор подписки не устаревает: продолжить можно с любого сохранённого ' +
    'курсора — и через минуту, и через год. sub.cursor — позиция после последнего события, которое отдала подписка, ' +
    'ev.cursor — позиция после этого события.',
  tables: [],
  covers: ['nuance.watch-subscription-cursor', 'load.withHistory', 'db.refresh', 'nuance.registry-refresh'],
  steps: [
    {
      title: 'Новый класс и подписка на него',
      text:
        'Класс записывает администраторское подключение `adm` (оно понадобится и загрузчику). Подключение Анны узнаёт о ' +
        'новом классе по сигналу базы, с небольшой задержкой: описания классов оно держит в памяти (реестр классов). ' +
        'Сразу — `db.refresh()`.',
      run: async ({ db, connect, dsn, schema, up }) => {
        adm = await connect({ dsn: dsn.admin, schema, token: up.tenant!.token!, allowBypassRls: true });
        await syncModels(adm, [Gauge], { apply: true });
        await db.refresh();
        sub = db.watch({ from: 'now', classes: ['Gauge'], pollMs: 100 });
        await sub.ready();
        return { 'класс Gauge в реестре Анны': db.registry.has('Gauge') };
      },
    },
    {
      title: 'Событие годичной давности',
      text:
        'Чтобы не ждать год, событие пишет загрузчик задним числом: `load(…, { withHistory: true })` пишет готовые ' +
        'версии с их номером и временем (`$rev`, `$at`) — так переносят архив. Подписка получает его как обычное событие.',
      run: async () => {
        await adm.load({ Gauge: [{ name: 'Давление', value: 101, $rev: 1, $at: '2025-01-01T00:00:00Z' }] }, { withHistory: true });
        old = (await sub.next()).value;
        return { op: old.op, 'датчик': old.row.data.name, 'время события': old.at };
      },
    },
    {
      title: 'Новое событие приходит',
      run: async ({ db }) => {
        await db.Gauge().create({ name: 'Влажность', value: 40 }).rows();
        const ev = (await sub.next()).value;
        saved = sub.cursor!;
        sub.close();
        return { op: ev.op, 'датчик': ev.row.data.name };
      },
    },
    {
      title: 'Продолжить с курсора старого события',
      text:
        '`ev.cursor` старого события — позиция сразу после него. Новая подписка с него получает следующее событие — ' +
        'влажность: курсору год, а ничего не пропало.',
      run: async ({ db }) => {
        const again = db.watch({ from: old.cursor, classes: ['Gauge'] });
        try {
          const ev = (await again.next()).value;
          return { op: ev.op, 'датчик': ev.row.data.name };
        } finally { again.close(); }
      },
    },
    {
      title: 'Продолжить с курсора подписки',
      text:
        'Сохранённый `sub.cursor` — позиция после последнего события, которое отдала подписка. Подписка с него ' +
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
