<script setup lang="ts">
/**
 * Пошаговый плеер исполняемого примера.
 * Данные — снимок прогона на настоящей базе (`snapshots/<id>.json`, пишет `npm run examples`):
 * код шага, его результат или ошибка и таблицы entity, log, secret после шага с подсветкой изменений.
 */
import { computed, onMounted, ref, shallowRef, watch } from 'vue';
import Sandbox from './Sandbox.vue';
import { players, report } from './sync';

type Rec = Record<string, any>;
interface Step {
  title: string;
  text: string | null;
  code: string;
  html: string;
  result: unknown;
  error: { code: string | null; message: string; detail?: unknown; expected?: boolean } | null;
  entity: Rec[];
  removed: Rec[];
  log: Rec[];
  secret: Rec[];
  counts?: Counts | null;
}
interface Counts { entity: Record<string, number>; log: Record<string, number>; secret: Record<string, number> }
interface Snapshot {
  id: string;
  title: string;
  summary: string | null;
  tables: string[];
  initial: { entity: Rec[]; log: Rec[]; secret: Rec[]; counts?: Counts | null };
  steps: Step[];
}

// sandbox — открыть редактор песочницы сразу (страница «Песочница»)
const props = defineProps<{ id: string; sandbox?: boolean }>();
const files = import.meta.glob<{ default: Snapshot }>('../../snapshots/**/*.json');
const snap = shallowRef<Snapshot | null>(null);
// записанный снимок; в плеере может быть и снимок прогона из песочницы (mine)
const recorded = shallowRef<Snapshot | null>(null);
const opened = ref(false);
const editing = ref(false);
const mine = ref(false);
const missing = ref(false);
const i = ref(0);
const showAllResult = ref(false);

onMounted(async () => {
  const load = files[`../../snapshots/${props.id}.json`];
  if (!load) {
    missing.value = true;
    return;
  }
  snap.value = recorded.value = (await load()).default;
  if (props.sandbox) opened.value = editing.value = true;
});

function toggleEditor() {
  opened.value = true;
  editing.value = !editing.value;
}
function display(s: Snapshot, own: boolean) {
  snap.value = s;
  mine.value = own;
  open.value = new Set();
  go(0);
}
const onResult = (s: unknown) => display(s as Snapshot, true);
const onReset = () => recorded.value && display(recorded.value, false);

const step = computed(() => snap.value?.steps[i.value] ?? null);
const total = computed(() => snap.value?.steps.length ?? 0);
const go = (n: number) => {
  i.value = Math.max(0, Math.min(total.value - 1, n));
  showAllResult.value = false;
};
// схема процесса на странице (<Flow>) подсвечивает стадии текущего шага и может попросить перейти к шагу
watch(i, (n) => report(props.id, n), { immediate: true });
watch(
  () => players[props.id]?.want,
  (n) => {
    if (n === null || n === undefined) return;
    go(n);
    players[props.id].want = null;
  },
);

// Пояснение шага: `код` → <code>, **жирный** → <strong>; остальное — как текст.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const md = (s: string | null) =>
  s ? esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>') : '';

// Результат { $mermaid } — схема (например, ER-схема модели из db.describe()).
const resultMermaid = computed(() => {
  const r = step.value?.result as Rec | null;
  return r && typeof r === 'object' && typeof r.$mermaid === 'string' ? (r.$mermaid as string) : null;
});
// Результат-строки (то, что вернул .rows(), versions() и т. п.) показываем таблицей, остальное — JSON.
const resultRows = computed<Rec[] | null>(() => {
  const r = step.value?.result as unknown;
  const arr = Array.isArray(r) ? r : r && typeof r === 'object' && 'id' in (r as Rec) && 'rev' in (r as Rec) ? [r] : null;
  if (!arr || !arr.length || !arr.every((x) => x && typeof x === 'object' && 'id' in x && 'rev' in x)) return null;
  return arr as Rec[];
});
const extraKeys = computed(() => {
  const keys = new Set<string>();
  for (const r of resultRows.value ?? []) for (const k of Object.keys(r)) if (k.startsWith('$')) keys.add(k);
  return [...keys];
});
const hasLinks = (rows: Rec[]) => rows.some((r) => r.links && Object.keys(r.links).length);
const hasReason = (rows: Rec[]) => rows.some((r) => r.reason);
const entLinks = computed(() => (snap.value?.steps ?? []).some((s) => hasLinks([...s.entity, ...s.removed])));
const logReason = computed(() => (snap.value?.steps ?? []).some((s) => hasReason(s.log)));
const resultText = computed(() => {
  const r = step.value?.result;
  if (r === null || r === undefined) return '';
  return JSON.stringify(r, null, 2);
});
const resultLines = computed(() => resultText.value.split('\n'));
const RESULT_LINES = 14;

