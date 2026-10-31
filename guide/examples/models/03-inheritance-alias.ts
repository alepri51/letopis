import { syncModels } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

const Person = hub('Person', { fields: { name: z.string() }, abstract: true });
const Customer = hub('Customer', { extends: Person, fields: { email: z.string() }, alias: 'Клиент' });
const Vip = hub('Vip', { extends: Customer, fields: { discount: z.number().int().min(0).max(50) } });

export default example({
  title: 'Наследование, абстрактный класс и алиас',
  summary:
    'Потомок получает поля, концы и ключ предка. Шаг по классу находит и строки потомков, .exact() — только сам ' +
    'класс. Абстрактный класс своих строк не имеет. Алиас — второе имя класса, например по-русски.',
  covers: ['class.extends', 'class.abstract', 'class.alias', 'chain.exact', 'nuance.polymorphic-read'],
  steps: [
    {
      title: 'Описываем: человек → клиент → VIP',
      run: async ({ db }) => {
        const r = await syncModels(db, [Person, Customer, Vip], { apply: true });
        return r.created;
      },
    },
    {
      title: 'Клиент и VIP-клиент',
      text: 'У VIP есть все поля клиента (`name`, `email`) и своё поле `discount`.',
      run: async ({ db }) => {
        await db.Customer().create({ name: 'Ольга', email: 'olga@mail.ru' }).rows();
        return db.Vip().create({ name: 'Иван', email: 'ivan@mail.ru', discount: 10 }).rows();
      },
    },
    {
      title: 'Шаг по классу находит и потомков',
      text: '`db.Customer()` отдаёт и Ольгу (Customer), и Ивана (Vip): VIP — тоже клиент.',
      run: async ({ db }) => (await db.Customer().sort('data.name').rows()).map((r) => ({ name: r.data.name, class: r.class })),
    },
    {
      title: '.exact() — только сам класс',
      run: async ({ db }) => (await db.Customer().exact().rows()).map((r) => ({ name: r.data.name, class: r.class })),
    },
    {
      title: 'Алиас — второе имя для шага',
      text: 'У класса `Customer` алиас `Клиент`: шаг `db.Клиент()` — то же самое.',
      run: async ({ db }) => db.Клиент().count(),
    },
    {
      title: 'У абстрактного класса нет своих строк',
      text: '`Person` — абстрактный: создать «просто человека» нельзя, только клиента или VIP.',
      run: async ({ db }) => db.Person().create({ name: 'Никто' }).rows(),
      expect: { error: 'invalid_class' },
    },
  ],
});
