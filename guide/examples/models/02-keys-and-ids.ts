import { syncModels, v5Id } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { example } from '../../kit/example.ts';

const Shop = hub('Shop', { name: z.string() }, { key: ['name'] });
const Visitor = hub('Visitor', { name: z.string() }, {}); // без ключа
const Email = hub('Email', { address: z.string() }, { key: ['address'] });
let shop: { id: string };

export default example({
  title: 'Ключ и id: что можно и чего нельзя',
  summary:
    'id объекта с ключом вычисляется из ключа (UUID версии 5), поэтому его не передают. Объект без ключа получает ' +
    'случайный id. Ключ нельзя поменять правкой — новый ключ значит новый объект.',
  covers: [
    'export.v5Id', 'error.immutable_key', 'nuance.key-case', 'nuance.keyless-repeat', 'nuance.no-id-in-create',
  ],
  steps: [
    {
      title: 'Классы и магазин',
      run: async ({ db }) => {
        await syncModels(db, [Shop, Visitor, Email], { apply: true });
        [shop] = await db.Shop().create({ name: 'Ромашка' }).rows();
        return shop;
      },
    },
    {
      title: 'id можно вычислить даже без базы',
      text:
        '`v5Id(арендатор, класс, значения ключа)` — та же формула, что в базе. Значит, приложение знает id заранее ' +
        'и может ссылаться на объект, не читая его.',
      run: async ({ db }) => v5Id(db.tenant!, 'Shop', ['Ромашка']) === shop.id,
    },
    {
      title: 'id в create не передают',
      text:
        'id объекта с ключом вычисляет база, у объекта без ключа — выдаёт база. Поле `id` в данных `create` — ' +
        'лишнее поле, которого нет в описании класса, поэтому отказ `invalid_data`. (Коды `id_mismatch` и ' +
        '`id_from_db` — в главе про ошибки.)',
      run: async ({ db }) => db.Shop().create({ id: randomUUID(), name: 'Лютик' }).rows(),
      expect: { error: 'invalid_data' },
    },
    {
      title: 'Без ключа повтор создаёт второй объект',
      text:
        'Класс без ключа не защищён от повтора: две одинаковые записи — два разных объекта. Если повтор после сбоя ' +
        'сети возможен, давайте классу ключ.',
      run: async ({ db }) => {
        await db.Visitor().create({ name: 'Пётр' }).rows();
        await db.Visitor().create({ name: 'Пётр' }).rows();
        return db.Visitor().count();
      },
    },
    {
      title: 'Ключ правкой не меняется',
      text: 'Поле ключа нельзя изменить обычной правкой (`immutable_key`): новый ключ — это новый id. Для смены ключа есть `rekey`.',
      run: async ({ db }) => db.Shop(shop).update({ name: 'Лютик' }).rows(),
      expect: { error: 'immutable_key' },
    },
    {
      title: 'Регистр важен',
      text:
        'Значения ключа берутся как есть: `Anna@Mail.ru` и `anna@mail.ru` дают разные id. Приводите такие ' +
        'значения к одному виду в приложении или задайте формат в модели.',
      run: async ({ db }) => (await db.idOf('Email', { address: 'Anna@Mail.ru' })) !== (await db.idOf('Email', { address: 'anna@mail.ru' })),
    },
  ],
});