const show = (t: string) => snap.value?.tables.includes(t);
// Сводка: сколько строк каждого класса, версий каждого действия, секретов каждого вида — и прирост за шаг.
const countsNow = computed(() => step.value?.counts ?? null);
const countsPrev = computed(() => (i.value > 0 ? snap.value?.steps[i.value - 1].counts : snap.value?.initial.counts) ?? null);
const COUNT_GROUPS: [keyof Counts, string, string][] = [
  ['entity', 'entity — объекты по классам', 'класс'],
  ['log', 'log — версии по действиям', 'действие'],
  ['secret', 'secret — секреты по видам', 'вид'],
];
const countRows = (g: keyof Counts) => {
  const now = countsNow.value?.[g] ?? {}, prev = countsPrev.value?.[g] ?? {};
  return [...new Set([...Object.keys(prev), ...Object.keys(now)])].sort().map((k) => ({
    k,
    n: now[k] ?? 0,
    d: (now[k] ?? 0) - (prev[k] ?? 0),
  }));
};
const isNew = (row: Rec) => row.$changed?.includes('*');
// Строки, которые были ещё до первого шага (служебные описания классов и т. п.) и на этом шаге не менялись, — свёрнуты.
const showOld = ref(false);
const initialIds = computed(() => new Set((snap.value?.initial.entity ?? []).map((r) => r.id)));
const quiet = (row: Rec) => initialIds.value.has(row.id) && !row.$changed?.length;
const entityRows = computed(() => (step.value?.entity ?? []).filter((r) => showOld.value || !quiet(r)));
const hiddenOld = computed(() => (step.value?.entity ?? []).filter(quiet).length);
const changed = (row: Rec, key: string) => !isNew(row) && row.$changed?.includes(key);
const dataKeys = (row: Rec) => Object.keys(row.data ?? {});
const fmt = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
// Длинные значения (описание класса, развёрнутая схема) свёрнуты: клик по «ещё» показывает целиком.
const LONG = 70;
const open = ref(new Set<string>());
const isLong = (v: unknown) => fmt(v).length > LONG;
const short = (v: unknown) => fmt(v).slice(0, LONG) + '…';
const toggle = (k: string) => {
  const s = new Set(open.value);
  s.has(k) ? s.delete(k) : s.add(k);
  open.value = s;
};
const linksText = (l: Rec | null) => (l && Object.keys(l).length ? Object.entries(l).map(([k, v]) => `${k} → ${fmt(v)}`).join(', ') : '—');

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowRight') go(i.value + 1);
  if (e.key === 'ArrowLeft') go(i.value - 1);
}
</script>

