import type { Db } from 'letopis';
import { example } from '../_shared/example.ts';

let adm: Db;

export default example({
  title: 'Обслуживание: maintain() убирает погашенные сессии и коды',
  summary:
    'Сессии и одноразовые коды живут в таблице secret. Истёкшие и погашенные строки убирает maintain(): его вызывает ' +
    'планировщик (letopis maintain) или сама библиотека — connect({ maintain: \'1h\' }). Журнал maintain() не трогает.',
  tables: ['counts'],
  covers: ['db.maintain'],
  steps: [
    {
      title: 'Сессии и коды копятся в secret',
      text:
        'Анна входит паролем и выходит (`auth.revoke()`) — сессия погашена. Потом сервис присылает ей одноразовый код, ' +
        'и она входит по нему — код использован. Обе строки остаются в `secret`, пока их не уберёт обслуживание.',
      run: async ({ svc, connect, dsn, schema, user }) => {
        const login = await svc.auth.verifyPassword({ identifier: user.login, password: user.password });
        const anna = await connect({ dsn: dsn.app, schema, token: login!.token });
        await anna.auth.revoke();
        const { code } = await svc.auth.issueOtp({ account: login!.account, identifier: user.login });
        const byCode = await svc.auth.verifyOtp({ identifier: user.login, code });
        return { 'выход паролем': 'сессия погашена', 'вход по коду': byCode ? 'код использован' : 'не вошла' };
      },
    },
    {
      title: 'maintain() убирает лишнее',
      text:
        'Отчёт: `sessions` — удалено сессий (истёкших и погашенных), `codes` — кодов (истёкших, использованных, заменённых ' +
        'новым, исчерпавших попытки), `queue` — заполнение очереди сигналов PostgreSQL (больше половины — предупреждение), ' +
        '`skipped` — обслуживание уже идёт в другом процессе. Ещё `maintain()` удаляет строки-замки удалённых классов. ' +
        'Вызывает его системный администратор, роль с правом `letopis.maintain` или администраторское подключение.',
      run: async ({ connect, dsn, schema, up }) => {
        adm = await connect({ dsn: dsn.admin, schema, token: up.tenant!.token!, allowBypassRls: true });
        return adm.maintain();
      },
    },
    {
      title: 'Повторный вызов — убирать нечего',
      text: 'Обслуживание — одна транзакция под блокировкой обслуживания: из нескольких процессов работает один, остальные получают `skipped: true`.',
      run: async () => adm.maintain(),
    },
  ],
});
