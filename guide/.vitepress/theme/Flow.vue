<script setup lang="ts">
/**
 * Схема процесса, синхронная с плеером примера на той же странице: стадии текущего шага подсвечены.
 * Схема и соответствие «шаг примера → стадии» — в `flows.ts`; текущий шаг плеер сообщает через `sync.ts`.
 * Номера под схемой листают плеер. Если плеера на странице нет (главы разделены на «как сделать» и «что внутри», пример
 * — на соседней странице), номера листают саму схему, а рядом — ссылка на страницу примера (`examples.data.ts`).
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useData, withBase } from 'vitepress';
import { flows } from './flows';
import { exAnchor, players, want } from './sync';
import { keepHash } from './anchor';
import { fitSvg, renderMermaid } from './mermaid';
import { data as examplePages } from './examples.data';

const props = defineProps<{ name: string }>();
const flow = computed(() => flows[props.name] ?? null);
const { isDark, page } = useData();
const box = ref<HTMLElement | null>(null);
const error = ref('');
// адрес страницы как у загрузчика данных: `write/inside.md` → `/write/inside`, `write/index.md` → `/write/`
const pageUrl = (rel: string) => '/' + rel.replace(/\.md$/, '').replace(/(^|\/)index$/, '$1');
const norm = (url: string) => url.replace(/\.html$/, '').replace(/(^|\/)index$/, '$1');
const homes = computed(() => (flow.value ? examplePages[flow.value.example] ?? [] : []));
// плеер примера — на этой странице: номера листают его; иначе — шаг схемы свой
const here = computed(() => homes.value.some((p) => norm(p.url) === pageUrl(page.value.relativePath)));
const away = computed(() => (here.value ? null : homes.value[0] ?? null));
const own = ref(0);
const step = computed(() => (!flow.value ? 0 : here.value ? players[flow.value.example]?.step ?? 0 : own.value));
const go = (n: number) => {
  if (!flow.value) return;
  if (here.value) want(flow.value.example, n - 1);
  else own.value = n - 1;
};
const cur = computed(() => flow.value?.steps[step.value + 1] ?? null);
const numbers = computed(() => Object.keys(flow.value?.steps ?? {}).map(Number).sort((a, b) => a - b));
let seq = 0;

// Отрисовка, общая очередь и масштаб (не мельче MIN_SCALE, шире — прокрутка вбок) — mermaid.ts.
async function render() {
  if (!box.value || !flow.value) return;
  const nodes = cur.value?.nodes ?? [];
  const now = isDark.value
    ? 'fill:#6b4f00,stroke:#fbbf24,stroke-width:3px,color:#fff'
    : 'fill:#fde68a,stroke:#d97706,stroke-width:3px,color:#111';
  const code = flow.value.code + (nodes.length ? `\n  classDef now ${now}\n  class ${nodes.join(',')} now` : '');
  try {
    const svg = await renderMermaid(`flow-${props.name}-${seq++}`, code, isDark.value);
    if (!box.value) return;
    box.value.innerHTML = svg;
    fitSvg(box.value);
    keepHash(); // схема выросла — якорь адреса мог уехать
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(render);
watch([isDark, step], render);
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
      <span class="lt-flow-hint">{{ here ? 'Листать пример:' : 'Шаги примера:' }}</span>
      <button
        v-for="n in numbers"
        :key="n"
        type="button"
        class="lt-flow-dot"
        :class="{ active: n === step + 1 }"
        :title="flow.steps[n].note"
        :aria-label="`Шаг ${n}: ${flow.steps[n].note}`"
        :aria-pressed="n === step + 1"
        @click="go(n)"
      >{{ n }}</button>
      <a v-if="away" class="lt-flow-away" :href="withBase(away.url) + '#' + exAnchor(flow.example)">Пример — на странице «{{ away.title }}»</a>
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
.lt-flow-hint { font-size: 12px; color: var(--vp-c-text-2); }
.lt-flow-dot { width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--vp-c-divider); background: var(--vp-c-bg); font-size: 12px; cursor: pointer; }
.lt-flow-dot.active { background: var(--vp-c-warning-1); color: var(--vp-c-bg); border-color: var(--vp-c-warning-1); }
.lt-flow-away { margin-left: 6px; font-size: 13px; }
.lt-flow-error { color: var(--vp-c-danger-1); white-space: pre-wrap; }
</style>
