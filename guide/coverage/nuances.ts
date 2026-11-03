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
   * Ловушку ловит код (план 2.0, этап 4): чем — код ошибки или предупреждение, например `'invalid_query'`.
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
    text: 'refine и superRefine база не исполняет: syncModels возвращает их в lost — проверяйте в приложении. Преобразования Zod (.trim(), .toLowerCase(), .transform(), z.preprocess(), .pipe()) не исполняет никто — syncModels их отклоняет: invalid_class (model.transform_unsupported); приводите значение в коде до записи.',
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
    text: 'update без найденных строк возвращает пустой список без ошибки — проверяйте длину ответа. Фильтр по данным при гонке перепроверяется под блокировкой: из двух одновременных правок одной строки пройдёт одна, вторая получит пустой ответ. Правило «одна открытая запись на объект» так не удержать — его держит ключ; «прочитал — посчитал — записал» — forUpdate() в db.begin() или { rev }.',
    source: 'lib/README.md, раздел 5; lib/src/write.ts:updateOp; пример money/05-one-open',
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
    id: 'end-not-in-data',
    topic: 'write',
    text: 'Конец связи не передают полем данных create(): для базы это лишнее поле — invalid_data (в issues — additionalProperties с пустым путём). Конец задают вызовом роли после глагола: create({ … }).Роль.set(id).',
    source: 'lib/README.md, раздел 5 «Концы: из пути и слоты»; пример write/02-ends-and-slots',
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
    text: 'restore({ expect }) возвращает только цели шага; строки, удалённые каскадом, возвращают отдельно — по надгробиям этого удаления (ответ delete), с restore({ expect, partial: true }).',
    source: 'lib/README.md, раздел 7',
  },
  {
    id: 'preview-depth',
    topic: 'delete',
    text: 'В предпросмотре удаления у строк каскада $action тоже delete: цель от каскада отличает $depth — 0 у самой цели, 1 и дальше у строк каскада; у строк unset и restrict $depth нет.',
    source: 'lib/README.md, раздел 7; пример delete/01-delete-cascade',
  },
  {
    id: 'delete-as-shown',
    topic: 'delete',
    caught: 'invalid_query',
    text: 'Подтверждение удаления — только с предпросмотром, который видел пользователь: delete({ confirm: true }) без expect — отказ invalid_query (write.confirm_without_expect), ничего не удалено; осознанно, без сверки — delete({ confirm: true, all: true }). delete({ confirm: true, expect: предпросмотр }) удаляет ровно показанное: в транзакции удаления строки каскада блокируются, предпросмотр строится заново под блокировкой и сравнивается по id, rev и $action; не совпал — conflict (write.preview_changed), ничего не удалено, новый предпросмотр — в err.detail.preview.',
    source: 'lib/src/write.ts:deleteOp; пример delete/01-delete-cascade',
  },
  {
    id: 'restore-cascade-by-reason',
    topic: 'delete',
    text: 'restore({ all: true }) вернул бы все удалённые строки шага — и те, что удалили раньше и отдельно. Строки одного удаления знает ответ delete, а без него их отличает причина: надгробия цели и её каскада получают reason этого удаления — отберите их по ней и верните restore({ expect: надгробия }). Причину делайте своей для каждого удаления.',
    source: 'lib/sql/60-write.sql (надгробия каскада с letopis.reason); пример delete/02-restore',
  },
  {
    id: 'restore-expect-stale',
    topic: 'delete',
    caught: 'conflict',
    text: 'Последний снимок строки — не обязательно версия, ушедшая конкретным удалением: если выдачу с ключом по вещи после удаления участника пересоздали (вещь выдали другому) и закрыли, restore({ all: true }) оживил бы чужую закрытую выдачу. restore({ expect: [надгробие] }) вернёт строку, только если её последняя версия — то самое надгробие; иначе отказ и ничего не восстановлено (conflict write.restore_stale; если id занял новый живой объект — not_deleted write.restore_id_taken; err.detail.stale — причина каждой цели), а с partial: true — строка-пропуск. Приложение сообщает «не вернулась».',
    source: 'lib/src/write.ts:deletedTargets, restoreOp; lib/sql/90-time.sql:restore; примеры money/05-one-open, delete/02-restore',
  },
  {
    id: 'restore-partial',
    topic: 'delete',
    text: 'restore({ expect, partial: true }) возвращает удаление целиком одним вызовом: восстанавливает цели, чья последняя версия — то самое надгробие, а остальные отдаёт в ответе строками-пропусками $action: \'skip\' с причиной $why — changed (после удаления строку пересоздавали, правили или удалили снова), reissued (id занял новый живой объект), restored (уже вернули). Без partial одна такая цель роняет весь вызов; partial без expect — invalid_query.',
    source: 'lib/src/write.ts:deletedTargets, restoreOp, skipRow; примеры delete/01-delete-cascade, money/05-one-open',
  },
  {
    id: 'with-deleted-per-step',
    topic: 'delete',
    caught: 'предупреждение api.with_deleted_step',
    text: 'withDeleted() — модификатор своего шага: X(id).withDeleted() — удалённый X, X(id).withDeleted().Y().withDeleted() — удалённые Y удалённого X. withDeleted() только у первого шага (X().withDeleted().Y()) даёт живых Y — letopis один раз предупреждает. Переход идёт по последней версии строки: пересозданную и снова удалённую строку от прежнего родителя не найти — её находят надгробия удаления.',
    source: 'lib/src/sql.ts:buildRead, lib/src/chain.ts:warnWithDeleted; пример delete/02-restore',
  },
  {
    id: 'restore-no-filter',
    topic: 'delete',
    caught: 'invalid_query',
    text: 'restore() без expect — отказ invalid_query (write.restore_without_expect), и для явного id тоже: возвращают по надгробиям — ответу delete или строкам withDeleted().rows(). Осознанно вернуть все удалённые цели шага последним снимком — restore({ all: true }).',
    source: 'lib/src/write.ts:precheckPlan; пример delete/02-restore',
  },
  {
    id: 'empty-target-delete-restore',
    topic: 'delete',
    text: 'Предпросмотр, удаление и возврат по несуществующему или невидимому id возвращают пустой список без ошибки — проверяйте длину ответа.',
    source: 'lib/src/write.ts:restoreOp, deleteOp; пример delete/02-restore',
  },
  {
    id: 'create-revives-deleted',
    topic: 'delete',
    text: 'create с ключом удалённого объекта не ошибка: id тот же, история продолжается версией create, надгробие уходит из корзины, а прежний снимок вернуть уже нельзя — restore({ expect }) даёт not_deleted (write.restore_id_taken). Нужен «новый» объект — проверьте ключ через withDeleted().first() до create.',
    source: 'lib/sql/60-write.sql:trg_entity_bi; пример delete/02-restore',
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
    id: 'mass-write-log-order',
    topic: 'write',
    text: 'Правка многих строк одним оператором пишет их версии в журнал в порядке id, а не в порядке обхода таблицы: журнал одинаков от прогона к прогону. Так же упорядочены пакетная вставка (по порядку входа), загрузчик с existing: update и надгробия каскада.',
    source: 'lib/sql/60-write.sql:trg_entity_au (коммит 2f977c0); пример write/07-mass-journal-order',
  },
  {
    id: 'lock-all-writers',
    topic: 'money',
    text: 'Запись итога «прочитал — посчитал — записал» без защиты теряет параллельную правку. lock() и forUpdate() ставят второго писателя в очередь, но только если их берут все, кто правит эти данные; для сумм проще inc — база сама сложит приращения.',
    source: 'lib/test/balance.test.ts №17; пример money/04-race',
  },
  {
    id: 'update-filter-race',
    topic: 'money',
    text: 'Фильтр update() по данным (не только id) при параллельной записи перепроверяется: найденные строки блокируются и читаются заново тем же запросом, правятся только всё ещё подходящие — из двух одновременных db.Item({ id, status: "free" }).update(…) пройдёт один, второй получит пустой ответ. Это защищает одну строку; решение «прочитал — проверил — записал» — forUpdate() в db.begin() или { rev } (conflict), правило «одна открытая … на …» — ключ.',
    source: 'lib/src/write.ts:updateOp, lib/src/chain.ts:lockedRead; пример money/05-one-open',
  },
  {
    id: 'begin-options-only',
    topic: 'money',
    caught: 'invalid_query',
    text: 'db.begin() принимает только опции { reason } и не вызывает функцию: begin(async (tr) => …) — invalid_query (api.begin_arg). Транзакцию открывает begin(), закрывают tr.commit() или tr.rollback(): try { …; await tr.commit() } catch (e) { await tr.rollback(); throw e }.',
    source: 'lib/src/index.ts:makeDb.begin; пример errors/01-api-errors',
  },
  {
    id: 'one-open-by-key',
    topic: 'money',
    text: 'Уникальность даёт только ключ: «одна открытая выдача на вещь» — отдельный класс (связь) с ключом по концу вещи; вторая такая строка — exists, и при одновременных запросах тоже.',
    source: 'lib/README.md, раздел 4 «Ключ и id»; пример money/05-one-open',
  },
  {
    id: 'registry-refresh',
    topic: 'watch',
    text: 'Другое подключение узнаёт о новом классе по сигналу, с задержкой: описания классов оно держит в памяти (реестр классов); сразу — db.refresh().',
    source: 'lib/src/index.ts:refresh; пример watch/02-quiet-cursor',
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
    text: 'Курсор подписки не устаревает: журнал хранит каждую версию, поэтому продолжить можно с любого сохранённого курсора — хоть через год. sub.cursor — позиция после последнего события, которое отдала подписка (события, прочитанные в запас, он не обгоняет), ev.cursor — после этого события.',
    source: 'пример watch/02-quiet-cursor; lib/src/watch.ts:Subscription',
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
    text: 'Свежая сессия входа работает в личном арендаторе аккаунта: классов компании там нет, шаг db.Item() — invalid_class «…сессия, похоже, в личном арендаторе». Арендаторов пользователя отдаёт auth.tenants() — с name и personal; в компанию сессию переводит auth.switch() — смена видна всем подключениям с этим токеном.',
    source: 'lib/sql/20-context.sql:ctx, lib/sql/80-auth.sql:auth_switch',
  },
  {
    id: 'revoke-by-token',
    topic: 'auth',
    text: 'Выход пользователя в веб-сервисе — svc.auth.revoke(token): сервис гасит сессию по токену из cookie (право auth.session), не подключаясь по нему; true — погашена, false — токен неверный, сессия погашена или истекла. revoke() без аргумента гасит сессию самого подключения — у сервиса это его собственный вход.',
    source: 'lib/src/auth.ts:revoke, lib/sql/80-auth.sql:auth_logout_token; пример auth/02-sessions-tenants',
  },
  {
    id: 'web-login-one-pool',
    topic: 'auth',
    text: 'Веб-сервис подключается к базе один раз — по ключу сервиса — и на каждый запрос работает через svc.as(аккаунт, { tenant }) на том же пуле. connect({ token }) на каждый вход создаёт пул на пользователя (до max соединений, по умолчанию 10) и исчерпывает соединения PostgreSQL. Арендатора берите из серверной сессии, а не из параметра запроса.',
    source: 'lib/src/index.ts:connect, makeDb.as; пример auth/04-web-login',
  },
  {
    id: 'purge-current-tenant',
    topic: 'auth',
    text: 'Владелец может стереть арендатора, в котором работает (purgeAccount): сессия возвращается в его личный арендатор.',
    source: 'пример auth/02-sessions-tenants; lib/sql/90-time.sql:account_purge',
  },
  {
    id: 'account-delete-secrets',
    topic: 'auth',
    text: 'Удаление аккаунта сразу стирает его строки secret — сессии, пароли, ключи, секреты TOTP, внешние учётные записи; сессии гаснут с сигналом, и кэш их ответов сбрасывается. Аккаунт System удалить нельзя (acl_denied).',
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
    text: 'Отозванная или истёкшая сессия при чтении не даёт ошибки: запросы просто возвращают пустой результат. no_session бросают функции входа (auth.*) и connect() с неверным ключом или погашенным токеном — сервис проверяет сессию в начале каждого запроса.',
    source: 'lib/sql/20-context.sql:ctx; сервис helpdesk',
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
    id: 'engine-checks-raw-sql',
    topic: 'errors',
    text: 'Правила целостности проверяют триггеры базы: сырой SQL под сессией получает те же коды, что цепочки; ошибку драйвера в LetopisError переводит fromDbError.',
    source: 'lib/sql/60-write.sql; пример errors/02',
  },
  {
    id: 'bad-uuid-letopis-error',
    topic: 'errors',
    caught: 'invalid_query',
    text: 'id шага, список id и { id } в фильтре, которые не uuid (и null), — отказ invalid_query до запроса (query.bad_uuid). Значение не того типа, которое дошло до базы (SQLSTATE 22P02, например в db.sql), — тоже LetopisError с кодом invalid_query (api.db_bad_value), исходная ошибка драйвера — в err.cause. Свойство массива у цепочки (length, map…) — invalid_query «цепочка — не массив».',
    source: 'lib/src/sql.ts:compileFilter, lib/src/errors.ts:fromDbError, lib/src/chain.ts; пример errors/01-api-errors',
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
  {
    id: 'update-needs-filter',
    topic: 'write',
    caught: 'invalid_query',
    text: 'update() и delete({ confirm: true, expect }), у которых ни у одного шага нет фильтра, id, tags(), owner() или limit(), отклоняются до записи: правка прошла бы по всем строкам шага. Все строки — только явно: update(патч, { all: true }), delete({ confirm: true, all: true }); предпросмотр delete() — без условий.',
    source: 'lib/README.md, раздел 4 «Строгий режим», раздел 5 «Изменить: update»; пример errors/03-strict-mcp-errors',
  },
  {
    id: 'key-class-immutable',
    topic: 'write',
    caught: 'immutable_key',
    text: 'Ключевые поля, класс, id, арендатор и владелец строки правкой не меняются — и сырым UPDATE тоже. Объект с другим ключом или классом — новый объект: создать его, перевести на него концы других строк и удалить прежний, одной транзакцией; у нового своя история, у прежнего она остаётся.',
    source: 'lib/README.md, раздел 5 «Ключ и класс неизменны»; пример write/04-key-class-immutable',
  },
  {
    id: 'unknown-option',
    topic: 'install',
    caught: 'invalid_data',
    text: 'Неизвестная опция connect(), up(), db.load(), db.watch() и createMcpServer() — отказ до подключения, с похожими именами в тексте и в err.params.similar: опечатка в опции не проходит молча.',
    source: 'lib/README.md, раздел 4 «Строгий режим»; пример errors/03-strict-mcp-errors',
  },
  {
    id: 'unknown-field',
    topic: 'read',
    caught: 'invalid_query',
    text: 'Поле фильтра, sort() или итога, которого нет в описании ни одного класса шага (с потомками, если шаг не exact()), — отказ до запроса, с похожими именами в тексте и в err.params.similar: такое условие ничего бы не нашло. Сверяется только первый ключ пути: опечатку внутри поля-объекта ({ specs: { colr } }) библиотека не видит, условие просто ничего не найдёт.',
    source: 'lib/README.md, раздел 4 «Строгий режим», раздел 15 «Ошибки»; пример errors/03-strict-mcp-errors',
  },
  {
    id: 'after-before-count',
    topic: 'read',
    caught: 'invalid_query',
    text: 'after() листает rows(), ids(), versions() и paths(); перед count() и итогами sum, avg, min, max, countBy — отказ: они считают по всем объектам шага, и курсор там молча не учитывался бы.',
    source: 'lib/README.md, раздел 4 «Строгий режим»; пример errors/03-strict-mcp-errors',
  },
  {
    id: 'strict-types-loose',
    topic: 'models',
    text: 'Подключение с моделями (connect({ models })) или с объявлениями letopis types даёт строгие типы: шаг — только класс моделей или системный, переход — только по концам, поля фильтра — поля класса. Имя класса, известное только во время выполнения, — через loose(db): то же подключение без строгих типов.',
    source: 'lib/README.md, раздел 4 «Строгий режим»; пример models/06-exports',
  },
];

export default nuances;
