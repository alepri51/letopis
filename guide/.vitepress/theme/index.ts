import DefaultTheme from 'vitepress/theme';
import { useRoute, type Theme } from 'vitepress';
import { defineComponent, h, nextTick, onMounted, watch } from 'vue';
import Example from './Example.vue';
import Flow from './Flow.vue';
import Mermaid from './Mermaid.vue';
import TimeTravel from './TimeTravel.vue';
import NavChapters from './NavChapters.vue';
import PageOutline from './PageOutline.vue';
import { annotate } from './glossary';
import { resetTouch } from './anchor';
import { localizeLabels } from './a11y';
import './style.css';

/** Обычная разметка темы, главы в меню-гамбургере, «На странице» над текстом на узком экране, русские подписи для чтеца экрана (a11y.ts) и подсказки глоссария в тексте каждой страницы (кроме самого глоссария). */
const Layout = defineComponent({
  setup() {
    const route = useRoute();
    const run = () => void nextTick(() => requestAnimationFrame(() => {
      localizeLabels();
      const doc = document.querySelector<HTMLElement>('.vp-doc');
      if (doc && !route.path.includes('/glossary/')) annotate(doc, route.path);
    }));
    onMounted(run);
    watch(() => route.path, () => {
      resetTouch();
      run();
    });
    // в меню-гамбургере узкого экрана — ещё и главы (иначе они только за кнопкой «Главы» под шапкой);
    // над текстом страницы на узком экране — свёрнутые «Разделы главы» (PageOutline)
    return () => h(DefaultTheme.Layout, null, {
      'nav-screen-content-after': () => h(NavChapters),
      'doc-before': () => h(PageOutline),
    });
  },
});

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('Example', Example);
    app.component('Mermaid', Mermaid);
    app.component('Flow', Flow);
    app.component('TimeTravel', TimeTravel);
  },
} satisfies Theme;
