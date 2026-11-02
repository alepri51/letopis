/**
 * Нюансы и ловушки letopis — каждый должен получить пример (поле `covers` с `nuance.<id>`).
 * Источники: карточки атласа (раздел «Инварианты и грабли»), раздел «Ограничения» README, CHANGELOG.
 * Список пополняется по главам; к концу работы (этап 5) покрытие проверяется строго.
 * Страницу «Все нюансы» по темам и десять главных на странице «Первые 15 минут» пишет scripts/gen-nuances.ts.
 */

/** Темы страницы «Все нюансы» — в порядке глав сайта (план 2.0, этап 5, п. 3). */
export const TOPICS = {
  install: 'Установка и подключение',
  models: 'Модели',
  write: 'Запись',
  read: 'Чтение',
  delete: 'Удаление и восстановление',
  money: 'Транзакции и деньги',
  access: 'Арендаторы и права',
  auth: 'Вход и сессии',
  history: 'История и время',
  watch: 'Подписка, кэш, сигналы',
  derived: 'Агрегаты и проекторы',
  load: 'Массовая загрузка',
  ops: 'Эксплуатация',
  mcp: 'ИИ-агенты: MCP',
  errors: 'Ошибки',
} as const;
export type Topic = keyof typeof TOPICS;

export interface Nuance {
  id: string;
  /** Тема — раздел страницы «Все нюансы». */
  topic: Topic;
  /** Место среди десяти главных (1–10) — они же на странице «Первые 15 минут»; у остальных поля нет. */
  top?: number;
  /**
   * Ловушку теперь ловит код (план 2.0, этап 4): чем — код ошибки или предупреждение, например `'invalid_query'`.
   * На странице нюансов — отметка «ловит код».
   */
  caught?: string;
  /** Суть простыми словами. */
  text: string;
  /** Откуда взят: файл и раздел. */
  source: string;
}

