import { setup } from 'letopis';
import type { SetupResult } from 'letopis';
import { End, hub, normalizeSchema, one, translatePattern } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { postman, inviteAndAccept } from '../_shared/postman.ts';

// Модель, которую дом получит опцией models.
const Shop = hub('Shop', { name: z.string(), city: z.string().optional() }, { key: ['name'] });
let r: SetupResult;

export default example({
  title: 'Опции setup(): сиды, модели, режим сигналов, правило по умолчанию, журнал',
  summary:
    'setup() не только строит дом, но и достраивает его: сиды, модели, режим сигналов, правило по умолчанию. ' +
    'Режим сигналов и правило по умолчанию хранятся в самом доме — повторный setup() без опции их не меняет.',
  setup: 'none',
  tables: ['counts'],
  covers: [
    'setup.seeds', 'setup.signals', 'setup.waitTimeoutMs', 'setup.models', 'setup.defaultRule', 'setup.log',
    'signals.tenant', 'signals.opaque', 'signals.none', 'model.End', 'model.normalizeSchema', 'model.translatePattern',
    'nuance.signals-mode-sticky', 'nuance.default-rule',
  ],
  steps: [
    {
      title: 'Дом с готовой моделью салона и режимом сигналов',
      text:
        '`seeds: [\'booking\']` добавляет готовые классы салона (мастера, услуги, брони) — в сводке классов стало ' +
        'больше. `signals` — режим сигналов, которыми база будит подписки и сбрасывает кэш в процессах приложения ' +
        '(глава «Подписка, кэш, сигналы»). `waitTimeoutMs` — сколько ждать, пока база начнёт принимать подключения. ' +
        'Режим хранится в доме: его показывает запрос мастер-ключом.',
      run: async ({ ADMIN_DSN, name, admin, schema }) => {
        r = await setup(ADMIN_DSN, name, { seeds: ['booking'], signals: 'tenant', waitTimeoutMs: 10_000, quiet: true });
        const [{ mode }] = await admin.unsafe(`select "${schema}".signal_mode() as mode`);
        return { created: r.created, 'режим сигналов': mode };
      },
    },
    {
      title: 'Режим сигналов хранится в доме',
      text: 'Повторный `setup()` без опции `signals` режим не трогает — он остался `tenant`.',
      run: async ({ ADMIN_DSN, name, admin, schema }) => {
        await setup(ADMIN_DSN, name, { quiet: true });
        const [{ mode }] = await admin.unsafe(`select "${schema}".signal_mode() as mode`);
        return { 'режим сигналов': mode };
      },
    },
    {
      title: 'Сменить режим — только явно',
      text:
        '`opaque` скрывает из сигналов имена классов и квартир, `none` выключает сигналы совсем — для пула в режиме ' +
        'транзакций (PgBouncer), где база не может их доставить: подписки тогда опрашивают журнал, а кэш работает только ' +
        'по сроку. После смены режима процессы приложения перезапускают: режим читается при подключении.',
      run: async ({ ADMIN_DSN, name, admin, schema }) => {
        const mode = async () => (await admin.unsafe(`select "${schema}".signal_mode() as mode`))[0].mode;
        await setup(ADMIN_DSN, name, { signals: 'opaque', quiet: true });
        const opaque = await mode();
        await setup(ADMIN_DSN, name, { signals: 'none', quiet: true });
        return { opaque, none: await mode() };
      },
    },
    {
      title: 'Правило по умолчанию: defaultRule',
      text:
        'Правило по умолчанию решает, когда ни одно правило матрицы не подошло: на свежем доме — запрет. Гость ' +
        '«Ромашки» прописан с ролью `guest`, правил для неё нет, поэтому действие `reports.daily` ему запрещено. ' +
        '`setup({ defaultRule: \'allow\' })` разрешает всё, что не решили другие правила, `\'deny\'` возвращает запрет. ' +
        'Правилом матрицы правило по умолчанию не изменить и не удалить — только мастер-ключом.',
      run: async ({ ADMIN_DSN, name, connect }) => {
        const db = await connect(r.pass, { postman });
        await db.createTenant('Ромашка');
        const guest = await inviteAndAccept(db, await db.in('Ромашка'), { email: 'guest@romashka.ru' }, ['guest'], { name: 'Гость' });
        const decide = async () => (await guest.acl.check('reports.daily')).allow;
        const fresh = await decide();
        await setup(ADMIN_DSN, name, { defaultRule: 'allow', quiet: true });
        const opened = await decide();
        await setup(ADMIN_DSN, name, { defaultRule: 'deny', quiet: true });
        return { 'свежий дом': fresh, "defaultRule: 'allow'": opened, "defaultRule: 'deny'": await decide() };
      },
    },
    {
      title: 'Модели дома: models',
      text:
        '`models` — модели `letopis/model`: `setup()` записывает их классами дома, общими для всех квартир, и ' +
        'возвращает итог в `r.models` (что создано, изменено, осталось как было). Повтор с той же моделью ничего не ' +
        'меняет.',
      run: async ({ ADMIN_DSN, name }) => {
        const first = await setup(ADMIN_DSN, name, { models: [Shop], quiet: true });
        const again = await setup(ADMIN_DSN, name, { models: [Shop], quiet: true });
        return { 'первый раз': first.models!.created, 'повтор': again.models!.unchanged };
      },
    },
    {
      title: 'Помощники letopis/model',
      text:
        '`one(…)` и `many(…)` — концы (`End`); `normalizeSchema` приводит JSON Schema к виду, который понимает база; ' +
        '`translatePattern` переводит регулярное выражение в синтаксис jsonpath.',
      run: async () => ({
        'one(Shop) — End': one(Shop) instanceof End,
        'normalizeSchema': normalizeSchema({ type: 'object', properties: { n: { type: 'integer', minimum: 1 } } }),
        'translatePattern': translatePattern('^\\d{3}$'),
      }),
    },
    {
      title: 'Журнал setup(): log',
      text:
        '`log` — логгер (функция, pino или `console`): `setup()` отдаёт ему событие `setup` с итогом, а ход работы — ' +
        'событиями `setup.step` вместо печати в консоль. `logLevel` — порог, `redact` — свои поля для маскировки ' +
        '(глава «Логирование»).',
      run: async ({ ADMIN_DSN, name }) => {
        const events: string[] = [];
        await setup(ADMIN_DSN, name, { log: (e) => void events.push(`${e.event}${e.msg ? `: ${e.msg}` : ''}`) });
        return events;
      },
    },
    {
      title: 'Опечатка в опции и неверное имя дома',
      text:
        'Неизвестную опцию `setup()` отклоняет до подключения к базе — `invalid_data` с похожими именами. Имя дома — ' +
        'латинские строчные буквы, цифры и подчёркивание, до 41 знака: из него получаются схема `v2.<имя>` и роль ' +
        'консьержа. Правило по умолчанию — только `deny` или `allow`.',
      run: async ({ ADMIN_DSN, name }) => {
        const why = (e: Error) => e.message;
        return {
          'seed вместо seeds': await setup(ADMIN_DSN, name, { seed: ['booking'] } as never).then(() => 'построен', why),
          'имя «Мой дом»': await setup(ADMIN_DSN, 'Мой дом').then(() => 'построен', why),
          "defaultRule: 'maybe'": await setup(ADMIN_DSN, name, { defaultRule: 'maybe' } as never).then(() => 'построен', why),
        };
      },
    },
  ],
});
