import { setup } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

const Note = hub('Note', { fields: { text: z.string() } });

export default example({
  title: 'Три таблицы: entity, log и secret',
  summary:
    'Всё, что хранит letopis, лежит в трёх таблицах. entity — объекты сейчас, log — все их версии, secret — ' +
    'ключи, приглашения и сессии. Даже описание класса — это объект в entity.',
  covers: ['house.open', 'db.token', 'setup.models', 'db.refresh', 'nuance.class-is-entity', 'nuance.session-in-secret', 'nuance.registry-refresh'],
  tables: ['entity', 'log', 'secret'],
  classes: ['Class'],
  steps: [
    {
      title: 'Что лежит в базе сразу после подготовки',
      text:
        'Дом уже завёл служебные объекты: описания системных классов (`Class`), аккаунты (`Account`: System, консьерж, ' +
        'квартира «Ромашка» и Анна), прописку Анны в «Ромашке» (`member`), ресурсы (`Resource`) и правила матрицы ' +
        '(`rule`). `member` и `rule` — системные классы-связи, их имена библиотека пишет со строчной буквы. SQL-запрос ' +
        'мастер-ключом прямо к таблице показывает, сколько строк каждого класса в `entity`.',
      run: async ({ admin, schema }) => {
        return admin.unsafe(`select class, count(*)::int as rows from "${schema}".entity group by class order by class`);
      },
    },
    {
      title: 'Вход по ключу — новая строка в secret',
      text:
        '`db.open(ключ)` — вход Анны по паролю: консьерж сверяет ключ и открывает сессию в квартире, которую этот ключ ' +
        'открывает. Сессия — строка вида `SESSION` в таблице `secret`, колонка `tenant` — её квартира. Запрос берёт самую ' +
        'новую сессию Анны: в колонке `material` лежит не токен, а его хэш sha256 — запрос сверяет его с токеном ' +
        '`anna.token`. В `entity` и `log` ничего не меняется.',
      run: async ({ db, annaKey, admin, schema }) => {
        const anna = await db.open(annaKey);
        return admin.unsafe(
          `select s.kind, a.data->>'name' as account, t.data->>'name' as tenant,
                  case when s.material = sha256(convert_to($1, 'UTF8')) then 'sha256 токена' else 'другое' end as material,
                  s.expires_at is not null as expires
             from "${schema}".secret s
             join "${schema}".entity a on a.id = s.account
             join "${schema}".entity t on t.id = s.tenant
            where s.kind = 'SESSION' and s.account = $2 order by s.created_at desc limit 1`,
          [anna.token, anna.account],
        );
      },
    },
    {
      title: 'Описание класса — тоже объект',
      text:
        'Дописываем в дом класс «Заметка»: `setup()` с моделью достраивает дом, ничего прежнего не трогая. В `entity` ' +
        'появилась строка класса `Class`: имя класса и его поля. Её версия записана в журнал, как у любого объекта: ' +
        '`versions` — число строк этого объекта в `log`.',
      run: async ({ ADMIN_DSN, name, admin, schema }) => {
        await setup(ADMIN_DSN, name, { models: [Note], quiet: true });
        return admin.unsafe(
          `select e.class, e.rev, e.data->>'name' as name, e.data->'fields' as fields,
                  (select count(*)::int from "${schema}".log l where l.id = e.id) as versions
             from "${schema}".entity e where e.class = 'Class' and e.data->>'name' = 'Note'`,
        );
      },
    },
    {
      title: 'Первая заметка',
      text:
        'Корень Анны открыт до того, как в доме появился класс «Заметка»: список классов он перечитывает по сигналу ' +
        'базы, а сразу — `me.refresh()`. Затем объект класса «Заметка»: строка в `entity` и запись `create` в журнале.',
      run: async ({ me }) => {
        await me.refresh();
        return me.Note().create({ text: 'Позвонить поставщику' }).rows();
      },
    },
  ],
});
