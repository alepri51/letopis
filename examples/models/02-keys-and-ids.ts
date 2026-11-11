import { v5Id } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { example } from '../_shared/example.ts';

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
  models: [Shop, Visitor, Email],
  steps: [
    {
      title: 'Магазин',
      text: 'Классы `Shop`, `Visitor` и `Email` — модели дома (`setup({ models })` при подготовке).',
      run: async ({ me }) => {
        [shop] = await me.Shop().create({ name: 'Ромашка' }).rows();
        return shop;
      },
    },
    {
      title: 'id можно вычислить даже без базы',
      text:
        '`v5Id(квартира, класс, значения ключа)` — та же формула, что в базе: id квартиры — `me.tenant`. Значит, ' +
        'приложение знает id заранее и может ссылаться на объект, не читая его.',
      run: async ({ me }) => v5Id(me.tenant, 'Shop', ['Ромашка']) === shop.id,
    },
    {
      title: 'id в create не передают',
      text:
        'id объекта с ключом вычисляет база, у объекта без ключа — выдаёт база. Поле `id` в данных `create` — ' +
        'лишнее поле, которого нет в описании класса, поэтому отказ `invalid_data`. (Коды `id_mismatch` и ' +
        '`id_from_db` — в главе про ошибки.)',
      run: async ({ me }) => me.Shop().create({ id: randomUUID(), name: 'Лютик' }).rows(),
      expect: { error: 'invalid_data' },
    },
    {
      title: 'Без ключа повтор создаёт второй объект',
      text:
        'Класс без ключа не защищён от повтора: две одинаковые записи — два разных объекта. Если повтор после сбоя ' +
        'сети возможен, давайте классу ключ.',
      run: async ({ me }) => {
        await me.Visitor().create({ name: 'Пётр' }).rows();
        await me.Visitor().create({ name: 'Пётр' }).rows();
        return me.Visitor().count();
      },
    },
    {
      title: 'Ключ правкой не меняется',
      text: 'Поле ключа нельзя изменить правкой (`immutable_key`): новый ключ — это новый id, то есть новый объект. Его создают, переводят на него концы других строк и удаляют прежний (глава «Запись», «Ключ и класс неизменны»).',
      run: async ({ me }) => me.Shop(shop).update({ name: 'Лютик' }).rows(),
      expect: { error: 'immutable_key' },
    },
    {
      title: 'Регистр важен',
      text:
        'Значения ключа берутся как есть: `Anna@Mail.ru` и `anna@mail.ru` дают разные id. Приводите такие ' +
        'значения к одному виду в приложении или задайте формат в модели.',
      run: async ({ me }) => (await me.idOf('Email', { address: 'Anna@Mail.ru' })) !== (await me.idOf('Email', { address: 'anna@mail.ru' })),
    },
  ],
});
