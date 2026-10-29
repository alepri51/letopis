import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import Example from './Example.vue';
import Mermaid from './Mermaid.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Example', Example);
    app.component('Mermaid', Mermaid);
  },
} satisfies Theme;
