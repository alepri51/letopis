/**
 * Реестр классов (план, этап 2, п. 3 и 6): описания из строк `Class` с развёрнутым `resolved`
 * (собственные классы арендатора и системные), поиск по имени и алиасу, предки и потомки,
 * типы листьев для фильтров и валидатор на TypeScript, скомпилированный из того же описания.
 */
import { LetopisError } from './errors.js';
import type { JsonSchema } from './jsonschema.js';
import { compileValidator, type Validator } from './validate.js';

export interface EndInfo {
  class: string | string[];
  many?: boolean;
  required?: boolean;
  min?: number;
  max?: number;
  onDelete?: 'restrict' | 'cascade' | 'unset';
  meta?: Record<string, unknown>;
}

/** Тип листа данных для фильтров, сортировки и агрегатов (замена fieldTypeOf 0.21). */
export type LeafType = 'text' | 'numeric' | 'boolean' | 'timestamptz' | 'date' | 'uuid' | 'jsonb';

export interface ClassInfo {
  name: string;
  tenant: string;
  rev: number;
  kind: 'hub' | 'link';
  alias?: string;
  abstract: boolean;
  /** Сам класс, затем предки до корня. */
  ancestors: string[];
  schema: JsonSchema;
  ends: Record<string, EndInfo>;
  key: string[];
  history: unknown;
  ownerDefault: 'tenant' | 'actor';
  cache?: { ttl?: number };
  meta: Record<string, unknown>;
  /** Производный класс: строки пишет только проектор с этим именем (план 1.1, §2.4). */
  derivedBy?: string;
  /** Валидатор на TypeScript (компилируется при первом обращении). */
  validator(): Validator;
}

interface ClassRow { tenant: string; rev: number; data: { alias?: string; resolved: Record<string, unknown> } }

export class Registry {
  private byName = new Map<string, ClassInfo>();
  private byAlias = new Map<string, string>();

  /** Заменить содержимое строками Class (собственные классы арендатора и системные). */
  load(rows: readonly ClassRow[]): void {
    this.byName.clear();
    this.byAlias.clear();
    for (const r of rows) {
      const res = r.data.resolved;
      let compiled: Validator | null = null;
      const info: ClassInfo = {
        name: res.name as string,
        tenant: r.tenant,
        rev: r.rev,
        kind: res.kind as 'hub' | 'link',
        alias: r.data.alias,
        abstract: Boolean(res.abstract),
        ancestors: res.ancestors as string[],
        schema: res.schema as JsonSchema,
        ends: (res.ends ?? {}) as Record<string, EndInfo>,
        key: (res.key ?? []) as string[],
        history: res.history,
        ownerDefault: (res.ownerDefault ?? 'tenant') as 'tenant' | 'actor',
        cache: (res.cache ?? undefined) as { ttl?: number } | undefined,
        meta: (res.meta ?? {}) as Record<string, unknown>,
        ...(typeof res.derivedBy === 'string' ? { derivedBy: res.derivedBy } : {}),
        validator: () => (compiled ??= compileValidator(res.schema as JsonSchema)),
      };
      this.byName.set(info.name, info);
      if (info.alias) this.byAlias.set(info.alias, info.name);
    }
  }

  has(name: string): boolean {
    return this.byName.has(name) || this.byAlias.has(name);
  }

  find(name: string): ClassInfo | undefined {
    return this.byName.get(name) ?? this.byName.get(this.byAlias.get(name) ?? '');
  }

  resolve(name: string): ClassInfo {
    const c = this.find(name);
    if (!c) throw new LetopisError('invalid_class', `класс ${name} не найден`);
    return c;
  }

  all(): ClassInfo[] {
    return [...this.byName.values()];
  }

  /** Класс и все его потомки (семейство). */
  family(name: string): ClassInfo[] {
    const root = this.resolve(name).name;
    return this.all().filter((c) => c.ancestors.includes(root));
  }

  /** Тип листа по пути полей класса: по JSON Schema (type и format). */
  leafType(cls: string, path: readonly string[]): LeafType {
    let node: JsonSchema | undefined = this.resolve(cls).schema;
    for (const p of path) {
      const props = node?.properties as Record<string, JsonSchema> | undefined;
      const next: JsonSchema | undefined = props?.[p] ?? (typeof node?.additionalProperties === 'object' ? (node.additionalProperties as JsonSchema) : undefined);
      if (!next) return 'jsonb';
      node = next;
    }
    const types = Array.isArray(node?.type) ? (node.type as string[]).filter((t) => t !== 'null') : [node?.type as string];
    if (types.length !== 1) return 'jsonb';
    switch (types[0]) {
      case 'integer':
      case 'number': return 'numeric';
      case 'boolean': return 'boolean';
      case 'string':
        return node?.format === 'date-time' ? 'timestamptz' : node?.format === 'date' ? 'date' : node?.format === 'uuid' ? 'uuid' : 'text';
      default: return 'jsonb';
    }
  }
}
