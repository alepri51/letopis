/**
 * Идентификаторы v5 (план, §2.3, этап 2, п. 4).
 *
 * id = uuid_v5(арендатор, '["<класс>", "<значение 1>", …]'). Имя собирается так же, как в базе
 * (`v5_name` в lib/sql/30-validate.sql — текстовый вид jsonb-массива): элементы через JSON.stringify,
 * разделитель — запятая с пробелом. Совпадение закрепляет общий файл векторов lib/test/vectors/v5.json.
 */
import { createHash } from 'node:crypto';
import { LetopisError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 4122 v5: sha1(пространство + имя); одно имя в одном пространстве — один id. */
export function uuidv5(name: string, ns: string): string {
  if (!UUID.test(ns)) throw new LetopisError('invalid_data', `пространство имён v5 — не uuid: ${ns}`);
  const h = createHash('sha1').update(Buffer.from(ns.replace(/-/g, ''), 'hex')).update(name, 'utf8').digest().subarray(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50; // версия 5
  h[8] = (h[8] & 0x3f) | 0x80; // вариант 10xx
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
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
    throw new LetopisError('no_key', `у класса ${cls.name} нет ключа: id выдаёт база при создании`);
  }
  const ends = new Set(cls.ends ?? []);
  const values = cls.key.map((k) => {
    const v = key[k];
    if (typeof v !== 'string') {
      throw new LetopisError('invalid_data', `idOf(${cls.name}): часть ключа ${k} должна быть строкой`, { key: cls.key });
    }
    if (ends.has(k)) {
      if (!UUID.test(v)) throw new LetopisError('invalid_data', `idOf(${cls.name}): конец ${k} — не uuid`);
      return v.toLowerCase();
    }
    return v;
  });
  return v5Id(opts.tenant, cls.name, values);
}
