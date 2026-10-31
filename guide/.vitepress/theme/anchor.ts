/**
 * Якорь адреса (#…) на странице с плеерами примеров. Плееры догружают снимки и сдвигают цель вниз. После каждой
 * загрузки цель возвращается на место — пока читатель сам не начал листать или нажимать клавиши (тогда страницу
 * больше не трогаем до следующего перехода).
 * При переходе по сайту VitePress прокручивает к якорю в кадре анимации, а позицию считает ещё до загрузки плееров
 * (vitepress/dist/client/app/router.js, scrollTo). Если кадр запоздал (занятый процессор, фоновая вкладка), он
 * вернул бы страницу к старой позиции уже после всех загрузок. Поэтому цель ставится на место ещё и в ближайшем
 * кадре: кадры исполняются в порядке заказа, и наш идёт после кадра VitePress.
 */
let touched = false;
if (typeof window !== 'undefined') {
  for (const ev of ['wheel', 'touchmove', 'keydown', 'mousedown']) {
    window.addEventListener(ev, () => { touched = true; }, { passive: true, capture: true });
  }
}

/** Новый переход по сайту: следить за якорем снова. */
export function resetTouch(): void {
  touched = false;
}

/** Цель якоря — к верху окна, если читатель ещё не листал страницу. */
function put(): void {
  if (touched || !location.hash) return;
  document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ block: 'start' });
}

/** Вернуть цель якоря к верху окна сейчас и ещё раз в ближайшем кадре, если читатель ещё не листал страницу. */
export function keepHash(): void {
  if (typeof window === 'undefined' || touched || !location.hash) return;
  put();
  requestAnimationFrame(put);
}
