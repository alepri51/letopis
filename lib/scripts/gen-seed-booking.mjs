/**
 * Генерация lib/sql/seed.booking.sql из моделей демо-домена (план, этап 2, п. 8).
 * Запуск: cd lib && npm run seed:booking
 */
import { writeFile } from 'node:fs/promises';
import { bookingSeedSql } from '../src/demo/booking.ts';

await writeFile(new URL('../sql/seed.booking.sql', import.meta.url), bookingSeedSql());
console.log('sql/seed.booking.sql обновлён');
