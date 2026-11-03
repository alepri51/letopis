/**
 * Где сайт берёт исполняемые примеры: корневой каталог `examples/` репозитория (сайт его только читает).
 * Пример — `examples/<глава>/<NN>-<имя>.ts`, его id — `<глава>/<NN>-<имя>`; снимок — `examples/_snapshots/<id>.json`.
 * Каталоги `_…` (помощники, раннер, снимки), `.…` и `node_modules` — не главы.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples');
export const SNAPSHOTS = join(EXAMPLES, '_snapshots');

/** Файлы примеров по порядку: глава, затем файл. */
export function exampleFiles(): string[] {
  if (!existsSync(EXAMPLES)) return [];
  return readdirSync(EXAMPLES).sort()
    .filter((n) => !/^[_.]/.test(n) && n !== 'node_modules' && statSync(join(EXAMPLES, n)).isDirectory())
    .flatMap((ch) => readdirSync(join(EXAMPLES, ch)).sort().filter((n) => n.endsWith('.ts')).map((n) => join(EXAMPLES, ch, n)));
}
