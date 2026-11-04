import { syncModels } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

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
        'Установка уже завела служебные объекты: описания системных классов (`Class`), аккаунты (`Account`: System, ' +
        'арендатор «Ромашка», пользователь Анна и сервис), членство Анны в «Ромашке» (`member`), ресурсы (`Resource`) ' +
        'и правила доступа (`rule`). `member` и `rule` — системные классы-связи, их имена библиотека пишет со строчной ' +
        'буквы. SQL-запрос прямо к таблице показывает, сколько строк каждого класса в `entity`.',
      run: async ({ admin, schema }) => {
        return admin.unsafe(`select class, count(*)::int as rows from "${schema}".entity group by class order by class`);
      },
    },
    {
      title: 'Вход по паролю — новая строка в secret',
      text:
        'Проверка пароля выдаёт сессию. Сессия — строка вида `SESSION` в таблице `secret`. Запрос к таблице берёт ' +
        'самую новую сессию Анны: в колонке `material` лежит не токен, а его хэш sha256 — запрос сверяет его с ' +
        'выданным токеном. В `entity` и `log` ничего не меняется.',
      run: async ({ svc, user, admin, schema }) => {
        const login = await svc.auth.verifyPassword({ identifier: user.login, password: user.password });
        return admin.unsafe(
          `select kind, account,
                  case when material = sha256(convert_to($1, 'UTF8')) then 'sha256 токена' else 'другое' end as material,
                  expires_at is not null as expires
             from "${schema}".secret where kind = 'SESSION' and account = $2 order by created_at desc limit 1`,
          [login!.token, login!.account],
        );
      },
    },
    {
      title: 'Описание класса — тоже объект',
      text:
        'Описываем класс «Заметка». В `entity` появилась строка класса `Class`: имя класса и его поля. Её версия ' +
        'записана в журнал, как у любого объекта: `versions` — число строк этого объекта в `log`.',
      run: async ({ db, admin, schema }) => {
        await syncModels(db, [Note], { apply: true });
        return admin.unsafe(
          `select e.class, e.rev, e.data->>'name' as name, e.data->'fields' as fields,
                  (select count(*)::int from "${schema}".log l where l.id = e.id) as versions
             from "${schema}".entity e where e.class = 'Class' and e.data->>'name' = 'Note'`,
        );
      },
    },
    {
      title: 'Первая заметка',
      text: 'Объект класса «Заметка»: строка в `entity` и запись `create` в журнале.',
      run: async ({ db }) => db.Note().create({ text: 'Позвонить поставщику' }).rows(),
    },
  ],
});
