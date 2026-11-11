import { LOG_EVENTS, setup, type LogEvent } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { postman, inviteAndAccept } from '../_shared/postman.ts';

// Модель: заметка с текстом.
const Note = hub('Note', { text: z.string() });

/** Главное из события — без времени, длительности и id: они от запуска к запуску разные. */
const brief = ({ level, event, op, rows, code, key }: LogEvent) =>
  Object.fromEntries(Object.entries({ level, event, op, rows, code, key }).filter(([, v]) => v !== undefined));

export default example({
  title: 'Логирование: что делает letopis',
  summary:
    'connect(pass, { log, logLevel }) и setup(…, { log }) пишут события: подключение, вход, запись, удаление, возврат, ' +
    'приглашения, выписка, ошибки. log — console, pino или своя функция; logLevel — порог (по умолчанию info). Пароли, ' +
    'токены, ключи и коды в события не попадают никогда; redact маскирует и ваши поля.',
  models: [Note],
  covers: ['connect.log', 'connect.logLevel', 'connect.redact', 'setup.log', 'setup.logLevel', 'setup.redact', 'export.LOG_EVENTS'],
  steps: [
    {
      title: 'Логгер — console',
      text:
        '`log: console` — события идут в `console.info`, `console.warn`, `console.error` по уровню: первым аргументом ' +
        'объект события, вторым — его имя. Логгер — у консьержа, корни квартир, которые он открывает, пишут тем же ' +
        'логгером. Здесь три события уровня info: `connect` (консьерж готов), `auth.login` (Анна вошла ключом) и `write` ' +
        '(записана заметка). Чтобы показать их и в ответе шага, `console.info` на время шага ещё и запоминает, что ' +
        'получил; в своей программе это не нужно — события просто печатаются.',
      run: async ({ connect, pass, annaKey }) => {
        const printed: { 'вызов': string; event: string; op?: string }[] = [];
        const info = console.info;
        console.info = (e: LogEvent, name: string) => {
          printed.push({ 'вызов': 'console.info', event: name, op: e.op });
          info(e, name); // console печатает событие как обычно
        };
        try {
          const db = await connect(pass, { log: console, logLevel: 'info' });
          const anna = await db.open(annaKey);
          await anna.Note().create({ text: 'первая заметка' }).rows();
        } finally {
          console.info = info;
        }
        return printed;
      },
    },
    {
      title: 'Свой логгер: запись, удаление, возврат, ошибка',
      text:
        'Функция в `log` получает каждое событие уровня `info` и выше. Предпросмотр удаления (`delete.preview`) и ' +
        'чтение (`read`) — уровень `debug`, ниже порога: их не видно. Повторный `restore` уже возвращённой заметки — отказ ' +
        '`not_deleted`, и событие `error` несёт его код и ключ каталога (уровень `warn`: штатный отказ). `redact: ' +
        '[\'text\']` прячет значения поля `text` везде в событии — и в цепочке правки по фильтру. Кроме показанного, в ' +
        'событии есть время `ts`, длительность `ms`, квартира, аккаунт и подробности `detail`.',
      run: async ({ connect, pass, annaKey }) => {
        const events: LogEvent[] = [];
        const db = await connect(pass, { log: (e) => void events.push(e), logLevel: 'info', redact: ['text'] });
        const anna = await db.open(annaKey);
        const [note] = await anna.Note().create({ text: 'черновик' }).rows();
        const preview = await anna.Note(note).delete().rows();
        const gone = await anna.Note(note).delete({ confirm: true, expect: preview }).rows();
        await anna.Note(note).restore({ expect: gone }).rows();
        await anna.Note(note).restore({ expect: gone }).rows().catch(() => null); // уже вернули — отказ
        await anna.Note({ text: 'черновик' }).update({ text: 'итог' }).rows();
        const update = events.find((e) => e.event === 'write' && e.op === 'update');
        return { 'события': events.filter((e) => e.event !== 'connect' && e.event !== 'auth.login').map(brief), 'цепочка правки': update?.chain };
      },
    },
    {
      title: 'Дом и квартиры: setup, приглашение, вход, выписка',
      text:
        'Повторный `setup()` с логгером пишет `setup.step` (то, что без логгера печатается в консоль) и итоговое `setup`. ' +
        'Консьерж заводит квартиру «Лютик» (`tenant.create`) и зовёт Бориса (`auth.invite`), Борис принимает приглашение ' +
        '(`auth.login`), неверный пароль — `auth.fail` и `error` уровня `warn`. Борис зовёт Глеба, Глеб выписывается ' +
        '(`member.leave`), Борис выпускает ключ API (`auth.credential`) и удаляет квартиру (`tenant.delete`); Анна входит ' +
        'и выходит (`auth.logout`). Каждая такая операция — ещё и транзакция с событием `tx.commit`: здесь они не ' +
        'показаны. Полный список событий с уровнями — `LOG_EVENTS`.',
      run: async ({ ADMIN_DSN, name, connect, pass, annaKey }) => {
        const events: LogEvent[] = [];
        const log = (e: LogEvent) => void events.push(e);
        await setup(ADMIN_DSN, name, { log, logLevel: 'info', redact: ['passport'] });
        const db = await connect(pass, { log, logLevel: 'info', redact: ['passport'], postman });
        await db.createTenant('Лютик');
        const boris = await inviteAndAccept(db, await db.in('Лютик'), { email: 'boris@lutik.ru' }, ['owner'], { password: 'Лютик-2026!', name: 'Борис' });
        await db.open({ email: 'boris@lutik.ru', password: 'не тот' }).catch(() => null);
        const gleb = await inviteAndAccept(db, boris, { email: 'gleb@lutik.ru' }, ['staff'], { password: 'Глеб-2026!', name: 'Глеб' });
        await gleb.leave();
        await boris.keys.issueApiKey({ name: 'склад' });
        await boris.deleteTenant();
        const anna = await db.open(annaKey);
        await anna.close();
        return {
          'события': events.filter((e) => !e.event.startsWith('tx.')).map(brief),
          'каталог LOG_EVENTS': ['setup', 'auth.invite', 'member.leave', 'tenant.delete'].map((n) => ({ n, ...LOG_EVENTS[n as keyof typeof LOG_EVENTS] })),
        };
      },
    },
  ],
});
