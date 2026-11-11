import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

const Ping = hub('Ping', { fields: { source: z.string() }, history: false }); // журнал не ведётся
const Draft = hub('Draft', { fields: { text: z.string() }, ownerDefault: 'actor' }); // владелец — автор
const Product = hub('Product', { fields: { title: z.string() }, meta: { title: 'Товар', icon: 'mdi:package-variant', order: 1 } });
let ping: { id: string };

export default example({
  title: 'Настройки класса: без истории, владелец-автор, метаданные',
  summary:
    'history: false выключает журнал класса. ownerDefault: \'actor\' делает владельцем новой строки самого ' +
    'жильца. meta — свободные метаданные для интерфейса: их, как и всё описание класса, отдаёт реестр корня квартиры.',
  covers: ['class.history', 'class.ownerDefault', 'class.meta', 'db.registry', 'nuance.history-false'],
  models: [Ping, Draft, Product],
  steps: [
    {
      title: 'Класс без истории: журнал пуст',
      text:
        'Строка `Ping` есть в `entity`, а в журнале `log` для неё ничего нет: у класса `history: false`. ' +
        'Нет версий, среза на дату, восстановления и событий подписки — зато запись дешевле. `versions()` ' +
        'вернёт пустой список и предупредит в консоли.',
      run: async ({ me, warnings }) => {
        [ping] = await me.Ping().create({ source: 'датчик-1' }).rows();
        await me.Ping(ping).update({ source: 'датчик-2' }).rows();
        const { result: versions, warnings: printed } = await warnings(() => me.Ping(ping).versions());
        return { versions, printed };
      },
    },
    {
      title: 'Владелец — автор, а не квартира',
      text:
        'У обычной строки владелец — квартира («Ромашка»). У класса с `ownerDefault: \'actor\'` владелец — ' +
        'жилец, который её создал (Анна). Это пригодится для правила «каждый видит свои черновики».',
      run: async ({ me }) => {
        const [draft] = await me.Draft().create({ text: 'План на неделю' }).rows();
        const [product] = await me.Product().create({ title: 'Чайник' }).rows();
        return { draftOwner: draft.owner, productOwner: product.owner };
      },
    },
    {
      title: 'Настройки класса — в реестре корня квартиры',
      text:
        '`me.registry` — описания классов, которые корень квартиры прочёл из базы: `find(имя)` отдаёт поля (`schema`), ключ, ' +
        'концы, `history`, `ownerDefault` и `meta`. Так интерфейс строит меню по `meta.title` и `meta.order`. ИИ-агенту ' +
        'модель отдаёт инструмент MCP `letopis_model` (глава «ИИ-агенты: MCP»).',
      run: async ({ me }) => {
        const pick = (name: string) => {
          const c = me.registry.find(name)!;
          return { history: c.history, ownerDefault: c.ownerDefault, meta: c.meta };
        };
        return { Ping: pick('Ping'), Draft: pick('Draft'), Product: pick('Product') };
      },
    },
  ],
});
