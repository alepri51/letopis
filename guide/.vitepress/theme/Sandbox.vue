<script setup lang="ts">
/**
 * Песочница примера: в редакторе — та же самостоятельная программа, что на странице (`examples/….ts?standalone`),
 * «Запустить на базе» выполняет её на живой базе (`POST /api/run` → `server.mjs` → `examples/_runner/sandbox.ts`) и
 * показывает, что она напечатала. Прогоны идут по одному: пока выполняется чужой, запрос ждёт в очереди сервера.
 * Работает, когда сайт открыт с сервера guide с включённой песочницей: контейнер (compose) или `npm run sandbox`.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { withBase } from 'vitepress';

const props = defineProps<{ id: string }>();
const programs = import.meta.glob<string>(['../../../examples/*/*.ts', '!../../../examples/_*/**'], { query: '?standalone', import: 'default' });

const original = ref('');
const code = ref('');
const enabled = ref<boolean | null>(null);
const running = ref(false);
// пока запрос ждёт ответа: сколько прогонов на сервере впереди (null — неизвестно)
const waiting = ref<string>('');
const error = ref('');
const output = ref<string | null>(null);
const exitCode = ref<number | null>(null);
const ms = ref<number | null>(null);

onMounted(async () => {
  const load = programs[`../../../examples/${props.id}.ts`];
  original.value = code.value = load ? await load() : '';
  try {
    const r = await fetch(withBase('/api/sandbox'));
    enabled.value = r.ok && (await r.json()).enabled === true;
  } catch {
    enabled.value = false;
  }
});

let poll: ReturnType<typeof setInterval> | null = null;
const stopPoll = () => {
  if (poll) clearInterval(poll);
  poll = null;
};
onBeforeUnmount(stopPoll);

/** Место своего прогона на сервере, пока ждём ответ: в очереди или уже выполняется. */
let ticket = '';
async function status() {
  try {
    const s = await fetch(withBase(`/api/sandbox?ticket=${ticket}`)).then((r) => r.json());
    if (s.place === 0) waiting.value = 'выполняется…';
    else if (typeof s.place === 'number') waiting.value = s.place === 1 ? 'в очереди: следующий' : `в очереди: впереди ${s.place - 1}`;
  } catch {
    /* ответ на сам прогон всё равно придёт */
  }
}

async function run() {
  running.value = true;
  error.value = '';
  output.value = null;
  exitCode.value = ms.value = null;
  waiting.value = 'отправляю…';
  ticket = Math.random().toString(36).slice(2);
  void status();
  poll = setInterval(status, 1000);
  try {
    const r = await fetch(withBase('/api/run'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: props.id, source: code.value, ticket }),
    });
    const body = await r.json().catch(() => ({ error: `сервер ответил ${r.status}` }));
    output.value = typeof body.output === 'string' ? body.output : null;
    if (!r.ok || body.error) {
      error.value = body.error ?? `сервер ответил ${r.status}`;
      return;
    }
    exitCode.value = body.exitCode ?? null;
    ms.value = body.ms ?? null;
  } catch {
    error.value = 'сервер песочницы недоступен';
  } finally {
    stopPoll();
    running.value = false;
  }
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
      aria-label="Текст программы"
      @keydown.tab.prevent="onTab"
    />
    <div class="lt-sbx-bar">
      <button class="lt-btn primary" :disabled="!enabled || running || !code.trim()" @click="run">
        {{ running ? 'Идёт прогон…' : 'Запустить на базе' }}
      </button>
      <button class="lt-btn ghost" :disabled="code === original" @click="code = original">Вернуть исходный код</button>
      <span v-if="running" class="lt-sbx-hint">{{ waiting }}</span>
    </div>
    <div v-if="error" class="lt-sbx-error"><strong>Прогон не получился:</strong> {{ error }}</div>
    <div v-if="output !== null" class="lt-sbx-out">
      <div class="lt-sbx-out-head">
        <strong>Что напечатала программа</strong>
        <span v-if="exitCode !== null" class="lt-sbx-hint">
          код выхода {{ exitCode }}<template v-if="ms !== null"> · {{ (ms / 1000).toFixed(1) }} с</template>
        </span>
      </div>
      <pre v-if="output">{{ output }}</pre>
      <p v-else class="lt-sbx-empty">программа ничего не напечатала</p>
    </div>
  </div>
</template>

<style scoped>
.lt-sbx { margin: 12px 0 4px; padding: 12px; border: 1px dashed var(--vp-c-brand-1); border-radius: 10px; background: var(--vp-c-bg-soft); }
.lt-sbx-warn { margin: 0 0 8px; font-size: 13px; color: var(--vp-c-text-2); }
.lt-sbx-off { margin: 0 0 8px; font-size: 13px; color: var(--vp-c-warning-1); }
.lt-sbx-code {
  display: block;
  width: 100%;
  min-height: 420px;
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
.lt-sbx-out { margin-top: 10px; font-size: 13px; }
.lt-sbx-out-head { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
.lt-sbx-out pre { margin: 6px 0 0; max-height: 420px; overflow: auto; font-size: 12px; line-height: 1.5; background: var(--vp-c-bg); padding: 8px 10px; border-radius: 6px; white-space: pre; }
.lt-sbx-empty { margin: 6px 0 0; color: var(--vp-c-text-3); font-style: italic; }
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
