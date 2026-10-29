import { readFile } from 'node:fs/promises';
import { up } from 'letopis';
import { example } from '../../kit/example.ts';
import { cli } from '../../kit/cli.ts';

const SRC = 'v1.g_import_src';
let base: string[];

export default example({
  title: 'Импорт из letopis 0.21: letopis import',
  summary:
    'Команда читает схему 0.21 (классы, объекты с историей, аккаунты, креды, права) и переносит её в установку ' +
    '1.x: классы — в System, данные — по арендаторам с историей. Всё, что остановит импорт, проверяется до первой ' +
    'записи; в конце — verify().',
  setup: 'none',
  tables: ['counts'],
  covers: ['cli.import', 'nuance.import-checks-first'],
  steps: [
    {
      title: 'Источник 0.21 и пустая установка 1.x',
      text: 'Источник — дамп схемы 0.21 из тестов letopis (`lib/test/fixtures/v021.sql`): два салона, клиенты, услуги, история правок.',
      run: async ({ admin, schema, dsn }) => {
        const dump = await readFile(new URL('../../../lib/test/fixtures/v021.sql', import.meta.url), 'utf8');
        await admin.unsafe(`drop schema if exists "${SRC}" cascade`);
        await admin.unsafe(dump.replaceAll('<SCHEMA>', SRC));
        await up({ dsn: dsn.admin, schema, fresh: true, quiet: true });
        base = ['import', '--from', dsn.admin, '--from-schema', SRC, '--dsn', dsn.admin, '--schema', schema, '--tenant', 'Импорт'];
        return (await admin.unsafe(`select count(*)::int as n from "${SRC}"."Entity"`))[0];
      },
    },
    {
      title: 'Первая попытка: в источнике нарушен ключ',
      text: 'В 0.21 две услуги «Стрижка» с одним ключом. Импорт останавливается до записи и называет строки (код выхода 1).',
      run: async () => {
        const r = await cli(base);
        return { 'код выхода': r.code, 'ошибка': r.err.split('\n')[0].slice(0, 160) };
      },
    },
    {
      title: 'С --keyless Service: услуги без ключа',
      text: '`--keyless C` переносит класс без ключа (id случайные). Флаг `--tenant` — арендатор для данных, что в 0.21 лежали у System.',
      run: async () => {
        const r = await cli([...base, '--keyless', 'Service']);
        const report = JSON.parse(r.out.slice(r.out.indexOf('{')));
        return { 'код выхода': r.code, classes: report.classes, tenants: report.tenants, objects: report.objects, 'verify.ok': report.verify.ok };
      },
    },
  ],
});
