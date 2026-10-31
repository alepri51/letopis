/**
 * ER-схема модели по реальному реестру: результат db.describe() → текст Mermaid erDiagram.
 * Пример возвращает { $mermaid: erDiagram(...) } — плеер рисует такой результат схемой, а не JSON.
 * Схема строится из того, что лежит в базе, поэтому не расходится с моделью.
 */
import type { ModelDescription } from 'letopis';

type Cls = ModelDescription['classes'][number];

const TYPE: Record<string, string> = { string: 'text', integer: 'int', number: 'num', boolean: 'bool', object: 'json', array: 'list' };

function fieldType(schema: unknown): string {
  const s = (schema ?? {}) as { type?: string | string[]; enum?: unknown[]; format?: string };
  if (s.enum) return 'enum';
  if (s.format === 'date-time') return 'datetime';
  if (s.format === 'date') return 'date';
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  return TYPE[t ?? ''] ?? 'any';
}

/** Mermaid erDiagram классов `names` (по умолчанию — все несистемные). */
export function erDiagram(d: ModelDescription, names?: string[]): { $mermaid: string } {
  const pick = (c: Cls) => (names ? names.includes(c.name) : !c.system);
  const classes = d.classes.filter(pick);
  const lines = ['erDiagram'];
  for (const c of classes) {
    lines.push(`  ${c.name} {`);
    const props = ((c.fields as { properties?: Record<string, unknown> }).properties ?? c.fields) as Record<string, unknown>;
    for (const [f, schema] of Object.entries(props)) {
      const note = [c.key.includes(f) ? 'ключ' : '', c.required.includes(f) ? 'обязательное' : 'необязательное'].filter(Boolean).join(', ');
      lines.push(`    ${fieldType(schema)} ${f}${c.key.includes(f) ? ' PK' : ''} "${note}"`);
    }
    lines.push('  }');
  }
  for (const c of classes) {
    for (const [role, raw] of Object.entries(c.ends)) {
      const e = raw as { class?: string | string[]; many?: boolean; required?: boolean; onDelete?: string };
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
    if (c.parent && classes.some((x) => x.name === c.parent)) lines.push(`  ${c.parent} ||--o| ${c.name} : "потомок"`);
  }
  return { $mermaid: lines.join('\n') };
}
