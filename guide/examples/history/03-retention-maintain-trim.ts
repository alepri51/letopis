import { up, syncModels } from 'letopis';
import type { Db } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

// ярусы: свежее — всё, дальше — по одной версии на день, неделю, месяц; старше года — удаляется
const Gauge = hub('Gauge', { name: z.string(), value: z.number() }, {
  key: ['name'], history: { all: '1 day', daily: '1 week', weekly: '1 month', monthly: '1 year' },
});
let adm: Db, gauge: string;
const revs = async () => (await adm.Gauge(gauge).versions()).map((v) => `v${v.rev} ${v.at.slice(0, 10)}${v.op === 'update' ? '' : ` ${v.op}`}`);

export default example({
  title: 'Хранение истории по ярусам: maintain, trimHistory, cursor_expired',
  summary:
    'Политика history класса говорит, сколько версий хранить: свежие — все, старые — по одной на день, неделю, ' +
    'месяц. Прореживает их maintain(). trimHistory вручную обрезает историю до заданной даты. Подписка с курсором старше ' +
    'яруса all получает cursor_expired.',
  setup: 'none',
  tables: [],
  covers: ['class.history', 'db.maintain', 'maintain.now', 'maintain.batches', 'maintain.limit', 'db.trimHistory', 'error.cursor_expired',
    'load.withHistory', 'up.allowReset', 'nuance.thinning-not-gap'],
  steps: [
    {
      title: 'Установка с allowReset и класс с политикой',
      text: '`maintain({ now })` — «как будто сейчас другое время» — работает только в установке с `allowReset`: это стенд, а не рабочая установка.',
      run: async ({ schema, dsn, connect }) => {
        const r = await up({ dsn: dsn.admin, schema, fresh: true, quiet: true, allowReset: true, tenant: { name: 'Ромашка', user: { name: 'Анна', login: 'anna@romashka.ru', password: 'Ромашка-2026!' } } });
        adm = await connect({ dsn: dsn.admin, schema: r.schema, token: r.tenant!.token!, allowBypassRls: true });
        await syncModels(adm, [Gauge], { apply: true });
        await adm.refresh();
        return adm.registry.resolve('Gauge').history;
      },
    },
    {
      title: 'Архив показаний: 90 дней по версии в день и три правки в последний день',
      text: '`db.load(…, { withHistory: true })` пишет готовые версии с их временем (`$rev`, `$at`) — так переносят архив.',
      run: async () => {
        const day = (n: number) => new Date(Date.UTC(2025, 0, 1) + n * 86_400_000);
        const rows = Array.from({ length: 90 }, (_, i) => ({ name: 'Давление', value: 100 + i, $rev: i + 1, $at: day(i).toISOString() }));
        for (let k = 1; k <= 3; k++) rows.push({ name: 'Давление', value: 200 + k, $rev: 90 + k, $at: new Date(day(89).getTime() + k * 3600_000).toISOString() });
        const report = await adm.load({ Gauge: rows }, { withHistory: true });
        gauge = (await adm.Gauge({ name: 'Давление' }).first())!.id;
        return { 'строк на входе': report.rows, 'объектов': report.loaded, 'версий у объекта': (await revs()).length };
      },
    },
    {
      title: 'Прореживание «на следующий день» после архива',
      text:
        'За последние сутки (`all`) остаются все версии, за неделю — последняя за каждый день, за месяц — за каждую ' +
        'неделю, за год — за каждый месяц. Первая и текущая версии остаются всегда.',
      run: async () => {
        const report = await adm.maintain({ now: '2025-04-01T12:00:00Z', batches: 10, limit: 1000 });
        return { 'удалено версий': report.thinned, 'осталось': await revs() };
      },
    },
    {
      title: 'Прореживание — не разрыв',
      text: '`verify()` знает политику хранения: пропуски в номерах версий старше яруса `all` для него допустимы.',
      run: async () => adm.verify(),
    },
    {
      title: 'Обрезать историю до даты',
      text: '`trimHistory(цель, до)` стирает версии старше даты (текущая остаётся); на место версии 1 встаёт запись `trim`.',
      run: async () => ({ 'стёрто': await adm.trimHistory(gauge, '2025-03-25T00:00:00Z'), 'осталось': await revs() }),
    },
    {
      title: 'Подписка с курсором старше яруса all',
      text: 'Курсор помнит время события. Если оно старше срока `all`, продолжить нельзя: часть событий уже прорежена — надо перечитать состояние.',
      run: async () => {
        const first = adm.watch({ from: 'start', classes: ['Gauge'] });
        const cursor = (await first.next()).value.cursor;
        await first.close();
        const again = adm.watch({ from: cursor, classes: ['Gauge'] });
        try { return await again.next(); } finally { await again.close(); }
      },
      expect: { error: 'cursor_expired' },
    },
  ],
});
