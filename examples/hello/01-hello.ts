import { up, syncModels } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

// Модель: один класс «Приветствие» с текстом.
const Greeting = hub('Greeting', { text: z.string() });

export default example({
  title: 'Hello, world!',
  summary: 'Вся letopis в одном шаге: поставить схему, подключиться, описать класс, записать объект и прочитать его.',
  setup: 'none',
  covers: ['export.up', 'export.connect', 'export.syncModels', 'model.hub', 'chain.create', 'chain.rows'],
  steps: [
    {
      title: 'Hello, world!',
      text:
        '`up()` ставит схему и заводит арендатора с пользователем, `connect()` подключается от его имени, ' +
        '`syncModels` записывает класс, `create()` — объект, `rows()` читает его обратно.',
      run: async ({ connect, dsn, schema }) => {
        const r = await up({
          dsn: dsn.admin, schema, quiet: true,
          tenant: { name: 'Мир', user: { name: 'Аня', login: 'anya@example.com', password: 'Hello-2026!' } },
          login: { user: 'hello_app', password: 'hello-secret' },
        });
        const db = await connect({ dsn: r.login!.dsn!, admin: dsn.admin, schema, token: r.tenant!.token! });
        await syncModels(db, [Greeting], { apply: true });
        await db.Greeting().create({ text: 'Hello, world!' }).rows();
        const [hello] = await db.Greeting().rows();
        console.log(hello.data.text); // Hello, world!
        return { text: hello.data.text, id: hello.id, rev: hello.rev };
      },
    },
  ],
});
