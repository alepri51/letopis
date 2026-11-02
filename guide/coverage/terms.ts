/**
 * Словарь сайта: одно слово на понятие (план 2.0, этап 5, п. 2). У каждого термина — каноническое слово (так пишут
 * README пакета и глоссарий сайта), английское соответствие (так пишет lib/README.en.md) и запрещённые синонимы.
 * Порядок и состав — как строки глоссария pages/glossary/index.md: `term` — первое слово строки (без пояснения в
 * скобках), `en` — её колонка «По-английски». Сверку делает scripts/check-terms.ts: синонимы на страницах и в текстах
 * примеров, строки и колонка глоссария.
 */

export interface Banned {
  /** Запрещённое слово или оборот — по тексту без кода (без учёта регистра). */
  re: RegExp;
  /** Чем заменить. */
  say: string;
}

export interface Term {
  /** Каноническое слово — первое слово строки глоссария. */
  term: string;
  /** Английское соответствие — колонка «По-английски» глоссария (код — без обратных кавычек). */
  en: string;
  /** Запрещённые синонимы. */
  banned?: Banned[];
  /** Где запрещённое слово законно: другое понятие с тем же словом (зачем — в комментарии). */
  allow?: RegExp[];
}

/** Слово или оборот целиком: не часть другого слова; пробел в образце — любой пробел, и перевод строки тоже. */
const w = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body.replace(/ /g, '\\s+')})(?![\\p{L}\\p{N}_])`, 'giu');

const terms: Term[] = [
  { term: 'объект', en: 'object (entity)', banned: [{ re: w('сущност\\p{L}*'), say: 'объект' }] },
  { term: 'журнал', en: 'journal (log)' },
  { term: 'секреты', en: 'secrets (secret)' },
  { term: 'класс', en: 'class' },
  { term: 'hub', en: 'hub, link' },
  // «псевдоним» не синоним: так README зовёт токен класса или арендатора в сигнале (режимы tenant и opaque)
  { term: 'алиас', en: 'alias' },
  { term: 'System', en: 'System' },
  { term: 'ключ', en: 'key, v5 id' },
  {
    term: 'конец',
    en: 'end',
    // «ссылка» как понятие letopis — это конец (README, «Основные понятия»: «конец (роль)»); глагол «ссылается» законен
    banned: [{ re: w('ссыл(?:к\\p{L}*|ок)'), say: 'конец (концы, цель конца); «ссылается» — можно' }],
    // ссылка-переход на странице сайта («ссылка „Изменить код“», «ссылка на пример») и обратная ссылка регулярного выражения
    allow: [/ссылк\p{L}*\s+(?:«|в\s+колонке|(?:прямо\s+)?на\s+(?:живой\s+)?пример)/giu, /обратн\p{L}*\s+ссылк\p{L}*/giu],
  },
  { term: 'цель', en: 'target' },
  { term: 'ключ API', en: 'API key, service key' },
  { term: 'версия структуры', en: 'structure version' },
  { term: 'агрегаты по полю', en: 'read aggregates' },
  { term: 'цепочка', en: 'chain' },
  { term: 'шаг', en: 'step' },
  { term: 'терминал', en: 'terminal' },
  { term: 'глагол', en: 'verb' },
  { term: 'батч', en: 'batch' },
  { term: 'фасад', en: 'facade' },
  { term: 'версия', en: 'version (rev)' },
  { term: 'причина', en: 'reason' },
  { term: 'предпросмотр удаления', en: 'delete preview', banned: [{ re: w('превью'), say: 'предпросмотр' }] },
  { term: 'надгробие', en: 'tombstone' },
  { term: 'действие при удалении', en: 'delete action (onDelete)' },
  { term: 'аккаунт', en: 'account',
    // аккаунт — строка Account (README, раздел 10); «учётная запись» на сайте значила то же
    banned: [{ re: w('уч[её]тн\\p{L}* запис\\p{L}*'), say: 'аккаунт' }],
    // внешняя учётная запись — другое понятие: вход через Telegram, Google, SSO (auth.link, auth.lookup)
    allow: [w('внешн\\p{L}* уч[её]тн\\p{L}* запис\\p{L}*')] },
  { term: 'арендатор', en: 'tenant', banned: [{ re: w('тенант\\p{L}*'), say: 'арендатор' }] },
  { term: 'RLS', en: 'RLS (Row-Level Security)' },
  { term: 'личный арендатор', en: 'own tenant', banned: [{ re: w('собственн\\p{L}* арендатор\\p{L}*'), say: 'личный арендатор' }] },
  { term: 'членство', en: 'membership (member)' },
  {
    term: 'роль',
    en: 'role',
    // задать конец после глагола — шаг роли `.Роль.set(…)`, а не «слот» (план 2.0, этап 5, п. 2)
    banned: [{ re: w('слот\\p{L}*'), say: 'шаг роли (`.Роль.set(…)`), конец роли' }],
    // класс slot модели салона (сид booking) — время мастера в расписании, предметная область, не понятие letopis
    allow: [/слот\p{L}*\s+(?:дня|и\s+брони|свободен|уже\s+занят)/giu, /слоты,\s+брони/giu, /(?:свободен\s+ли|этот|занятый|каждого)\s+слот/giu],
  },
  { term: 'правило', en: 'rule, resource' },
  { term: 'сессия', en: 'session', banned: [{ re: w('сеанс\\p{L}*'), say: 'сессия' }],
    // надпись действия в интерфейсе helpdesk (services/helpdesk) — страница цитирует её как есть
    allow: [/«Завершить сеансы»/gu] },
  { term: 'TOTP', en: 'TOTP, OTP' },
  { term: 'работа от имени', en: 'acting on behalf (impersonation)' },
  { term: 'политика хранения', en: 'retention policy, tiers', banned: [{ re: w('уровн\\p{L}* хранени\\p{L}*'), say: 'ярус' }] },
  { term: 'прореживание', en: 'thinning' },
  { term: 'срез на момент', en: 'point-in-time read (asOf)' },
  { term: 'реестр классов', en: 'class registry' },
  { term: 'подписка', en: 'subscription, cursor' },
  { term: 'сигнал', en: 'signal' },
  { term: 'SSE', en: 'SSE (Server-Sent Events)' },
  { term: 'кэш результатов', en: 'result cache', banned: [{ re: w('кэш\\p{L}* ответ\\p{L}*'), say: 'кэш результатов' }] },
  { term: 'агрегат', en: 'aggregate field' },
  { term: 'проектор', en: 'projector' },
  { term: 'первая заливка', en: 'initial load' },
  { term: 'цепочка хэшей', en: 'hash chain' },
  { term: 'установка', en: 'installation' },
  { term: 'стенд', en: 'test installation' },
  { term: 'сид', en: 'seed' },
  { term: 'ревизия схемы', en: 'engine revision, engine stamp' },
  { term: 'allowReset', en: 'allowReset' },
  { term: 'MCP', en: 'MCP (Model Context Protocol)' },
];

export default terms;
