import { syncModels } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

const Note = hub('Note', { fields: { text: z.string() } });

export default example({
  title: 'Три таблицы: entity, log и secret',
  summary:
    'Всё, что хранит letopis, лежит в трёх таблицах. entity — объекты сейчас, log — все их версии, secret — ' +
    'пароли, ключи и сессии. Даже описание класса — это объект в entity.',
  covers: ['db.auth', 'auth.verifyPassword', 'nuance.class-is-entity', 'nuance.session-in-secret'],
  tables: ['entity', 'log', 'secret'],
  classes: ['Class'],
  steps: [
    {
      title: 'Что лежит в базе сразу после установки',
      text:
        'Установка уже завела служебные объекты: описания системных классов, аккаунты арендатора «Ромашка», ' +
        'пользователя Анны и сервиса, правило доступа. Сырой SQL показывает, сколько каких строк в `entity`.',
      run: async ({ admin, schema }) => {
        return admin.unsafe(`select class, count(*)::int as rows from "${schema}".entity group by class order by class`);
      },
    },
    {
      title: 'Вход по паролю — новая строка в secret',
      text:
        'Проверка пароля выдаёт сессию. Сессия — строка вида `SESSION` в таблице `secret`; сам токен там не ' +
        'хранится, только его хэш. В `entity` и `log` ничего не меняется.',
      run: async ({ svc, user }) => {
        const login = await svc.auth.verifyPassword({ identifier: user.login, password: user.password });
        return { account: login!.account, token: login!.token };
      },
    },
    {
      title: 'Описание класса — тоже объект',
      text:
        'Описываем класс «Заметка». В `entity` появилась строка класса `Class`: имя, поля, ключ. Её версия ' +
        'легла в журнал, как у любого объекта.',
      run: async ({ db }) => {
        await syncModels(db, [Note], { apply: true });
      },
    },
    {
      title: 'Первая заметка',
      text: 'Объект класса «Заметка»: строка в `entity` и запись `create` в журнале.',
      run: async ({ db }) => db.Note().create({ text: 'Позвонить поставщику' }).rows(),
    },
  ],
});
