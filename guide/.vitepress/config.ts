import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import { withPreviews } from './preview';
import { standalonePlugin } from './standalone';

// каталог guide/: снимки примеров (превью в разметке) и исходники примеров (самостоятельный вариант)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
  // песочница: dev-сервер (5173) отправляет /api на сервер сайта с включённой песочницей (`npm run sandbox`, 8080)
  // ?standalone — самостоятельный вариант примера для кнопки «Весь код примера» (.vitepress/standalone.ts)
  vite: {
    server: { proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true } } },
    plugins: [standalonePlugin(ROOT)],
  },
  markdown: {
    // ```mermaid → компонент <Mermaid>: схема рисуется в браузере
    config(md) {
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const t = tokens[idx];
        if (t.info.trim() === 'mermaid') return `<Mermaid code="${encodeURIComponent(t.content)}" />`;
        return fence(tokens, idx, options, env, self);
      };
      // <Example id="…" /> → с превью внутри: заголовок и код первого шага видны, пока плеер грузит снимок
      md.core.ruler.push('lt-example-preview', (state) => {
        for (const t of state.tokens) {
          if ((t.type === 'html_block' || t.type === 'html_inline') && t.content.includes('<Example')) t.content = withPreviews(t.content, ROOT);
        }
      });
    },
  },
  themeConfig: {
    nav: [
      { text: 'Начать', link: '/first/' },
      { text: 'Справочник API', link: '/reference/' },
      { text: 'Сервисы-примеры', link: '/services/' },
    ],
    sidebar: [
      {
        text: 'Основы',
        items: [
          { text: 'Первые 15 минут', link: '/first/' },
          { text: 'Старт с нуля', link: '/start/' },
          { text: '1. Что такое letopis', link: '/basics/what-is' },
          { text: '2. Установка и подключение', link: '/install/' },
          { text: '3. Модели', link: '/models/' },
          { text: '4. Запись', link: '/write/' },
          { text: '5. Чтение', link: '/read/' },
          { text: '6. Удаление и восстановление', link: '/delete/' },
          { text: '7. Транзакции и деньги', link: '/money/' },
          { text: '8. Арендаторы и права', link: '/access/' },
          { text: '9. Вход', link: '/auth/' },
          { text: '10. История и время', link: '/history/' },
          { text: '11. Подписка, кэш, сигналы', link: '/watch/' },
          { text: '12. Массовая загрузка', link: '/load/' },
          { text: '13. Эксплуатация', link: '/ops/' },
          { text: '14. ИИ-агенты: MCP', link: '/mcp/' },
          { text: '15. Ошибки', link: '/errors/' },
          { text: '16. Все нюансы', link: '/nuances/' },
          { text: 'Карта понятий', link: '/concepts/' },
          { text: 'Глоссарий', link: '/glossary/' },
          { text: 'Песочница', link: '/sandbox' },
        ],
      },
      {
        text: 'Справочник API',
        items: [
          { text: 'Обзор', link: '/reference/' },
          { text: 'Цепочка', link: '/reference/chain' },
          { text: 'Корень db', link: '/reference/db' },
          { text: 'Вход: db.auth', link: '/reference/auth' },
          { text: 'Права: db.acl', link: '/reference/acl' },
          { text: 'Подписка и кэш', link: '/reference/watch' },
          { text: 'Загрузка', link: '/reference/load' },
          { text: 'Установка и подключение', link: '/reference/setup' },
          { text: 'Модели: letopis/model', link: '/reference/model' },
          { text: 'Служебные экспорты', link: '/reference/utils' },
          { text: 'MCP: letopis/mcp', link: '/reference/mcp' },
          { text: 'Командная строка', link: '/reference/cli' },
          { text: 'Типы', link: '/reference/types' },
        ],
      },
      {
        text: 'Сервисы-примеры',
        items: [
          { text: 'Обзор', link: '/services/' },
          { text: 'Салон записи', link: '/services/salon' },
          { text: 'Кошелёк и биллинг', link: '/services/wallet' },
          { text: 'Helpdesk', link: '/services/helpdesk' },
          { text: 'Документы с аудитом', link: '/services/documents' },
        ],
      },
    ],
    outline: { level: [2, 3], label: 'На странице' },
    docFooter: { prev: 'Назад', next: 'Дальше' },
    darkModeSwitchLabel: 'Тема',
    lightModeSwitchTitle: 'Светлая тема',
    darkModeSwitchTitle: 'Тёмная тема',
    sidebarMenuLabel: 'Главы',
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
