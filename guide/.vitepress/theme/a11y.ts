/**
 * Подписи для чтеца экрана, которые тема VitePress 1.6 держит по-английски в коде компонентов (`themeConfig` их не
 * настраивает): переводятся в DOM после отрисовки, на каждом переходе по сайту (`index.ts`). Настраиваемые подписи
 * (`skipToContentLabel`, `sidebarMenuLabel`, перевод поиска и т. п.) — в config.ts.
 */
const LABELS: [selector: string, attr: 'aria-label' | 'title' | 'text', value: string][] = [
  ['.VPNavBarHamburger', 'aria-label', 'Меню'], // VPNavBarHamburger.vue: «mobile navigation»
  ['.VPNavBarExtra button', 'aria-label', 'Ещё'], // VPNavBarExtra.vue: «extra navigation»
  ['#main-nav-aria-label', 'text', 'Основное меню'], // VPNavBarMenu.vue: «Main Navigation»
  ['#sidebar-aria-label', 'text', 'Главы'], // VPSidebar.vue: «Sidebar Navigation»
  ['#doc-footer-aria-label', 'text', 'Соседние страницы'], // VPDocFooter.vue: «Pager»
  ['.VPSidebarItem .caret[aria-label]', 'aria-label', 'Свернуть или развернуть раздел'], // VPSidebarItem.vue: «toggle section»
  ['.vp-doc div[class*="language-"] > button.copy', 'title', 'Копировать код'], // markdown codeCopyButtonTitle: «Copy Code»
];

export function localizeLabels(): void {
  for (const [selector, attr, value] of LABELS) {
    for (const el of document.querySelectorAll(selector)) {
      if (attr === 'text') {
        if (el.textContent?.trim() !== value) el.textContent = value;
      } else el.setAttribute(attr, value);
    }
  }
  // «Ctrl K» на кнопке поиска — подсказка для зрячих: имя кнопки для чтеца («Поиск») совпадает с видимой подписью
  document.querySelector('.DocSearch-Button-Keys')?.setAttribute('aria-hidden', 'true');
}
