/**
 * База для разработки без установленного PostgreSQL (решение 6 точки А): PGlite (PostgreSQL 18 в
 * WebAssembly) с pgcrypto, доступный postgres.js через pglite-socket. Одно соединение: годится для
 * разработки и быстрых тестов логики, но не для гонок и не вместо postgres:18 в CI; LISTEN из
 * второго соединения нет — connect({ listen: false, max: 1 }).
 *
 * Пакеты @electric-sql/pglite и @electric-sql/pglite-socket — необязательные peer-зависимости:
 * основная точка входа их не импортирует, up({ pglite }) загружает их по требованию.
 */
import { lmsg } from './errors.js';

export interface PgliteOptions {
  /** Каталог данных (по умолчанию — в памяти, данные теряются при остановке). */
  dataDir?: string;
  /** Порт сокета (по умолчанию — свободный). */
  port?: number;
}

export interface PgliteServer {
  /** Строка подключения postgres.js к сокету PGlite (пользователь и база postgres). */
  dsn: string;
  close(): Promise<void>;
}

/** Запустить PGlite с pgcrypto и сокетом для postgres.js. */
export async function startPglite(opts: PgliteOptions = {}): Promise<PgliteServer> {
  const load = async (name: string): Promise<Record<string, unknown>> => {
    try {
      return await import(name) as Record<string, unknown>;
    } catch {
      // обычный Error, как у up(): подходящего кода нет
      throw new Error(`letopis.up: ${lmsg('boot.pglite_package', { name })}`);
    }
  };
  const { PGlite } = await load('@electric-sql/pglite') as { PGlite: { create(dir?: string, o?: unknown): Promise<{ close(): Promise<void> }> } };
  const { pgcrypto } = await load('@electric-sql/pglite/contrib/pgcrypto');
  const { PGLiteSocketServer } = await load('@electric-sql/pglite-socket') as {
    PGLiteSocketServer: new (o: { db: unknown; port: number; host: string }) => { start(): Promise<void>; stop(): Promise<void> };
  };
  const db = await PGlite.create(opts.dataDir, { extensions: { pgcrypto } });
  const port = opts.port ?? (await freePort());
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  return {
    dsn: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    async close() {
      await server.stop();
      await db.close();
    },
  };
}

async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}
