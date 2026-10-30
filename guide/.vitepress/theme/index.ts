import DefaultTheme from 'vitepress/theme';
import { useRoute, type Theme } from 'vitepress';
import { defineComponent, h, nextTick, onMounted, watch } from 'vue';
import Example from './Example.vue';
import Flow from './Flow.vue';
import Mermaid from './Mermaid.vue';
import TimeTravel from './TimeTravel.vue';
import { annotate } from './glossary';
import './style.css';

/** Обычная разметка темы и подсказки глоссария в тексте каждой страницы (кроме самого глоссария). */
const Layout = defineComponent({
  setup() {
    const route = useRoute();
    const run = () => void nextTick(() => requestAnimationFrame(() => {
      const doc = document.querySelector<HTMLElement>('.vp-doc');
      if (doc && !route.path.includes('/glossary/')) annotate(doc, route.path);
    }));
    onMounted(run);
    watch(() => route.path, run);
    return () => h(DefaultTheme.Layout);
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
