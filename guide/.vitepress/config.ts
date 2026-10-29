import { defineConfig } from 'vitepress';

// Сайт только на русском и только локально (решение владельца от 29.10.2026).
export default defineConfig({
  lang: 'ru-RU',
  title: 'letopis',
  titleTemplate: ':title — letopis понятно',
  description: 'letopis простым языком: примеры на настоящих данных, схемы процессов, сервисы-примеры',
  srcDir: 'pages',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }]],
  cleanUrls: true,
  lastUpdated: false,
  markdown: {
    // ```mermaid → компонент <Mermaid>: схема рисуется в браузере
    config(md) {
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const t = tokens[idx];
        if (t.info.trim() === 'mermaid') return `<Mermaid code="${encodeURIComponent(t.content)}" />`;
        return fence(tokens, idx, options, env, self);
      };
    },
  },
  themeConfig: {
    nav: [
      { text: 'Начать', link: '/basics/what-is' },
      { text: 'Сервисы-примеры', link: '/services/' },
    ],
    sidebar: [
      {
        text: 'Основы',
        items: [
          { text: 'Старт с нуля', link: '/start/' },
          { text: '1. Что такое letopis', link: '/basics/what-is' },
          { text: '2. Установка и подключение', link: '/install/' },
          { text: '3. Модели', link: '/models/' },
          { text: '4. Запись', link: '/write/' },
          { text: '5. Чтение', link: '/read/' },
          { text: '6. Удаление и восстановление', link: '/delete/' },
          { text: '7. Транзакции и деньги', link: '/money/' },
          { text: '12. Агрегаты и проекторы', link: '/derived/' },
        ],
      },
      {
        text: 'Сервисы-примеры',
        items: [
          { text: 'Обзор', link: '/services/' },
          { text: 'Салон записи', link: '/services/salon' },
          { text: 'Кошелёк и биллинг', link: '/services/wallet' },
        ],
      },
    ],
    outline: { level: [2, 3], label: 'На странице' },
    docFooter: { prev: 'Назад', next: 'Дальше' },
    darkModeSwitchLabel: 'Тема',
    lightModeSwitchTitle: 'Светлая тема',
    darkModeSwitchTitle: 'Тёмная тема',
    sidebarMenuLabel: 'Меню',
    returnToTopLabel: 'Наверх',
    notFound: { title: 'Страница не найдена', quote: 'Такой страницы нет.', linkText: 'На главную' },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: 'Поиск', buttonAriaLabel: 'Поиск' },
          modal: {
            noResultsText: 'Ничего не найдено',
            resetButtonTitle: 'Сбросить',
            footer: { selectText: 'выбрать', navigateText: 'перейти', closeText: 'закрыть' },
          },
        },
      },
    },
  },
});
