/**
 * Нюансы и ловушки letopis — каждый должен получить пример (поле `covers` с `nuance.<id>`).
 * Источники: карточки атласа (раздел «Инварианты и грабли»), раздел «Ограничения» README, CHANGELOG.
 * Список пополняется по главам; к концу работы (этап 5) покрытие проверяется строго.
 */
export interface Nuance {
  id: string;
  /** Суть простыми словами. */
  text: string;
  /** Откуда взят: файл и раздел. */
  source: string;
}

const nuances: Nuance[] = [
  {
    id: 'delete-preview',
    text: 'delete() без { confirm: true } ничего не удаляет — возвращает превью: что удалится и с каким действием ($action).',
    source: 'lib/README.md, раздел 7',
  },
  {
    id: 'class-is-entity',
    text: 'Описание класса — тоже объект: строка класса Class в entity со своей историей в log.',
    source: 'lib/README.md, раздел 2',
  },
  {
    id: 'session-in-secret',
    text: 'Сессия — строка SESSION в таблице secret; сам токен там не хранится, только его хэш.',
    source: 'lib/sql/10-core.sql, таблица secret',
  },
  {
    id: 'up-idempotent',
    text: 'Повторный up() безопасен: накатывает ту же ревизию, данные не трогает, ключ сервиса снова не выдаёт.',
    source: 'lib/README.md, раздел 1; docs/atlas/F-BOOT.md',
  },
  {
    id: 'service-key-once',
    text: 'Ключ сервиса up() выдаёт только при первой установке или когда не осталось ни одного действующего ключа API.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'signals-mode-sticky',
    text: 'Режим сигналов хранится в схеме: up() без опции signals его не меняет; после смены — перезапуск процессов.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'fresh-drops-data',
    text: 'up({ fresh: true }) удаляет схему и ставит заново — данные теряются, ключ сервиса новый.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'pglite-no-rls',
    text: 'Подключение к PGlite — суперпользователь (allowBypassRls), одно соединение, без LISTEN: права, изоляцию и гонки на нём не проверить.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'engine-stamp',
    text: 'up() пишет штамп движка в комментарий схемы; connect() предупреждает, если штамп не совпал с пакетом (схему не накатили или накатила новее).',
    source: 'lib/README.md, раздел 3; lib/src/up.ts:stampDrift',
  },
  {
    id: 'sync-dry-run',
    text: 'syncModels без apply — сухой прогон: ничего не пишет, отвечает, что будет создано и изменено.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'key-case',
    text: 'Значения ключа берутся как есть: email в разном регистре даёт разные id.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'keyless-repeat',
    text: 'Класс без ключа не защищён от повтора: повтор create после сбоя создаёт второй объект.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'no-id-in-create',
    text: 'Поле id в данных create — лишнее поле (invalid_data): id вычисляет или выдаёт база.',
    source: 'пример models/02-keys-and-ids',
  },
  {
    id: 'polymorphic-read',
    text: 'Шаг по классу находит и строки потомков; .exact() — только сам класс.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'refine-lost',
    text: 'refine, superRefine и transform база не исполняет: syncModels возвращает их в lost.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'defaults-by-db',
    text: 'Умолчания .default() модели подставляет сама база при вставке.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'safe-change',
    text: 'Новое необязательное поле, конец, meta, алиас применяются сразу; остальное — ужесточение с проверкой строк.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'history-false',
    text: 'history: false — нет журнала: ни версий, ни среза на дату, ни восстановления, ни событий подписки.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'update-merge',
    text: 'update сливает патч внутри базы: вложенные объекты — рекурсивно, массивы и скаляры заменяются.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'update-empty-target',
    text: 'update без найденных строк возвращает пустой список без ошибки — проверяйте длину ответа.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'upsert-replaces',
    text: 'upsert заменяет данные целиком: поля, которых нет в объекте, пропадают; затирает параллельные приращения.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'links-from-path',
    text: 'Ссылки создаваемой строки берутся из пути цепочки: db.Shop(shop).Product().create() ссылается на shop.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'slots-atomic',
    text: 'Слоты .Роль.set/unset/add/remove меняют links атомарно, без чтения списка.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'inc-min-check',
    text: 'inc проверяет правило модели (min) над итогом: уход в минус — invalid_data.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'inc-start',
    text: 'inc по отсутствующему полю — ошибка; inc(n, { start }) начинает с заданного значения.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'rekey-new-id',
    text: 'rekey — новый id; ссылки переводятся, строки с этим концом в ключе тоже получают новый id.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'anonymize-history',
    text: 'anonymize пишет новую версию с [erased] и тегом anonymized; прежние версии остаются в журнале.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'reason-in-log',
    text: 'Причина изменения (reason) записывается в версию журнала рядом с автором и временем.',
    source: 'lib/README.md, раздел 11',
  },
  {
    id: 'batch-own-queue',
    text: 'Очередь батча своя у каждого фасада (db, db.as(), db.begin()); план исполняется от имени поставившего фасада.',
    source: 'lib/README.md, раздел 8',
  },
  {
    id: 'step-direction',
    text: 'Переход цепочки идёт по концам: назад — к тем, кто ссылается; вперёд — к цели; к тому же классу — к детям.',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'filter-no-cast',
    text: 'Простое значение фильтра сравнивается без приведения типов: { price: 900 } не найдёт "900".',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'filter-end-null',
    text: 'Роль конца в фильтре — id цели или null («ссылки нет»): так находятся корневые узлы дерева.',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'cursor-json',
    text: 'Курсор страницы { v, id } переживает JSON; поле cursorOf совпадает с sort; тип проверяется до запроса.',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'countby-limit-groups',
    text: 'limit перед countBy относится к группам: самые частые значения.',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'count-paths',
    text: 'count() — сущности без повторов; count({ paths: true }) — число путей до них.',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'cascade-unset-restrict',
    text: 'Правило конца решает судьбу ссылок при удалении цели: cascade — удалить вместе, unset — снять ссылку, restrict — отказ delete_restricted.',
    source: 'lib/README.md, раздел 7',
  },
  {
    id: 'restore-only-targets',
    text: 'restore() возвращает только цели шага; строки, удалённые каскадом, возвращают отдельно через withDeleted().',
    source: 'lib/README.md, раздел 7',
  },
  {
    id: 'purge-record',
    text: 'purge стирает версии удалённого объекта, на месте версии 1 остаётся запись purge с числом стёртых версий.',
    source: 'lib/README.md, раздел 7',
  },
  {
    id: 'tx-all-or-nothing',
    text: 'db.begin(): записи фиксируются вместе commit(); ошибка — rollback(), не записано ничего.',
    source: 'lib/README.md, раздел 8',
  },
  {
    id: 'opid-idempotency',
    text: 'Ключ операции [кошелёк, opId] защищает от повтора: повтор той же операции — exists, деньги не спишутся дважды.',
    source: 'lib/README.md, раздел 8',
  },
  {
    id: 'commit-unknown-retry',
    text: 'commit_unknown библиотека не повторяет: исход выясняют повтором той же операции с тем же ключом (exists — уже записано).',
    source: 'lib/README.md, раздел 8',
  },
  {
    id: 'start-from-zero',
    text: 'С нуля: up() → роль приложения → createTenant → connect по ключу и вход → syncModels → данные.',
    source: 'guide/start/start.mjs',
  },
  {
    id: 'aggregate-by-db',
    text: 'Агрегатное поле пересчитывает триггер базы после каждого оператора; писать в него нельзя (aggregate_field); min проверяется над итогом.',
    source: 'lib/README.md, раздел 4 «Агрегаты в базе»',
  },
  {
    id: 'projector-lag',
    text: 'Проектор пишет итоги из журнала с отставанием: результат — после прохода run(); писатели не ждут друг друга.',
    source: 'lib/README.md, раздел 12 «Проекторы»',
  },
  {
    id: 'registry-refresh',
    text: 'Реестр классов другого подключения узнаёт о новом классе по сигналу с задержкой; сразу — db.refresh().',
    source: 'lib/src/index.ts:refresh; пример derived/02-projector',
  },
  {
    id: 'login-case-insensitive',
    text: 'Идентификатор при входе сравнивается без учёта регистра (Anna@ и anna@ — один вход).',
    source: 'lib/README.md, раздел 10',
  },
  {
    id: 'password-change-revokes',
    text: 'Смена пароля гасит остальные сессии аккаунта; keepCurrent оставляет текущую.',
    source: 'lib/README.md, раздел 10',
  },
  {
    id: 'deny-by-default',
    text: 'Права включены всегда и по умолчанию запрещают всё; createTenant даёт правило «своим можно всё» (вес 10).',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'rule-weight',
    text: 'Правило с большим весом сильнее: запрет с весом 50 перекрывает «можно всё» с весом 10.',
    source: 'lib/README.md, раздел 10 «Выдать право»',
  },
  {
    id: 'tenant-classes',
    text: 'Классы, записанные syncModels, принадлежат арендатору: другой арендатор не видит даже класса (invalid_class).',
    source: 'пример access/01-rules',
  },
  {
    id: 'watch-cursor-resume',
    text: 'Событие подписки несёт курсор: новая подписка с него получает ровно то, что случилось после, без потерь и повторов.',
    source: 'lib/README.md, раздел 12',
  },
  {
    id: 'mcp-user-rights',
    text: 'Сервер MCP работает с правами пользователя, чьим подключением создан; правка через letopis_write — только с rev.',
    source: 'lib/README.md, раздел 13 «MCP»',
  },
];

export default nuances;
