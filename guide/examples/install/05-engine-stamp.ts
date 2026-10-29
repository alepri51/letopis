import { up } from 'letopis';
import { example } from '../../kit/example.ts';

export default example({
  title: 'Штамп движка: connect() замечает, что схему не накатили',
  summary:
    'up() пишет в комментарий схемы ревизию, версию пакета и хэш его SQL-файлов. Если после обновления пакета ' +
    'забыть вызвать up(), функции в базе останутся старыми — connect() это заметит и предупредит.',
  tables: [],
  covers: ['nuance.engine-stamp'],
  steps: [
    {
      title: 'Что записано в комментарии схемы',
      text:
        'Ревизия схемы (`ddl_revision`), версия пакета (`engine`) и 16 знаков хэша SQL-файлов (`sql`). ' +
        'В документации версия и хэш заменены метками — они меняются от выпуска к выпуску.',
      run: async ({ admin, schema }) => {
        const [row] = await admin`select obj_description(oid, 'pg_namespace') as comment from pg_namespace where nspname = ${schema}`;
        return row.comment;
      },
    },
    {
      title: 'Схему «поставила старая версия»',
      text:
        'Изображаем схему версии до 1.4: в комментарии только ревизия, штампа нет. Ревизия та же, поэтому ' +
        '`connect()` подключается, но предупреждает и называет команду, которая всё исправит.',
      run: async ({ admin, connect, warnings, dsn, schema, up }) => {
        await admin.unsafe(`comment on schema "${schema}" is 'letopis ddl_revision=6'`);
        const { warnings: printed } = await warnings(() => connect({ dsn: dsn.app, schema, token: up.tenant!.token! }));
        return printed;
      },
    },
    {
      title: 'Накатываем up() — предупреждения нет',
      text: 'Повторный `up()` накатывает функции и пишет свежий штамп. Теперь `connect()` молчит.',
      run: async ({ connect, warnings, dsn, schema, up: installed }) => {
        await up({ dsn: dsn.admin, schema, quiet: true });
        const { warnings: printed } = await warnings(() => connect({ dsn: dsn.app, schema, token: installed.tenant!.token! }));
        return printed;
      },
    },
  ],
});
