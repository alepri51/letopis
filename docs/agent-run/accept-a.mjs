#!/usr/bin/env node
/**
 * Агентский прогон, задача А «CRUD со связями» (методика — docs/agent-run.md, условия — docs/agent-run/TASK.md).
 * Решение: solution-a.mjs с функциями run(dsn, schema) и report(db).
 * Запуск: node docs/agent-run/accept-a.mjs <каталог агента> [--solution файл] [--schema v2.имя] [--drop]
 */
import { start, Fail, eq, rejects } from './_accept.mjs';

const ISBN = {
  war: '978-5-00-000001-1',
  anna: '978-5-00-000002-2',
  pride: '978-5-00-000003-3',
  crime: '978-5-00-000004-4',
  idiot: '978-5-00-000005-5',
  childhood: '978-5-00-000006-6',
  orphan: '978-5-00-000009-9',
};

const CHECKS = [
  ['a1', 'арендатор «Библиотека» — одна строка Account'],
  ['a2', 'авторы: живы Толстой (Россия) и Остин (Великобритания), больше никого'],
  ['a3', 'книги: живы «Анна Каренина» (1878, 5 экз., Толстой) и «Гордость и предубеждение» (1813, 4 экз., Остин)'],
  ['a4', '«Гордость и предубеждение» перепривязана от Толстого к Остин правкой, без пересоздания'],
  ['a5', '«Война и мир»: экземпляров стало 2 (было 3), затем книга удалена'],
  ['a6', 'оба отзыва на «Войну и мир» были созданы и удалены вместе с книгой'],
  ['a7', 'Достоевский, обе его книги и отзыв на «Преступление и наказание» удалены'],
  ['a8', 'живой отзыв один: 5 звёзд, «Чудесно», на «Гордость и предубеждение»'],
  ['a9', 'Лиза входит паролем и переключается в «Библиотеку»'],
  ['a10', 'report(db) — авторы, книги и экземпляры, с книгой «Детство», которую добавила приёмка'],
  ['a11', 'повтор ключа: книга с ISBN «Анны Карениной» — отказ exists, книга прежняя'],
  ['a12', 'книга без автора — отказ, книга не создана'],
  ['a13', 'отзыв с оценкой 6 — отказ invalid_data, отзыв не создан'],
  ['a14', 'copies −1 у «Анны Карениной» — отказ invalid_data, экземпляров по-прежнему 5'],
  ['a15', 'удаление Толстого, у которого есть книги, — отказ delete_restricted, автор и книги живы'],
];
const title = (id) => CHECKS.find(([i]) => i === id)[1];
const after = (id) => CHECKS.slice(CHECKS.findIndex(([i]) => i === id) + 1);
const by = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);
const need = (v, what) => {
  if (!v) throw new Fail(`нет ${what}`);
  return v;
};
/** Имя цели конца role: одиночный конец — строка id, many — массив id. */
const endName = (links, role, names) => {
  const v = links?.[role];
  if (Array.isArray(v)) return v.map((id) => names.get(id) ?? id);
  return v == null ? null : (names.get(v) ?? v);
};

const ctx = await start({ task: 'a', title: 'CRUD со связями', exports: ['run', 'report'] });
if (!ctx.result.build.ok) {
  ctx.skip(CHECKS, 'решение не собралось');
  await ctx.finish();
}

const T = await ctx.check('a1', title('a1'), () => ctx.tenantId('Библиотека'));
if (!T) {
  ctx.skip(after('a1'), 'нет арендатора «Библиотека»');
  await ctx.finish();
}

const authors = await ctx.live('Author', T);
const books = await ctx.live('Book', T);
const authorNames = new Map(authors.map((r) => [r.id, r.data.name]));
const bookTitles = new Map(books.map((r) => [r.id, r.data.title]));
const tolstoy = authors.find((r) => r.data.name === 'Лев Толстой')?.id;
const anna = books.find((r) => r.data.isbn === ISBN.anna)?.id;
const pride = books.find((r) => r.data.isbn === ISBN.pride)?.id;

