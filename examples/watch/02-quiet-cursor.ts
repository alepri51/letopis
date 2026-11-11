import { setup } from 'letopis';
import type { Subscription, WatchEvent } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { cli } from '../_shared/cli.ts';

// Показания датчиков: имя датчика — ключ.
const Gauge = hub('Gauge', { name: z.string(), value: z.number() }, { key: ['name'] });
let sub: Subscription, first: WatchEvent, saved: string;

export default example({
  title: 'Курсор подписки не устаревает',
  summary:
    'Журнал хранит каждую версию, поэтому курсор подписки не устаревает: продолжить можно с любого сохранённого ' +
    'курсора — после перезапуска процесса, обслуживания дома и сколько угодно времени спустя. sub.cursor — позиция ' +
    'после последнего события, которое отдала подписка, ev.cursor — позиция после этого события.',
  tables: [],
  covers: [
    'db.watch', 'watch.from', 'db.refresh', 'export.setup', 'setup.models', 'cli.maintain',
    'nuance.watch-subscription-cursor', 'nuance.registry-refresh',
  ],
  steps: [
    {
      title: 'Новый класс в доме и подписка на него',
      text:
        'Повторный `setup()` с моделью `Gauge` достраивает дом: класс общий, его видят все квартиры. Корень Анны открыт ' +
        'раньше и держит описания классов в памяти (реестр классов): о новом классе он узнаёт по сигналу базы, с ' +
        'небольшой задержкой, а сразу — после `me.refresh()`. Подписка `from: \'now\'` получит то, что запишут после ' +
        '`await sub.ready()`.',
      run: async ({ ADMIN_DSN, name, me }) => {
        await setup(ADMIN_DSN, name, { models: [Gauge], quiet: true });
        await me.refresh();
        sub = me.watch({ from: 'now', classes: ['Gauge'] });
        await sub.ready();
        return { 'класс Gauge в реестре Анны': me.registry.has('Gauge'), 'курсор подписки задан': sub.cursor !== null };
      },
    },
    {
      title: 'Первое показание',
      text: 'Анна записывает давление — событие приходит в подписку. Его курсор `ev.cursor` запоминаем: вернёмся к нему в конце.',
      run: async ({ me }) => {
        await me.Gauge().create({ name: 'Давление', value: 101 }).rows();
        first = (await sub.next()).value;
        return { op: first.op, 'датчик': first.row.data.name, rev: first.rev };
      },
    },
    {
      title: 'Курсор подписки — после отданного события',
      text:
        'Ещё два показания. Подписка читает журнал пачками и может прочесть оба события сразу, но `sub.cursor` не ' +
        'обгоняет то, что она ещё не отдала: после одного `next()` он равен курсору отданного события. Его и сохраняют, ' +
        'обработав событие. Подписку закрываем — процесс остановлен.',
      run: async ({ me }) => {
        await me.Gauge().create({ name: 'Влажность', value: 40 }).rows();
        await me.Gauge().create({ name: 'Ветер', value: 3 }).rows();
        const ev = (await sub.next()).value;
        saved = sub.cursor!;
        sub.close();
        return { 'отдано': ev.row.data.name, 'sub.cursor совпадает с ev.cursor': saved === ev.cursor };
      },
    },
    {
      title: 'Процесс перезапущен: продолжить с сохранённого курсора',
      text:
        'Пока подписки нет, дом обслужили (`letopis maintain` мастер-ключом: он убирает погашенные сессии и коды, а журнал ' +
        'не трогает) и записали новое давление. Новый процесс — новый консьерж и новый вход Анны; подписка с ' +
        'сохранённого курсора отдаёт ровно то, что ещё не было отдано: показание ветра и правку давления.',
      run: async ({ ADMIN_DSN, name, me, connect, pass, annaKey }) => {
        const service = await cli(['maintain', '--dsn', ADMIN_DSN, '--schema', name]);
        await me.Gauge({ name: 'Давление' }).update({ value: 99 }).rows();
        const db = await connect(pass);
        const anna = await db.open(annaKey);
        const again = anna.watch({ from: saved, classes: ['Gauge'] });
        const got: string[] = [];
        for (let i = 0; i < 2; i++) {
          const ev = (await again.next()).value;
          got.push(`${ev.op} ${ev.row.data.name} = ${ev.row.data.value}`);
        }
        again.close();
        return { 'обслуживание, код выхода': service.code, 'события после курсора': got };
      },
    },
    {
      title: 'Курсор первого события тоже годится',
      text:
        '`ev.cursor` первого показания — позиция сразу после него. Подписка с этого курсора отдаёт всё, что было после: ' +
        'три события, по порядку журнала. Сколько бы времени ни прошло, курсор не устаревает: журнал не прореживается.',
      run: async ({ me }) => {
        const again = me.watch({ from: first.cursor, classes: ['Gauge'] });
        const got: string[] = [];
        for (let i = 0; i < 3; i++) {
          const ev = (await again.next()).value;
          got.push(`${ev.op} ${ev.row.data.name} = ${ev.row.data.value}`);
        }
        again.close();
        return got;
      },
    },
  ],
});
