<script setup lang="ts">
/**
 * Песочница примера: исходник примера в редакторе, «Запустить на базе» — прогон на живой базе в свежей схеме
 * (`POST /api/run`, `server.mjs` → `scripts/sandbox-run.ts`). Снимок прогона уходит в тот же плеер (`result`).
 * Работает, когда сайт открыт с сервера guide с включённой песочницей: контейнер (compose) или `npm run sandbox`.
 */
import { onMounted, ref } from 'vue';
import { withBase } from 'vitepress';

const props = defineProps<{ id: string }>();
// result: снимок с метками и тот же прогон с настоящими значениями (вкладка «Реальная таблица»; null — сервер их не прислал)
const emit = defineEmits<{ result: [snapshot: unknown, real: unknown]; reset: [] }>();
const sources = import.meta.glob<string>('../../examples/**/*.ts', { query: '?raw', import: 'default' });

const original = ref('');
const code = ref('');
const enabled = ref<boolean | null>(null);
const running = ref(false);
const ran = ref(false);
const error = ref('');
const failures = ref<string[]>([]);
const logs = ref('');

onMounted(async () => {
  const load = sources[`../../examples/${props.id}.ts`];
  original.value = code.value = load ? await load() : '';
  try {
    const r = await fetch(withBase('/api/sandbox'));
    enabled.value = r.ok && (await r.json()).enabled === true;
  } catch {
    enabled.value = false;
  }
});

async function run() {
  running.value = true;
  error.value = '';
  failures.value = [];
  logs.value = '';
  try {
    const r = await fetch(withBase('/api/run'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: props.id, source: code.value }),
    });
    const body = await r.json().catch(() => ({ error: `сервер ответил ${r.status}` }));
    logs.value = body.logs ?? '';
    if (!r.ok || body.error) {
      error.value = body.error ?? `сервер ответил ${r.status}`;
      return;
    }
    failures.value = body.failures ?? [];
    ran.value = true;
    emit('result', body.snapshot, body.real ?? null);
  } catch {
    error.value = 'сервер песочницы недоступен';
  } finally {
    running.value = false;
  }
}

function back() {
  ran.value = false;
  failures.value = [];
  emit('reset');
}

// Tab в редакторе вставляет два пробела, а не уводит фокус к следующему полю.
function onTab(e: KeyboardEvent) {
  const t = e.target as HTMLTextAreaElement;
  const { selectionStart: a, selectionEnd: b } = t;
  code.value = code.value.slice(0, a) + '  ' + code.value.slice(b);
  requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
}
</script>

<template>
  <div class="lt-sbx">
    <p class="lt-sbx-warn">
      <strong>Песочница выполняет код на вашей машине</strong> — с доступом к базе стенда. Поэтому сервер слушает
      только 127.0.0.1 и принимает запросы только со страниц этого сайта. Не открывайте его порт наружу.
    </p>
    <p v-if="enabled === false" class="lt-sbx-off">
      Сейчас песочница выключена: сайт открыт не с сервера guide или сервер запущен без песочницы. Код можно
      править, но запускать — нет. <a :href="withBase('/sandbox')">Как включить</a>.
    </p>
    <textarea
      :id="`sbx-${id.replace(/[^a-z0-9]+/gi, '-')}`"
      v-model="code"
      name="source"
      class="lt-sbx-code"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      aria-label="Исходник примера"
      @keydown.tab.prevent="onTab"
    />
    <div class="lt-sbx-bar">
      <button class="lt-btn primary" :disabled="!enabled || running || !code.trim()" @click="run">
        {{ running ? 'Идёт прогон…' : 'Запустить на базе' }}
      </button>
      <button class="lt-btn ghost" :disabled="code === original" @click="code = original">Вернуть исходный код</button>
      <button v-if="ran" class="lt-btn ghost" @click="back">Показать записанный снимок</button>
      <span v-if="running" class="lt-sbx-hint">свежая схема, установка и шаги — обычно несколько секунд</span>
    </div>
    <div v-if="error" class="lt-sbx-error"><strong>Прогон не получился:</strong> {{ error }}</div>
    <div v-if="failures.length" class="lt-sbx-failures">
      <strong>Замечания прогона</strong> (шаг упал не так, как обещает пример, — так сверка ловит изменения):
      <ul><li v-for="(f, k) in failures" :key="k">{{ f }}</li></ul>
    </div>
    <details v-if="logs" class="lt-sbx-logs">
      <summary>Что напечатал прогон</summary>
      <pre>{{ logs }}</pre>
    </details>
  </div>
</template>

<style scoped>
.lt-sbx { margin: 12px 0 4px; padding: 12px; border: 1px dashed var(--vp-c-brand-1); border-radius: 10px; background: var(--vp-c-bg-soft); }
.lt-sbx-warn { margin: 0 0 8px; font-size: 13px; color: var(--vp-c-text-2); }
.lt-sbx-off { margin: 0 0 8px; font-size: 13px; color: var(--vp-c-warning-1); }
.lt-sbx-code {
  display: block;
  width: 100%;
  min-height: 320px;
  resize: vertical;
  padding: 10px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-code-block-bg);
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.55;
  tab-size: 2;
  white-space: pre;
}
.lt-sbx-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.lt-sbx-hint { font-size: 12px; color: var(--vp-c-text-3); }
.lt-sbx-error { margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: var(--vp-c-danger-soft); color: var(--vp-c-danger-1); font-size: 13px; white-space: pre-wrap; }
.lt-sbx-failures { margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: var(--vp-c-warning-soft); font-size: 13px; }
.lt-sbx-failures ul { margin: 4px 0 0; }
.lt-sbx-logs { margin-top: 8px; font-size: 13px; }
.lt-sbx-logs pre { max-height: 260px; overflow: auto; font-size: 12px; background: var(--vp-c-bg); padding: 8px; border-radius: 6px; }
.lt-btn {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 4px 12px;
  font-size: 14px;
  background: var(--vp-c-bg-soft);
  cursor: pointer;
}
.lt-btn.primary { background: var(--vp-c-brand-1); color: var(--vp-c-white); border-color: var(--vp-c-brand-1); }
.lt-btn.ghost { background: transparent; }
.lt-btn:disabled { opacity: 0.4; cursor: default; }
</style>
