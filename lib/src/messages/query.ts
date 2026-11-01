/**
 * Раздел query: sql.ts, ops.ts — построитель чтения, фильтры, сортировка, курсоры, агрегаты.
 */
import type { Section } from './types.js';

export const query = {
  // sql.ts, sortSpec: поле sort() не из списка
  'query.sort_field': {
    code: 'invalid_query',
    ru: "sort: поле 'at', 'rev', 'id' или 'data.<путь>', а не '{field}'",
    en: "sort: the field is 'at', 'rev', 'id' or 'data.<path>', not '{field}'",
  },
  // sql.ts: поле фильтра, sort() или агрегата не описано ни в одном классе шага — в 1.5 предупреждение (lwarn), в 2.0 —
  // ошибка; where — шаг или вызов, как в коде: Shop({ nmae }), sort('data.nmae'), sum('data.nmae')
  'query.unknown_field': {
    code: 'invalid_query',
    ru: '{where}: поле {field} не описано в классе {cls}',
    en: '{where}: field {field} is not described in class {cls}',
    hint: {
      ru: 'проверить имя поля: похожие названы в тексте, поля класса — db.registry.resolve(класс).schema или describe()',
      en: 'check the field name: similar ones are named in the text, the fields of a class are in db.registry.resolve(class).schema or describe()',
    },
  },
  // sql.ts, resolveHop: классы соседних шагов не ссылаются друг на друга; from, to — имена шагов
  'query.no_path': {
    code: 'no_path',
    ru: 'нет перехода {from} → {to}: ни один класс не ссылается на другой',
    en: 'no hop {from} → {to}: neither class references the other',
  },
  // sql.ts, compileOp: оператор фильтра, которого построитель не знает
  'query.unknown_op': {
    code: 'invalid_query',
    ru: 'неизвестный оператор {op}',
    en: 'unknown operator {op}',
  },
  // sql.ts, compileTags: значение tags()
  'query.tags_arg': {
    code: 'invalid_query',
    ru: 'tags() принимает строку, список или has/hasAny/hasAll',
    en: 'tags() takes a string, a list or has/hasAny/hasAll',
  },
  // sql.ts, compileFilter: оператор, кроме or(…), вместо фильтра шага
  'query.step_op': {
    code: 'invalid_query',
    ru: 'оператор {op} на уровне фильтра шага — допустим только or(…)',
    en: 'operator {op} at the level of a step filter — only or(…) is allowed',
  },
  // sql.ts, compileFilter: фильтр — список, а в нём не id
  'query.id_list': {
    code: 'invalid_query',
    ru: 'список id: ожидались строки',
    en: 'list of ids: strings were expected',
  },
  // sql.ts, compileFilter: { id: […] } — в списке не id
  'query.filter_id_list': {
    code: 'invalid_query',
    ru: 'filter.id: ожидались строки',
    en: 'filter.id: strings were expected',
  },
  // sql.ts, compileFilter: { id } — не строка и не список
  'query.filter_id': {
    code: 'invalid_query',
    ru: 'filter.id принимает строку или список строк',
    en: 'filter.id takes a string or a list of strings',
  },
  // sql.ts, compileFilter: значение конца в фильтре шага; role — имя конца
  'query.end_value': {
    code: 'invalid_query',
    ru: 'конец {role}: ожидался id, строка ответа или null',
    en: 'end {role}: an id, a result row or null was expected',
  },
  // sql.ts, cursorParams: курсор — не объект со значением v; field — поле sort()
  'query.cursor_shape': {
    code: 'invalid_query',
    ru: "after(cursor): курсор — объект { v, id } из cursorOf(строка, '{field}')",
    en: "after(cursor): the cursor is an object { v, id } from cursorOf(row, '{field}')",
  },
  // sql.ts, cursorParams: id курсора — не uuid; id — значение, как его печатает shown() (JSON, длинное — с многоточием)
  'query.cursor_id': {
    code: 'invalid_query',
    ru: 'after(cursor): id курсора — uuid строки, а не {id}',
    en: 'after(cursor): the cursor id is the uuid of a row, not {id}',
  },
  // sql.ts, cursorParams: значение курсора не подходит к типу поля sort(); value — как печатает shown(), expect — текст
  // записи query.cursor_expect_* (lmsg)
  'query.cursor_value': {
    code: 'invalid_query',
    ru: "after(cursor): значение курсора {value} не подходит к sort('{field}') — ожидалось: {expect}; курсор снят с другого поля? Нужен cursorOf(строка, '{field}')",
    en: "after(cursor): the cursor value {value} does not fit sort('{field}') — expected: {expect}; was the cursor taken from another field? Use cursorOf(row, '{field}')",
  },
  // то же у поля данных, которого в строке может не быть: подходит и курсор null
  'query.cursor_value_nullable': {
    code: 'invalid_query',
    ru: "after(cursor): значение курсора {value} не подходит к sort('{field}') — ожидалось: {expect} или null; курсор снят с другого поля? Нужен cursorOf(строка, '{field}')",
    en: "after(cursor): the cursor value {value} does not fit sort('{field}') — expected: {expect} or null; was the cursor taken from another field? Use cursorOf(row, '{field}')",
  },
  // sql.ts, CURSOR_EXPECT: какое значение курсора ждёт поле sort() по своему типу — параметр expect двух записей выше
  'query.cursor_expect_numeric': {
    code: 'invalid_query',
    ru: 'число',
    en: 'a number',
  },
  'query.cursor_expect_int': {
    code: 'invalid_query',
    ru: 'целое число',
    en: 'an integer',
  },
  'query.cursor_expect_boolean': {
    code: 'invalid_query',
    ru: 'true/false',
    en: 'true/false',
  },
  'query.cursor_expect_text': {
    code: 'invalid_query',
    ru: 'строка',
    en: 'a string',
  },
  'query.cursor_expect_uuid': {
    code: 'invalid_query',
    ru: 'uuid строкой',
    en: 'a uuid as a string',
  },
  'query.cursor_expect_timestamptz': {
    code: 'invalid_query',
    ru: 'время строкой вида 2026-10-07T10:00:00Z',
    en: 'a time as a string like 2026-10-07T10:00:00Z',
  },
  'query.cursor_expect_date': {
    code: 'invalid_query',
    ru: 'дата строкой вида 2026-10-07',
    en: 'a date as a string like 2026-10-07',
  },
  'query.cursor_expect_jsonb': {
    code: 'invalid_query',
    ru: 'строка, число, true/false',
    en: 'a string, a number, true/false',
  },
  // sql.ts, cursorRev: rev курсора versions(); rev — как печатает shown()
  'query.cursor_rev': {
    code: 'invalid_query',
    ru: 'after(cursor): rev курсора — номер версии (целое ≥ 1), а не {rev}',
    en: 'after(cursor): the cursor rev is a version number (an integer ≥ 1), not {rev}',
  },
  // sql.ts, cursorPath: в курсоре paths() нет id узла; key — ключ узла в пути
  'query.cursor_path': {
    code: 'invalid_query',
    ru: 'after(cursor): в курсоре пути нет id узла {key} — нужен cursorOf(путь, поле) из paths() этой же цепочки',
    en: 'after(cursor): the path cursor has no id of node {key} — use cursorOf(path, field) from paths() of the same chain',
  },
  // sql.ts, cursorOf(): поле не из списка
  'query.cursor_of_field': {
    code: 'invalid_query',
    ru: "cursorOf: поле 'at', 'rev', 'id' или 'data.<путь>', а не '{field}'",
    en: "cursorOf: the field is 'at', 'rev', 'id' or 'data.<path>', not '{field}'",
  },
  // sql.ts, buildRead: цепочка без шагов
  'query.empty_chain': {
    code: 'invalid_query',
    ru: 'пустая цепочка',
    en: 'empty chain',
  },
  // sql.ts, buildRead: возврат к узлу, которого нет в пути; name — имя шага
  'query.pivot_missing': {
    code: 'invalid_query',
    ru: 'возврат к узлу {name}: узла нет в этом пути',
    en: 'return to node {name}: the node is not in this path',
  },
  // sql.ts, buildRead: deep() на первом шаге
  'query.deep_first_step': {
    code: 'invalid_query',
    ru: 'deep() — на шаге перехода к тому же классу, а не на первом шаге',
    en: 'deep() goes on a step that hops to the same class, not on the first step',
  },
  // sql.ts, buildRead: deep() на переходе к другому классу; from, to — имена шагов
  'query.deep_hop': {
    code: 'invalid_query',
    ru: 'deep() — только на переходе к тому же классу (дети любой глубины): {from} → {to}',
    en: 'deep() works only on a hop to the same class (children of any depth): {from} → {to}',
  },
  // sql.ts, buildRead: deep() вместе с withDeleted()
  'query.deep_with_deleted': {
    code: 'invalid_query',
    ru: 'deep() и withDeleted() не сочетаются',
    en: 'deep() and withDeleted() cannot be combined',
  },
  // sql.ts, buildRead: after() без sort()
  'query.after_without_sort': {
    code: 'invalid_query',
    ru: 'after(cursor) требует sort(поле)',
    en: 'after(cursor) requires sort(field)',
  },
  // sql.ts, buildRead: агрегат не по полю данных
  'query.agg_field': {
    code: 'invalid_query',
    ru: "агрегат по полю 'data.<путь>'",
    en: "an aggregate goes over a field 'data.<path>'",
  },
} satisfies Section<'query'>;
