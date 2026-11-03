<script setup lang="ts">
/**
 * Машина времени: ползунок по версиям одного объекта из снимка примера.
 * Версии — записи журнала `log` объекта после последнего шага примера (каждая — полный снимок данных).
 * На выбранной версии видно состояние объекта, что изменилось относительно прошлой версии, кто и почему менял.
 * Так читают историю `versions()` (весь список) и `asOf(момент)` (последняя версия не позже момента).
 */
import { computed, onMounted, ref, shallowRef } from 'vue';

type Rec = Record<string, any>;
const props = defineProps<{ id: string; object: string }>();
const files = import.meta.glob<{ default: { steps: { log: Rec[] }[] } }>(['../../../examples/_snapshots/**/*.json', '!../../../examples/_snapshots/**/*.real.json']);
const versions = shallowRef<Rec[]>([]);
const missing = ref(false);
const k = ref(0);

onMounted(async () => {
  const load = files[`../../../examples/_snapshots/${props.id}.json`];
  const snap = load ? (await load()).default : null;
  const log = snap?.steps.at(-1)?.log ?? [];
  versions.value = log.filter((r) => r.id === props.object);
  missing.value = !versions.value.length;
  k.value = Math.max(0, versions.value.length - 1);
});

const cur = computed(() => versions.value[k.value] ?? null);
const prev = computed(() => (k.value > 0 ? versions.value[k.value - 1] : null));
const gone = computed(() => cur.value?.op === 'delete');
const fmt = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const keys = computed(() => [...new Set([...Object.keys(prev.value?.data ?? {}), ...Object.keys(cur.value?.data ?? {})])]);
const changed = (key: string) => !!prev.value && fmt(prev.value.data?.[key]) !== fmt(cur.value?.data?.[key]);
const links = (r: Rec | null) => Object.entries(r?.links ?? {}).map(([role, to]) => `${role} → ${fmt(to)}`).join(', ');
const linksChanged = computed(() => !!prev.value && links(prev.value) !== links(cur.value));
const next = computed(() => versions.value[k.value + 1] ?? null);
const plural = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'версия' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'версии' : 'версий');
const OPS: Record<string, string> = {
  create: 'создан',
  update: 'изменён',
  delete: 'удалён — в журнале надгробие с последним снимком',
  restore: 'возвращён последним снимком',
};
</script>

<template>
  <div class="lt-tt">
    <div class="lt-tt-badge">Машина времени</div>
    <div v-if="missing" class="lt-tt-missing">В снимке «{{ id }}» нет версий объекта «{{ object }}».</div>
    <template v-else-if="cur">
      <div class="lt-tt-title">{{ object }}: {{ versions.length }} {{ plural(versions.length) }} в журнале</div>
      <div class="lt-tt-track">
        <button class="lt-tt-arrow" :disabled="k === 0" aria-label="Раньше" @click="k--">←</button>
        <input v-model.number="k" type="range" min="0" :max="versions.length - 1" step="1" aria-label="Версия объекта" />
        <button class="lt-tt-arrow" :disabled="k === versions.length - 1" aria-label="Позже" @click="k++">→</button>
      </div>
      <div class="lt-tt-ticks">
        <button
          v-for="(v, n) in versions"
          :key="v.seq"
          class="lt-tt-tick"
          :class="[`op-${v.op}`, { active: n === k }]"
          @click="k = n"
        >rev {{ v.rev }} · {{ v.at }}</button>
      </div>

      <div class="lt-tt-head">
        Версия <strong>rev {{ cur.rev }}</strong>, момент <strong>{{ cur.at }}</strong>: объект {{ OPS[cur.op] ?? cur.op }}.
        Автор — {{ fmt(cur.author) }}<template v-if="cur.reason">, причина — «{{ cur.reason }}»</template>.
      </div>

      <table class="lt-tt-table">
        <thead><tr><th>поле</th><th>значение на этот момент</th><th v-if="prev">было в rev {{ prev.rev }}</th></tr></thead>
        <tbody>
          <tr v-for="key in keys" :key="key" :class="{ 'lt-tt-chg': changed(key) }">
            <td><code>{{ key }}</code></td>
            <td>{{ fmt(cur.data?.[key]) }}</td>
            <td v-if="prev">{{ changed(key) ? fmt(prev.data?.[key]) : '' }}</td>
          </tr>
          <tr v-if="links(cur) || links(prev)" :class="{ 'lt-tt-chg': linksChanged }">
            <td>концы</td>
            <td>{{ links(cur) || '—' }}</td>
            <td v-if="prev">{{ linksChanged ? links(prev) || '—' : '' }}</td>
          </tr>
        </tbody>
      </table>

      <p class="lt-tt-note">
        <template v-if="gone">
          На этот момент объекта нет: <code>asOf(момент)</code> его не вернёт. Данные в таблице — снимок, который
          сохранило надгробие.
        </template>
        <template v-else>
          Так объект вернёт <code>asOf(момент)</code> для любого момента
          <template v-if="next">от {{ cur.at }} до {{ next.at }} (следующая версия)</template><template v-else>начиная с {{ cur.at }}</template>.
          Подсвечены поля, которые эта версия изменила по сравнению с предыдущей.
        </template>
      </p>
    </template>
    <div v-else class="lt-tt-missing">Загружаю версии…</div>
  </div>
</template>

<style scoped>
.lt-tt { margin: 24px 0; padding: 14px 18px; border: 1px solid var(--vp-c-divider); border-radius: 12px; background: var(--vp-c-bg); }
.lt-tt-badge {
  display: inline-block;
  font-size: 12px;
  font-weight: 600;
  color: var(--vp-c-purple-1);
  background: var(--vp-c-purple-soft);
  border-radius: 999px;
  padding: 2px 10px;
  margin-bottom: 6px;
}
.lt-tt-title { font-size: 17px; font-weight: 700; }
.lt-tt-track { display: flex; gap: 10px; align-items: center; margin: 12px 0 6px; }
.lt-tt-track input { flex: 1; accent-color: var(--vp-c-brand-1); }
.lt-tt-arrow { border: 1px solid var(--vp-c-divider); border-radius: 8px; padding: 2px 10px; background: var(--vp-c-bg-soft); cursor: pointer; }
.lt-tt-arrow:disabled { opacity: 0.4; cursor: default; }
.lt-tt-ticks { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.lt-tt-tick { font-size: 12px; border: 1px solid var(--vp-c-divider); border-radius: 6px; padding: 1px 8px; background: var(--vp-c-default-soft); cursor: pointer; }
.lt-tt-tick.op-create { background: var(--vp-c-green-soft); }
.lt-tt-tick.op-update { background: var(--vp-c-warning-soft); }
.lt-tt-tick.op-delete { background: var(--vp-c-danger-soft); }
.lt-tt-tick.op-restore { background: var(--vp-c-brand-soft); }
.lt-tt-tick.active { outline: 2px solid var(--vp-c-brand-1); font-weight: 600; }
.lt-tt-head { margin: 4px 0 8px; }
.lt-tt-table { width: 100%; border-collapse: collapse; font-size: 13px; display: table; margin: 0; }
.lt-tt-table th, .lt-tt-table td { border: 1px solid var(--vp-c-divider); padding: 4px 8px; text-align: left; vertical-align: top; }
.lt-tt-table th { background: var(--vp-c-bg-soft); }
.lt-tt-chg td { background: var(--vp-c-warning-soft); }
.lt-tt-note { margin: 10px 0 0; font-size: 13px; color: var(--vp-c-text-2); }
.lt-tt-missing { color: var(--vp-c-text-2); }
</style>
