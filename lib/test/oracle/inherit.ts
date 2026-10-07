// Эталон: наследование атрибутов из buildDef letopis 0.21 (lib/src/schema.ts:168, тег v0.21.0). Не менять.

export interface OracleSchemaRow {
  id: string;
  ancestor: string | null;
  ancestors?: string[] | null;
  attributes?: Record<string, unknown> | null;
}

/** Цепочка наследования: сам класс, затем предки до корня. */
export function ancestorsOf(row: OracleSchemaRow, byId: Map<string, OracleSchemaRow>): string[] {
  let ancestors = row.ancestors ?? [];
  if (!ancestors.length) {
    ancestors = [row.id];
    let cur = row.ancestor;
    const seen = new Set([row.id]);
    while (cur && !seen.has(cur)) {
      ancestors.push(cur);
      seen.add(cur);
      cur = byId.get(cur)?.ancestor ?? null;
    }
  }
  return ancestors;
}

/** Атрибуты наследуются по цепочке: потомок поверх предка, поле заменяется целиком. */
export function inheritedAttributes(row: OracleSchemaRow, byId: Map<string, OracleSchemaRow>): Record<string, unknown> {
  const ancestors = ancestorsOf(row, byId);
  const merged: Record<string, unknown> = {};
  for (let i = ancestors.length - 1; i >= 0; i--) {
    Object.assign(merged, byId.get(ancestors[i])?.attributes ?? {});
  }
  return merged;
}
