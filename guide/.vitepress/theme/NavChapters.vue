<script setup lang="ts">
/**
 * Главы сайта в меню-гамбургере (узкий экран). В обычной теме VitePress там только верхнее меню, а список глав
 * спрятан за отдельной кнопкой в полосе под шапкой — на телефоне её не находят. Здесь те же группы, что в боковой
 * панели (themeConfig.sidebar): первые две («Начать» и «Главы») открыты, остальные свёрнуты; переход по ссылке закрывает меню.
 */
import { computed, inject } from 'vue';
import { useData, useRoute, withBase } from 'vitepress';

interface Item { text?: string; link?: string; items?: Item[] }

const { theme } = useData();
const route = useRoute();
const closeScreen = inject<() => void>('close-screen', () => {});
const groups = computed<Item[]>(() => (Array.isArray(theme.value.sidebar) ? (theme.value.sidebar as Item[]) : []));
const norm = (p: string) => p.replace(/(index)?(\.html)?$/, '').replace(/\/$/, '') || '/';
const active = (link?: string) => !!link && norm(route.path) === norm(withBase(link));
const inGroup = (g: Item) => (g.items ?? []).some((it) => active(it.link));
</script>

<template>
  <nav v-if="groups.length" class="lt-nav-chapters" aria-label="Главы">
    <details v-for="(g, k) in groups" :key="g.text" class="lt-nav-group" :open="k < 2 || inGroup(g)">
      <summary>{{ g.text }}</summary>
      <ul>
        <li v-for="it in g.items" :key="it.link">
          <a :href="withBase(it.link ?? '/')" :class="{ active: active(it.link) }" @click="closeScreen()">{{ it.text }}</a>
        </li>
      </ul>
    </details>
  </nav>
</template>

<style scoped>
.lt-nav-chapters { margin-top: 16px; border-top: 1px solid var(--vp-c-divider); padding-top: 8px; }
.lt-nav-group summary {
  padding: 10px 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  cursor: pointer;
  list-style-position: inside;
}
.lt-nav-group ul { list-style: none; margin: 0 0 8px; padding: 0 0 0 14px; }
.lt-nav-group a {
  display: block;
  padding: 7px 0;
  font-size: 14px;
  line-height: 1.4;
  color: var(--vp-c-text-2);
  border-bottom: 1px solid var(--vp-c-divider);
}
.lt-nav-group a.active { color: var(--vp-c-brand-1); font-weight: 600; }
</style>