await ctx.check('a2', title('a2'), () => {
  eq(authors.map((r) => ({ name: r.data.name, country: r.data.country ?? null })).sort(by('name')), [
    { name: 'Джейн Остин', country: 'Великобритания' },
    { name: 'Лев Толстой', country: 'Россия' },
  ], 'живые Author');
});

await ctx.check('a3', title('a3'), () => {
  eq(books.map((r) => ({
    isbn: r.data.isbn, title: r.data.title, year: r.data.year, copies: r.data.copies,
    Author: endName(r.links, 'Author', authorNames),
  })).sort(by('isbn')), [
    { isbn: ISBN.anna, title: 'Анна Каренина', year: 1878, copies: 5, Author: 'Лев Толстой' },
    { isbn: ISBN.pride, title: 'Гордость и предубеждение', year: 1813, copies: 4, Author: 'Джейн Остин' },
  ], 'живые Book');
});

await ctx.check('a4', title('a4'), async () => {
  const ids = await ctx.idsInLog('Book', T, 'isbn', ISBN.pride);
  if (ids.length !== 1) throw new Fail(`id книги в журнале: ${ids.length}, нужен один`);
  const v = await ctx.versions(ids[0]);
  if (v.length < 2) throw new Fail(`версий ${v.length}, нужно не меньше двух`);
  if (v.some((x) => x.op === 'delete')) throw new Fail('книгу удаляли и создавали заново');
  eq([endName(v[0].links, 'Author', authorNames), endName(v.at(-1).links, 'Author', authorNames)],
    ['Лев Толстой', 'Джейн Остин'], 'автор в первой и последней версиях');
});

let warId = null;
await ctx.check('a5', title('a5'), async () => {
  const ids = await ctx.idsInLog('Book', T, 'isbn', ISBN.war);
  if (ids.length !== 1) throw new Fail(`id книги в журнале: ${ids.length}, нужен один`);
  warId = ids[0];
  const copies = (await ctx.versions(warId)).filter((x) => x.data).map((x) => x.data.copies);
  const i3 = copies.indexOf(3);
  if (i3 < 0 || !copies.slice(i3 + 1).includes(2)) {
    throw new Fail(`copies по версиям: ${JSON.stringify(copies)} — нет перехода 3 → 2`);
  }
  await ctx.removed(warId, '«Война и мир»');
});

await ctx.check('a6', title('a6'), async () => {
  need(warId, 'книги «Война и мир» в журнале');
  const ids = await ctx.idsLinkedInLog('Review', T, 'Book', warId);
  const first = [];
  for (const id of ids) {
    const v = await ctx.versions(id);
    first.push({ stars: v[0].data?.stars ?? null, text: v[0].data?.text ?? null });
    await ctx.removed(id, `отзыв ${v[0].data?.text ?? id}`);
  }
  eq(first.sort(by('text')), [
    { stars: 5, text: 'Великая книга' },
    { stars: 4, text: 'Длинновато' },
  ], 'отзывы на «Войну и мир»');
});

await ctx.check('a7', title('a7'), async () => {
  const fd = await ctx.idsInLog('Author', T, 'name', 'Фёдор Достоевский');
  if (fd.length !== 1) throw new Fail(`id автора «Фёдор Достоевский» в журнале: ${fd.length}, нужен один`);
  await ctx.removed(fd[0], 'автор «Фёдор Достоевский»');
  const fdName = new Map([[fd[0], 'Фёдор Достоевский']]);
  for (const isbn of [ISBN.crime, ISBN.idiot]) {
    const ids = await ctx.idsInLog('Book', T, 'isbn', isbn);
    if (ids.length !== 1) throw new Fail(`книга ${isbn}: id в журнале — ${ids.length}, нужен один`);
    const v = await ctx.versions(ids[0]);
    if (endName(v[0].links, 'Author', fdName) !== 'Фёдор Достоевский') throw new Fail(`книга ${isbn} создана не у Достоевского`);
    await ctx.removed(ids[0], `книга ${isbn}`);
    if (isbn === ISBN.crime) {
      const r = await ctx.idsLinkedInLog('Review', T, 'Book', ids[0]);
      if (r.length !== 1) throw new Fail(`отзывов на «Преступление и наказание» в журнале: ${r.length}, нужен один`);
      const rv = await ctx.versions(r[0]);
      eq({ stars: rv[0].data?.stars, text: rv[0].data?.text }, { stars: 3, text: 'Мрачно' }, 'отзыв на «Преступление и наказание»');
      await ctx.removed(r[0], 'отзыв на «Преступление и наказание»');
    }
  }
});

