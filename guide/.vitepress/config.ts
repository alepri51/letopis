import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import { withPreviews } from './preview';
import { standalonePlugin } from './standalone';
import { deadAnchors } from './anchors';

// каталог guide/; примеры и их снимки (предпросмотр в разметке, самостоятельный вариант) — в корневом examples/, сайт их
// только читает
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = join(ROOT, '..', 'examples');

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
  // мёртвые якоря (`#…` на переименованный заголовок) — ошибка сборки: VitePress сам проверяет только страницы
  buildEnd(site) {
    const dead = deadAnchors(site.outDir);
    if (dead.length) throw new Error(`мёртвые якоря (${dead.length}):\n${dead.join('\n')}`);
  },
  // песочница: dev-сервер (5173) отправляет /api на сервер сайта с включённой песочницей (`npm run sandbox`, 8080)
  // ?standalone — самостоятельный вариант примера модулем (.vitepress/standalone.ts); программу примера в HTML страницы
  // вставляет preview.ts при сборке
  vite: {
    // dev-сервер отдаёт файлы вне guide/ только из разрешённых каталогов: примеры и снимки — в ../examples
    server: { proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true } }, fs: { allow: [ROOT, EXAMPLES] } },
    plugins: [standalonePlugin(ROOT)],
  },
  markdown: {
    // подпись кнопки копирования у блоков кода (по умолчанию — английское «Copy Code»)
    codeCopyButtonTitle: 'Копировать код',
    // ```mermaid → компонент <Mermaid>: схема рисуется в браузере
    config(md) {
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const t = tokens[idx];
        if (t.info.trim() === 'mermaid') return `<Mermaid code="${encodeURIComponent(t.content)}" />`;
        return fence(tokens, idx, options, env, self);
      };
      // <Example id="…" /> → с предпросмотром внутри: программа и её вывод видны, пока плеер грузит снимок
      md.core.ruler.push('lt-example-preview', (state) => {
        for (const t of state.tokens) {
          if ((t.type === 'html_block' || t.type === 'html_inline') && t.content.includes('<Example')) t.content = withPreviews(t.content, ROOT, state.md);
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
        text: 'Начать',
        items: [
          { text: 'Первые 15 минут: один процесс', link: '/first/' },
          { text: 'Старт с нуля: веб-сервис с пропуском', link: '/start/' },
          { text: 'Что такое letopis', link: '/basics/what-is' },
          { text: 'Карта понятий', link: '/concepts/' },
        ],
      },
      {
        text: 'Дом и люди',
        items: [
          { text: 'Дом, пропуск, консьерж', link: '/house/' },
          { text: 'Установка и подключение', link: '/install/' },
          { text: 'Приглашения и почтальон', link: '/invites/' },
          { text: 'Вход и ключи', link: '/auth/' },
          { text: 'Квартиры и права', link: '/access/' },
        ],
      },
      {
        text: 'Данные',
        items: [
          { text: 'Модели: какие бывают классы', link: '/models/' },
          { text: 'Модели: что внутри', link: '/models/inside' },
          { text: 'Запись: создать, изменить, заменить', link: '/write/' },
          { text: 'Запись: что внутри', link: '/write/inside' },
          { text: 'Чтение: цепочки, фильтры, страницы', link: '/read/' },
          { text: 'Удаление и восстановление', link: '/delete/' },
          { text: 'Удаление: что внутри', link: '/delete/inside' },
          { text: 'Транзакции и деньги', link: '/money/' },
          { text: 'История и время', link: '/history/' },
        ],
      },
      {
        text: 'Работа приложения',
        items: [
          { text: 'Подписка, кэш и сигналы', link: '/watch/' },
          { text: 'Массовая загрузка', link: '/load/' },
          { text: 'Эксплуатация', link: '/ops/' },
          { text: 'Логирование', link: '/logging/' },
          { text: 'ИИ-агенты: MCP', link: '/mcp/' },
          { text: 'Ошибки', link: '/errors/' },
          { text: 'Ошибки: все коды и ключи', link: '/errors/codes' },
          { text: 'Все нюансы', link: '/nuances/' },
        ],
      },
      {
        text: 'Рецепты',
        items: [
          { text: 'Веб-приложение с входом', link: '/recipes/web-login' },
          { text: 'Несколько квартир', link: '/recipes/rooms' },
          { text: 'Фоновые задачи консьержа', link: '/recipes/background' },
          { text: 'Отмена удаления в веб-сервисе', link: '/recipes/undo' },
        ],
      },
      {
        // вложенные списки — пункты со ссылкой: в меню узкого экрана (theme/NavChapters.vue) они остаются ссылками на обзор
        text: 'Справка',
        items: [
          {
            text: 'Справочник API',
            link: '/reference/',
            collapsed: true,
            items: [
              { text: 'Цепочка', link: '/reference/chain' },
              { text: 'Цепочка: запись', link: '/reference/write' },
              { text: 'Корень квартиры', link: '/reference/db' },
              { text: 'Вход, приглашения и ключи', link: '/reference/auth' },
              { text: 'Права: me.acl', link: '/reference/acl' },
              { text: 'Подписка и кэш', link: '/reference/watch' },
              { text: 'Загрузка', link: '/reference/load' },
              { text: 'Дом и консьерж', link: '/reference/setup' },
              { text: 'Модели: letopis/model', link: '/reference/model' },
              { text: 'Операторы фильтров', link: '/reference/filters' },
              { text: 'Служебные экспорты', link: '/reference/utils' },
              { text: 'MCP: letopis/mcp', link: '/reference/mcp' },
              { text: 'Командная строка', link: '/reference/cli' },
              { text: 'Типы', link: '/reference/types' },
              { text: 'Типы: цепочка и запись', link: '/reference/types-chain' },
              { text: 'Типы: модели', link: '/reference/types-model' },
              { text: 'Типы: строгие типы', link: '/reference/types-typed' },
              { text: 'Типы: права', link: '/reference/types-access' },
              { text: 'Типы: подписка, кэш, загрузка, MCP', link: '/reference/types-watch' },
              { text: 'Типы: журнал', link: '/reference/types-log' },
              { text: 'Типы: дом, консьерж, ключи, ошибки', link: '/reference/types-setup' },
            ],
          },
          { text: 'Глоссарий', link: '/glossary/' },
          { text: 'Песочница', link: '/sandbox' },
          {
            text: 'Сервисы-примеры',
            link: '/services/',
            collapsed: true,
            items: [
              { text: 'Салон записи', link: '/services/salon' },
              { text: 'Кошелёк и биллинг', link: '/services/wallet' },
              { text: 'Helpdesk', link: '/services/helpdesk' },
              { text: 'Документы с аудитом', link: '/services/documents' },
            ],
          },
          { text: 'Лицензия', link: '/license/' },
        ],
      },
    ],
    // подвал на всех страницах (на страницах с боковой панелью его показывает theme/style.css)
    footer: {
      message: 'Исходный код доступен; некоммерческое использование бесплатно: <a href="/license/">PolyForm Noncommercial 1.0.0</a>, коммерческое — по разрешению владельца. Версии до 2.0.0 включительно — MIT.',
      copyright: 'Copyright 2026 <a href="https://github.com/alepri51">alepri51</a> · <a href="https://github.com/alepri51/letopis">исходники на GitHub</a>',
    },
    outline: { level: [2, 3], label: 'На странице' },
    docFooter: { prev: 'Назад', next: 'Дальше' },
    darkModeSwitchLabel: 'Тема',
    lightModeSwitchTitle: 'Светлая тема',
    darkModeSwitchTitle: 'Тёмная тема',
    sidebarMenuLabel: 'Главы',
    returnToTopLabel: 'Наверх',
    skipToContentLabel: 'К тексту страницы',
    notFound: { title: 'Страница не найдена', quote: 'Такой страницы нет.', linkText: 'На главную', linkLabel: 'На главную' },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: 'Поиск', buttonAriaLabel: 'Поиск' },
          modal: {
            noResultsText: 'Ничего не найдено',
            resetButtonTitle: 'Сбросить',
            backButtonTitle: 'Закрыть поиск',
            displayDetails: 'Показать подробности',
            footer: {
              selectText: 'выбрать',
              selectKeyAriaLabel: 'Ввод',
              navigateText: 'перейти',
              navigateUpKeyAriaLabel: 'Стрелка вверх',
              navigateDownKeyAriaLabel: 'Стрелка вниз',
              closeText: 'закрыть',
              closeKeyAriaLabel: 'Escape',
            },
          },
        },
      },
    },
  },
});
