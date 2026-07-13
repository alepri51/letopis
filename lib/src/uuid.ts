/**
 * Генерация id по Schema (attributes.id):
 *   "uuid"                                    → v4 (random) — дефолт;
 *   { type: 'uuid', generate: 7 }             → v7 (unix-время в старших битах: btree-локальность);
 *   { type: 'uuid', generate: 5, from: […] }  → v5: sha1 от «схема:партиция:класс:значения from» —
 *     детерминированный id из концов/полей: та же комбинация → тот же id (идемпотентный create,
 *     дубль невозможен даже в гонке — оба запроса вычислят один id, второй станет версией).
 */
//
// FILE: lib/src/uuid.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Детерминированная (v5) и упорядоченная по времени (v7) генерация UUID для id сущностей.
//   SCOPE: namespace-константа LETOPIS_NS, форматирование 16 байт в каноничный UUID, v5 (sha1 от namespace+name), v7 (unix-ms в старших битах + random).
//   DEPENDS: none
//   LINKS: M-UUID, V-M-UUID
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LETOPIS_NS - фиксированный namespace letopis для uuidv5 (стабильность id между релизами).
//   fmt - (локальная) форматирует 16-байтный Buffer в каноничную строку UUID 8-4-4-4-12.
//   uuidv5 - RFC 4122 v5: детерминированный uuid = sha1(namespace + name).
//   uuidv7 - RFC 9562 v7: 48 бит unix-ms в старших битах + random.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Documented existing module: reverse-engineered contract + markup]
// END_CHANGE_SUMMARY
import { createHash, randomBytes } from 'node:crypto';

/** Namespace letopis для uuidv5 (фиксированная константа — стабильность id между релизами). */
export const LETOPIS_NS = 'c7a2f9d4-3b61-4e8a-9f05-8d2c1e6b7a90';

const fmt = (b: Buffer): string => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

// START_CONTRACT: uuidv5
//   PURPOSE: Детерминированный UUID v5 из имени и namespace (одно имя → один uuid).
//   INPUTS: { name: string - имя (склеенные значения from класса), ns: string - namespace (default LETOPIS_NS) }
//   OUTPUTS: { string - каноничный UUID v5 (version=5, variant=10xx) }
//   SIDE_EFFECTS: none (чистая функция — только хэширование входа)
//   LINKS: M-UUID, V-M-UUID
// END_CONTRACT: uuidv5
/** RFC 4122 v5: sha1(namespace + name); детерминирован — одно имя → один uuid. */
export function uuidv5(name: string, ns: string = LETOPIS_NS): string {
  const nsBytes = Buffer.from(ns.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(nsBytes).update(name, 'utf8').digest().subarray(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50; // version 5
  h[8] = (h[8] & 0x3f) | 0x80; // variant 10xx
  return fmt(h);
}

// START_CONTRACT: uuidv7
//   PURPOSE: Упорядоченный по времени UUID v7 — 48 бит unix-ms в старших битах + random.
//   INPUTS: { none }
//   OUTPUTS: { string - каноничный UUID v7 (version=7, variant=10xx) }
//   SIDE_EFFECTS: недетерминирован — читает Date.now() и криптослучайные байты (randomBytes)
//   LINKS: M-UUID, V-M-UUID
// END_CONTRACT: uuidv7
/** RFC 9562 v7: 48 бит unix-ms + random — время в старших битах, вставки ложатся в хвост индекса. */
export function uuidv7(): string {
  const b = Buffer.alloc(16);
  b.writeUIntBE(Date.now(), 0, 6);
  randomBytes(10).copy(b, 6);
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  return fmt(b);
}
