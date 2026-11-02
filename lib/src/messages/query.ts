/**
 * Раздел query: sql.ts, ops.ts — построитель чтения, фильтры, сортировка, курсоры, агрегаты.
 */
import type { Section } from './types.js';

export const query = {
  // sql.ts, sortSpec: поле sort() не из списка
  'query.sort_field': {
    code: 'invalid_query',
    ru: "sort: поле 'at', 'rev', 'id' или 'data.<путь>', а не '{field}'",
  },
  // sql.ts: поле фильтра, sort() или агрегата не описано ни в одном классе шага — в 1.5 предупреждение (lwarn), в 2.0 —
  // ошибка; where — шаг или вызов, как в коде: Shop({ nmae }), sort('data.nmae'), sum('data.nmae')
  'query.unknown_field': {
    code: 'invalid_query',
    ru: '{where}: поле {field} не описано в классе {cls}',
    hint: 'проверить имя поля: похожие названы в тексте, поля класса — db.registry.resolve(класс).schema или describe()',
  },
  // sql.ts, resolveHop: классы соседних шагов не ссылаются друг на друга; from, to — имена шагов
  'query.no_path': {
    code: 'no_path',
    ru: 'нет перехода {from} → {to}: ни один класс не ссылается на другой',
  },
  // sql.ts, compileOp: оператор фильтра, которого построитель не знает
  'query.unknown_op': {
    code: 'invalid_query',
    ru: 'неизвестный оператор {op}',
  },
  // sql.ts, compileTags: значение tags()
  'query.tags_arg': {
    code: 'invalid_query',
    ru: 'tags() принимает строку, список или has/hasAny/hasAll',
  },
  // sql.ts, compileFilter: оператор, кроме or(…), вместо фильтра шага
  'query.step_op': {
    code: 'invalid_query',
    ru: 'оператор {op} на уровне фильтра шага — допустим только or(…)',
  },
  // sql.ts, compileFilter: фильтр — список, а в нём не id
  'query.id_list': {
    code: 'invalid_query',
    ru: 'список id: ожидались строки',
  },
  // sql.ts, compileFilter: { id: […] } — в списке не id
  'query.filter_id_list': {
    code: 'invalid_query',
    ru: 'filter.id: ожидались строки',
  },
  // sql.ts, compileFilter: { id } — не строка и не список
  'query.filter_id': {
    code: 'invalid_query',
    ru: 'filter.id принимает строку или список строк',
  },
  // sql.ts, compileFilter: значение конца в фильтре шага; role — имя конца
  'query.end_value': {
    code: 'invalid_query',
    ru: 'конец {role}: ожидался id, строка ответа или null',
  },
  // sql.ts, cursorParams: курсор — не объект со значением v; field — поле sort()
  'query.cursor_shape': {
    code: 'invalid_query',
    ru: "after(cursor): курсор — объект { v, id } из cursorOf(строка, '{field}')",
  },
  // sql.ts, cursorParams: id курсора — не uuid; id — значение, как его печатает shown() (JSON, длинное — с многоточием)
  'query.cursor_id': {
    code: 'invalid_query',
    ru: 'after(cursor): id курсора — uuid строки, а не {id}',
  },
  // sql.ts, cursorParams: значение курсора не подходит к типу поля sort(); value — как печатает shown(), expect — текст
  // записи query.cursor_expect_* (lmsg)
  'query.cursor_value': {
    code: 'invalid_query',
    ru: "after(cursor): значение курсора {value} не подходит к sort('{field}') — ожидалось: {expect}; курсор снят с другого поля? Нужен cursorOf(строка, '{field}')",
  },
  // то же у поля данных, которого в строке может не быть: подходит и курсор null
  'query.cursor_value_nullable': {
    code: 'invalid_query',
    ru: "after(cursor): значение курсора {value} не подходит к sort('{field}') — ожидалось: {expect} или null; курсор снят с другого поля? Нужен cursorOf(строка, '{field}')",
  },
  // sql.ts, CURSOR_EXPECT: какое значение курсора ждёт поле sort() по своему типу — параметр expect двух записей выше
  'query.cursor_expect_numeric': {
    code: 'invalid_query',
    ru: 'число',
  },
  'query.cursor_expect_int': {
    code: 'invalid_query',
    ru: 'целое число',
  },
  'query.cursor_expect_boolean': {
    code: 'invalid_query',
    ru: 'true/false',
  },
  'query.cursor_expect_text': {
    code: 'invalid_query',
    ru: 'строка',
  },
  'query.cursor_expect_uuid': {
    code: 'invalid_query',
    ru: 'uuid строкой',
  },
  'query.cursor_expect_timestamptz': {
    code: 'invalid_query',
    ru: 'время строкой вида 2026-10-07T10:00:00Z',
  },
  'query.cursor_expect_date': {
    code: 'invalid_query',
    ru: 'дата строкой вида 2026-10-07',
  },
  'query.cursor_expect_jsonb': {
    code: 'invalid_query',
    ru: 'строка, число, true/false',
  },
  // sql.ts, cursorRev: rev курсора versions(); rev — как печатает shown()
  'query.cursor_rev': {
    code: 'invalid_query',
    ru: 'after(cursor): rev курсора — номер версии (целое ≥ 1), а не {rev}',
  },
  // sql.ts, cursorPath: в курсоре paths() нет id узла; key — ключ узла в пути
  'query.cursor_path': {
    code: 'invalid_query',
    ru: 'after(cursor): в курсоре пути нет id узла {key} — нужен cursorOf(путь, поле) из paths() этой же цепочки',
  },
  // sql.ts, cursorOf(): поле не из списка
  'query.cursor_of_field': {
    code: 'invalid_query',
    ru: "cursorOf: поле 'at', 'rev', 'id' или 'data.<путь>', а не '{field}'",
  },
  // sql.ts, buildRead: цепочка без шагов
  'query.empty_chain': {
    code: 'invalid_query',
    ru: 'пустая цепочка',
  },
  // sql.ts, buildRead: возврат к узлу, которого нет в пути; name — имя шага
  'query.pivot_missing': {
    code: 'invalid_query',
    ru: 'возврат к узлу {name}: узла нет в этом пути',
  },
  // sql.ts, buildRead: deep() на первом шаге
  'query.deep_first_step': {
    code: 'invalid_query',
    ru: 'deep() — на шаге перехода к тому же классу, а не на первом шаге',
  },
  // sql.ts, buildRead: deep() на переходе к другому классу; from, to — имена шагов
  'query.deep_hop': {
    code: 'invalid_query',
    ru: 'deep() — только на переходе к тому же классу (дети любой глубины): {from} → {to}',
  },
  // sql.ts, buildRead: deep() вместе с withDeleted()
  'query.deep_with_deleted': {
    code: 'invalid_query',
    ru: 'deep() и withDeleted() не сочетаются',
  },
  // sql.ts, buildRead: after() без sort()
  'query.after_without_sort': {
    code: 'invalid_query',
    ru: 'after(cursor) требует sort(поле)',
  },
  // sql.ts, buildRead: агрегат не по полю данных
  'query.agg_field': {
    code: 'invalid_query',
    ru: "агрегат по полю 'data.<путь>'",
  },
} satisfies Section<'query'>;
