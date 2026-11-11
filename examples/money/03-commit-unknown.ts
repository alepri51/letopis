import { inc, LetopisError } from 'letopis';
import type { House, Room } from 'letopis';
import { hub, link } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { commitProxy, type CommitProxy } from '../_shared/proxy.ts';

const Wallet = hub('Wallet', { number: z.string(), balance: z.number().int().min(0).default(0) }, { key: ['number'] });
const Movement = link('Movement', { opId: z.string(), kind: z.enum(['topup', 'debit']), amount: z.number().int() }, {
  ends: { Wallet }, key: ['Wallet', 'opId'],
});
let wallet: { id: string }, proxy: CommitProxy, house: House, cut: Room;

/** Провести операцию: запись операции и приращение баланса — одной транзакцией; тот же opId второй раз — «уже было». */
async function apply(me: Room, opId: string, amount: number): Promise<'проведено' | 'уже было'> {
  const tr = await me.begin({ reason: `debit ${opId}` });
  try {
    await tr.Wallet(wallet).Movement().create({ opId, kind: 'debit', amount }).rows();
    await tr.Wallet(wallet).update({ balance: inc(-amount) }).rows();
    await tr.commit();
    return 'проведено';
  } catch (e) {
    await tr.rollback();
    if (e instanceof LetopisError && e.code === 'exists') return 'уже было';
    throw e;
  }
}
const state = async (me: Room, opId: string) => ({
  [`операция ${opId} в базе`]: (await me.Wallet(wallet).Movement({ opId }).count()) === 1,
  'баланс': (await me.Wallet(wallet).first())!.data.balance,
});

export default example({
  title: 'Обрыв связи на COMMIT: commit_unknown и проверка исхода повтором',
  summary:
    'Связь может оборваться, когда COMMIT уже отправлен: записалась транзакция или нет, приложение не знает. ' +
    'Библиотека отвечает commit_unknown и сама не повторяет. Исход выясняют повтором той же операции с тем же ' +
    'ключом: «проведено» — в первый раз не записалось, exists («уже было») — записалось. Связь в примере рвёт ' +
    'TCP-прокси между приложением и базой: до COMMIT и после него.',
  tables: ['entity'],
  classes: ['Wallet', 'Movement'],
  covers: ['error.commit_unknown'],
  models: [Wallet, Movement],
  steps: [
    {
      title: 'Кошелёк на 1000 и второй консьерж через прокси',
      text:
        'Прокси пропускает трафик к базе, пока его не «взведут». Пропуск — строка подключения: в его копии хост и порт ' +
        'базы заменены портом прокси, и `connect()` с ней — второй консьерж, все запросы которого идут через прокси ' +
        '(`max: 1` — одно соединение, `listen: false` — без канала сигналов). Анна входит через него по своему ключу: ' +
        '`cut` — её корень квартиры за прокси. COMMIT letopis шлёт простым текстовым запросом, поэтому прокси узнаёт его ' +
        'по тексту.',
      run: async ({ me, pass, annaKey, connect }) => {
        [wallet] = await me.Wallet().create({ number: 'W-1', balance: 1000 }).rows();
        const url = new URL(pass);
        proxy = await commitProxy(Number(url.port || 5432), url.hostname === 'localhost' ? '127.0.0.1' : url.hostname);
        url.hostname = '127.0.0.1';
        url.port = String(proxy.port); // тот же пропуск — через прокси
        house = await connect(url.toString(), { max: 1, listen: false });
        cut = await house.open(annaKey);
        return { 'баланс через прокси': (await cut.Wallet(wallet).first())!.data.balance };
      },
    },
    {
      title: 'Связь оборвалась до COMMIT',
      text:
        'Списание 300 (`op-2`): прокси рвёт связь, не передав COMMIT базе. Приложение получает `commit_unknown`. ' +
        'Этот отказ — не защита базы: связь оборвал прокси, и приложение не знает, записалась ли операция.',
      run: async () => {
        proxy.arm('before');
        return apply(cut, 'op-2', 300);
      },
      expect: { error: 'commit_unknown' },
    },
    {
      title: 'Повтор той же операции: «проведено» — значит, в первый раз не записалось',
      text:
        'Повтор идёт напрямую, через `me`. Повторяют ту же операцию с тем же ключом `op-2` — запись `Movement` и ' +
        'приращение одной транзакцией: ключ не даст записать её второй раз.',
      run: async ({ me }) => {
        const before = await state(me, 'op-2');
        return { 'до повтора': before, 'повтор': await apply(me, 'op-2', 300), 'после повтора': await state(me, 'op-2') };
      },
    },
    {
      title: 'Связь оборвалась после COMMIT',
      text:
        'Списание 200 (`op-3`): база выполнила COMMIT, но ответ до приложения не дошёл — снова `commit_unknown`. ' +
        'Отказ и здесь — от обрыва связи, а не от базы: по нему не понять, что операция уже записана.',
      run: async () => {
        proxy.arm('after');
        return apply(cut, 'op-3', 200);
      },
      expect: { error: 'commit_unknown' },
    },
    {
      title: 'Повтор той же операции: «уже было» — значит, записалось',
      text:
        'Повтор `op-3` база отклоняет как `exists`: операция уже есть, и деньги не спишутся второй раз. Голый ' +
        '`inc(-200)` без ключа операции повторять нельзя: он списал бы ещё 200.',
      run: async ({ me }) => {
        const before = await state(me, 'op-3');
        const again = await apply(me, 'op-3', 200);
        await house.close(); // скрыть
        await proxy.close(); // скрыть
        return { 'до повтора': before, 'повтор': again, 'после повтора': await state(me, 'op-3') };
      },
    },
  ],
});