await ctx.check('a8', title('a8'), async () => {
  const live = await ctx.live('Review', T);
  eq(live.map((r) => ({ stars: r.data.stars, text: r.data.text, Book: endName(r.links, 'Book', bookTitles) })),
    [{ stars: 5, text: 'Чудесно', Book: 'Гордость и предубеждение' }], 'живые Review');
});

const liza = await ctx.check('a9', title('a9'), () => ctx.login('liza@library.test', 'Library-Liza-1!', 'Библиотека'));
if (!liza) {
  ctx.skip(after('a9'), 'Лиза не вошла');
  await ctx.finish();
}
const db = liza.db;
const copiesOf = async (id) => (await ctx.q(`select data from ${ctx.S}.entity where id = $1`, [id]))[0]?.data?.copies;

await ctx.check('a10', title('a10'), async () => {
  await db.Author(need(tolstoy, 'живого автора «Лев Толстой»')).Book()
    .create({ isbn: ISBN.childhood, title: 'Детство', year: 1852, copies: 7 }).rows();
  eq(await ctx.call('report', db), [
    { author: 'Джейн Остин', books: ['Гордость и предубеждение'], copies: 4 },
    { author: 'Лев Толстой', books: ['Анна Каренина', 'Детство'], copies: 12 },
  ], 'report(db)');
});

await ctx.check('a11', title('a11'), async () => {
  need(anna, 'живой книги «Анна Каренина»');
  await rejects(() => db.Author(need(tolstoy, 'живого автора «Лев Толстой»')).Book()
    .create({ isbn: ISBN.anna, title: 'Дубль', year: 2000, copies: 1 }).rows(), 'exists');
  const [r] = await ctx.q(`select data from ${ctx.S}.entity where id = $1`, [anna]);
  eq(r?.data?.title, 'Анна Каренина', 'название книги');
});

await ctx.check('a12', title('a12'), async () => {
  await rejects(() => db.Book().create({ isbn: ISBN.orphan, title: 'Без автора', year: 2000, copies: 1 }).rows());
  if ((await ctx.live('Book', T)).some((r) => r.data.isbn === ISBN.orphan)) throw new Fail('книга без автора создана');
});

await ctx.check('a13', title('a13'), async () => {
  await rejects(() => db.Book(need(pride, 'живой книги «Гордость и предубеждение»')).Review()
    .create({ stars: 6, text: 'Слишком' }).rows(), 'invalid_data');
  if ((await ctx.live('Review', T)).some((r) => r.data.stars === 6)) throw new Fail('отзыв с оценкой 6 создан');
});

await ctx.check('a14', title('a14'), async () => {
  await rejects(() => db.Book(need(anna, 'живой книги «Анна Каренина»')).update({ copies: -1 }).rows(), 'invalid_data');
  eq(await copiesOf(anna), 5, 'copies «Анны Карениной»');
});

await ctx.check('a15', title('a15'), async () => {
  await rejects(() => db.Author(need(tolstoy, 'живого автора «Лев Толстой»')).delete({ confirm: true }).rows(), 'delete_restricted');
  if (!(await ctx.isLive(tolstoy))) throw new Fail('автор удалён');
  if (!(await ctx.isLive(anna))) throw new Fail('книга «Анна Каренина» удалена');
});

await ctx.finish();
