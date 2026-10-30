<script setup lang="ts">
/**
 * Пошаговый плеер исполняемого примера.
 * Данные — снимок прогона на настоящей базе (`snapshots/<id>.json`, пишет `npm run examples`):
 * код шага, его результат или ошибка и таблицы entity, log, secret после шага с подсветкой изменений.
 * В снимке вместо uuid, времени и токенов — метки; настоящие значения того же прогона лежат рядом
 * (`snapshots/<id>.real.json`) и показываются на вкладке «Реальная таблица». Файла может не быть — тогда вкладки нет.
 */
import { computed, nextTick, onMounted, ref, shallowRef, watch } from 'vue';
import Sandbox from './Sandbox.vue';
import { players, report } from './sync';
import { keepHash } from './anchor';

type Rec = Record<string, any>;
interface Step {
  title: string;
  text: string | null;
  code: string;
  /** Что шаг берёт из ctx (dsn, schema, db…); в старых снимках поля нет. */
  params?: string[];
  html: string;
  result: unknown;
  error: { code: string | null; message: string; detail?: unknown; expected?: boolean } | null;
  entity: Rec[];
  removed: Rec[];
  log: Rec[];
  secret: Rec[];
  counts?: Counts | null;
  /** Сигналы, которые шаг отправил в канал схемы; в старых снимках поля нет. */
  signals?: string[];
}
interface Counts { entity: Record<string, number>; log: Record<string, number>; secret: Record<string, number> }
/** Что раннер передаёт шагам в run(ctx) и чему это равно в прогоне. */
interface Given {
  schema?: string;
  dsn?: { admin?: string; app?: string };
  user?: { login?: string; password?: string };
  up?: { serviceKey?: string | null; tenant?: Rec | null } | null;
}
interface Snapshot {
  id: string;
  title: string;
  summary: string | null;
  tables: string[];
  context?: Given;
  source?: string;
  sourceHtml?: string;
  initial: { entity: Rec[]; log: Rec[]; secret: Rec[]; counts?: Counts | null };
  steps: Step[];
}
/** Тот же прогон с настоящими значениями; массивы строк — в том же порядке, что в снимке с метками. */
interface RealStep { result: unknown; error: Rec | null; entity: Rec[]; removed: Rec[]; log: Rec[]; secret: Rec[]; signals?: string[] }
interface Real {
  id: string;
  context?: Given;
  initial?: { entity: Rec[]; log: Rec[]; secret: Rec[] };
  steps: RealStep[];
}

// sandbox — открыть редактор песочницы сразу (страница «Песочница»)
const props = defineProps<{ id: string; sandbox?: boolean }>();
// снимки с метками; *.real.json грузятся отдельно, иначе каждый попал бы и в этот список
const files = import.meta.glob<{ default: Snapshot }>(['../../snapshots/**/*.json', '!../../snapshots/**/*.real.json']);
const realFiles = import.meta.glob<{ default: Real }>('../../snapshots/**/*.real.json');
const snap = shallowRef<Snapshot | null>(null);
// настоящие значения показанного снимка (null — их нет: старый снимок или песочница их не прислала)
const real = shallowRef<Real | null>(null);
// записанный снимок; в плеере может быть и снимок прогона из песочницы (mine)
const recorded = shallowRef<Snapshot | null>(null);
const recordedReal = shallowRef<Real | null>(null);
const opened = ref(false);
const editing = ref(false);
const mine = ref(false);
const missing = ref(false);
const i = ref(0);
const showAllResult = ref(false);
const showSource = ref(false);
// вкладка данных шага: «Метки» или «Реальная таблица»; выбор живёт при листании шагов и смене снимка
const tab = ref<'labels' | 'real'>('labels');

/** Настоящие значения подходят снимку: тот же пример, столько же шагов; иначе null. */
const fits = (s: Snapshot, r: Real | null | undefined): Real | null =>
  r && r.id === s.id && Array.isArray(r.steps) && r.steps.length === s.steps.length ? r : null;

