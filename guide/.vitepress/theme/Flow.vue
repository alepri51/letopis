<script setup lang="ts">
/**
 * Схема процесса, синхронная с плеером примера на той же странице: стадии текущего шага подсвечены.
 * Схема и соответствие «шаг примера → стадии» — в `flows.ts`; текущий шаг плеер сообщает через `sync.ts`.
 * Номера под схемой листают плеер.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useData } from 'vitepress';
import { flows } from './flows';
import { players, want } from './sync';
import { keepHash } from './anchor';

const props = defineProps<{ name: string }>();
const flow = computed(() => flows[props.name] ?? null);
const { isDark } = useData();
const box = ref<HTMLElement | null>(null);
const error = ref('');
const step = computed(() => (flow.value ? players[flow.value.example]?.step ?? 0 : 0));
const cur = computed(() => flow.value?.steps[step.value + 1] ?? null);
const numbers = computed(() => Object.keys(flow.value?.steps ?? {}).map(Number).sort((a, b) => a - b));
let seq = 0;
let queue: Promise<void> = Promise.resolve();

async function render() {
  if (!box.value || !flow.value) return;
  const mermaid = (await import('mermaid')).default;
  mermaid.initialize({ startOnLoad: false, theme: isDark.value ? 'dark' : 'default', securityLevel: 'strict' });
  const nodes = cur.value?.nodes ?? [];
  const now = isDark.value
    ? 'fill:#6b4f00,stroke:#fbbf24,stroke-width:3px,color:#fff'
    : 'fill:#fde68a,stroke:#d97706,stroke-width:3px,color:#111';
  const code = flow.value.code + (nodes.length ? `\n  classDef now ${now}\n  class ${nodes.join(',')} now` : '');
  try {
    const { svg } = await mermaid.render(`flow-${props.name}-${seq++}`, code);
    box.value.innerHTML = svg;
    keepHash(); // схема выросла — якорь адреса мог уехать
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

// перерисовки по очереди: две одновременные отрисовки Mermaid мешают друг другу
const schedule = () => (queue = queue.then(render));
onMounted(schedule);
watch([isDark, step], schedule);
</script>

<template>
  <div v-if="flow" class="lt-flow">
    <div class="lt-flow-head">
      <span class="lt-flow-badge">Схема процесса</span>
      <span class="lt-flow-title">{{ flow.title }}</span>
    </div>
    <div ref="box" class="lt-flow-svg" />
    <pre v-if="error" class="lt-flow-error">Схема не нарисовалась: {{ error }}</pre>
    <div class="lt-flow-now">
      <strong>Шаг {{ step + 1 }} примера:</strong> {{ cur?.note ?? 'этот шаг схему не затрагивает.' }}
    </div>
    <div class="lt-flow-steps">
      <span class="lt-flow-hint">Листать пример:</span>
      <button
        v-for="n in numbers"
        :key="n"
        class="lt-flow-dot"
        :class="{ active: n === step + 1 }"
        :title="flow.steps[n].note"
        @click="want(flow.example, n - 1)"
      >{{ n }}</button>
    </div>
  </div>
  <div v-else class="lt-flow-error">Схемы «{{ name }}» нет в flows.ts.</div>
</template>

<style scoped>
.lt-flow { margin: 20px 0; padding: 12px 14px; border: 1px solid var(--vp-c-divider); border-radius: 10px; background: var(--vp-c-bg-soft); }
.lt-flow-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.lt-flow-badge {
  font-size: 12px;
  font-weight: 600;
  color: var(--vp-c-warning-1);
  background: var(--vp-c-warning-soft);
  border-radius: 999px;
  padding: 2px 10px;
}
.lt-flow-title { font-weight: 700; }
.lt-flow-svg { overflow-x: auto; text-align: center; margin: 10px 0 6px; }
.lt-flow-now { font-size: 14px; }
.lt-flow-steps { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 8px; }
.lt-flow-hint { font-size: 12px; color: var(--vp-c-text-3); }
.lt-flow-dot { width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--vp-c-divider); background: var(--vp-c-bg); font-size: 12px; cursor: pointer; }
.lt-flow-dot.active { background: var(--vp-c-warning-1); color: var(--vp-c-white); border-color: var(--vp-c-warning-1); }
.lt-flow-error { color: var(--vp-c-danger-1); white-space: pre-wrap; }
</style>
