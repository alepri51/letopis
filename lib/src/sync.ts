/**
 * Синхронизация моделей с базой и генерация типов (план, этап 2, п. 7).
 *
 * syncModels: описания моделей сравниваются со строками Class арендатора сессии; все изменения
 * выполняются одной транзакцией. Сухой прогон откатывает её в конце, поэтому ужесточение с
 * мешающими строками отклоняет сама база (`tightening_conflict` с перечнем) уже в сухом прогоне.
 * generateTypes: объявления TypeScript для классов из реестра — в том числе созданных данными.
 */
import type { DbCore } from './index.js';
import { lerr, lmsg } from './errors.js';
import { internalsOf } from './internal.js';
import { NOLOG, traced } from './log.js';
import type { Tx } from './tx.js';
import type { AnyModel, LostRule } from './model.js';
import type { JsonSchema } from './jsonschema.js';
import type { Registry } from './registry.js';
import { RESERVED_CLASS_NAMES } from './types.js';

export interface SyncResult {
  applied: boolean;
  created: string[];
  updated: string[];
  unchanged: string[];
  /** Классы системного арендатора: их меняет только установка. */
  skipped: string[];
  /** Правила refine, которых нет в базе (преобразования Zod syncModels отклоняет — model.transform_unsupported). */
  lost: LostRule[];
}

const ROLLBACK = Symbol('sync-dry-run');

/** Канонический JSON: ключи по алфавиту — сравнение описаний без учёта порядка ключей. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export async function syncModels(db: DbCore, models: readonly AnyModel[], opts: { apply?: boolean } = {}): Promise<SyncResult> {
  // событие sync (логирование 3.0): логгер — фасада, которым пишут классы
  return traced(internalsOf(db)?.log ?? NOLOG, 'sync', { op: 'syncModels' }, () => syncCore(db, models, opts), (r) => ({
    rows: r.created.length + r.updated.length,
    detail: { applied: r.applied, models: models.length, created: r.created, updated: r.updated, unchanged: r.unchanged.length,
      skipped: r.skipped, lost: r.lost.length },
  }));
}

async function syncCore(db: DbCore, models: readonly AnyModel[], opts: { apply?: boolean }): Promise<SyncResult> {
  // хаб с именем метода цепочки или корня db (модель собрана мимо hub()) — отказ до записи (план 2.0, этап 4, п. 2;
  // 7.10 №3); связь с таким именем отклоняет база
  for (const m of models) {
    if (m.kind === 'hub' && RESERVED_CLASS_NAMES.includes(m.name)) throw lerr('model.sync_hub_name_reserved', { name: m.name });
  }
  const res: SyncResult = { applied: Boolean(opts.apply), created: [], updated: [], unchanged: [], skipped: [], lost: models.flatMap((m) => m.lostRules()) };
  // преобразования Zod (.trim(), .toLowerCase(), .transform(), z.preprocess …) база и валидатор letopis не исполняют —
  // данные записались бы как есть: отказ до записи (план 2.1, A11); refine остаётся в отчёте lost
  const transforms = res.lost.filter((l) => l.kind !== 'refine');
  if (transforms.length) {
    throw lerr('model.transform_unsupported', { rules: transforms.map((l) => `${l.path} (${l.kind})`).join(', ') }, { detail: { rules: transforms } });
  }
  checkEndRoles(db.registry, models);
  const S = `"${db.schema.replace(/"/g, '""')}"`;
  // предок раньше потомка: потомка класса, которого ещё нет, база отклоняет. Круг родителей (модель, собранная мимо
  // hub()) так не упорядочить — отказ до записи с самим кругом (хвост ревью доработок после 1.2.0: раньше обход молча
  // ставил потомка раньше предка)
  const ordered: AnyModel[] = [];
  const path: AnyModel[] = [];
  const visit = (m: AnyModel) => {
    if (ordered.includes(m)) return;
    const at = path.indexOf(m);
    if (at >= 0) {
      throw lerr('model.models_cycle', { cycle: [...path.slice(at), m].map((x) => x.name).join(' → ') });
    }
    path.push(m);
    if (m.parent && models.includes(m.parent)) visit(m.parent);
    path.pop();
    ordered.push(m);
  };
  models.forEach(visit);
  // у корня connect({ admin }) классы пишет администраторский пул с той же сессией (план 2.0, 7.9 №3): правка класса
  // со строками требует прав, которых у роли приложения может не быть
  const adminTx = internalsOf(db)?.adminTx;
  const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => (adminTx ? adminTx(fn) : db.transaction(fn));
  try {
    await run(async (tx) => {
      for (const m of ordered) {
        const desc = m.describe();
        const [cur] = await tx.unsafe(`select tenant = ${S}.ctx_tenant() as own, data - 'resolved' as data from ${S}.entity
          where class = 'Class' and data->>'name' = $1 and tenant in (${S}.ctx_tenant(), '2eba6d0a-1edd-4bb6-a85a-a703dab49035')`, [m.name]);
        if (cur && !cur.own) {
          res.skipped.push(m.name);
        } else if (!cur) {
          await tx.unsafe(`insert into ${S}.entity (class, data) values ('Class', $1::jsonb)`, [desc as never]);
          res.created.push(m.name);
        } else if (canon(cur.data) === canon(desc)) {
          res.unchanged.push(m.name);
        } else {
          await tx.unsafe(`update ${S}.entity set data = $2::jsonb where class = 'Class' and tenant = ${S}.ctx_tenant() and data->>'name' = $1`, [m.name, desc as never]);
          res.updated.push(m.name);
        }
      }
      if (!opts.apply) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  if (opts.apply) await db.refresh();
  return res;
}

const SYSTEM_ID = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';

/** Набор классов конца — как class_set() базы: список без повторов по порядку. */
const classSet = (c: string | readonly string[]): string => [...new Set(typeof c === 'string' ? [c] : c)].sort().join(', ');