onMounted(async () => {
  const load = files[`../../snapshots/${props.id}.json`];
  if (!load) {
    missing.value = true;
    return;
  }
  const loadReal = realFiles[`../../snapshots/${props.id}.real.json`];
  const [s, r] = await Promise.all([
    load().then((m) => m.default),
    loadReal ? loadReal().then((m) => m.default, () => null) : Promise.resolve(null),
  ]);
  recorded.value = s;
  recordedReal.value = r;
  real.value = fits(s, r);
  snap.value = s;
  if (props.sandbox) opened.value = editing.value = true;
  void nextTick(keepHash); // плеер вырос — якорь адреса мог уехать вниз
});

function toggleEditor() {
  opened.value = true;
  editing.value = !editing.value;
}
function display(s: Snapshot, own: boolean, r: Real | null) {
  real.value = fits(s, r);
  snap.value = s;
  mine.value = own;
  open.value = new Set();
  go(0);
}
const onResult = (s: unknown, r?: unknown) => display(s as Snapshot, true, (r as Real | null | undefined) ?? null);
const onReset = () => recorded.value && display(recorded.value, false, recordedReal.value);

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

// «Дано»: что шаг берёт из ctx, что это такое и чему равно в этом прогоне.
const ABOUT: Record<string, string> = {
  db: 'подключение от имени Анны в арендаторе «Ромашка»: `svc.as(Анна, { tenant })`, все проверки прав как у пользователя',
  svc: 'сервис приложения: вошёл по ключу установки, `connect({ dsn: dsn.app, schema, apiKey: up.serviceKey })`',
  up: 'результат установки `up()`: ключ сервиса, арендатор «Ромашка», его первый пользователь Анна и её токен',
  admin: 'сырой SQL от суперпользователя базы (postgres.js)',
  dsn: 'строки подключения: `dsn.admin` — администратор базы, `dsn.app` — роль приложения',
  schema: 'схема этого примера (каждый пример ставится в свою)',
  user: 'логин и пароль Анны',
  connect: 'ещё одно подключение с любыми опциями `connect()`, раннер закроет его сам',
  warnings: 'выполнить функцию и собрать предупреждения, которые она напечатала через `console.warn`',
};
// без установки (setup: 'none') раннер их не создаёт
const FROM_UP = new Set(['up', 'svc', 'db']);
interface GivenRow { path: string; value: string }
const given = computed(() => {
  const c = realTab.value ? real.value?.context : snap.value?.context;
  return (step.value?.params ?? []).map((name) => {
    const rows: GivenRow[] = [];
    const add = (path: string, o: unknown, key: string) => {
      const v = o && typeof o === 'object' ? (o as Rec)[key] : undefined;
      if (v !== null && v !== undefined) rows.push({ path, value: fmt(v) });
    };
    if (name === 'schema') add('schema', c, 'schema');
    if (name === 'dsn') {
      add('dsn.admin', c?.dsn, 'admin');
      add('dsn.app', c?.dsn, 'app');
    }
    if (name === 'user') {
      add('user.login', c?.user, 'login');
      add('user.password', c?.user, 'password');
    }
    if (name === 'up' && c?.up) {
      add('up.serviceKey', c.up, 'serviceKey');
      for (const k of ['tenant', 'user', 'token']) add(`up.tenant.${k}`, c.up.tenant, k);
    }
    const none = !!c && c.up === null && FROM_UP.has(name);
    return { name, about: ABOUT[name] ?? 'поле `ctx`, которое раннер передаёт шагу', rows, none };
  });
});

