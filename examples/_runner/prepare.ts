/**
 * Подготовка дома примера — одна у раннера снимков (`runner.ts`) и у запуска файла (`direct.ts`): `setup()` с моделями
 * примера, консьерж с почтальоном-заглушкой (`connect(pass, { postman })`), квартира «Ромашка» и её owner Анна,
 * вошедшая по приглашению (`invite` → письмо в ящик почтальона → `accept(token)`). Самостоятельная программа на
 * странице делает то же своими строками (`guide/.vitepress/standalone.ts`).
 */
import { setup, connect } from 'letopis';
import type { House, HouseOptions, Room } from 'letopis';
import { ADMIN_DSN, demolishHouses, type Sql } from './db.ts';
import { postman, lastLetter } from '../_shared/postman.ts';
import type { Ctx, Example } from '../_shared/example.ts';

/** Квартира и её первый жилец — одинаковые у раннера, у запуска файла и у самостоятельной программы. */
export const TENANT = 'Ромашка';
export const ANNA = { name: 'Анна', email: 'anna@romashka.ru', password: 'Ромашка-2026!' };

/** Консьержи примера: подключения, которые закрыть в конце, и корни квартир, через которые отправить сигналы шага. */
export interface Houses {
  /** Консьерж, чьи корни квартир запоминаются: open, resume, accept, in, as. */
  track(h: House): House;
  /** Отправить накопленные сигналы всех консьержей (через любой их корень квартиры). */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export function houses(): Houses {
  const all: { house: House; rooms: Room[] }[] = [];
  const OPEN = new Set(['open', 'resume', 'accept', 'in', 'as']);
  return {
    track(h) {
      const rooms: Room[] = [];
      all.push({ house: h, rooms });
      return new Proxy(h, {
        get(t, p, r) {
          const v = Reflect.get(t, p, r);
          if (typeof v !== 'function' || typeof p !== 'string' || !OPEN.has(p)) return v;
          return async (...a: unknown[]) => {
            const room = (await (v as (...x: unknown[]) => Promise<Room>).apply(t, a)) as Room;
            rooms.push(room);
            return room;
          };
        },
      });
    },
    async flush() {
      // очередь сигналов одна на консьержа: хватит любого его корня
      for (const x of all) if (x.rooms.length) await x.rooms[0].flushSignals().catch(() => {});
    },
    async close() {
      // splice: повторный close (сбой подготовки, затем finally раннера) ничего не закрывает дважды
      for (const x of all.splice(0).reverse()) await x.house.close().catch(() => {});
    },
  };
}

/** Собрать предупреждения console.warn, которые напечатала функция. */
export const collectWarnings: Ctx['warnings'] = async (fn) => {
  const seen: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void seen.push(a.map(String).join(' '));
  try {
    return { result: await fn(), warnings: seen };
  } finally {
    console.warn = orig;
  }
};

/**
 * Подготовка дома примера (раннер и запуск файла — одинаково): `tenant` — дом с моделями примера, консьерж с
 * почтальоном-заглушкой, квартира «Ромашка», приглашение Анны owner и его принятие; `none` — только снести прежний дом
 * с этим именем. Упала подготовка — консьержи, которых она успела открыть, закрываются здесь же (иначе соединения
 * текут до конца прогона).
 */
export async function prepare(ex: Example, name: string, admin: Sql, hs: Houses): Promise<Ctx> {
  const schema = `v2.${name}`;
  const ctx = {
    name, schema, ADMIN_DSN, admin, annaKey: { email: ANNA.email, password: ANNA.password },
    connect: async (pass: string, opts?: HouseOptions) => hs.track(await connect(pass, opts)),
    warnings: collectWarnings,
  } as unknown as Ctx;
  await demolishHouses(admin, name);
  if ((ex.setup ?? 'tenant') === 'tenant') {
    try {
      const { pass } = await setup(ADMIN_DSN, name, { quiet: true, ...(ex.models?.length ? { models: ex.models } : {}) });
      const db = await ctx.connect(pass, { postman });
      await db.createTenant(TENANT);
      await (await db.in(TENANT)).invite({ email: ANNA.email }, ['owner']);
      const me = await db.accept(lastLetter(ANNA.email, 'invite').token, { password: ANNA.password, name: ANNA.name });
      Object.assign(ctx, { pass, db, me });
    } catch (e) {
      await hs.close();
      throw e;
    }
  }
  return ctx;
}
