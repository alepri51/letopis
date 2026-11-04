import { LOG_EVENTS, syncModels, up as install, type LogEvent } from 'letopis';
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
  covers: ['connect.log', 'connect.logLevel', 'connect.redact', 'up.log', 'up.logLevel', 'up.redact', 'export.LOG_EVENTS'],
  steps: [
    {
      title: 'Логгер — console',
      text:
        '`log: console` — события идут в `console.info`, `console.warn`, `console.error` по уровню: первым аргументом ' +
        'объект события, вторым — его имя. Здесь два события уровня info: `connect` (подключение готово) и `write` ' +
        '(записана заметка). Чтобы показать их и в ответе шага, `console.info` на время шага ещё и запоминает, что ' +
        'получил; в своей программе это не нужно — события просто печатаются. Таблицы меняет только запись заметки.',
      run: async ({ db, connect, dsn, schema, up }) => {
        await syncModels(db, [Note], { apply: true });
        const printed: { вызов: string; event: string; op?: string }[] = [];
        const info = console.info;
        console.info = (e: LogEvent, name: string) => {
          printed.push({ вызов: 'console.info', event: name, op: e.op });
          info(e, name); // console печатает событие как обычно
        };
        try {
          const app = await connect({ dsn: dsn.app, schema, token: up.tenant!.token!, log: console, logLevel: 'info' });
          await app.Note().create({ text: 'первая заметка' }).rows();
        } finally {
          console.info = info;
        }
        return printed;
      },
    },
    {
      title: 'Свой логгер: события write, delete, restore, error',
      text:
        'Функция в `log` получает каждое событие уровня `info` и выше. Предпросмотр удаления (`delete.preview`) и чтение ' +
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
        // поля без значения в событие не попадают — и в ответ тоже
        return events.map(({ level, event, op, rows, code, key }) =>
          Object.fromEntries(Object.entries({ level, event, op, rows, code, key }).filter(([, v]) => v !== undefined)));
      },
    },
    {
      title: 'Журнал установки и свои секретные поля: up({ log }), redact',
      text:
        'Те же опции есть у `up()`: установка пишет события `up` и `migrate`. `redact` — имена полей, которые журнал ' +
        'маскирует везде в `detail` вдобавок к паролям, токенам и ключам (их он маскирует всегда). Здесь `up()` ставит ' +
        'вторую, учебную схему — только чтобы показать его события. Полный список событий с уровнями — `LOG_EVENTS`.',
      run: async ({ connect, dsn, schema, up }) => {
        const events: Record<string, unknown>[] = [];
        const log = (e: LogEvent) => void events.push({ ...e });
        await install({ dsn: dsn.admin, schema: `${schema}_up`, quiet: true, log, logLevel: 'info', redact: ['passport'] });
        const app = await connect({ dsn: dsn.app, schema, token: up.tenant!.token!, log, logLevel: 'info', redact: ['passport'] });
        await app.Note().create({ text: 'с маскировкой' }).rows();
        const catalog = Object.entries(LOG_EVENTS).slice(0, 4).map(([name, e]) => ({ name, level: e.level, ru: e.ru }));
        return { events: events.map(({ level, event, op }) => ({ level, event, op })), catalog };
      },
    },
  ],
});
