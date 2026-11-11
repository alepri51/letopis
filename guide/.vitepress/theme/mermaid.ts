/**
 * Отрисовка схем Mermaid для всего сайта (`Mermaid.vue`, `Flow.vue`): общая очередь, точный замер подписей и
 * масштаб схемы в колонке.
 *
 * Почему подписи обрезались. Mermaid 12 (`addHtmlSpan` в `mermaid/dist/chunks/mermaid.core/chunk-*.mjs`, исходник
 * `src/rendering-util/createText.ts`) кладёт подпись узла в `div` с `display: table-cell; white-space: nowrap;
 * max-width: 120px` (200px у подписей стрелок) и решает, переносить ли строки, строгим сравнением
 * `getBoundingClientRect().width === 120`. При дробном масштабе экрана (Windows 125–175 %) Chrome возвращает
 * 120.0000152…, сравнение ложно, перенос не включается — `div` остаётся одной строкой, ужатой до 120px, и хвост текста
 * срезается. Здесь на время отрисовки размеры таких `div` (прямые потомки `foreignObject`) округляются до 1/64 px —
 * единицы раскладки Chrome: 120.0000152 → 120, и Mermaid переносит подпись, как задумано.
 */

/** Две одновременные отрисовки Mermaid мешают друг другу (общие initialize и временный контейнер) — по очереди. */
let queue: Promise<unknown> = Promise.resolve();

const unit = (v: number) => Math.round(v * 64) / 64;

async function draw(id: string, code: string, dark: boolean): Promise<string> {
  const mermaid = (await import('mermaid')).default;
  // тёмная тема: подложка подписей стрелок #585858 под текстом #ccc — 4.4:1, ниже AA; #404040 — 6.5:1
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? 'dark' : 'default',
    securityLevel: 'strict',
    ...(dark ? { themeVariables: { edgeLabelBackground: '#404040' } } : {}),
  });
  const proto = Element.prototype;
  const rect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: Element) {
    const r = rect.call(this);
    return this.parentNode instanceof SVGForeignObjectElement ? new DOMRect(unit(r.x), unit(r.y), unit(r.width), unit(r.height)) : r;
  };
  try {
    return (await mermaid.render(id, code)).svg;
  } finally {
    proto.getBoundingClientRect = rect;
  }
}

/** SVG-разметка схемы; отрисовки идут по очереди. */
export function renderMermaid(id: string, code: string, dark: boolean): Promise<string> {
  const job = queue.then(() => draw(id, code, dark));
  queue = job.catch(() => undefined);
  return job;
}

/** Наименьший масштаб схемы в колонке: подпись 16px не мельче 12px. Шире — схема прокручивается вбок в своей рамке. */
export const MIN_SCALE = 0.75;

/**
 * Ширина нарисованной схемы: в колонку, но не крупнее натуральной величины и не мельче MIN_SCALE (тогда — прокрутка
 * внутри рамки, страница вбок не едет); full — натуральная величина. Возвращает натуральную ширину схемы.
 */
export function fitSvg(box: HTMLElement, full = false): number {
  const svg = box.querySelector('svg');
  if (!svg) return 0;
  const natural = svg.viewBox.baseVal?.width || svg.getBoundingClientRect().width;
  svg.style.maxWidth = `${natural}px`;
  svg.style.width = full ? `${natural}px` : '100%';
  svg.style.minWidth = `${Math.round(natural * (full ? 1 : MIN_SCALE))}px`;
  return natural;
}
