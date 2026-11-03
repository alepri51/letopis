import { syncModels } from 'letopis';
import type { Row } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

// Модель: класс «Клиент» с именем и телефоном.
const Client = hub('Client', { fields: { name: z.string(), phone: z.string() } });
let anna: { id: string }, shown: Row[], gone: Row[];

export default example({
  title: 'Первый объект: создать, изменить, удалить, вернуть',
  summary:
    'Как одна запись живёт в letopis. Текущее состояние объекта лежит в таблице entity, а каждая его версия — ' +
    'в журнале log. Журнал только растёт: правка и удаление не стирают прошлое.',
  covers: [
    'export.syncModels', 'model.hub', 'chain.create', 'chain.update', 'chain.versions',
    'chain.delete', 'chain.restore', 'chain.rows', 'nuance.delete-preview',
  ],
  steps: [
    {
      title: 'Описываем класс «Клиент»',
      text:
        'Прежде чем хранить клиентов, базе нужно описание класса: какие у него поля. `syncModels` записывает ' +
        'описание в базу. Данных клиентов пока нет — таблицы пусты.',
      run: async ({ db }) => {
        await syncModels(db, [Client], { apply: true });
      },
    },
    {
      title: 'Создаём клиента Анну',
      text:
        'В `entity` появилась строка: это Анна сейчас, версия `rev = 1`. В журнале `log` — запись `create` ' +
        'с теми же данными, автором и временем.',
      run: async ({ db }) => {
        [anna] = await db.Client().create({ name: 'Анна', phone: '+7 900 111-22-33' }).rows();
        return anna;
      },
    },
    {
      title: 'Меняем телефон',
      text:
        'Строка в `entity` та же, но теперь `rev = 2` и новый телефон (подсвечен). В журнал добавилась ' +
        'вторая запись — `update`. Первая версия никуда не делась.',
      run: async ({ db }) => db.Client(anna).update({ phone: '+7 900 444-55-66' }).rows(),
    },
    {
      title: 'Смотрим историю',
      text:
        '`versions()` читает журнал: обе версии Анны по порядку. Таблицы не меняются — это только чтение.',
      run: async ({ db }) => db.Client(anna).versions(),
    },
    {
      title: 'Удаление, шаг 1: предпросмотр',
      text:
        '`delete()` без подтверждения ничего не удаляет. Он показывает, что удалится: саму Анну ' +
        '(`$action: delete`) и всё, что удалилось бы вместе с ней. Этот ответ показывают пользователю и сохраняют — ' +
        'он нужен для подтверждения.',
      run: async ({ db }) => (shown = await db.Client(anna).delete().rows()),
    },
    {
      title: 'Удаление, шаг 2: по-настоящему',
      text:
        '`delete({ confirm: true, expect })` удаляет ровно то, что показал предпросмотр (`expect` — его ответ); если ' +
        'с тех пор что-то изменилось — отказ `conflict`, ничего не удалено. Без `expect` подтверждение не принимается. ' +
        'Строка уходит из `entity`, а в журнале появляется надгробие — запись `delete`. История Анны осталась целиком.',
      run: async ({ db }) => (gone = await db.Client(anna).delete({ confirm: true, expect: shown }).rows()),
    },
    {
      title: 'Возвращаем Анну',
      text:
        '`restore({ expect })` возвращает данные, какими они были до удаления, новой версией: `rev = 4`, id прежний. ' +
        '`expect` — надгробия из ответа удаления: вернётся только то, что ушло этим удалением. В журнале теперь ' +
        'четыре записи — вся жизнь объекта.',
      run: async ({ db }) => db.Client(anna).restore({ expect: gone }).rows(),
    },
  ],
});
