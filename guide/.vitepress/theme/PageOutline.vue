<script setup lang="ts">
/**
 * «На странице» в начале текста на узком экране. В обычной теме VitePress оглавление страницы — либо колонка справа
 * (только от 1280 px), либо свёрнутая кнопка в полосе под шапкой: на телефоне её не находят, и длинную главу листают
 * целиком. Здесь — разделы второго уровня (h2) страницы раскрытым блоком над текстом; на широком экране блок скрыт
 * (style.css), там есть колонка справа. Блок можно свернуть.
 */
import { nextTick, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vitepress';

interface Head { id: string; title: string }

const route = useRoute();
const heads = ref<Head[]>([]);

/** Текст заголовка без значка якоря и бейджей — как у оглавления темы. */
function title(h: Element): string {
  let s = '';
  for (const n of h.childNodes) {
    if (n.nodeType === 3) s += n.textContent;
    else if (n.nodeType === 1 && !/\b(header-anchor|VPBadge|ignore-header)\b/.test((n as Element).className)) s += n.textContent;
  }
  return s.trim();
}

function collect() {
  heads.value = [...document.querySelectorAll('.VPDoc .vp-doc h2')]
    .filter((h) => h.id)
    .map((h) => ({ id: h.id, title: title(h) }));
}

onMounted(() => void nextTick(() => requestAnimationFrame(collect)));
watch(() => route.path, () => void nextTick(() => requestAnimationFrame(collect)));
</script>

<template>
  <details v-if="heads.length >= 3" class="lt-outline" open>
    <summary>На странице</summary>
    <ol>
      <li v-for="h in heads" :key="h.id"><a :href="`#${h.id}`">{{ h.title }}</a></li>
    </ol>
  </details>
</template>

<style scoped>
.lt-outline {
  margin: 0 0 20px;
  padding: 8px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  font-size: 14px;
}
.lt-outline summary { cursor: pointer; font-weight: 600; color: var(--vp-c-text-1); padding: 4px 0; }
.lt-outline ol { margin: 4px 0 4px; padding-left: 20px; }
.lt-outline li { margin: 2px 0; line-height: 1.5; }
.lt-outline a { color: var(--vp-c-brand-1); text-decoration: none; }
.lt-outline a:hover { text-decoration: underline; }
@media (min-width: 1280px) {
  .lt-outline { display: none; }
}
</style>
