import { up } from 'letopis';
import { example } from '../../kit/example.ts';

// Свой ключ сервиса: lts_ и 32–128 шестнадцатеричных знаков.
const MY_KEY = 'lts_' + '0123456789abcdef'.repeat(2);

export default example({
  title: 'Опции up(): сиды, режим сигналов, свой ключ, история, обновление, установка заново',
  summary:
    'up() настраивает установку опциями. Часть настроек хранится в самой схеме (режим сигналов), поэтому ' +
    'повторный up() без опции их не меняет. fresh ставит схему заново и стирает данные.',
  setup: 'none',
  tables: ['counts'],
  covers: [
    'up.seeds', 'up.signals', 'up.serviceKey', 'up.allowReset', 'up.history', 'up.upgrade', 'up.fresh',
    'up.waitTimeoutMs', 'signals.tenant', 'signals.opaque', 'nuance.signals-mode-sticky', 'nuance.fresh-drops-data',
    'nuance.up-concurrent',
  ],
  steps: [
    {
      title: 'Установка с готовой моделью салона и своими настройками',
      text:
        '`seeds: [\'booking\']` добавляет готовые классы салона (мастера, услуги, брони) — в сводке классов стало ' +
        'больше. `signals` — режим сигналов, `serviceKey` — свой ключ вместо случайного, `allowReset` разрешает ' +
        '`db.reset()`, `history` — политика хранения истории для классов без своей, `waitTimeoutMs` — сколько ждать базу.',
      run: async ({ dsn, schema }) => {
        const r = await up({
          dsn: dsn.admin, schema, quiet: true, waitTimeoutMs: 10_000,
          seeds: ['booking'],
          signals: 'tenant',
          serviceKey: MY_KEY,
          allowReset: true,
          history: { all: '1 day', daily: '1 week', weekly: '1 month', monthly: '1 year', yearly: 'forever', tz: 'Europe/Moscow' },
        });
        return { created: r.created, signals: r.signals, ourKey: r.serviceKey === MY_KEY };
      },
    },
    {
      title: 'Режим сигналов хранится в схеме',
      text: 'Повторный `up()` без опции `signals` режим не трогает — он остался `tenant`.',
      run: async ({ dsn, schema }) => {
        const r = await up({ dsn: dsn.admin, schema, quiet: true });
        return { signals: r.signals };
      },
    },
    {
      title: 'Сменить режим — только явно',
      text:
        'С опцией режим меняется: `opaque` скрывает из сигналов имена классов. После смены режима процессы ' +
        'приложения перезапускают: режим читается при подключении.',
      run: async ({ dsn, schema }) => {
        const r = await up({ dsn: dsn.admin, schema, quiet: true, signals: 'opaque' });
        return { signals: r.signals };
      },
    },
    {
      title: 'upgrade на свежей схеме ничего не делает',
      text:
        '`upgrade: true` нужен, когда новая версия пакета принесла новую ревизию схемы: тогда он применяет миграции — ' +
        'SQL-скрипты, которые обновляют схему. ' +
        'Здесь ревизия уже текущая — миграций нет, `upgraded: false`.',
      run: async ({ dsn, schema }) => {
        const r = await up({ dsn: dsn.admin, schema, quiet: true, upgrade: true });
        return { upgraded: r.upgraded, revision: r.revision, migrations: r.migrations };
      },
    },
    {
      title: 'fresh — поставить заново (данные теряются)',
      text:
        '`fresh: true` удаляет схему и ставит её с нуля. Классы салона исчезли из сводки, потому что `seeds` не указан. ' +
        'Ключ сервиса выдан новый — старый больше не работает.',
      run: async ({ dsn, schema }) => {
        const r = await up({ dsn: dsn.admin, schema, quiet: true, fresh: true });
        return { created: r.created, signals: r.signals, newKey: r.serviceKey !== null && r.serviceKey !== MY_KEY };
      },
    },
    {
      title: 'Три экземпляра сервиса запускают up() одновременно',
      text:
        'Сервис зовёт `up()` при каждом запуске, а экземпляров бывает несколько. Перед шагом схему удалили — база ' +
        'пустая. Накат идёт под блокировкой самой схемы: первый `up()` ставит её (`created: true`), остальные ждут его ' +
        'и делают повторный накат по готовой. Первого арендатора (`tenant`) тоже заводит только один из них — ' +
        'остальные находят его по имени.',
      run: async ({ dsn, schema, admin }) => {
        await admin.unsafe(`drop schema if exists "${schema}" cascade`); // скрыть
        const tenant = { name: 'Ромашка', user: { name: 'Анна', login: 'anna@romashka.ru', password: 'Ромашка-2026!' } };
        const start = () => up({ dsn: dsn.admin, schema, quiet: true, tenant });
        const rs = await Promise.all([start(), start(), start()]);
        return {
          created: rs.filter((r) => r.created).length,
          reinstalled: rs.filter((r) => !r.created).length,
          tenantCreated: rs.filter((r) => r.tenant!.created).length,
          revisions: [...new Set(rs.map((r) => r.revision))],
        };
      },
    },
  ],
});
