import { up, connect } from 'letopis';
import type { Db, UpResult } from 'letopis';
import { example } from '../../kit/example.ts';

let r: UpResult;
let db: Db;

export default example({
  title: 'Один процесс: роль приложения и второй пул администратора',
  summary:
    'Малому приложению не обязательно держать два процесса. up({ login }) заводит роль приложения, а ' +
    'connect({ admin }) берёт строку администратора для своих администраторских вызовов; цепочки при этом идут под ' +
    'ролью приложения и правами базы.',
  setup: 'none',
  tables: ['entity'],
  covers: ['up.login', 'connect.admin'],
  steps: [
    {
      title: 'up() заводит роль приложения',
      text:
        '`login` — имя и пароль роли приложения: `up()` создаёт её или обновляет пароль и делает членом `letopis_app`. ' +
        'Имя и пароль квотирует сама база, поэтому кавычка в пароле ничего не ломает. В ответе — строка подключения ' +
        'этой роли, `r.login.dsn`.',
      run: async ({ dsn, schema }) => {
        r = await up({ dsn: dsn.admin, schema, quiet: true, login: { user: 'guide_one_app', password: "пароль с 'кавычкой'" },
          tenant: { name: 'Ромашка', user: { name: 'Анна', login: 'anna@romashka.ru', password: 'Ромашка-2026!' } } });
        return { 'роль приложения': r.login!.user, 'строка подключения': r.login!.dsn ? 'есть' : 'нет' };
      },
    },
    {
      title: 'Одно подключение — два пула',
      text:
        '`connect({ dsn, admin, token })`: цепочки и `db.sql` идут под ролью приложения и правами базы, а `maintain()` — ' +
        'администраторский вызов — открывает второй пул строкой администратора, с той же сессией Анны. Так же идут ' +
        '`load` и `syncModels`.',
      run: async ({ dsn, schema }) => {
        db = await connect({ dsn: r.login!.dsn!, admin: dsn.admin, schema, token: r.tenant!.token!, max: 2 });
        const [who] = await db.sql`select current_user as role`;
        const report = await db.maintain();
        return { 'цепочки и db.sql — роль': who.role, 'maintain вторым пулом': report.skipped ? 'пропущен' : 'выполнен' };
      },
    },
    {
      title: 'close() закрывает оба пула',
      text: 'Пароль администратора в процессе приложения — только для малых приложений: взломанный процесс получит и его.',
      run: async () => {
        await db.close();
        return 'закрыто';
      },
    },
  ],
});
