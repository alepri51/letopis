import { syncModels, up as install } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

// Модель: заметка с текстом.
const Note = hub('Note', { text: z.string() });

export default example({
  title: 'Логирование: что делает letopis',
  summary:
    'connect({ log, logLevel }) пишет события: запись, удаление, восстановление, ошибки, вход. log — console, pino или ' +
    'своя функция; logLevel — порог (по умолчанию info). Пароли, токены и ключи в событиях всегда замаскированы.',
  covers: ['connect.log', 'connect.logLevel', 'connect.redact', 'up.log', 'up.logLevel', 'up.redact'],
  steps: [
    {
      title: 'Логгер — console',
      text:
        '`log: console` — события идут в `console.info`, `console.warn`, `console.error` по уровню: первым аргументом ' +
        'объект события, вторым — его имя. Запустите пример сам (`npx tsx logging/01-log.ts`) — события `connect` и ' +
        '`write` появятся в выводе. Таблицы меняет только запись заметки.',
      run: async ({ db, connect, dsn, schema, up }) => {
        await syncModels(db, [Note], { apply: true });
        const app = await connect({ dsn: dsn.app, schema, token: up.tenant!.token!, log: console, logLevel: 'info' });
        const [note] = await app.Note().create({ text: 'первая заметка' }).rows();
        return note.data;
      },
    },
    {
      title: 'Свой логгер: события write, delete, restore, error',
      text:
        'Функция в `log` получает каждое событие уровня `info` и выше. Превью удаления (`delete.preview`) и чтение ' +
        '(`read`) — уровень `debug`, ниже порога: их не видно. Повторный `restore` уже возвращённой заметки — отказ ' +
        '`not_deleted`, и событие `error` несёт его код и ключ. В ответе — главное из каждого события; кроме этого в ' +
        'нём время `ts`, длительность `ms`, арендатор, аккаунт и цепочка `chain`.',
      run: async ({ connect, dsn, schema, up }) => {
        const events: Record<string, unknown>[] = [];
        const app = await connect({ dsn: dsn.app, schema, token: up.tenant!.token!, log: (e) => void events.push({ ...e }), logLevel: 'info' });
        const [note] = await app.Note().create({ text: 'черновик' }).rows();
        const preview = await app.Note(note).delete().rows();
        const gone = await app.Note(note).delete({ confirm: true, expect: preview }).rows();
        await app.Note(note).restore({ expect: gone }).rows();
        await app.Note(note).restore({ expect: gone }).rows().catch(() => null); // уже вернули — отказ
        return events.map(({ level, event, op, rows, code, key }) => ({ level, event, op, rows, code, key }));
      },
    },
    {
      title: 'Журнал установки и свои секретные поля: up({ log }), redact',
      text:
        'Те же опции есть у `up()`: установка пишет события `up` и `migrate`. `redact` — имена полей, которые журнал ' +
        'маскирует везде в `detail` вдобавок к паролям, токенам и ключам (их он маскирует всегда). Здесь `up()` ставит ' +
        'вторую, учебную схему — только чтобы показать его события.',
      run: async ({ connect, dsn, schema, up }) => {
        const events: Record<string, unknown>[] = [];
        const log = (e: Record<string, unknown>) => void events.push({ ...e });
        await install({ dsn: dsn.admin, schema: `${schema}_up`, quiet: true, log, logLevel: 'info', redact: ['passport'] });
        const app = await connect({ dsn: dsn.app, schema, token: up.tenant!.token!, log, logLevel: 'info', redact: ['passport'] });
        await app.Note().create({ text: 'с маскировкой' }).rows();
        return events.map(({ level, event, op }) => ({ level, event, op }));
      },
    },
  ],
});
