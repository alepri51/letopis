/**
 * Идентификаторы v5 (план, §2.3, этап 2, п. 4).
 *
 * id = uuid_v5(арендатор, '["<класс>", "<значение 1>", …]'). Имя собирается так же, как в базе
 * (`v5_name` в lib/sql/30-validate.sql — текстовый вид jsonb-массива): элементы через JSON.stringify,
 * разделитель — запятая с пробелом. Совпадение закрепляет общий файл векторов lib/test/vectors/v5.json.
 */
import { hash } from 'node:crypto';
import { lerr } from './errors.js';

/** uuid в каноническом виде 8-4-4-4-12 (регистр любой) — общий для построителя, загрузчика и MCP. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = UUID_RE;

/**
 * Любой вид uuid, который принимает приведение PostgreSQL `::uuid`: 32 шестнадцатеричные цифры, дефис — после любой
 * группы из четырёх (или без дефисов), весь в фигурных скобках или без них. Фильтр с таким id работал и до проверки,
 * поэтому проверка до запроса (sql.ts, compileFilter) отказывает только тому, что отклонила бы база.
 */
export const PG_UUID_RE = /^(?:[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}|\{[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}\})$/i;

// байты пространств имён (арендаторов): в загрузке их единицы, а проверка и разбор шли на каждый id
const NS = new Map<string, Buffer>();
function nsBytes(ns: string): Buffer {
  let b = NS.get(ns);
  if (!b) {
    if (!UUID.test(ns)) throw lerr('model.v5_namespace_not_uuid', { ns });
    b = Buffer.from(ns.replace(/-/g, ''), 'hex');
    if (NS.size >= 10_000) NS.clear();
    NS.set(ns, b);
  }
  return b;
}

/** RFC 4122 v5: sha1(пространство + имя); одно имя в одном пространстве — один id. */
export function uuidv5(name: string, ns: string): string {
  const x = hash('sha1', Buffer.concat([nsBytes(ns), Buffer.from(name, 'utf8')]), 'hex');
  // версия 5 — старшая тетрада байта 6; вариант 10xx — старшие биты байта 8
  const variant = ((parseInt(x[16], 16) & 0x3) | 0x8).toString(16);
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-5${x.slice(13, 16)}-${variant}${x.slice(17, 20)}-${x.slice(20, 32)}`;
}

/** Имя v5: JSON-массив из имени класса и значений ключа — как `jsonb_build_array(…)::text` в базе. */
export function v5Name(cls: string, values: readonly string[]): string {
  return `[${[cls, ...values].map((v) => JSON.stringify(v)).join(', ')}]`;
}

/** id строки класса по значениям ключа в объявленном порядке. */
export function v5Id(tenant: string, cls: string, values: readonly string[]): string {
  return uuidv5(v5Name(cls, values), tenant);
}

/** Что нужно idOf() о классе: имя, ключ и какие его части — концы (их значения — id целей). */
export interface KeyedClass {
  name: string;
  key: readonly string[];
  /** Имена концов класса: значение конца в ключе — id цели, он приводится к строчным буквам. */
  ends?: readonly string[];
}

/**
 * id объекта класса с ключом: `idOf(класс, { поле: значение, Роль: id }, { tenant })`. Значения
 * ключевых полей — строки как есть (база их не нормализует), значения концов — id целей.
 * Для класса без ключа id выдаёт база — ошибка `no_key`.
 */
export function idOf(cls: KeyedClass, key: Readonly<Record<string, unknown>>, opts: { tenant: string }): string {
  if (!cls.key.length) {
    throw lerr('model.class_no_key', { cls: cls.name });
  }
  const ends = new Set(cls.ends ?? []);
  const values = cls.key.map((k) => {
    const v = key[k];
    if (typeof v !== 'string') {
      throw lerr('model.key_part_not_string', { cls: cls.name, part: k }, { detail: { key: cls.key } });
    }
    if (ends.has(k)) {
      if (!UUID.test(v)) throw lerr('model.key_end_not_uuid', { cls: cls.name, end: k });
      return v.toLowerCase();
    }
    return v;
  });
  return v5Id(opts.tenant, cls.name, values);
}
