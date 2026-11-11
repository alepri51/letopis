import { example } from '../_shared/example.ts';
import { cli } from '../_shared/cli.ts';
import { lastLetter } from '../_shared/postman.ts';

/** Строки secret по видам: живые и погашенные (срок вышел или строку погасили). */
const secrets = (schema: string) => `select kind,
    count(*) filter (where deleted_at is null and (expires_at is null or expires_at > clock_timestamp()))::int as live,
    count(*) filter (where deleted_at is not null or expires_at <= clock_timestamp())::int as dead
  from "${schema}".secret where kind in ('SESSION', 'OTP', 'INVITE') group by kind order by kind`;

export default example({
  title: 'Обслуживание: letopis maintain убирает погашенные сессии, коды и истёкшие приглашения',
  summary:
    'Сессии, одноразовые коды и приглашения живут в таблице secret. Истёкшие и погашенные строки убирает обслуживание — ' +
    'команда letopis maintain мастер-ключом, которую ставят во внешний планировщик (cron), или db.maintain() консьержа ' +
    'из самого приложения. Журнал обслуживание не трогает.',
  tables: ['counts'],
  covers: ['cli.maintain', 'house.maintain', 'house.requestCode', 'house.open', 'db.close', 'db.revokeInvite'],
  steps: [
    {
      title: 'Сессии, коды и приглашения копятся в secret',
      text:
        'Анна входит паролем и выходит (`close()`) — сессия погашена. Она просит код (`requestCode`, код приходит ' +
        'почтальону) и входит по нему — код использован. Анна зовёт Олега и тут же отзывает приглашение, ' +
        'а Веру зовёт со сроком в одну секунду — и это приглашение истекает. Приглашение, по которому Анна стала ' +
        'жильцом, тоже погашено — его приняли. Все эти строки остаются в `secret`: погашенное приглашение хранится до ' +
        'своего срока, чтобы по ссылке было видно, что с ним стало (`status`).',
      run: async ({ db, me, annaKey, admin, schema }) => {
        const anna = await db.open(annaKey);
        await anna.close();
        await db.requestCode({ email: annaKey.email });
        await db.open({ email: annaKey.email, code: lastLetter(annaKey.email, 'code').code });
        const { id } = await me.invite({ email: 'oleg@romashka.ru' }, ['staff']);
        await me.revokeInvite(id);
        await me.invite({ email: 'vera@romashka.ru' }, ['staff'], { ttl: 1 });
        await new Promise((r) => setTimeout(r, 1500)); // ждём, пока приглашение Веры истечёт
        return admin.unsafe(secrets(schema));
      },
    },
    {
      title: 'letopis maintain убирает лишнее',
      text:
        'Отчёт — строка JSON: `sessions` — удалено сессий (истёкших и погашенных), `codes` — кодов (использованных и ' +
        'истёкших) и приглашений, чей срок вышел, `queue` — заполнение очереди сигналов PostgreSQL (больше половины — ' +
        'предупреждение), `skipped` — обслуживание уже идёт в другом процессе. Ещё команда удаляет строки-замки удалённых ' +
        'классов. Истёкшее приглашение Веры убрано; принятое и отозванное ждут своего срока. Живые сессии остались.',
      run: async ({ ADMIN_DSN, name, admin, schema }) => {
        const r = await cli(['maintain', '--dsn', ADMIN_DSN, '--schema', name]);
        const { queue, ...report } = JSON.parse(r.out);
        return {
          'код выхода': r.code, 'отчёт': report, 'очередь сигналов меньше половины': queue < 0.5,
          'secret после': await admin.unsafe(secrets(schema)),
        };
      },
    },
    {
      title: 'Повторный вызов — убирать нечего',
      text:
        'Обслуживание — одна транзакция под строкой-замком: из нескольких процессов работает один, остальные получают ' +
        '`skipped: true`. Запускать его можно сколько угодно часто — повтор ничего не ломает.',
      run: async ({ ADMIN_DSN, name }) => {
        const { queue: _queue, ...report } = JSON.parse((await cli(['maintain', '--dsn', ADMIN_DSN, '--schema', name])).out);
        return report;
      },
    },
    {
      title: 'Из приложения: db.maintain()',
      text:
        'То же обслуживание без мастер-ключа — `db.maintain()` у консьержа: право на него даёт правило System ' +
        '«консьержу можно `letopis.maintain`». Удобно, когда приложение само раз в несколько минут убирает за собой. ' +
        'Отчёт — тот же: `skipped`, `sessions`, `codes`, `queue`. У корня жильца `maintain` нет.',
      run: async ({ db }) => {
        const { queue, ...report } = await db.maintain();
        return { 'отчёт': report, 'очередь сигналов меньше половины': queue < 0.5 };
      },
    },
  ],
});