/**
 * Имя роли конца — одно на арендатора: в любом другом классе (своём или системном) роль с тем же именем обязана вести
 * на тот же набор классов (база: sql-write.end_other_class в 60-write.sql, проверка ends при записи Class). Системные
 * классы занимают роли User и Tenant (member → Account), Group и Object (rule → Resource). Проверка — до записи, по
 * реестру и самим моделям, с понятным текстом; база проверяет всё равно.
 */
function checkEndRoles(reg: Registry, models: readonly AnyModel[]): void {
  const names = new Set(models.map((m) => m.name));
  const seen = new Map<string, { cls: string; set: string; system: boolean }>();
  for (const c of reg.all()) {
    if (names.has(c.name)) continue;
    for (const [role, e] of Object.entries(c.ends)) {
      if (!seen.has(role) || c.tenant === SYSTEM_ID) seen.set(role, { cls: c.name, set: classSet(e.class), system: c.tenant === SYSTEM_ID });
    }
  }
  for (const m of models) {
    for (const [role, e] of Object.entries(m.describe().ends ?? {})) {
      const mine = classSet(e.class);
      const other = seen.get(role);
      if (other && other.set !== mine) {
        if (other.system) throw lerr('model.end_role_system', { end: role, model: m.name, cls: other.cls, target: other.set });
        throw lerr('model.end_role_taken', { end: role, model: m.name, mine, cls: other.cls, target: other.set });
      }
      if (!other) seen.set(role, { cls: m.name, set: mine, system: false });
    }
  }
}

/** Тип TypeScript по JSON Schema подмножества. */
export function schemaToTs(s: JsonSchema | undefined, indent = ''): string {
  if (!s || Object.keys(s).length === 0) return 'unknown';
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  const branches = (s.anyOf ?? s.oneOf) as JsonSchema[] | undefined;
  // ветки из одних required у объекта с полями — условие, а не форма: тип — сам объект (план 2.0, 7.5 №1)
  const onlyRequired = Array.isArray(branches) && s.properties !== undefined
    && branches.every((b) => Object.keys(b).every((k) => k === 'required'));
  if (Array.isArray(branches) && !onlyRequired) return branches.map((b) => schemaToTs(b, indent)).join(' | ');
  const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string | undefined];
  return types.map((t) => {
    switch (t) {
      case 'string': return 'string';
      case 'integer':
      case 'number': return 'number';
      case 'boolean': return 'boolean';
      case 'null': return 'null';
      case 'array': return `Array<${schemaToTs(s.items as JsonSchema, indent)}>`;
      case 'object': {
        const props = (s.properties ?? {}) as Record<string, JsonSchema>;
        const req = new Set((s.required ?? []) as string[]);
        const inner = indent + '  ';
        const lines = Object.entries(props).map(([k, v]) => `${inner}${JSON.stringify(k)}${req.has(k) ? '' : '?'}: ${schemaToTs(v, inner)};`);
        if (s.additionalProperties && typeof s.additionalProperties === 'object') {
          const key = s.propertyNames && Array.isArray((s.propertyNames as JsonSchema).enum) ? ((s.propertyNames as JsonSchema).enum as string[]).map((x) => JSON.stringify(x)).join(' | ') : 'string';
          const rec = `Partial<Record<${key}, ${schemaToTs(s.additionalProperties as JsonSchema, inner)}>>`;
          return lines.length ? `{\n${lines.join('\n')}\n${indent}} & ${rec}` : rec;
        }
        return lines.length ? `{\n${lines.join('\n')}\n${indent}}` : 'Record<string, unknown>';
      }
      default: return 'unknown';
    }
  }).join(' | ');
}

