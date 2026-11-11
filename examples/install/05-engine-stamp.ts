import { setup, DDL_REVISION } from 'letopis';
import { example } from '../_shared/example.ts';

export default example({
  title: 'Штамп движка: connect() замечает, что дом не обновили',
  summary:
    'setup() пишет в комментарий схемы дома ревизию движка, версию пакета и хэш его SQL-файлов. Если после обновления ' +
    'пакета забыть вызвать setup(), функции в базе останутся старыми — connect() это заметит и предупредит. Дом старой ' +
    'ревизии пакет не обновляет: его сносят и строят заново.',
  tables: [],
  covers: ['export.DDL_REVISION', 'nuance.engine-stamp', 'nuance.demolish-drops-data'],
  steps: [
    {
      title: 'Что записано в комментарии схемы',
      text:
        'Ревизия движка (`ddl_revision`, она же экспорт `DDL_REVISION` и поле `revision` в ответе `setup()`), версия ' +
        'пакета (`engine`) и 16 знаков хэша SQL-файлов (`sql`). В документации версия и хэш заменены метками — они ' +
        'меняются от выпуска к выпуску.',
      run: async ({ admin, schema }) => {
        const [row] = await admin`select obj_description(oid, 'pg_namespace') as comment from pg_namespace where nspname = ${schema}`;
        return { comment: row.comment, DDL_REVISION };
      },
    },
    {
      title: 'Функции дома поставила неизвестная версия',
      text:
        'Изображаем дом без штампа движка: в комментарии только ревизия. Ревизия та же, поэтому `connect()` ' +
        'подключается, но предупреждает и называет, что делать: вызвать `setup()` с именем дома.',
      run: async ({ admin, connect, warnings, pass, schema }) => {
        await admin.unsafe(`comment on schema "${schema}" is 'letopis ddl_revision=${DDL_REVISION}'`);
        const { warnings: printed } = await warnings(() => connect(pass));
        return printed;
      },
    },
    {
      title: 'Повторный setup() — предупреждения нет',
      text:
        'Повторный `setup()` заново ставит функции движка и пишет свежий штамп, данные и пропуск не трогает ' +
        '(`created: false`). Теперь `connect()` ничего не печатает.',
      run: async ({ ADMIN_DSN, name, connect, warnings, pass }) => {
        const again = await setup(ADMIN_DSN, name, { quiet: true });
        const { warnings: printed } = await warnings(() => connect(pass));
        return { created: again.created, 'тот же пропуск': again.pass === pass, 'connect() предупредил': printed };
      },
    },
    {
      title: 'Дом уже обновил более новый пакет',
      text:
        'Изображаем дом, который обновила следующая версия пакета: ревизия в комментарии на единицу больше. `connect()` ' +
        'подключается — во время раскатки новой версии старые экземпляры сервиса продолжают работать, — но предупреждает: ' +
        'этот пакет может не знать функций и колонок новой ревизии. `setup()` такой дом не трогает и отказывает.',
      run: async ({ ADMIN_DSN, name, admin, connect, warnings, pass, schema }) => {
        const [row] = await admin`select obj_description(oid, 'pg_namespace') as comment from pg_namespace where nspname = ${schema}`;
        const comment = String(row.comment);
        await admin.unsafe(`comment on schema "${schema}" is '${comment.replace(/ddl_revision=\d+/, `ddl_revision=${DDL_REVISION + 1}`)}'`);
        const { warnings: printed } = await warnings(() => connect(pass));
        const again = await setup(ADMIN_DSN, name, { quiet: true }).then(() => 'построено', (e: Error) => e.message);
        await admin.unsafe(`comment on schema "${schema}" is '${comment}'`); // скрыть
        return { 'connect() предупредил': printed, 'setup() отказал': again };
      },
    },
    {
      title: 'Дом старой ревизии — только снести и построить заново',
      text:
        'Изображаем дом ревизии на единицу меньше. Такой дом пакет не обновляет: `connect()` и `setup()` отказывают с ' +
        '`invalid_data` (ключ `boot.schema_old`) ещё до любых изменений и подсказывают выход — снести дом `demolish()` и ' +
        'построить заново `setup()`; данные не переносятся.',
      run: async ({ ADMIN_DSN, name, admin, connect, pass, schema }) => {
        const [row] = await admin`select obj_description(oid, 'pg_namespace') as comment from pg_namespace where nspname = ${schema}`;
        const comment = String(row.comment);
        await admin.unsafe(`comment on schema "${schema}" is 'letopis ddl_revision=${DDL_REVISION - 1}'`);
        const why = (e: { code?: string; key?: string; message: string }) => ({ code: e.code, key: e.key, message: e.message });
        const conn = await connect(pass).then(() => 'подключено', why);
        const again = await setup(ADMIN_DSN, name, { quiet: true }).then(() => 'построено', why);
        await admin.unsafe(`comment on schema "${schema}" is '${comment}'`); // скрыть
        return { 'connect()': conn, 'setup()': again };
      },
    },
  ],
});
