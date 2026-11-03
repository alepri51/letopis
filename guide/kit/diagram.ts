/**
 * ER-схема модели по реальному реестру: описания классов подключения (`db.registry.all()`) → текст Mermaid erDiagram.
 * Пример возвращает { $mermaid: erDiagram(...) } — плеер рисует такой результат схемой, а не JSON.
 * Схема строится из того, что лежит в базе, поэтому не расходится с моделью.
 */
import type { ClassInfo } from 'letopis';

/** Системные классы установки — на схеме модели их нет, если не назвать явно. */
const SYSTEM = new Set(['Class', 'Account', 'member', 'Resource', 'rule']);

const TYPE: Record<string, string> = { string: 'text', integer: 'int', number: 'num', boolean: 'bool', object: 'json', array: 'list' };

function fieldType(schema: unknown): string {
  const s = (schema ?? {}) as { type?: string | string[]; enum?: unknown[]; format?: string };
  if (s.enum) return 'enum';
  if (s.format === 'date-time') return 'datetime';
  if (s.format === 'date') return 'date';
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  return TYPE[t ?? ''] ?? 'any';
}

/** Mermaid erDiagram классов `names` (по умолчанию — все несистемные) из описаний реестра `db.registry.all()`. */
export function erDiagram(all: readonly ClassInfo[], names?: string[]): { $mermaid: string } {
  const pick = (c: ClassInfo) => (names ? names.includes(c.name) : !SYSTEM.has(c.name));
  const classes = all.filter(pick).sort((x, y) => x.name.localeCompare(y.name));
  const lines = ['erDiagram'];
  for (const c of classes) {
    lines.push(`  ${c.name} {`);
    const props = (c.schema.properties ?? {}) as Record<string, unknown>;
    const required = (c.schema.required ?? []) as string[];
    for (const [f, schema] of Object.entries(props)) {
      const note = [c.key.includes(f) ? 'ключ' : '', required.includes(f) ? 'обязательное' : 'необязательное'].filter(Boolean).join(', ');
      lines.push(`    ${fieldType(schema)} ${f}${c.key.includes(f) ? ' PK' : ''} "${note}"`);
    }
    lines.push('  }');
  }
  for (const c of classes) {
    for (const [role, e] of Object.entries(c.ends)) {
      for (const target of ([] as string[]).concat(e.class ?? [])) {
        if (!classes.some((x) => x.name === target)) continue;
        // слева — строк класса сколько угодно; справа — сколько целей: ровно одна, ноль или одна, список
        // необязательный конец в описании — без required: true
        const right = e.many ? 'o{' : e.required === true ? '||' : 'o|';
        const del = e.onDelete && e.onDelete !== 'restrict' ? `, ${e.onDelete}` : '';
        const key = c.key.includes(role) ? ', в ключе' : '';
        lines.push(`  ${c.name} }o--${right} ${target} : "${role}${key}${del}"`);
      }
    }
    const parent = c.ancestors[1];
    if (parent && classes.some((x) => x.name === parent)) lines.push(`  ${parent} ||--o| ${c.name} : "потомок"`);
  }
  return { $mermaid: lines.join('\n') };
}
