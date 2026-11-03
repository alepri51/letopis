/**
 * Всплывающие подсказки глоссария: первое упоминание каждого термина на странице получает подсказку с его
 * определением. Термины и определения берутся из таблицы страницы «Глоссарий» (pages/glossary/index.md) — правка
 * глоссария сразу меняет подсказки. Код, ссылки, заголовки, схемы и плееры примеров не трогаются.
 */
import raw from '../../pages/glossary/index.md?raw';

interface Term { words: string[]; def: string }

/** Markdown ячейки → простой текст: ссылки, код и жирный — без разметки. */
const plain = (s: string) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').trim();

/** Строки таблицы «Термин | Что это | Где подробнее» (колонки — по заголовку); варианты термина — через запятую, пояснения в скобках — не термин. */
const lines = raw.split('\n');
const head = (lines.find((l) => l.startsWith('| Термин')) ?? '').split('|').map((c) => c.trim());
const [TERM, DEF] = [head.indexOf('Термин'), head.indexOf('Что это')];
const TERMS: Term[] = lines
  .filter((l) => l.startsWith('| ') && !l.startsWith('| Термин'))
  .map((l) => l.split('|').map((c) => c.trim()))
  .map((cells) => ({ term: cells[TERM] ?? '', def: cells[DEF] ?? '' }))
  .map(({ term, def }) => ({
    words: term.replace(/\([^)]*\)/g, '').split(',').map(plain).filter((w) => w.length >= 3),
    def: plain(def),
  }))
  .filter((t) => t.words.length && t.def);

const byWord = new Map<string, number>();
TERMS.forEach((t, i) => t.words.forEach((w) => byWord.has(w.toLowerCase()) || byWord.set(w.toLowerCase(), i)));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// слово термина целиком, с окончанием до трёх букв («журнал» — «журнале», «журнала»)
const RE = new RegExp(`(?<![\\p{L}\\p{N}_-])(${[...byWord.keys()].sort((a, b) => b.length - a.length).map(esc).join('|')})(\\p{L}{0,3})(?![\\p{L}\\p{N}_])`, 'giu');

const SKIP = 'pre, code, a, h1, h2, h3, h4, h5, h6, button, textarea, input, svg, .lt-term, .lt-ex, .lt-flow, .lt-tt, .lt-sbx, .lt-mermaid, .mermaid';

/** Расставить подсказки в тексте страницы page (повторный вызов на той же странице ничего не меняет). */
export function annotate(root: HTMLElement, page: string): number {
  if (root.dataset.ltTerms === page) return 0;
  root.dataset.ltTerms = page;
  const used = new Set<number>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  let count = 0;
  for (let node of nodes) {
    RE.lastIndex = 0;
    for (let m = RE.exec(node.data); m; m = RE.exec(node.data)) {
      const i = byWord.get(m[1].toLowerCase());
      if (i === undefined || used.has(i)) continue;
      used.add(i);
      const word = node.splitText(m.index);
      const after = word.splitText(m[0].length);
      const span = document.createElement('span');
      span.className = 'lt-term';
      span.tabIndex = 0;
      span.dataset.def = TERMS[i].def;
      span.setAttribute('aria-description', TERMS[i].def);
      word.replaceWith(span);
      span.append(word);
      count++;
      node = after;
      RE.lastIndex = 0;
    }
  }
  return count;
}
