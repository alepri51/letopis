// Эталон: решение ACL и маски letopis 0.21 (lib/src/acl.ts:29-161, тег v0.21.0). Не менять.

export interface OracleRule {
  account: string;
  resource: string;
  permission: 'allow' | 'deny';
  weight?: number | null;
  enabled: boolean;
}

/** pattern.categories: "{A,B}" | "!{A,B}" | отсутствие/NULL (матч всех). */
export function matchCategories(pattern: Record<string, unknown> | null, cats: string[]): boolean {
  const spec = pattern?.categories;
  if (typeof spec !== 'string') return true;
  const neg = spec.startsWith('!');
  const list = spec
    .replace(/^!/, '')
    .replace(/^\{/, '')
    .replace(/\}$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const hit = list.some((c) => cats.includes(c));
  return neg ? !hit : hit;
}

/** Маска → regex: '{a,b}' — альтернативы (рекурсивно), '*' — хвост из 1+ сегментов. */
function maskBody(mask: string): string {
  // START_BLOCK_MASK_COMPILE
  let out = '';
  for (let i = 0; i < mask.length; i++) {
    const ch = mask[i];
    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      for (; j < mask.length && depth; j++) {
        if (mask[j] === '{') depth++;
        else if (mask[j] === '}') depth--;
      }
      const inner = mask.slice(i + 1, j - 1);
      const parts: string[] = [];
      let d = 0;
      let start = 0;
      for (let k = 0; k <= inner.length; k++) {
        const c = inner[k];
        if (k === inner.length || (c === ',' && d === 0)) {
          parts.push(inner.slice(start, k));
          start = k + 1;
        } else if (c === '{') d++;
        else if (c === '}') d--;
      }
      out += '(?:' + parts.map(maskBody).join('|') + ')';
      i = j - 1;
    } else if (ch === '*') {
      out += '[^.]+(?:\\.[^.]+)*';
    } else if ('.\\+?()[]^$|'.includes(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  // END_BLOCK_MASK_COMPILE
  return out;
}

export function matchMask(mask: string, value: string): boolean {
  return new RegExp(`^${maskBody(mask)}$`).test(value);
}

/** Победитель: max weight; равный вес — deny бьёт allow, равные allow — по alias объекта. */
export function decide(rules: OracleRule[], subjects: Set<string>, objects: Set<string>): OracleRule | undefined {
  let winner: OracleRule | undefined;
  for (const rule of rules) {
    if (!rule.enabled || !subjects.has(rule.account) || !objects.has(rule.resource)) continue;
    if (!winner) {
      winner = rule;
      continue;
    }
    const w = rule.weight ?? 0;
    const ww = winner.weight ?? 0;
    if (
      w > ww ||
      (w === ww && winner.permission === 'allow' && rule.permission !== 'allow') ||
      (w === ww && winner.permission === rule.permission && rule.resource < winner.resource)
    ) {
      winner = rule;
    }
  }
  return winner;
}
