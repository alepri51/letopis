import { up } from 'letopis';
import type { Db } from 'letopis';
import { example } from '../../kit/example.ts';
import { syncShop } from '../../kit/shop.ts';

let adm: Db, tenant: string;
const TENANT = { name: 'Ромашка', user: { name: 'Анна', login: 'anna@romashka.ru', password: 'Ромашка-2026!' } };

export default example({
  title: 'Сброс: reset({ level }) — сессии, данные арендатора, всё',
  summary:
    'reset — для стендов и тестов: погасить все сессии, стереть данные арендатора или всю установку. ' +
    'Включается только флагом установки allowReset, требует права letopis.reset и подтверждения именем схемы.',
  setup: 'none',
  tables: ['counts'],
  covers: ['db.reset', 'reset.level', 'reset.confirm', 'reset.tenant', 'error.reset_disabled', 'error.confirm_mismatch', 'error.tenant_denied', 'nuance.reset-tenant-memberships'],
  steps: [
    {
      title: 'Установка без allowReset — сброс выключен',
      run: async ({ schema, dsn, connect: track }) => {
        const r = await up({ dsn: dsn.admin, schema, fresh: true, quiet: true, tenant: TENANT });
        tenant = r.tenant!.tenant;
        adm = await track({ dsn: dsn.admin, schema: r.schema, token: r.tenant!.token!, allowBypassRls: true });
        return adm.reset({ level: 'sessions', confirm: r.schema });
      },
      expect: { error: 'reset_disabled' },
    },
    {
      title: 'Накат с allowReset; неверное подтверждение',
      text: 'Флаг — константа установки: его переставляет каждый `up()`. `confirm` — полное имя схемы.',
      run: async ({ schema, dsn }) => {
        await up({ dsn: dsn.admin, schema, quiet: true, allowReset: true });
        return adm.reset({ level: 'sessions', confirm: 'не та схема' });
      },
      expect: { error: 'confirm_mismatch' },
    },
    {
      title: 'Погасить все сессии, кроме текущей',
      run: async ({ schema }) => adm.reset({ level: 'sessions', confirm: schema }),
    },
    {
      title: 'Стереть данные арендатора',
      text: 'Строки и журнал арендатора — пачками; аккаунт, креды и сессии остаются. В журнале — запись `reset`.',
      run: async ({ schema }) => {
        await syncShop(adm);
        await adm.refresh();
        await adm.Shop().create({ name: 'Ромашка' }).rows();
        return adm.reset({ level: 'tenant', tenant, confirm: schema });
      },
    },
    {
      title: 'Сессия в стёртом арендаторе больше не работает',
      text: 'Членства — тоже данные арендатора: `reset` их стёр, и сессия Анны в «Ромашке» получает `tenant_denied`.',
      run: async () => adm.Shop().count(),
      expect: { error: 'tenant_denied' },
    },
    {
      title: 'Стереть всё: классы, данные, креды, сессии',
      text: 'Администраторское подключение без сессии (право — у администраторской роли). Остаётся пустая установка с новым сервисным ключом.',
      run: async ({ schema, dsn, connect: track }) => {
        const root = await track({ dsn: dsn.admin, schema, allowBypassRls: true });
        const res = await root.reset({ level: 'all', confirm: schema });
        return { ...res, serviceKey: res.serviceKey ? 'новый ключ lts_…' : null };
      },
    },
  ],
});
