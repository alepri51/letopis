import { setup } from 'letopis';
import type { House, SetupResult } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { postman, lastLetter } from '../_shared/postman.ts';

const Task = hub('Task', { title: z.string(), done: z.boolean() });
let dev: SetupResult, house: House;

export default example({
  title: 'Разработка без PostgreSQL: PGlite',
  summary:
    'PGlite — PostgreSQL 18, собранный в WebAssembly: работает внутри процесса Node, ставить сервер базы не нужно. ' +
    'Удобно для разработки и демонстраций. Для проверки прав, одновременных транзакций и CI он не годится: соединение ' +
    'одно, а подключение — суперпользователем, поэтому права и изоляция квартир не проверяются.',
  setup: 'none',
  tables: [],
  covers: ['setup.pglite', 'connect.max', 'connect.listen', 'nuance.pglite-no-rls'],
  steps: [
    {
      title: 'Запускаем PGlite и строим дом',
      text:
        '`setup(\'\', \'dev\', { pglite: true })` запускает PGlite с сокетом на свободном порту и строит в нём дом. ' +
        'Мастер-ключ не нужен — первый аргумент пустой. В `warnings` — предупреждение: права здесь не проверяются. ' +
        'Нужны пакеты `@electric-sql/pglite` и `@electric-sql/pglite-socket` (`npm i -D @electric-sql/pglite ' +
        '@electric-sql/pglite-socket`); без них `setup()` отказывает и называет недостающий пакет.',
      run: async () => {
        dev = await setup('', 'dev', { pglite: true, models: [Task], quiet: true });
        return { schema: dev.schema, created: dev.created, warnings: dev.warnings, pglite: !!dev.pglite };
      },
    },
    {
      title: 'Консьерж и жилец: одно соединение, без LISTEN',
      text:
        'Соединение у PGlite одно, поэтому консьерж подключается с `max: 1` и `listen: false` — без них `connect()` ' +
        'ждал бы второго соединения. Подключение идёт от суперпользователя: `connect()` предупреждает, что права не ' +
        'проверяются. Дальше — как с настоящей базой: квартира, приглашение, жилец, данные. Почтальон у PGlite не должен ' +
        'ходить в базу через того же консьержа: его зовут внутри транзакции, а соединение одно — заглушка, которая ' +
        'кладёт письмо в ящик, этого и не делает.',
      run: async ({ connect, warnings }) => {
        const { result, warnings: printed } = await warnings(() => connect(dev.pass, { max: 1, listen: false, postman }));
        house = result;
        await house.createTenant('Мир');
        await (await house.in('Мир')).invite({ email: 'dev@example.com' }, ['owner']);
        const me = await house.accept(lastLetter('dev@example.com', 'invite').token, { name: 'Разработчик' });
        await me.Task().create({ title: 'Написать документацию', done: false }).rows();
        return { 'connect() предупредил': printed, 'задачи': (await me.Task().rows()).map((t) => t.data) };
      },
    },
    {
      title: 'Закрываем консьержа и PGlite',
      run: async () => {
        await house.close();
        await dev.pglite!.close();
        return 'закрыто';
      },
    },
  ],
});
