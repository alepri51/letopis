import { setup } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { postman, lastLetter } from '../_shared/postman.ts';

// Модель: один класс «Приветствие» с текстом.
const Greeting = hub('Greeting', { text: z.string() });

export default example({
  title: 'Hello, world!',
  summary:
    'Вся letopis в одном шаге: построить дом с моделью, завести квартиру, позвать в неё жильца, записать объект и ' +
    'прочитать его.',
  setup: 'none',
  covers: [
    'export.setup', 'setup.models', 'export.connect', 'house.createTenant', 'house.in', 'db.invite', 'house.accept',
    'model.hub', 'chain.create', 'chain.rows',
  ],
  steps: [
    {
      title: 'Hello, world!',
      text:
        '`setup()` мастер-ключом строит дом — схему с моделью `Greeting` — и отдаёт пропуск консьержа. `connect(pass, ' +
        '{ postman })` — консьерж: он заводит квартиру «Мир» и зовёт в неё Аню. Ссылку-приглашение консьерж отдаёт ' +
        'почтальону — функции приложения, которая доставляет письма; здесь это заглушка, она кладёт письмо в ящик. ' +
        '`accept(token, { name })` — Аня открывает ссылку и принимает приглашение, а дальше сразу работает в квартире: `create()` ' +
        'записывает объект, `rows()` читает его обратно.',
      run: async ({ ADMIN_DSN, name, connect }) => {
        const { pass } = await setup(ADMIN_DSN, name, { models: [Greeting], quiet: true });
        const db = await connect(pass, { postman });
        await db.createTenant('Мир');
        await (await db.in('Мир')).invite({ email: 'anya@example.com' }, ['owner']);
        const anya = await db.accept(lastLetter('anya@example.com', 'invite').token, { name: 'Аня' });
        await anya.Greeting().create({ text: 'Hello, world!' }).rows();
        const [hello] = await anya.Greeting().rows();
        return { text: hello.data.text, id: hello.id, rev: hello.rev };
      },
    },
  ],
});
