import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import Example from './Example.vue';
import Flow from './Flow.vue';
import Mermaid from './Mermaid.vue';
import TimeTravel from './TimeTravel.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Example', Example);
    app.component('Mermaid', Mermaid);
    app.component('Flow', Flow);
    app.component('TimeTravel', TimeTravel);
  },
} satisfies Theme;
