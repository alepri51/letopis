/**
 * Якорь адреса (#…) на странице с плеерами примеров. Плееры догружают снимки уже после того, как VitePress
 * прокрутил страницу к якорю, и сдвигают цель вниз. После каждой загрузки цель возвращается на место — пока
 * читатель сам не начал листать или нажимать клавиши (тогда страницу больше не трогаем до следующего перехода).
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

/** Вернуть цель якоря к верху окна, если читатель ещё не листал страницу. */
export function keepHash(): void {
  if (typeof window === 'undefined' || touched || !location.hash) return;
  document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ block: 'start' });
}
