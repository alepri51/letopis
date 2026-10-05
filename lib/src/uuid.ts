/**
 * Генерация id по Schema (attributes.id):
 *   "uuid"                                    → v4 (random) — дефолт;
 *   { type: 'uuid', generate: 7 }             → v7 (unix-время в старших битах: btree-локальность);
 *   { type: 'uuid', generate: 5, from: […] }  → v5: sha1 от «схема:партиция:класс:значения from» —
 *     детерминированный id из концов/полей: та же комбинация → тот же id (идемпотентный create,
 *     дубль невозможен даже в гонке — оба запроса вычислят один id, второй станет версией).
 */
import { createHash, randomBytes } from 'node:crypto';

/** Namespace letopis для uuidv5 (фиксированная константа — стабильность id между релизами). */
export const LETOPIS_NS = 'c7a2f9d4-3b61-4e8a-9f05-8d2c1e6b7a90';

const fmt = (b: Buffer): string => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/** RFC 4122 v5: sha1(namespace + name); детерминирован — одно имя → один uuid. */
export function uuidv5(name: string, ns: string = LETOPIS_NS): string {
  const nsBytes = Buffer.from(ns.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(nsBytes).update(name, 'utf8').digest().subarray(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50; // version 5
  h[8] = (h[8] & 0x3f) | 0x80; // variant 10xx
  return fmt(h);
}

/** RFC 9562 v7: 48 бит unix-ms + random — время в старших битах, вставки ложатся в хвост индекса. */
export function uuidv7(): string {
  const b = Buffer.alloc(16);
  b.writeUIntBE(Date.now(), 0, 6);
  randomBytes(10).copy(b, 6);
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  return fmt(b);
}