const nuances: Nuance[] = [
  {
    id: 'delete-preview',
    topic: 'delete',
    top: 8,
    text: 'delete() без { confirm: true } ничего не удаляет — возвращает предпросмотр: что удалится и с каким действием ($action).',
    source: 'lib/README.md, раздел 7',
  },
  {
    id: 'class-is-entity',
    topic: 'models',
    text: 'Описание класса — тоже объект: строка класса Class в entity со своей историей в log.',
    source: 'lib/README.md, раздел 2',
  },
  {
    id: 'session-in-secret',
    topic: 'auth',
    text: 'Сессия — строка SESSION в таблице secret; сам токен там не хранится, только его хэш.',
    source: 'lib/sql/10-core.sql, таблица secret',
  },
  {
    id: 'up-idempotent',
    topic: 'install',
    text: 'Повторный up() безопасен: заново применяет ту же версию схемы, данные не трогает, ключ сервиса снова не выдаёт.',
    source: 'lib/README.md, раздел 1; docs/atlas/F-BOOT.md',
  },
  {
    id: 'service-key-once',
    topic: 'install',
    top: 1,
    text: 'Ключ сервиса up() выдаёт только при первой установке или когда не осталось ни одного ключа API, кроме отозванных: истёкший или выключенный ключ тоже в счёт, нового не будет.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'signals-mode-sticky',
    topic: 'install',
    text: 'Режим сигналов хранится в схеме: up() без опции signals его не меняет; после смены — перезапуск процессов.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'fresh-drops-data',
    topic: 'install',
    text: 'up({ fresh: true }) удаляет схему и ставит заново — данные теряются, ключ сервиса новый.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'up-concurrent',
    topic: 'install',
    text: 'Одновременные up() одной схемы (несколько экземпляров сервиса при запуске) не мешают друг другу: накат идёт под блокировкой схемы — первый ставит или обновляет её, остальные ждут и делают повторный накат; первого арендатора (tenant) заводит один из них. up() разных схем друг друга не ждут.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'pglite-no-rls',
    topic: 'install',
    text: 'Подключение к PGlite — суперпользователь (allowBypassRls), одно соединение, без LISTEN: права, изоляцию и гонки на нём не проверить.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'engine-stamp',
    topic: 'install',
    text: 'up() пишет штамп движка (ревизию схемы и версию пакета) в комментарий схемы; connect() предупреждает, если штамп не совпал с пакетом: схему не обновили после обновления пакета или её поставила более новая версия.',
    source: 'lib/README.md, раздел 3; lib/src/up.ts:stampDrift',
  },
  {
    id: 'sync-dry-run',
    topic: 'models',
    top: 2,
    text: 'syncModels без apply — сухой прогон: ничего не пишет, отвечает, что будет создано и изменено.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'key-case',
    topic: 'models',
    top: 4,
    text: 'Значения ключа берутся как есть: email в разном регистре даёт разные id.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'keyless-repeat',
    topic: 'models',
    text: 'Класс без ключа не защищён от повтора: повтор create после сбоя создаёт второй объект.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'no-id-in-create',
    topic: 'models',
    text: 'Поле id в данных create — лишнее поле (invalid_data): id вычисляет или выдаёт база.',
    source: 'пример models/02-keys-and-ids',
  },
  {
    id: 'polymorphic-read',
    topic: 'read',
    text: 'Шаг по классу находит и строки потомков; .exact() — только сам класс.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'refine-lost',
    topic: 'models',
    text: 'refine, superRefine и transform база не исполняет: syncModels возвращает их в lost.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'defaults-by-db',
    topic: 'models',
    text: 'Умолчания .default() модели подставляет сама база при вставке.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'safe-change',
    topic: 'models',
    text: 'Новое необязательное поле, конец, meta, алиас применяются сразу; остальное — ужесточение с проверкой строк.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'history-false',
    topic: 'history',
    text: 'history: false — нет журнала: ни версий, ни среза на дату, ни восстановления, ни событий подписки.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'update-merge',
    topic: 'write',
    text: 'update сливает патч внутри базы: вложенные объекты — рекурсивно, массивы и скаляры заменяются.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'update-empty-target',
    topic: 'write',
    top: 7,
    text: 'update без найденных строк возвращает пустой список без ошибки — проверяйте длину ответа.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'upsert-replaces',
    topic: 'write',
    top: 6,
    text: 'upsert заменяет данные целиком: поля, которых нет в объекте, пропадают; затирает параллельные приращения.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'links-from-path',
    topic: 'write',
    text: 'Концы создаваемой строки берутся из пути цепочки: db.Shop(shop).Product().create() ссылается на shop.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'slots-atomic',
    topic: 'write',
    text: 'Шаги ролей .Роль.set/unset/add/remove меняют links атомарно, без чтения списка.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'inc-min-check',
    topic: 'write',
    text: 'inc проверяет ограничение модели (min) для получившегося значения: уход в минус — invalid_data.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'inc-start',
    topic: 'write',
    text: 'inc по отсутствующему полю — ошибка; inc(n, { start }) начинает с заданного значения.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'rekey-new-id',
    topic: 'write',
    text: 'rekey — новый id; концы других строк переводятся на него, а строки с этим концом в ключе тоже получают новый id.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'anonymize-history',
    topic: 'write',
    text: 'anonymize пишет новую версию с [erased] и тегом anonymized; прежние версии остаются в журнале.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'reason-in-log',
    topic: 'history',
    text: 'Причина изменения (reason) записывается в версию журнала рядом с автором и временем.',
    source: 'lib/README.md, раздел 11',
  },
  {
    id: 'batch-own-queue',
    topic: 'write',
    text: 'Очередь батча своя у каждого объекта подключения (db, db.as(), db.begin()); план выполняется от имени того объекта, через который его положили в очередь.',
    source: 'lib/README.md, раздел 8',
  },
  {
    id: 'mods-after-verb',
    topic: 'write',
    text: 'Цели правки сужают limit(), offset() и sort() до глагола. Модификатор сразу после глагола перед rows(), first(), ids(), count() или paths() — ошибка invalid_query, и ничего не записано: глагол уже прошёл по всем целям. В батче так же отказывает run().',
    source: 'lib/README.md, раздел 5, «Как исполняется план»',
  },
  {
    id: 'tags-op-update',
    topic: 'write',
    text: 'Перед update() строка или список в .tags(…) и отбирают строки, и заменяют их теги целиком, а оператор (has, hasAny, hasAll) только отбирает — теги остаются прежними.',
    source: 'lib/README.md, раздел 5, «Изменить: update»',
  },
  {
    id: 'hasall-empty',
    topic: 'write',
    text: 'hasAll([]) и .tags([]) подходят любой строке (у каждой есть «все теги из пустого списка»), а hasAny([]) и inList([]) — никакой. Пустой список от пользователя перед update() или delete() заденет все строки шага — проверяйте его до запроса.',
    source: 'lib/README.md, раздел 6, операторы фильтра',
  },
  {
    id: 'asof-reverse-once',
    topic: 'history',
    text: 'Объект, к которому ведут несколько путей (например, товар в двух категориях на шаге назад от категорий), приходит в rows() один раз — и в срезе asOf(), и с withDeleted(); count() и итоги его не удваивают, а paths() отдаёт по пути на каждый конец, который к нему ведёт.',
    source: 'lib/README.md, раздел 6, «Терминалы и строка ответа»',
  },
  {
    id: 'step-direction',
    topic: 'read',
    text: 'Шаг цепочки переходит по концам: назад — к объектам, которые ссылаются на текущие; вперёд — к объектам, на которые ссылаются текущие; шаг того же класса — к дочерним узлам дерева.',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'filter-no-cast',
    topic: 'read',
    text: 'Простое значение фильтра сравнивается без приведения типов: { price: 900 } не найдёт "900".',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'filter-end-null',
    topic: 'read',
    text: 'Роль конца в фильтре — id цели или null («конец пуст»): так находятся корневые узлы дерева.',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'cursor-json',
    topic: 'read',
    text: 'Курсор страницы { v, id } можно сохранить в JSON и восстановить; поле в cursorOf должно совпадать с полем sort; тип значения проверяется до запроса.',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'countby-limit-groups',
    topic: 'read',
    text: 'limit перед countBy относится к группам: самые частые значения.',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'count-paths',
    topic: 'read',
    text: 'count() считает каждый объект один раз; count({ paths: true }) — число путей до объектов.',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'cascade-unset-restrict',
    topic: 'delete',
    text: 'Действие при удалении, заданное у конца, решает судьбу концов, ведущих на удаляемую цель: cascade — удалить вместе, unset — очистить конец, restrict — отказ delete_restricted.',
    source: 'lib/README.md, раздел 7',
  },
  {
    id: 'restore-only-targets',
    topic: 'delete',
    text: 'restore() возвращает только цели шага; строки, удалённые каскадом, возвращают отдельно через withDeleted().',
    source: 'lib/README.md, раздел 7',
  },
  {
    id: 'purge-record',
    topic: 'delete',
    text: 'purge стирает версии удалённого объекта, на месте версии 1 остаётся запись purge с числом стёртых версий.',
    source: 'lib/README.md, раздел 7',
  },
  {
    id: 'tx-all-or-nothing',
    topic: 'money',
    text: 'db.begin(): записи фиксируются вместе commit(); ошибка — rollback(), не записано ничего.',
    source: 'lib/README.md, раздел 8',
  },
  {
    id: 'opid-idempotency',
    topic: 'money',
    text: 'Ключ операции [кошелёк, opId] защищает от повтора: повтор той же операции — exists, деньги не спишутся дважды.',
    source: 'lib/README.md, раздел 8',
  },
  {
    id: 'commit-unknown-retry',
    topic: 'money',
    text: 'commit_unknown библиотека не повторяет: исход выясняют повтором той же операции с тем же ключом (exists — уже записано).',
    source: 'lib/README.md, раздел 8',
  },
  {
    id: 'start-from-zero',
    topic: 'install',
    text: 'С нуля: up() → роль приложения → createTenant → connect по ключу и вход → syncModels → данные.',
    source: 'guide/start/start.mjs',
  },
  {
    id: 'aggregate-by-db',
    topic: 'derived',
    text: 'Агрегатное поле пересчитывает триггер базы после каждого оператора; писать в него нельзя (aggregate_field); min проверяется для посчитанного значения.',
    source: 'lib/README.md, раздел 4 «Агрегаты в базе»',
  },
  {
    id: 'projector-lag',
    topic: 'derived',
    text: 'Проектор пишет итоги из журнала с отставанием: результат — после прохода run(); одновременные записи не ждут друг друга.',
    source: 'lib/README.md, раздел 12 «Проекторы»',
  },
  {
    id: 'projector-out-by-key',
    topic: 'derived',
    text: 'out.delete и out.get находят строку класса с ключом по полям ключа, а по id — только строку класса без ключа. Начиная с 1.4.1 один id у класса с ключом — сразу invalid_data, и пачка откатывается.',
    source: 'пример derived/03-projector-options; lib/src/project.ts:Out',
  },
  {
    id: 'mass-write-log-order',
    topic: 'write',
    text: 'Правка многих строк одним оператором пишет их версии в журнал в порядке id, а не в порядке обхода таблицы: журнал одинаков от прогона к прогону. Так же упорядочены пакетная вставка (по порядку входа), перестройка проектора, загрузчик с existing: update и надгробия каскада.',
    source: 'lib/sql/60-write.sql:trg_entity_au (коммит 2f977c0); пример write/07-mass-journal-order',
  },
  {
    id: 'lock-all-writers',
    topic: 'money',
    text: 'Запись итога «прочитал — посчитал — записал» без защиты теряет параллельную правку. lock() и forUpdate() ставят второго писателя в очередь, но только если их берут все, кто правит эти данные; для сумм проще inc — база сама сложит приращения.',
    source: 'lib/test/balance.test.ts №17; пример money/04-race',
  },
  {
    id: 'projector-run-stop',
    topic: 'derived',
    text: 'run() без once не завершается сам: догоняет журнал и ждёт новых изменений. Остановить — stop() (промис run() выполнится с отчётом); процесс, который больше не запускает run(), вызывает close() — проектор отключается от сигналов базы.',
    source: 'lib/src/project.ts:Projector.stop, close; пример derived/04-projector-process',
  },
  {
    id: 'registry-refresh',
    topic: 'watch',
    text: 'Другое подключение узнаёт о новом классе по сигналу, с задержкой: описания классов оно держит в памяти (реестр классов); сразу — db.refresh().',
    source: 'lib/src/index.ts:refresh; пример derived/02-projector',
  },
  {
    id: 'login-case-insensitive',
    topic: 'auth',
    text: 'Идентификатор при входе сравнивается без учёта регистра (Anna@ и anna@ — один вход).',
    source: 'lib/README.md, раздел 10',
  },
  {
    id: 'password-change-revokes',
    topic: 'auth',
    text: 'Смена пароля завершает остальные сессии аккаунта; keepCurrent оставляет текущую.',
    source: 'lib/README.md, раздел 10',
  },
  {
    id: 'deny-by-default',
    topic: 'access',
    top: 9,
    text: 'Права включены всегда и по умолчанию запрещают всё; createTenant даёт правило «своим можно всё» (вес 10).',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'rule-weight',
    topic: 'access',
    text: 'Правило с большим весом сильнее: запрет с весом 50 перекрывает «можно всё» с весом 10.',
    source: 'lib/README.md, раздел 10 «Выдать право»',
  },
  {
    id: 'tenant-classes',
    topic: 'access',
    top: 3,
    text: 'Классы, записанные syncModels, принадлежат арендатору: другой арендатор не видит даже класса (invalid_class).',
    source: 'пример access/01-rules',
  },
  {
    id: 'watch-cursor-resume',
    topic: 'watch',
    text: 'Событие подписки несёт курсор: новая подписка с него получает ровно то, что случилось после, без потерь и повторов.',
    source: 'lib/README.md, раздел 12',
  },
  {
    id: 'watch-subscription-cursor',
    topic: 'watch',
    text: 'Начиная с 1.4.1 подписка, догнавшая журнал, обновляет время своего курсора sub.cursor и на пустых опросах: без событий она не устаревает. Курсор события ev.cursor хранит время события, и после суток затишья продолжение с него — cursor_expired; сохраняйте sub.cursor.',
    source: 'пример watch/02-quiet-cursor; lib/src/watch.ts:Subscription.fetch',
  },
  {
    id: 'mcp-user-rights',
    topic: 'mcp',
    text: 'Сервер MCP работает с правами пользователя, чьим подключением создан; правка через letopis_write — только с rev.',
    source: 'lib/README.md, раздел 13 «MCP»',
  },
  {
    id: 'session-starts-personal',
    topic: 'auth',
    text: 'Свежая сессия входа работает в личном арендаторе аккаунта; в компанию её переводит auth.switch() — смена видна всем подключениям с этим токеном.',
    source: 'lib/sql/20-context.sql:ctx, lib/sql/80-auth.sql:auth_switch',
  },
  {
    id: 'purge-current-tenant',
    topic: 'auth',
    text: 'Начиная с 1.4.1 владелец может стереть арендатора, в котором работает (purgeAccount): сессия возвращается в его личный арендатор.',
    source: 'пример auth/02-sessions-tenants; lib/sql/90-time.sql:account_purge',
  },
  {
    id: 'account-delete-secrets',
    topic: 'auth',
    text: 'Начиная с 1.4.1 удаление аккаунта сразу стирает его строки secret — сессии, пароли, ключи, секреты TOTP, внешние учётные записи; сессии гаснут с сигналом, и кэш их ответов сбрасывается. Аккаунт System удалить нельзя (acl_denied).',
    source: 'пример auth/03-delete-account; lib/sql/60-write.sql:trg_entity_bd_account, внешний ключ secret.account',
  },
  {
    id: 'refresh-never-shortens',
    topic: 'auth',
    text: 'auth.refresh({ ttl }) не укорачивает сессию и не продлевает дальше срока входа: новый срок — позднейшее из текущего и «сейчас + min(ttl, срок входа)».',
    source: 'lib/sql/80-auth.sql:auth_refresh',
  },
  {
    id: 'revoked-session-empty',
    topic: 'auth',
    top: 10,
    text: 'Отозванная или истёкшая сессия при чтении не даёт ошибки: запросы просто возвращают пустой результат. no_session бросают функции входа (auth.*) и connect() с неверным ключом — сервис проверяет сессию в начале каждого запроса.',
    source: 'lib/sql/20-context.sql:ctx; сервис helpdesk',
  },
  {
    id: 'versions-follow',
    topic: 'history',
    text: 'versions() отдаёт версии одного id; versions({ follow: true }) идёт по moved через rekey и reclass — вся жизнь объекта одной лентой, с надгробиями прежних id.',
    source: 'lib/src/sql.ts (versions, follow); пример history/02',
  },
  {
    id: 'reclass-keyed-new-id',
    topic: 'history',
    text: 'Класс входит в v5-id: reclass строки класса с ключом даёт новый id (старый — надгробие с moved), у класса без ключа id прежний.',
    source: 'lib/sql/60-write.sql:move_row; пример history/02',
  },
  {
    id: 'thinning-not-gap',
    topic: 'history',
    text: 'Прореживание по политике — не разрыв журнала: verify() считает законными пропуски номеров версий старше яруса all.',
    source: 'lib/sql/90-time.sql:verify; пример history/03',
  },
  {
    id: 'load-admin-only',
    topic: 'load',
    text: 'db.load — только администраторское подключение (обход RLS и право стать владельцем схемы): иначе admin_required. От имени пользователя — опция as.',
    source: 'lib/src/load.ts; пример load/01',
  },
  {
    id: 'initial-empty-schema',
    topic: 'load',
    text: 'Первая заливка (load({ initial: true })) — только в пустую схему: допустимы классы, аккаунты, членства и права; иначе not_empty.',
    source: 'lib/src/load.ts:initial; пример load/02',
  },
  {
    id: 'reset-tenant-memberships',
    topic: 'ops',
    text: 'reset({ level: "tenant" }) стирает и членства, и правила арендатора: сессии его пользователей в нём получают tenant_denied, а createTenant правила «можно всё» заново не выдаёт.',
    source: 'lib/sql/90-time.sql:reset; пример ops/02',
  },
  {
    id: 'verify-hash-chain',
    topic: 'ops',
    text: 'Хэш версии включает хэш предыдущей: правка журнала в обход библиотеки ломает цепочку, и verify() называет id и номер версии.',
    source: 'lib/sql/10-core.sql (hash); пример ops/01',
  },
  {
    id: 'engine-checks-raw-sql',
    topic: 'errors',
    text: 'Правила целостности проверяют триггеры базы: сырой SQL под сессией получает те же коды, что цепочки; ошибку драйвера в LetopisError переводит fromDbError.',
    source: 'lib/sql/60-write.sql; пример errors/02',
  },
  {
    id: 'chain-not-thenable',
    topic: 'read',
    top: 5,
    text: 'У цепочки нет метода then: await db.Класс(…) отдаёт саму цепочку и ничего не читает — запрос выполняет терминал (rows, first, count…).',
    source: 'lib/src/chain.ts (then → undefined); пример write/06',
  },
  {
    id: 'cache-raced',
    topic: 'watch',
    text: 'Ответ, во время чтения которого пришёл сигнал, способный его изменить (в том числе запоздалый сигнал своей же прошлой записи), в кэш не кладётся: такое же следующее чтение снова пойдёт в базу. Счётчик — raced в db.cache.stats().',
    source: 'lib/src/cache.ts (гонка запроса и сигнала); пример write/06',
  },
  {
    id: 'service-enforces-2fa',
    topic: 'auth',
    text: 'letopis не навязывает второй фактор: verifyPassword без totp даёт сессию и при включённом TOTP — требовать код должен сервис (totpEnabled).',
    source: 'lib/src/auth.ts:verifyPassword; сервис helpdesk',
  },
];

export default nuances;
