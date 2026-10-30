<script setup lang="ts">
// Схема Mermaid: рисуется в браузере, перерисовывается при смене темы.
import { onMounted, ref, watch } from 'vue';
import { useData } from 'vitepress';
import { keepHash } from './anchor';

const props = defineProps<{ code: string }>();
const { isDark } = useData();
const box = ref<HTMLElement | null>(null);
const error = ref('');
let seq = 0;

async function render() {
  if (!box.value) return;
  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({ startOnLoad: false, theme: isDark.value ? 'dark' : 'default', securityLevel: 'strict' });
  try {
    const { svg } = await mermaid.render(`mmd-${Math.random().toString(36).slice(2)}-${seq++}`, decodeURIComponent(props.code));
    box.value.innerHTML = svg;
    keepHash(); // схема выросла — якорь адреса мог уехать
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(render);
watch(isDark, render);
</script>

<template>
  <div class="lt-mermaid">
    <div ref="box" />
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
  overflow-x: auto;
  text-align: center;
}
.lt-mermaid-error {
  color: var(--vp-c-danger-1);
  white-space: pre-wrap;
  text-align: left;
}
</style>
