import { setup, demolish } from 'letopis';
import type { House } from 'letopis';
import { example } from '../_shared/example.ts';

let newPass: string, fresh: House;

export default example({
  title: 'Аварии и конец: новый пропуск и снос дома',
  summary:
    'Пропуск утёк — setup({ rotate: true }) выдаёт новый: старый перестаёт работать сразу, процессы со старым пропуском ' +
    'перезапускают с новым, а жильцы, которые уже вошли, работают дальше. demolish() сносит дом целиком — схему со всеми ' +
    'квартирами и роль консьержа.',
  tables: ['counts'],
  covers: [
    'setup.rotate', 'export.demolish', 'house.resume', 'error.auth_failed', 'error.no_session', 'nuance.pass-same-rotate',
    'nuance.demolish-drops-data',
  ],
  steps: [
    {
      title: 'Новый пропуск: setup({ rotate: true })',
      text:
        '`rotate` выпускает консьержу новый ключ и меняет пароль его роли. Дом и данные не трогаются (`created: false`), ' +
        'а пропуск — новый. Его кладут в настройки приложения вместо прежнего.',
      run: async ({ ADMIN_DSN, name, pass }) => {
        const r = await setup(ADMIN_DSN, name, { rotate: true, quiet: true });
        newPass = r.pass;
        return { created: r.created, 'пропуск новый': r.pass !== pass };
      },
    },
    {
      title: 'Старый пропуск не работает',
      text:
        'Новое подключение по старому пропуску — отказ `auth_failed` (ключ `boot.pass_stale`). Консьерж, подключённый ' +
        'до `rotate`, тоже потерял ключ: квартиры и вход ему больше не доступны — такой процесс перезапускают с новым ' +
        'пропуском. Сессии жильцов не связаны с ключом консьержа: Анна, которая уже вошла, работает дальше.',
      run: async ({ connect, db, me, pass }) => ({
        'connect(старый пропуск)': await connect(pass).then(() => 'подключено', (e) => `${e.code} (${e.key})`),
        'старый консьерж: tenants()': await db.tenants().then(() => 'работает', (e) => e.code),
        'Анна: её квартира': me.tenantName,
        'Анна: её ключи': (await me.keys.list()).map((k) => k.kind),
      }),
    },
    {
      title: 'Новый консьерж: connect(новый пропуск)',
      text:
        'Процесс с новым пропуском — полноценный консьерж: квартиры на месте, а токен Анны (`me.token`, например из ' +
        'cookie) открывает её корень через `resume()`.',
      run: async ({ connect, me }) => {
        fresh = await connect(newPass);
        const anna = await fresh.resume(me.token!);
        return { 'квартиры': (await fresh.tenants()).map((t) => t.name), 'resume(токен Анны)': anna.tenantName };
      },
    },
    {
      title: 'Снести дом: demolish()',
      text:
        'Сначала закрываются консьержи — дому, который сносят, они больше не нужны. `demolish(ADMIN_DSN, имя)` — ' +
        'мастер-ключом: схема дома со всеми квартирами, вещами и журналом и роль консьержа удаляются (`dropped: true`), ' +
        'сводка таблиц пуста. Повтор безопасен — дома уже нет, `dropped: false`. Пропуск снесённого дома не подходит: ' +
        '`auth_failed`.',
      run: async ({ ADMIN_DSN, name, connect, db }) => {
        await db.close();
        await fresh.close();
        const first = await demolish(ADMIN_DSN, name, { quiet: true });
        const again = await demolish(ADMIN_DSN, name, { quiet: true });
        return {
          'первый раз': first, 'второй раз': again,
          'connect(пропуск)': await connect(newPass).then(() => 'подключено', (e) => e.code),
        };
      },
    },
  ],
});
