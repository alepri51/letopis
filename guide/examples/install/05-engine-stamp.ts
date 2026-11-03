import { up, DDL_REVISION } from 'letopis';
import { example } from '../../kit/example.ts';

export default example({
  title: 'Штамп движка: connect() замечает, что схему не обновили',
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
      title: 'Схему поставила неизвестная версия',
      text:
        'Изображаем схему без штампа движка: в комментарии только ревизия. Ревизия та же, поэтому ' +
        '`connect()` подключается, но предупреждает и называет команду, которая всё исправит.',
      run: async ({ admin, connect, warnings, dsn, schema, up }) => {
        await admin.unsafe(`comment on schema "${schema}" is 'letopis ddl_revision=${DDL_REVISION}'`);
        const { warnings: printed } = await warnings(() => connect({ dsn: dsn.app, schema, token: up.tenant!.token! }));
        return printed;
      },
    },
    {
      title: 'Повторный up() — предупреждения нет',
      text: 'Повторный `up()` заново ставит функции схемы и пишет свежий штамп. Теперь `connect()` ничего не печатает.',
      run: async ({ connect, warnings, dsn, schema, up: installed }) => {
        await up({ dsn: dsn.admin, schema, quiet: true });
        const { warnings: printed } = await warnings(() => connect({ dsn: dsn.app, schema, token: installed.tenant!.token! }));
        return printed;
      },
    },
    {
      title: 'Схему уже обновил более новый пакет',
      text:
        'Изображаем схему, которую обновила следующая версия пакета: ревизия в комментарии на единицу больше. ' +
        '`connect()` подключается — во время раскатки новой версии старые экземпляры сервиса продолжают работать, — но ' +
        'предупреждает: этот пакет может не знать функций и колонок новой ревизии. `up()` такую схему не трогает и отказывает.',
      run: async ({ admin, connect, warnings, dsn, schema, up: installed }) => {
        const [row] = await admin`select obj_description(oid, 'pg_namespace') as comment from pg_namespace where nspname = ${schema}`;
        const comment = String(row.comment);
        await admin.unsafe(`comment on schema "${schema}" is '${comment.replace(/ddl_revision=\d+/, `ddl_revision=${DDL_REVISION + 1}`)}'`);
        const { warnings: printed } = await warnings(() => connect({ dsn: dsn.app, schema, token: installed.tenant!.token! }));
        const again = await up({ dsn: dsn.admin, schema, quiet: true }).then(() => 'поставлено', (e: Error) => e.message);
        await admin.unsafe(`comment on schema "${schema}" is '${comment}'`); // скрыть
        return { 'connect() предупредил': printed, 'up() отказал': again };
      },
    },
    {
      title: 'Схема ревизии 7 — только заново',
      text:
        'Изображаем схему ревизии 7 — младше первой ревизии, которую знает пакет (8). Такую схему пакет не обновляет: ' +
        '`connect()` и `up()` отказывают с `invalid_data` ещё до любых изменений и подсказывают ' +
        '`up({ schema, fresh: true })` — схема пересоздаётся, данные не переносятся.',
      run: async ({ admin, connect, dsn, schema, up: installed }) => {
        const [row] = await admin`select obj_description(oid, 'pg_namespace') as comment from pg_namespace where nspname = ${schema}`;
        const comment = String(row.comment);
        await admin.unsafe(`comment on schema "${schema}" is 'letopis ddl_revision=7'`);
        const why = (e: Error) => e.message;
        const conn = await connect({ dsn: dsn.app, schema, token: installed.tenant!.token! }).then(() => 'подключено', why);
        const again = await up({ dsn: dsn.admin, schema, quiet: true }).then(() => 'поставлено', why);
        await admin.unsafe(`comment on schema "${schema}" is '${comment}'`); // скрыть
        return { 'connect()': conn, 'up()': again };
      },
    },
  ],
});
