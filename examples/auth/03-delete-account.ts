import { createTenant } from 'letopis';
import type { Db, TenantResult } from 'letopis';
import { example } from '../_shared/example.ts';

let adm: Db, root: Db, lutik: Db, system: string, boris: TenantResult;

export default example({
  title: 'Удалить аккаунт: способы входа стёрты, сессии погашены',
  summary:
    'Аккаунт удаляет системный администратор. Вместе со строкой Account из таблицы secret сразу уходят все его ' +
    'строки: пароль, ключи, сессии. Сессии гаснут с сигналом — процессы сбрасывают кэш результатов этих сессий. Аккаунт ' +
    'System удалить нельзя.',
  tables: ['secret'],
  covers: ['nuance.account-delete-secrets'],
  steps: [
    {
      title: 'Системный администратор',
      text:
        'Аккаунтами распоряжается системный администратор — член System с ролью `admin`. Отдельного метода, ' +
        'чтобы назначить его, нет: членство кладёт загрузчик на администраторском подключении `adm` ' +
        '(`connect({ dsn: <DSN администратора базы>, schema, allowBypassRls: true })`). После назначения сервис ' +
        'сессий этому аккаунту не выдаёт, поэтому Анна вошла паролем раньше и с этой сессией переходит в System. ' +
        'Постоянный вход сисадмина — по ключу API, выпущенному до назначения ([«Системный администратор»](#системныи-администратор-назначить-и-воити)).',
      run: async ({ svc, up, user, connect, dsn, schema }) => {
        const ok = await svc.auth.verifyPassword({ identifier: user.login, password: user.password });
        adm = await connect({ dsn: dsn.admin, schema, token: up.tenant!.token!, allowBypassRls: true });
        system = (await adm.Account().rows()).find((a) => a.data.name === 'System')!.id;
        await adm.load({ member: [{ User: up.tenant!.user!, Tenant: system, roles: ['admin'] }] }, { tenant: system });
        root = await connect({ dsn: dsn.app, schema, token: ok!.token });
        await root.auth.switch(system);
        return { 'Анна работает в': root.tenant === system ? 'System' : root.tenant };
      },
    },
    {
      title: 'Борис: пароль, пара «ключ + секрет» и сессия',
      text:
        '`createTenant` заводит Борису компанию «Лютик», пароль и сессию; сервис выдаёт ему пару «ключ + секрет». В ' +
        '`secret` у Бориса три строки. Подключение Бориса читает правила своей компании и кладёт ответ в кэш.',
      run: async ({ svc, admin, schema, connect, dsn }) => {
        boris = await createTenant(admin, schema, { name: 'Лютик', user: { name: 'Борис', login: 'boris@lutik.ru', password: 'Лютик-2026!' } });
        await svc.auth.issueKeySecret({ account: boris.user!, name: 'касса' });
        lutik = await connect({ dsn: dsn.app, schema, token: boris.token!, cache: { ttl: 60 } });
        return { 'правил в кэше': (await lutik.rule().cache().rows()).length, 'кэш': lutik.cache.stats().stores };
      },
    },
    {
      title: 'Удалить аккаунт Бориса',
      text:
        'Строки `secret` Бориса стёрты в том же операторе, что и строка `Account`: таблица `secret` их больше не хранит. ' +
        'Его сессии погашены до удаления, и сигнал об этом сбросил кэш подключения Бориса: тот же запрос с `.cache()` ' +
        'снова идёт в базу и по погашенной сессии ничего не находит. Сервис по токену Бориса получает `null`.',
      run: async ({ admin, schema, svc }) => {
        const shown = await root.Account(boris.user!).delete().rows(); // предпросмотр: что удалится
        await root.Account(boris.user!).delete({ confirm: true, expect: shown }).rows();
        const left = await admin.unsafe(`select kind from "${schema}".secret where account = $1`, [boris.user!]);
        let cached = (await lutik.rule().cache().rows()).length;
        for (let i = 0; i < 50 && cached > 0; i++) { // сигнал приходит после фиксации — подождать его
          await new Promise((r) => setTimeout(r, 100));
          cached = (await lutik.rule().cache().rows()).length;
        }
        return { 'строк Бориса в secret': left.length, 'правил по кэшированному запросу': cached, 'сессия по токену': await svc.auth.session(boris.token!) };
      },
      expect: {
        check: (r) => {
          if (r['строк Бориса в secret'] !== 0) throw new Error('строки secret удалённой учётной записи остались');
          if (r['правил по кэшированному запросу'] !== 0) throw new Error('кэш погашенной сессии не сброшен: сигнал не пришёл');
        },
      },
    },
    {
      title: 'Аккаунт System удалить нельзя',
      text:
        'Аккаунту System принадлежат служебные строки установки в `secret` — ключ прав и сигналов, строки-замки. ' +
        'Удалить его не может никто: `acl_denied`.',
      run: async () => {
        const shown = await root.Account(system).delete().rows();
        return root.Account(system).delete({ confirm: true, expect: shown }).rows();
      },
      expect: { error: 'acl_denied' },
    },
  ],
});
