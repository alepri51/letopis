import { setup } from 'letopis';
import type { House, Room, SetupResult } from 'letopis';
import { example } from '../_shared/example.ts';
import { mail, postman, lastLetter } from '../_shared/postman.ts';

let r: SetupResult, db: House, anna: Room;

export default example({
  title: 'Дом, консьерж, квартира и первый жилец',
  summary:
    'setup() мастер-ключом строит дом и отдаёт пропуск консьержа. connect(pass, { postman }) — консьерж: он заводит ' +
    'квартиры, зовёт в них жильцов приглашениями (ссылку доставляет почтальон приложения) и впускает по ключам. ' +
    'Цепочки с данными идут только от корня квартиры.',
  setup: 'none',
  tables: ['counts', 'secret'],
  covers: [
    'export.setup', 'setup.quiet', 'export.connect', 'connect.postman', 'house.schema', 'house.createTenant', 'house.in',
    'house.invitation', 'house.accept',
    'house.open', 'house.tenants', 'db.invite', 'db.invites', 'db.tenant', 'db.tenantName', 'db.account', 'db.concierge',
    'error.exists', 'error.auth_failed', 'nuance.setup-idempotent',
  ],
  steps: [
    {
      title: 'Строим дом: setup()',
      text:
        '`setup(ADMIN_DSN, name)` вызывают мастер-ключом — строкой подключения администратора PostgreSQL. Дома нет, ' +
        'поэтому `setup()` строит его целиком: схему `v2.<имя>` с тремя таблицами, системные классы, матрицу прав с ' +
        'правилом по умолчанию и консьержа — роль базы `letopis_c_<имя>` и служебный аккаунт с ключом. Ответ — ' +
        '**пропуск** консьержа `r.pass`: строка подключения его роли, в которой ещё дом и ключ. Пропуск — секрет: его ' +
        'кладут в настройки приложения. Здесь он показан разобранным, без пароля.',
      run: async ({ ADMIN_DSN, name }) => {
        r = await setup(ADMIN_DSN, name, { quiet: true });
        const pass = new URL(r.pass);
        return {
          schema: r.schema, created: r.created, revision: r.revision, warnings: r.warnings,
          'пропуск: роль консьержа': pass.username,
          'пропуск: дом': pass.searchParams.get('letopis_schema'),
          'пропуск: ключ консьержа': `${pass.searchParams.get('letopis_key')!.slice(0, 4)}…`,
        };
      },
    },
    {
      title: 'Повторный setup() — тот же пропуск',
      text:
        'Второй вызов ничего не дублирует: `created: false`, данные на месте (сводка не изменилась), а пропуск — тот же. ' +
        'Поэтому `setup()` можно вызывать при каждом развёртывании: он достраивает дом (новые модели, сиды, правило по ' +
        'умолчанию) и накатывает функции движка. Новый пропуск выдаёт только `setup(…, { rotate: true })`.',
      run: async ({ ADMIN_DSN, name }) => {
        const again = await setup(ADMIN_DSN, name, { quiet: true });
        return { created: again.created, 'тот же пропуск': again.pass === r.pass };
      },
    },
    {
      title: 'Консьерж: connect(pass, { postman })',
      text:
        '`connect(pass, { postman })` — подключение консьержа. Почтальон — функция приложения: консьерж отдаёт ей письма ' +
        'со ссылками-приглашениями и кодами входа, а она отправляет их письмом или СМС. Здесь почтальон — заглушка, ' +
        'письма складываются в ящик `mail`. У консьержа нет шагов классов: `db.Order` — `undefined`, данные читают и ' +
        'пишут только в квартире. Методы консьержа — дверь дома: квартиры (`createTenant`, `tenants`), приглашения и ' +
        'ссылки (`invitation`, `accept`), вход жильцов по ключам и кодам (`open`, `resume`, `requestCode`, `tenantsOf`), ' +
        'работа в квартире (`in`, `as`) и обслуживание (`maintain`, `deleteAccount`).',
      run: async ({ connect }) => {
        db = await connect(r.pass, { postman });
        return { 'дом': db.schema, 'шаг класса Order': 'Order' in db, 'методы консьержа': Object.keys(db) };
      },
    },
    {
      title: 'Квартира: createTenant()',
      text:
        'Квартира — это «чьи данные»: компания, магазин, клуб. `createTenant` заводит пустую квартиру «Ромашка» и её ' +
        'правила: консьержу можно всё, хозяину (роль `owner`) — тоже, включая выдачу любых ролей. Имя квартиры уникально ' +
        'в доме: второй `createTenant` с тем же именем — отказ `exists`. В сводке: +1 аккаунт (квартира), +1 ресурс ' +
        '(группа «роль owner») и +10 правил — консьержу и хозяину по правилу на чтение, запись, удаление, действия API и ' +
        'выдачу ролей.',
      run: async () => {
        const created = await db.createTenant('Ромашка');
        const again = await db.createTenant('Ромашка').then(() => 'создана', (e) => e.code);
        return { 'квартира': created.name, 'второй раз': again };
      },
    },
    {
      title: 'Первый жилец: приглашение и accept()',
      text:
        'Регистрации нет — только приглашения. `db.in(\'Ромашка\')` — консьерж в квартире; `invite` заводит ' +
        'приглашение для `anna@romashka.ru` с ролью `owner` (в `secret` — строка `INVITE` с хэшем токена) и отдаёт ' +
        'почтальону письмо со ссылкой; ответ — только `{ id, expiresAt }`. Анна открывает ссылку: `db.invitation(token)` ' +
        'показывает приглашение, ничего не меняя, а `db.accept(token, { password, name })` — её согласие: аккаунт Анны с ' +
        'этим контактом, прописка в «Ромашке» с ролью `owner`, пароль — ключ от квартиры — и сессия. Ссылка гаснет: тот ' +
        'же токен второй раз — `auth_failed`.',
      run: async () => {
        const romashka = await db.in('Ромашка');
        const sent = await romashka.invite({ email: 'anna@romashka.ru' }, ['owner']);
        const waiting = (await romashka.invites()).map((i) => ({ to: i.to, roles: i.roles }));
        const { token } = lastLetter('anna@romashka.ru', 'invite'); // ссылка из письма
        const seen = await db.invitation(token);
        anna = await db.accept(token, { password: 'Ромашка-2026!', name: 'Анна' });
        const again = await db.accept(token).then(() => 'принято', (e) => e.code);
        return {
          'ответ invite': Object.keys(sent), 'письмо почтальону': { to: mail.at(-1)!.to, kind: mail.at(-1)!.message.kind }, 'ждали приглашения': waiting,
          'по ссылке': { 'квартира': seen.tenantName, 'роли': seen.roles, 'статус': seen.status },
          'квартира Анны': anna.tenantName, 'консьерж?': anna.concierge, 'та же ссылка второй раз': again,
        };
      },
    },
    {
      title: 'Вход по ключу: open()',
      text:
        '`db.open(ключ)` — вход жильца: ключ открывает ровно одну квартиру, и корень открывается сразу в ней. Аккаунт ' +
        'тот же, что завёл `accept`; имя для входа — контакт Анны. Неверный пароль — `auth_failed` («ключ не подошёл»), ' +
        'и так же отвечает неизвестный контакт: по ответу не узнать, есть ли такой аккаунт. Каждый вход — новая сессия ' +
        'в `secret`.',
      run: async () => {
        const me = await db.open({ email: 'anna@romashka.ru', password: 'Ромашка-2026!' });
        const wrong = await db.open({ email: 'anna@romashka.ru', password: 'не тот' }).then(() => 'вошла', (e) => e.code);
        return { 'квартира': me.tenantName, 'тот же аккаунт': me.account === anna.account, 'неверный пароль': wrong };
      },
    },
    {
      title: 'Консьерж в квартире: in() и tenants()',
      text:
        '`db.in(квартира)` — корень консьержа в квартире (по имени или id): полный доступ, для фоновых задач и ' +
        'обслуживания. Жилец так не работает — у него свой корень по ключу. `db.tenants()` — все квартиры дома.',
      run: async () => {
        const romashka = await db.in('Ромашка');
        return {
          'консьерж?': romashka.concierge, 'квартира': romashka.tenantName,
          'та же квартира, что у Анны': romashka.tenant === anna.tenant,
          'квартиры дома': (await db.tenants()).map((t) => t.name),
        };
      },
    },
  ],
});