// Результат { $mermaid } — схема (например, ER-схема модели из db.describe()).
const mermaidOf = (r: unknown) => (r && typeof r === 'object' && typeof (r as Rec).$mermaid === 'string' ? ((r as Rec).$mermaid as string) : null);
const resultMermaid = computed(() => mermaidOf(step.value?.result));
// Результат-строки (то, что вернул .rows(), versions() и т. п.) показываем таблицей, остальное — JSON.
const asRows = (r: unknown): Rec[] | null => {
  const arr = Array.isArray(r) ? r : r && typeof r === 'object' && 'id' in (r as Rec) && 'rev' in (r as Rec) ? [r] : null;
  if (!arr || !arr.length || !arr.every((x) => x && typeof x === 'object' && 'id' in x && 'rev' in x)) return null;
  return arr as Rec[];
};
const resultRows = computed(() => asRows(step.value?.result));
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

// ---------- вкладка «Реальная таблица»: тот же шаг со значениями как в базе ----------
const realTab = computed(() => tab.value === 'real' && !!real.value);
const realStep = computed<RealStep | null>(() => real.value?.steps[i.value] ?? null);
const realMermaid = computed(() => mermaidOf(realStep.value?.result));
const realResultRows = computed(() => (step.value?.error || realMermaid.value ? null : asRows(realStep.value?.result)));
const realResultText = computed(() => {
  const r = realStep.value?.result;
  return r === null || r === undefined ? '' : JSON.stringify(r, null, 2);
});
const realResultLines = computed(() => realResultText.value.split('\n'));
const rowsWord = (n: number) => (n === 1 ? 'строка' : n < 5 ? 'строки' : 'строк');
// колонки — ключи строк в порядке появления
const columns = (rows: Rec[]) => [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))];
interface RealRow { key: string; row: Rec; mark: string }
interface RealBlock { table: string; title: string; rows: RealRow[]; cols: string[]; empty: string; old: number }
const realBlocks = computed<RealBlock[]>(() => {
  const st = step.value, rs = realStep.value;
  if (!st || !rs) return [];
  const blocks: RealBlock[] = [];
  const add = (table: string, title: string, rows: RealRow[], empty: string, old = 0) =>
    blocks.push({ table, title, rows, cols: columns(rows.map((r) => r.row)), empty, old });
  // строки обоих снимков идут в одном порядке: отсюда отметка «новая» и свёрнутые строки, что были до начала примера
  const twins = (rows: Rec[] | undefined, labeled: Rec[]) =>
    (rows ?? []).map((row, k) => ({ row, lab: rows!.length === labeled.length ? labeled[k] : undefined }));
  const rr = realResultRows.value;
  if (rr) add('result', `Результат как в базе: ${rr.length} ${rowsWord(rr.length)}`, rr.map((row, k) => ({ key: `r${k}`, row, mark: '' })), '');
  if (show('entity')) {
    const all = twins(rs.entity, st.entity);
    const rows = all
      .filter((p) => showOld.value || !p.lab || !quiet(p.lab))
      .map((p) => ({ key: String(p.row.id), row: p.row, mark: p.lab && isNew(p.lab) ? 'new' : '' }));
    for (const row of rs.removed ?? []) rows.push({ key: `x-${row.id}`, row, mark: 'removed' });
    const old = all.filter((p) => p.lab && quiet(p.lab)).length;
    add('entity', 'Таблица `entity` как в базе — объекты сейчас; зачёркнуты строки, которые ушли на этом шаге', rows, 'пусто', old);
  }
  if (show('log')) {
    const rows = twins(rs.log, st.log).map((p) => ({ key: String(p.row.seq), row: p.row, mark: p.lab?.$new ? 'new' : '' }));
    add('log', 'Журнал `log` как в базе — все версии; `tx` — номер транзакции', rows, 'пока ни одной версии');
  }
  if (show('secret')) {
    const rows = twins(rs.secret, st.secret).map((p, k) => ({ key: `s${k}`, row: p.row, mark: p.lab?.$new ? 'new' : '' }));
    add('secret', 'Таблица `secret` как в базе; `material` — хэш секрета, сам секрет в базе не хранится', rows, 'новых строк нет');
  }
  return blocks;
});

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowRight') go(i.value + 1);
  if (e.key === 'ArrowLeft') go(i.value - 1);
}
</script>

