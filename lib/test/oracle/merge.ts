// Эталон: deepMerge из letopis 0.21 (lib/src/write.ts:73-85, тег v0.21.0). Не менять.

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

/**
 * Deep-merge патча в базу: меняются ТОЛЬКО указанные листья.
 * Вложенные plain-объекты сливаются рекурсивно; массивы/скаляры/null — заменяются.
 */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k])
      ? deepMerge(out[k] as Record<string, unknown>, v)
      : v;
  }
  return out;
}