<template>
  <div class="lt-ex" tabindex="0" @keydown="onKey">
    <div v-if="missing" class="lt-ex-missing">Снимка примера «{{ id }}» нет: запустите <code>npm run examples</code>.</div>
    <template v-else-if="snap && step">
      <div class="lt-ex-head">
        <div class="lt-ex-top">
          <div class="lt-ex-badge" :class="{ mine }">{{ mine ? 'Ваш прогон в песочнице' : 'Пример на настоящей базе' }}</div>
          <button class="lt-link" @click="toggleEditor">{{ editing ? 'Скрыть редактор' : 'Изменить код и запустить' }}</button>
        </div>
        <div class="lt-ex-title">{{ snap.title }}</div>
        <p v-if="snap.summary" class="lt-ex-summary">{{ snap.summary }}</p>
      </div>
      <Sandbox v-if="opened" v-show="editing" :id="id" @result="onResult" @reset="onReset" />

      <div class="lt-ex-nav">
        <button class="lt-btn" :disabled="i === 0" @click="go(i - 1)">← Назад</button>
        <div class="lt-ex-dots">
          <button
            v-for="(s, k) in snap.steps"
            :key="k"
            class="lt-dot"
            :class="{ active: k === i, done: k < i, failed: !!s.error && !s.error.expected, expected: !!s.error?.expected }"
            :title="s.title"
            @click="go(k)"
          >{{ k + 1 }}</button>
        </div>
        <button class="lt-btn primary" :disabled="i === total - 1" @click="go(i + 1)">Дальше →</button>
        <button class="lt-btn ghost" :disabled="i === 0" @click="go(0)">С начала</button>
      </div>

      <div class="lt-ex-step">
        <div class="lt-ex-step-title">Шаг {{ i + 1 }} из {{ total }}. {{ step.title }}</div>
        <p v-if="step.text" class="lt-ex-text" v-html="md(step.text)" />
        <div class="lt-ex-code" v-html="step.html" />

        <div v-if="step.error" class="lt-ex-error" :class="{ expected: step.error.expected }">
          <div v-if="step.error.expected" class="lt-ex-expected">Отказ — так и задумано: шаг показывает, как база защищается.</div>
          <strong>Ошибка<template v-if="step.error.code"> <code>{{ step.error.code }}</code></template>:</strong>
          {{ step.error.message }}
          <pre v-if="step.error.detail" class="lt-ex-detail">{{ JSON.stringify(step.error.detail, null, 2) }}</pre>
        </div>
        <div v-else-if="resultMermaid" class="lt-ex-result">
          <div class="lt-ex-label">Схема</div>
          <Mermaid :code="encodeURIComponent(resultMermaid)" />
        </div>
        <div v-else-if="resultRows" class="lt-ex-result lt-ex-table">
          <div class="lt-ex-label">Результат: {{ resultRows.length }} {{ resultRows.length === 1 ? 'строка' : resultRows.length < 5 ? 'строки' : 'строк' }}</div>
          <div class="lt-scroll">
            <table>
              <thead>
                <tr>
                  <th>id</th><th>rev</th><th>действие</th><th>данные</th>
                  <th v-if="hasLinks(resultRows)">ссылки</th>
                  <th v-for="k in extraKeys" :key="k">{{ k }}</th>
                  <th>автор</th><th>когда</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, k) in resultRows" :key="k">
                  <td class="lt-id">{{ row.id }}</td>
                  <td>{{ row.rev }}</td>
                  <td><span class="lt-op" :class="`op-${row.op}`">{{ row.op }}</span></td>
                  <td class="lt-data">
                    <div v-for="kk in Object.keys(row.data ?? {})" :key="kk"><span class="lt-key">{{ kk }}:</span> {{ isLong(row.data[kk]) ? short(row.data[kk]) : fmt(row.data[kk]) }}</div>
                  </td>
                  <td v-if="hasLinks(resultRows)">{{ linksText(row.links) }}</td>
                  <td v-for="kk in extraKeys" :key="kk"><code>{{ fmt(row[kk]) }}</code></td>
                  <td>{{ fmt(row.author) }}</td>
                  <td>{{ fmt(row.at) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div v-else-if="resultText" class="lt-ex-result">
          <div class="lt-ex-label">Результат</div>
          <pre>{{ showAllResult ? resultText : resultLines.slice(0, RESULT_LINES).join('\n') }}</pre>
          <button v-if="resultLines.length > RESULT_LINES" class="lt-link" @click="showAllResult = !showAllResult">
            {{ showAllResult ? 'свернуть' : `показать всё (${resultLines.length} строк)` }}
          </button>
        </div>
      </div>

      <div v-if="show('counts') && countsNow" class="lt-ex-table">
        <div class="lt-ex-label">Сводка по таблицам после шага (в скобках — сколько добавилось на этом шаге)</div>
        <div class="lt-counts">
          <div v-for="[g, label, col] in COUNT_GROUPS" :key="g" class="lt-counts-col">
            <table>
              <thead><tr><th colspan="2">{{ label }}</th></tr></thead>
              <tbody>
                <tr v-if="!countRows(g).length"><td colspan="2" class="lt-empty">пусто</td></tr>
                <tr v-for="row in countRows(g)" :key="row.k" :class="{ 'lt-new': row.d > 0, 'lt-removed-soft': row.d < 0 }">
                  <td><code>{{ row.k }}</code></td>
                  <td class="lt-num">{{ row.n }}<span v-if="row.d" class="lt-delta"> ({{ row.d > 0 ? '+' : '' }}{{ row.d }})</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div v-if="show('entity')" class="lt-ex-table">
        <div class="lt-ex-label">Таблица <code>entity</code> — объекты сейчас</div>
        <div class="lt-scroll">
          <table>
            <thead>
              <tr>
                <th>id</th><th>класс</th><th>rev</th><th>данные</th>
                <th v-if="entLinks">ссылки</th>
                <th>действие</th><th>автор</th><th>когда</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!step.entity.length && !step.removed.length"><td :colspan="entLinks ? 8 : 7" class="lt-empty">пусто</td></tr>
              <tr v-if="hiddenOld">
                <td :colspan="entLinks ? 8 : 7" class="lt-empty">
                  <button class="lt-link" @click="showOld = !showOld">
                    {{ showOld ? 'свернуть строки, которые были до начала примера' : `ещё ${hiddenOld} — были до начала примера и не менялись (показать)` }}
                  </button>
                </td>
              </tr>
              <tr v-for="row in entityRows" :key="row.id" :class="{ 'lt-new': isNew(row) }">
                <td class="lt-id">{{ row.id }}</td>
                <td>{{ row.class }}</td>
                <td :class="{ 'lt-chg': changed(row, 'rev') }">{{ row.rev }}</td>
                <td class="lt-data">
                  <div v-for="k in dataKeys(row)" :key="k" :class="{ 'lt-chg': changed(row, `data.${k}`) }">
                    <span class="lt-key">{{ k }}:</span>
                    <template v-if="isLong(row.data[k]) && !open.has(`${i}|e|${row.id}|${k}`)">
                      {{ short(row.data[k]) }} <button class="lt-link" @click="toggle(`${i}|e|${row.id}|${k}`)">ещё</button>
                    </template>
                    <template v-else>
                      {{ fmt(row.data[k]) }}
                      <button v-if="isLong(row.data[k])" class="lt-link" @click="toggle(`${i}|e|${row.id}|${k}`)">свернуть</button>
                    </template>
                  </div>
                </td>
                <td v-if="entLinks" :class="{ 'lt-chg': row.$changed?.some((c: string) => c.startsWith('links.')) }">{{ linksText(row.links) }}</td>
                <td :class="{ 'lt-chg': changed(row, 'op') }">{{ row.op }}</td>
                <td>{{ row.author }}</td>
                <td :class="{ 'lt-chg': changed(row, 'at') }">{{ row.at }}</td>
              </tr>
              <tr v-for="row in step.removed" :key="`x-${row.id}`" class="lt-removed">
                <td class="lt-id">{{ row.id }}</td>
                <td>{{ row.class }}</td>
                <td>{{ row.rev }}</td>
                <td class="lt-data"><div v-for="k in dataKeys(row)" :key="k"><span class="lt-key">{{ k }}:</span> {{ isLong(row.data[k]) ? short(row.data[k]) : fmt(row.data[k]) }}</div></td>
                <td v-if="entLinks">{{ linksText(row.links) }}</td>
                <td colspan="3">строка ушла из entity</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="show('log')" class="lt-ex-table">
        <div class="lt-ex-label">Журнал <code>log</code> — все версии (только растёт)</div>
        <div class="lt-scroll">
          <table>
            <thead>
              <tr>
                <th>№</th><th>id</th><th>rev</th><th>действие</th><th>данные версии</th><th>автор</th>
                <th v-if="logReason">причина</th>
                <th>когда</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!step.log.length"><td colspan="8" class="lt-empty">пока ни одной версии</td></tr>
              <tr v-for="(row, k) in step.log" :key="row.seq" :class="{ 'lt-new': row.$new }">
                <td>{{ k + 1 }}</td>
                <td class="lt-id">{{ row.id }}</td>
                <td>{{ row.rev }}</td>
                <td><span class="lt-op" :class="`op-${row.op}`">{{ row.op }}</span></td>
                <td class="lt-data">
                  <div v-for="kk in Object.keys(row.data ?? {})" :key="kk">
                    <span class="lt-key">{{ kk }}:</span>
                    <template v-if="isLong(row.data[kk]) && !open.has(`${i}|l|${row.seq}|${kk}`)">
                      {{ short(row.data[kk]) }} <button class="lt-link" @click="toggle(`${i}|l|${row.seq}|${kk}`)">ещё</button>
                    </template>
                    <template v-else>{{ fmt(row.data[kk]) }}</template>
                  </div>
                  <span v-if="!row.data">—</span>
                </td>
                <td>{{ row.author }}</td>
                <td v-if="logReason">{{ fmt(row.reason) }}</td>
                <td>{{ row.at }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="show('secret')" class="lt-ex-table">
        <div class="lt-ex-label">Таблица <code>secret</code> — пароли, ключи, сессии (сам секрет не показывается и в базе хранится хэшем)</div>
        <div class="lt-scroll">
          <table>
            <thead>
              <tr><th>аккаунт</th><th>вид</th><th>идентификатор</th><th>подробности</th><th>создан</th><th>истекает</th><th>погашен</th></tr>
            </thead>
            <tbody>
              <tr v-if="!step.secret.length"><td colspan="7" class="lt-empty">новых строк нет</td></tr>
              <tr v-for="(row, k) in step.secret" :key="k" :class="{ 'lt-new': row.$new }">
                <td>{{ row.account }}</td>
                <td><code>{{ row.kind }}</code></td>
                <td>{{ fmt(row.ident) }}</td>
                <td class="lt-data">{{ fmt(row.meta) }}</td>
                <td>{{ row.created_at }}</td>
                <td>{{ fmt(row.expires_at) }}</td>
                <td>{{ fmt(row.deleted_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="lt-ex-legend">
        <span><i class="sw new" /> новая строка</span>
        <span><i class="sw chg" /> изменилось на этом шаге</span>
        <span><i class="sw del" /> строка ушла</span>
        <span>t1, t2… — моменты по порядку: одна транзакция — один момент</span>
        <span>← → — листать шаги с клавиатуры</span>
      </div>
    </template>
    <div v-else class="lt-ex-loading">Загружаю пример…</div>
  </div>
</template>

<style scoped>
.lt-ex {
  margin: 24px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 16px 18px;
  background: var(--vp-c-bg);
  outline: none;
}
.lt-ex:focus-visible { box-shadow: 0 0 0 2px var(--vp-c-brand-1); }
.lt-ex-badge {
  display: inline-block;
  font-size: 12px;
  font-weight: 600;
  color: var(--vp-c-green-1);
  background: var(--vp-c-green-soft);
  border-radius: 999px;
  padding: 2px 10px;
  margin-bottom: 6px;
}
.lt-ex-badge.mine { color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); }
.lt-ex-top { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: baseline; justify-content: space-between; }
.lt-ex-title { font-size: 18px; font-weight: 700; line-height: 1.4; }
.lt-ex-summary { margin: 6px 0 0; color: var(--vp-c-text-2); }
.lt-ex-nav { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 14px 0; }
.lt-ex-dots { display: flex; flex-wrap: wrap; gap: 6px; }
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
.lt-dot {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  font-size: 13px;
  cursor: pointer;
}
.lt-dot.done { background: var(--vp-c-brand-soft); }
.lt-dot.active { background: var(--vp-c-brand-1); color: var(--vp-c-white); border-color: var(--vp-c-brand-1); }
.lt-dot.failed { border-color: var(--vp-c-danger-1); }
.lt-dot.expected { border: 2px dashed var(--vp-c-warning-1); }
.lt-ex-error.expected { background: var(--vp-c-warning-soft); color: var(--vp-c-text-1); }
.lt-ex-detail { margin: 6px 0 0; font-size: 12px; line-height: 1.45; white-space: pre-wrap; background: transparent; }
.lt-ex-expected { font-size: 13px; margin-bottom: 4px; color: var(--vp-c-warning-1); font-weight: 600; }
.lt-ex-step { border-top: 1px dashed var(--vp-c-divider); padding-top: 12px; }
.lt-ex-step-title { font-weight: 700; font-size: 16px; }
.lt-ex-text { margin: 6px 0 10px; }
.lt-ex-code :deep(pre) {
  margin: 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--vp-code-block-bg);
  overflow-x: auto;
  font-size: 13.5px;
  line-height: 1.6;
}
.lt-ex-code :deep(code) { background: transparent; padding: 0; }
.lt-ex-result, .lt-ex-error { margin-top: 10px; }
.lt-ex-result pre {
  margin: 4px 0 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  font-size: 12.5px;
  line-height: 1.5;
  overflow-x: auto;
}
.lt-ex-error {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--vp-c-danger-soft);
  color: var(--vp-c-danger-1);
}
.lt-ex-label { font-size: 13px; font-weight: 600; color: var(--vp-c-text-2); margin: 14px 0 6px; }
.lt-scroll { overflow-x: auto; }
.lt-ex-table table { width: 100%; border-collapse: collapse; font-size: 13px; display: table; margin: 0; }
.lt-ex-table th, .lt-ex-table td { border: 1px solid var(--vp-c-divider); padding: 4px 8px; vertical-align: top; text-align: left; }
.lt-ex-table th { background: var(--vp-c-bg-soft); font-weight: 600; white-space: nowrap; }
.lt-id { white-space: nowrap; font-weight: 600; }
.lt-key { color: var(--vp-c-text-3); }
.lt-data { min-width: 180px; }
.lt-data > div { overflow-wrap: anywhere; }
.lt-empty { color: var(--vp-c-text-3); text-align: center !important; font-style: italic; }
.lt-new td { background: var(--vp-c-green-soft); }
.lt-chg { background: var(--vp-c-warning-soft); }
.lt-removed td { background: var(--vp-c-danger-soft); text-decoration: line-through; color: var(--vp-c-text-2); }
.lt-op { font-family: var(--vp-font-family-mono); font-size: 12px; padding: 1px 6px; border-radius: 4px; background: var(--vp-c-default-soft); }
.lt-op.op-create { background: var(--vp-c-green-soft); }
.lt-op.op-update { background: var(--vp-c-warning-soft); }
.lt-op.op-delete, .lt-op.op-purge { background: var(--vp-c-danger-soft); }
.lt-op.op-restore { background: var(--vp-c-brand-soft); }
.lt-link { background: none; border: 0; color: var(--vp-c-brand-1); cursor: pointer; padding: 0; font-size: 13px; }
.lt-counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.lt-num { text-align: right !important; white-space: nowrap; }
.lt-delta { color: var(--vp-c-green-1); font-weight: 600; }
.lt-removed-soft td { background: var(--vp-c-danger-soft); }
.lt-ex-legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 12px; font-size: 12px; color: var(--vp-c-text-2); }
.sw { display: inline-block; width: 12px; height: 12px; border-radius: 3px; vertical-align: -1px; margin-right: 4px; }
.sw.new { background: var(--vp-c-green-soft); border: 1px solid var(--vp-c-green-2); }
.sw.chg { background: var(--vp-c-warning-soft); border: 1px solid var(--vp-c-warning-2); }
.sw.del { background: var(--vp-c-danger-soft); border: 1px solid var(--vp-c-danger-2); }
.lt-ex-missing, .lt-ex-loading { color: var(--vp-c-text-2); }
</style>