<template>
  <div :id="`ex-${id.replace(/[^a-z0-9]+/gi, '-')}`" class="lt-ex" tabindex="0" @keydown="onKey">
    <div v-if="missing" class="lt-ex-missing">Снимка примера «{{ id }}» нет: запустите <code>npm run examples</code>.</div>
    <template v-else-if="snap && step">
      <div class="lt-ex-head">
        <div class="lt-ex-top">
          <div class="lt-ex-badge" :class="{ mine }">{{ mine ? 'Ваш прогон в песочнице' : 'Пример на настоящей базе' }}</div>
          <div class="lt-ex-actions">
            <button v-if="snap.sourceHtml || snap.source" class="lt-link" :aria-expanded="showSource" @click="showSource = !showSource">
              {{ showSource ? 'Скрыть весь код' : 'Весь код примера' }}
            </button>
            <button class="lt-link" @click="toggleEditor">{{ editing ? 'Скрыть редактор' : 'Изменить код и запустить' }}</button>
          </div>
        </div>
        <div class="lt-ex-title">{{ snap.title }}</div>
        <p v-if="snap.summary" class="lt-ex-summary">{{ snap.summary }}</p>
        <div v-if="showSource && (snap.sourceHtml || snap.source)" class="lt-ex-source">
          <div class="lt-ex-label">
            <template v-if="mine">Код вашего прогона целиком</template>
            <template v-else>Файл <code>examples/{{ id }}.ts</code> целиком: модели, помощники и все шаги</template>
          </div>
          <div v-if="snap.sourceHtml" class="lt-ex-code" v-html="snap.sourceHtml" />
          <pre v-else class="lt-ex-plain">{{ snap.source }}</pre>
        </div>
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
        <div v-if="given.length" class="lt-ex-given">
          <div class="lt-ex-given-head">
            <strong>Дано</strong> — что шаг берёт из <code>ctx</code>: раннер передаёт его в <code>run</code><template v-if="realTab">; значения — как в базе</template>
          </div>
          <div v-for="g in given" :key="g.name" class="lt-ex-given-item">
            <code class="lt-ex-given-name">{{ g.name }}</code>
            <div>
              <div v-html="md(g.about)" />
              <div v-if="g.none" class="lt-ex-given-none">В этом примере его нет: пример ставится без установки (<code>setup: 'none'</code>).</div>
              <div v-for="r in g.rows" :key="r.path" class="lt-ex-given-val">
                <span class="lt-key">{{ r.path }} =</span> <code>{{ r.value }}</code>
              </div>
            </div>
          </div>
        </div>
        <div class="lt-ex-code" v-html="step.html" />

        <div v-if="real" class="lt-ex-tabs" role="tablist" aria-label="Как показать данные шага">
          <button role="tab" class="lt-tab" :class="{ active: !realTab }" :aria-selected="!realTab" @click="tab = 'labels'">Метки</button>
          <button role="tab" class="lt-tab" :class="{ active: realTab }" :aria-selected="realTab" @click="tab = 'real'">Реальная таблица</button>
          <span class="lt-ex-tabs-hint">{{ realTab ? 'uuid, время, токены и хэши — как в базе в этом прогоне' : 'вместо uuid, времени и токенов — метки, чтобы снимок читался' }}</span>
        </div>

        <template v-if="!realTab">
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
        </template>

        <template v-else>
          <div v-if="step.error" class="lt-ex-error" :class="{ expected: step.error.expected }">
            <div v-if="step.error.expected" class="lt-ex-expected">Отказ — так и задумано: шаг показывает, как база защищается.</div>
            <strong>Ошибка<template v-if="step.error.code"> <code>{{ step.error.code }}</code></template>:</strong>
            {{ realStep?.error?.message ?? step.error.message }}
            <pre v-if="realStep?.error?.detail" class="lt-ex-detail">{{ JSON.stringify(realStep?.error?.detail, null, 2) }}</pre>
          </div>
          <div v-else-if="realMermaid" class="lt-ex-result">
            <div class="lt-ex-label">Схема</div>
            <Mermaid :code="encodeURIComponent(realMermaid)" />
          </div>
          <div v-else-if="realResultText && !realResultRows" class="lt-ex-result">
            <div class="lt-ex-label">Результат как в базе</div>
            <pre>{{ showAllResult ? realResultText : realResultLines.slice(0, RESULT_LINES).join('\n') }}</pre>
            <button v-if="realResultLines.length > RESULT_LINES" class="lt-link" @click="showAllResult = !showAllResult">
              {{ showAllResult ? 'свернуть' : `показать всё (${realResultLines.length} строк)` }}
            </button>
          </div>
          <div v-for="b in realBlocks" :key="b.table" class="lt-ex-table lt-ex-real">
            <div class="lt-ex-label" v-html="md(b.title)" />
            <div class="lt-scroll">
              <table>
                <thead>
                  <tr><th v-for="c in b.cols" :key="c">{{ c }}</th></tr>
                </thead>
                <tbody>
                  <tr v-if="!b.rows.length && !b.old"><td :colspan="Math.max(b.cols.length, 1)" class="lt-empty">{{ b.empty }}</td></tr>
                  <tr v-if="b.old">
                    <td :colspan="Math.max(b.cols.length, 1)" class="lt-empty">
                      <button class="lt-link" @click="showOld = !showOld">
                        {{ showOld ? 'свернуть строки, которые были до начала примера' : `ещё ${b.old} — были до начала примера и не менялись (показать)` }}
                      </button>
                    </td>
                  </tr>
                  <tr v-for="r in b.rows" :key="r.key" :class="{ 'lt-new': r.mark === 'new', 'lt-removed': r.mark === 'removed' }">
                    <td v-for="c in b.cols" :key="c">
                      <template v-if="isLong(r.row[c]) && !open.has(`${i}|r|${b.table}|${r.key}|${c}`)">
                        {{ short(r.row[c]) }} <button class="lt-link" @click="toggle(`${i}|r|${b.table}|${r.key}|${c}`)">ещё</button>
                      </template>
                      <template v-else-if="isLong(r.row[c])">
                        <span class="lt-wrap">{{ fmt(r.row[c]) }}</span>
                        <button class="lt-link" @click="toggle(`${i}|r|${b.table}|${r.key}|${c}`)">свернуть</button>
                      </template>
                      <template v-else>{{ fmt(r.row[c]) }}</template>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
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

      <template v-if="!realTab">
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
      </template>

      <div v-if="step?.signals" class="lt-ex-signals">
        <span class="lt-ex-signals-label">Сигналы шага</span>
        <template v-if="(realTab ? realStep?.signals ?? step.signals : step.signals).length">
          <code v-for="s in realTab ? realStep?.signals ?? step.signals : step.signals" :key="s">{{ s }}</code>
        </template>
        <span v-else class="lt-ex-signals-none">не было</span>
        <span class="lt-ex-signals-hint">— уведомления NOTIFY в канал схемы после фиксации: по ним просыпаются подписки и сбрасывается кэш</span>
      </div>

      <div class="lt-ex-legend">
        <span><i class="sw new" /> новая строка</span>
        <span><i class="sw chg" /> изменилось на этом шаге</span>
        <span><i class="sw del" /> строка ушла</span>
        <span v-if="!realTab">t1, t2… — моменты по порядку: одна транзакция — один момент</span>
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
.lt-ex-actions { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: baseline; }
.lt-ex-title { font-size: 18px; font-weight: 700; line-height: 1.4; }
.lt-ex-summary { margin: 6px 0 0; color: var(--vp-c-text-2); }
.lt-ex-source .lt-ex-label { margin-top: 12px; }
.lt-ex-plain {
  margin: 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--vp-code-block-bg);
  font-size: 13px;
  line-height: 1.55;
  white-space: pre;
}
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
.lt-ex-given {
  margin: 8px 0 10px;
  padding: 8px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  font-size: 13px;
  line-height: 1.5;
}
.lt-ex-given-head { color: var(--vp-c-text-2); margin-bottom: 4px; }
.lt-ex-given-item { display: grid; grid-template-columns: minmax(64px, max-content) 1fr; gap: 0 12px; padding: 4px 0; }
.lt-ex-given-item + .lt-ex-given-item { border-top: 1px dashed var(--vp-c-divider); }
.lt-ex-given-name { justify-self: start; align-self: start; font-weight: 600; }
.lt-ex-given-val { margin-top: 2px; overflow-wrap: anywhere; }
.lt-ex-given-none { margin-top: 2px; color: var(--vp-c-text-3); font-style: italic; }
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
.lt-ex-source :deep(pre), .lt-ex-plain { max-height: 560px; overflow: auto; }
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
/* вкладки «Метки» и «Реальная таблица» */
.lt-ex-tabs { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 4px; margin: 12px 0 0; border-bottom: 1px solid var(--vp-c-divider); }
.lt-tab {
  margin-bottom: -1px;
  padding: 4px 12px;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 8px 8px 0 0;
  background: transparent;
  color: var(--vp-c-text-2);
  font-size: 14px;
  cursor: pointer;
}
.lt-tab.active { border-color: var(--vp-c-divider); background: var(--vp-c-bg); color: var(--vp-c-text-1); font-weight: 600; }
.lt-ex-tabs-hint { margin: 0 0 5px 8px; font-size: 12px; color: var(--vp-c-text-3); }
.lt-ex-label { font-size: 13px; font-weight: 600; color: var(--vp-c-text-2); margin: 14px 0 6px; }
.lt-scroll { overflow-x: auto; }
.lt-ex-table table { width: 100%; border-collapse: collapse; font-size: 13px; display: table; margin: 0; }
.lt-ex-table th, .lt-ex-table td { border: 1px solid var(--vp-c-divider); padding: 4px 8px; vertical-align: top; text-align: left; }
.lt-ex-table th { background: var(--vp-c-bg-soft); font-weight: 600; white-space: nowrap; }
.lt-id { white-space: nowrap; font-weight: 600; }
.lt-key { color: var(--vp-c-text-3); }
.lt-data { min-width: 180px; }
.lt-data > div { overflow-wrap: anywhere; }
/* «Реальная таблица»: значения как в базе — моноширинно, uuid и время одной строкой; длинное разворачивается с переносом */
.lt-ex-real td { font-family: var(--vp-font-family-mono); font-size: 12px; white-space: nowrap; }
.lt-ex-real td.lt-empty { font-family: inherit; }
.lt-wrap { display: block; min-width: 32ch; max-width: 70ch; white-space: pre-wrap; overflow-wrap: anywhere; }
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
.lt-ex-signals { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; margin-top: 12px; font-size: 13px; }
.lt-ex-signals-label { font-weight: 600; }
.lt-ex-signals-none, .lt-ex-signals-hint { color: var(--vp-c-text-2); }
.lt-ex-signals-hint { font-size: 12px; }
.lt-ex-legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 12px; font-size: 12px; color: var(--vp-c-text-2); }
.sw { display: inline-block; width: 12px; height: 12px; border-radius: 3px; vertical-align: -1px; margin-right: 4px; }
.sw.new { background: var(--vp-c-green-soft); border: 1px solid var(--vp-c-green-2); }
.sw.chg { background: var(--vp-c-warning-soft); border: 1px solid var(--vp-c-warning-2); }
.sw.del { background: var(--vp-c-danger-soft); border: 1px solid var(--vp-c-danger-2); }
.lt-ex-missing, .lt-ex-loading { color: var(--vp-c-text-2); }
</style>