/**
 * Объявления `<Класс>Data` и `<Класс>Links` для классов реестра и `<Класс>Model` — имя, алиас, концы с классами целей
 * и предки, — а в конце список `Models`: строгие типы цепочек без моделей Zod, `connect<Models>()`. Классы арендатора
 * System (системные и классы сидов пакета) — только с includeSystem (`letopis types --system`); без него системные
 * классы даёт встроенный набор SystemModels. Первая строка — пометка «Сгенерировано letopis types — не править руками.»
 */
export function generateTypes(registry: Registry, opts: { includeSystem?: boolean } = {}): string {
  const out = [`// ${lmsg('model.types_header')}`, ''];
  const models: string[] = [];
  const lit = (v: string): string => JSON.stringify(v);
  for (const c of registry.all().sort((a, b) => a.name.localeCompare(b.name))) {
    if (!opts.includeSystem && c.tenant === '2eba6d0a-1edd-4bb6-a85a-a703dab49035') continue;
    // идентификатор TypeScript — буквы Unicode, цифры, _ и $: кириллические имена классов допустимы (план 2.0, 7.5 №1)
    if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(c.name)) throw lerr('model.types_class_name', { name: c.name });
    // additionalProperties: false верхнего уровня в тип не переносится — лишние ключи и так ошибка типов
    const { additionalProperties: _closed, ...open } = c.schema;
    void _closed;
    // объектный литерал — интерфейс; класс без полей, union и открытая схема — псевдоним типа (иначе неверный TypeScript)
    const data = schemaToTs(open);
    out.push(/^\{[\s\S]*\}$/.test(data) && !/\}\s*&/.test(data) ? `export interface ${c.name}Data ${data}` : `export type ${c.name}Data = ${data};`);
    const required = (e: { required?: boolean; min?: number }): boolean => e.required === true || (e.min ?? 0) > 0;
    const ends = Object.entries(c.ends).map(([role, e]) => `  ${lit(role)}${required(e) ? '' : '?'}: ${e.many ? 'string[]' : 'string'};`);
    out.push(`export interface ${c.name}Links {${ends.length ? `\n${ends.join('\n')}\n` : ''}}`);
    // концы с классами целей и предки — переходы, слоты и семейства строгих типов (typed.ts: ModelLike)
    const specs = Object.entries(c.ends).map(([role, e]) => {
      const targets = (Array.isArray(e.class) ? e.class : [e.class]).map(lit).join(' | ');
      return `      ${lit(role)}: { targets: ${targets}; many: ${e.many === true}; required: ${required(e)} };`;
    });
    out.push(`export interface ${c.name}Model {`, `  readonly name: ${lit(c.name)};`, ...(c.alias ? [`  readonly alias: ${lit(c.alias)};`] : []),
      '  readonly __types?: {', `    data: ${c.name}Data;`, `    links: ${c.name}Links;`,
      `    ends: {${specs.length ? `\n${specs.join('\n')}\n    ` : ''}};`, `    ancestors: ${(c.ancestors.length ? c.ancestors : [c.name]).map(lit).join(' | ')};`, '  };', '}', '');
    models.push(`${c.name}Model`);
  }
  out.push(`export type Models = readonly [${models.join(', ')}];`, '');
  return out.join('\n');
}
