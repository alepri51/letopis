import { syncModels } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

const Ping = hub('Ping', { fields: { source: z.string() }, history: false }); // журнал не ведётся
const Draft = hub('Draft', { fields: { text: z.string() }, ownerDefault: 'actor' }); // владелец — автор
const Product = hub('Product', { fields: { title: z.string() }, meta: { title: 'Товар', icon: 'mdi:package-variant', order: 1 } });
let ping: { id: string };

export default example({
  title: 'Настройки класса: без истории, владелец-автор, метаданные',
  summary:
    'history: false выключает журнал класса. ownerDefault: \'actor\' делает владельцем новой строки самого ' +
    'пользователя. meta — свободные метаданные для интерфейса: их, как и всё описание класса, отдаёт реестр подключения.',
  covers: ['class.history', 'class.ownerDefault', 'class.meta', 'db.registry', 'nuance.history-false'],
  steps: [
    {
      title: 'Три класса с настройками',
      run: async ({ db }) => (await syncModels(db, [Ping, Draft, Product], { apply: true })).created,
    },
    {
      title: 'Класс без истории: журнал пуст',
      text:
        'Строка `Ping` есть в `entity`, а в журнале `log` для неё ничего нет: у класса `history: false`. ' +
        'Нет версий, среза на дату, восстановления и событий подписки — зато запись дешевле. `versions()` ' +
        'вернёт пустой список и предупредит в консоли.',
      run: async ({ db, warnings }) => {
        [ping] = await db.Ping().create({ source: 'датчик-1' }).rows();
        await db.Ping(ping).update({ source: 'датчик-2' }).rows();
        const { result: versions, warnings: printed } = await warnings(() => db.Ping(ping).versions());
        return { versions, printed };
      },
    },
    {
      title: 'Владелец — автор, а не арендатор',
      text:
        'У обычной строки владелец — арендатор («Ромашка»). У класса с `ownerDefault: \'actor\'` владелец — ' +
        'пользователь, который её создал. Это пригодится для правила «каждый видит свои черновики».',
      run: async ({ db }) => {
        const [draft] = await db.Draft().create({ text: 'План на неделю' }).rows();
        const [product] = await db.Product().create({ title: 'Чайник' }).rows();
        return { draftOwner: draft.owner, productOwner: product.owner };
      },
    },
    {
      title: 'Настройки класса — в реестре подключения',
      text:
        '`db.registry` — описания классов, которые подключение прочло из базы: `find(имя)` отдаёт поля (`schema`), ключ, ' +
        'концы, `history`, `ownerDefault` и `meta`. Так интерфейс строит меню по `meta.title` и `meta.order`. ИИ-агенту ' +
        'модель отдаёт инструмент MCP `letopis_model` (глава «ИИ-агенты: MCP»).',
      run: async ({ db }) => {
        const pick = (name: string) => {
          const c = db.registry.find(name)!;
          return { history: c.history, ownerDefault: c.ownerDefault, meta: c.meta };
        };
        return { Ping: pick('Ping'), Draft: pick('Draft'), Product: pick('Product') };
      },
    },
  ],
});
