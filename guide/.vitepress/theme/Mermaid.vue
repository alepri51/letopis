<script setup lang="ts">
// Схема Mermaid: рисуется в браузере, перерисовывается при смене темы. Отрисовка и масштаб — mermaid.ts.
import { onMounted, ref, watch } from 'vue';
import { useData } from 'vitepress';
import { keepHash } from './anchor';
import { fitSvg, renderMermaid } from './mermaid';

const props = defineProps<{ code: string }>();
const { isDark } = useData();
const box = ref<HTMLElement | null>(null);
const error = ref('');
// широкая схема (ER на много классов) ужата под колонку (не мельче MIN_SCALE, дальше — прокрутка вбок) — её можно
// показать в натуральную величину
const wide = ref(false);
const full = ref(false);
let seq = 0;

function toggle() {
  full.value = !full.value;
  if (box.value) fitSvg(box.value, full.value);
}

async function render() {
  if (!box.value) return;
  try {
    const svg = await renderMermaid(`mmd-${Math.random().toString(36).slice(2)}-${seq++}`, decodeURIComponent(props.code), isDark.value);
    if (!box.value) return;
    box.value.innerHTML = svg;
    const natural = fitSvg(box.value, full.value);
    wide.value = natural > box.value.clientWidth * 1.3;
    keepHash(); // схема выросла — якорь адреса мог уехать
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(render);
watch([isDark, () => props.code], render);
</script>

<template>
  <div class="lt-mermaid">
    <button v-if="wide" type="button" class="lt-mermaid-zoom" @click="toggle">{{ full ? 'Вернуть обычный масштаб' : 'Схема мелкая? Показать в натуральную величину' }}</button>
    <div ref="box" class="lt-mermaid-svg" />
    <pre v-if="error" class="lt-mermaid-error">Схема не нарисовалась: {{ error }}</pre>
  </div>
</template>

<style scoped>
.lt-mermaid {
  margin: 16px 0;
  padding: 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  text-align: center;
}
/* прокрутка вбок — у схемы, а не у рамки: кнопка масштаба остаётся на месте */
.lt-mermaid-svg {
  overflow-x: auto;
}
.lt-mermaid-zoom {
  display: block;
  margin: 0 0 8px auto;
  padding: 2px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  font-size: 13px;
  cursor: pointer;
}
.lt-mermaid-error {
  color: var(--vp-c-danger-1);
  white-space: pre-wrap;
  text-align: left;
}
</style>
