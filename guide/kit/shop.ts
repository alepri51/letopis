/**
 * Модель магазина из главы 3 — общая для примеров глав о записи, чтении и удалении.
 * Магазин, дерево категорий, товар, покупатель (и VIP-покупатель), заказ и строка заказа.
 */
import { syncModels } from 'letopis';
import type { Db } from 'letopis';
import { hub, link, one, many } from 'letopis/model';
import { z } from 'zod';

export const Shop = hub('Shop', { name: z.string(), city: z.string().optional() }, { key: ['name'] });
export const Category = hub('Category', { name: z.string() }, {
  key: ['name'],
  ends: { Parent: one('Category').optional().onDelete('unset') },
});
export const Product = hub('Product', {
  sku: z.string(), title: z.string(), price: z.number().int().min(0), views: z.number().int().optional(),
  specs: z.object({ color: z.string().optional(), volume: z.number().optional() }).optional(),
  labels: z.array(z.string()).optional(),
}, {
  ends: { Shop, Category: many(Category, { max: 5, onDelete: 'unset' }) },
  key: ['Shop', 'sku'],
});
export const Customer = hub('Customer', { name: z.string(), email: z.string() }, {});
export const Vip = hub('Vip', { extends: Customer, fields: { discount: z.number().int().min(0).max(50) } });
export const Order = hub('Order', {
  number: z.string(), status: z.enum(['new', 'paid', 'cancelled']).default('new'),
}, { ends: { Customer, Shop }, key: ['Shop', 'number'] });
export const line = link('line', { qty: z.number().int().min(1), price: z.number().int().min(0) }, {
  ends: { Order: one(Order).onDelete('cascade'), Product },
  key: ['Order', 'Product'],
});

export const shopModels = [Shop, Category, Product, Customer, Vip, Order, line];

/** Записать модель магазина (шаг подготовки в примерах). */
export async function syncShop(db: Db): Promise<void> {
  await syncModels(db, shopModels, { apply: true });
}
