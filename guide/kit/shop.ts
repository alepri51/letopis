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

export interface ShopData {
  romashka: string; lutik: string;
  tea: string; green: string; dishes: string;
  kettle: string; sencha: string; puer: string; mug: string;
  olga: string; ivan: string; order1: string; order2: string;
}

/** Модель и данные магазина для примеров чтения и удаления (шаг подготовки). */
export async function seedShop(db: Db): Promise<ShopData> {
  await syncShop(db);
  const [romashka] = await db.Shop().create({ name: 'Ромашка', city: 'Казань' }).rows();
  const [lutik] = await db.Shop().create({ name: 'Лютик', city: 'Уфа' }).rows();
  const [tea] = await db.Category().create({ name: 'Чай' }).rows();
  const [green] = await db.Category().create({ name: 'Зелёный чай' }).Parent.set(tea).rows();
  const [dishes] = await db.Category().create({ name: 'Посуда' }).rows();
  const [kettle] = await db.Shop(romashka).Product()
    .create({ sku: 'K-1', title: 'Чайник', price: 2500, labels: ['хит', 'стекло'], specs: { color: 'белый', volume: 1.7 } }).Category.add(dishes).rows();
  const [sencha] = await db.Shop(romashka).Product()
    .create({ sku: 'T-7', title: 'Сенча', price: 900, labels: ['хит'] }).Category.add(green).rows();
  const [puer] = await db.Shop(romashka).Product().create({ sku: 'T-9', title: 'Пуэр', price: 1500 }).Category.add(tea).rows();
  const [mug] = await db.Shop(lutik).Product().create({ sku: 'M-1', title: 'Кружка', price: 400, labels: ['стекло'] }).Category.add(dishes).rows();
  const [olga] = await db.Customer().create({ name: 'Ольга', email: 'olga@mail.ru' }).rows();
  const [ivan] = await db.Vip().create({ name: 'Иван', email: 'ivan@mail.ru', discount: 10 }).rows();
  const [l1] = await db.Customer(olga).Order().create({ number: 'A-1' }).Shop.set(romashka)
    .line().create({ qty: 1, price: 2500 }).Product.set(kettle).rows();
  const order1 = l1.links.Order as string;
  await db.Order(order1).line().create({ qty: 2, price: 900 }).Product.set(sencha).rows();
  const [l2] = await db.Vip(ivan).Order().create({ number: 'A-2', status: 'paid' }).Shop.set(romashka)
    .line().create({ qty: 1, price: 1500 }).Product.set(puer).rows();
  return {
    romashka: romashka.id, lutik: lutik.id, tea: tea.id, green: green.id, dishes: dishes.id,
    kettle: kettle.id, sencha: sencha.id, puer: puer.id, mug: mug.id,
    olga: olga.id, ivan: ivan.id, order1, order2: l2.links.Order as string,
  };
}
