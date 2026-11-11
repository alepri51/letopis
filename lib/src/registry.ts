/**
 * Реестр классов: описания из строк `Class` с развёрнутым `resolved`
 * (собственные классы квартиры и классы System — системные и общие классы дома), поиск по имени и алиасу, предки и потомки,
 * типы листьев для фильтров и валидатор на TypeScript, скомпилированный из того же описания.
 */
import { lerr } from './errors.js';
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

/** Тип листа данных для фильтров, сортировки и агрегатов. */
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
  /** Ведёт ли класс журнал версий (`history: false` — нет). */
  history: boolean;
  ownerDefault: 'tenant' | 'actor';
  cache?: { ttl?: number };
  meta: Record<string, unknown>;
  /** Валидатор на TypeScript (компилируется при первом обращении). */
  validator(): Validator;
}

interface ClassRow { tenant: string; rev: number; data: { alias?: string; resolved: Record<string, unknown> } }

/**
 * Реестр классов сессии — `me.registry`: описания классов квартиры и классов System, как их видит подключение.
 * Методы: `has(имя)` — есть ли класс или алиас; `find(имя)` — описание `ClassInfo` или `undefined`; `resolve(имя)` — то же,
 * а неизвестное имя — `invalid_class`; `all()` — все классы; `family(имя)` — класс и его потомки; `leafType(класс, путь)` —
 * тип поля по пути в данных; `load(строки)` — заменить содержимое (его зовёт само подключение, `me.refresh()`).
 */
export class Registry {
  private byName = new Map<string, ClassInfo>();
  private byAlias = new Map<string, string>();

  /** Заменить содержимое строками Class (собственные классы квартиры и классы System). */
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
        history: res.history !== false,
        ownerDefault: (res.ownerDefault ?? 'tenant') as 'tenant' | 'actor',
        cache: (res.cache ?? undefined) as { ttl?: number } | undefined,
        meta: (res.meta ?? {}) as Record<string, unknown>,
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
    if (!c) throw lerr('model.class_not_found', { name });
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

  /**
   * Тип листа — поля в конце пути `path` — у класса `cls`, по его JSON Schema (`type` и `format`). По этому типу
   * библиотека сравнивает значения поля в фильтрах, сортировке и итогах.
   */
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
