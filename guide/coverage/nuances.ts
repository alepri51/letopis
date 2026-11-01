/**
 * Нюансы и ловушки letopis — каждый должен получить пример (поле `covers` с `nuance.<id>`).
 * Источники: карточки атласа (раздел «Инварианты и грабли»), раздел «Ограничения» README, CHANGELOG.
 * Список пополняется по главам; к концу работы (этап 5) покрытие проверяется строго.
 */
export interface Nuance {
  id: string;
  /** Суть простыми словами. */
  text: string;
  /** То же по-английски — для lib/llms-full.txt (план 2.0, этап 3, п. 4). */
  en: string;
  /** Откуда взят: файл и раздел. */
  source: string;
}

const nuances: Nuance[] = [
  {
    id: 'delete-preview',
    text: 'delete() без { confirm: true } ничего не удаляет — возвращает предпросмотр: что удалится и с каким действием ($action).',
    en: 'delete() without { confirm: true } deletes nothing; it returns a preview: what will be deleted and with which action ($action).',
    source: 'lib/README.md, раздел 7',
  },
  {
    id: 'class-is-entity',
    text: 'Описание класса — тоже объект: строка класса Class в entity со своей историей в log.',
    en: 'A class description is an object too: a row of class Class in entity with its own history in log.',
    source: 'lib/README.md, раздел 2',
  },
  {
    id: 'session-in-secret',
    text: 'Сессия — строка SESSION в таблице secret; сам токен там не хранится, только его хэш.',
    en: 'A session is a SESSION row in the secret table; the token itself is not stored there, only its hash.',
    source: 'lib/sql/10-core.sql, таблица secret',
  },
  {
    id: 'up-idempotent',
    text: 'Повторный up() безопасен: заново применяет ту же версию схемы, данные не трогает, ключ сервиса снова не выдаёт.',
    en: 'A repeated up() is safe: it re-applies the same schema version, does not touch the data and does not issue the service key again.',
    source: 'lib/README.md, раздел 1; docs/atlas/F-BOOT.md',
  },
  {
    id: 'service-key-once',
    text: 'Ключ сервиса up() выдаёт только при первой установке или когда не осталось ни одного ключа API, кроме отозванных: истёкший или выключенный ключ тоже в счёт, нового не будет.',
    en: 'up() issues a service key only on the first installation or when no API key is left except revoked ones: an expired or disabled key counts too, and no new one is issued.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'signals-mode-sticky',
    text: 'Режим сигналов хранится в схеме: up() без опции signals его не меняет; после смены — перезапуск процессов.',
    en: 'The signal mode is stored in the schema: up() without the signals option does not change it; after a change, restart the processes.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'fresh-drops-data',
    text: 'up({ fresh: true }) удаляет схему и ставит заново — данные теряются, ключ сервиса новый.',
    en: 'up({ fresh: true }) drops the schema and installs it again: the data is lost, and the service key is new.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'up-concurrent',
    text: 'Одновременные up() одной схемы (несколько экземпляров сервиса при запуске) не мешают друг другу: накат идёт под блокировкой схемы — первый ставит или обновляет её, остальные ждут и делают повторный накат; первого арендатора (tenant) заводит один из них. up() разных схем друг друга не ждут.',
    en: 'Concurrent up() calls for one schema (several service instances at startup) do not interfere with each other: the schema is applied under a lock on it; the first call installs or upgrades it, the others wait and re-apply it; one of them creates the first tenant (the tenant option). up() calls for different schemas do not wait for each other.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'pglite-no-rls',
    text: 'Подключение к PGlite — суперпользователь (allowBypassRls), одно соединение, без LISTEN: права, изоляцию и гонки на нём не проверить.',
    en: 'A connection to PGlite is a superuser (allowBypassRls), a single connection, without LISTEN: permissions, isolation and races cannot be tested on it.',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'engine-stamp',
    text: 'up() пишет штамп движка (ревизию схемы и версию пакета) в комментарий схемы; connect() предупреждает, если штамп не совпал с пакетом: схему не обновили после обновления пакета или её поставила более новая версия.',
    en: 'up() writes an engine stamp (the schema revision and the package version) into the schema comment; connect() warns if the stamp does not match the package: the schema was not upgraded after a package update, or a newer version installed it.',
    source: 'lib/README.md, раздел 3; lib/src/up.ts:stampDrift',
  },
  {
    id: 'sync-dry-run',
    text: 'syncModels без apply — сухой прогон: ничего не пишет, отвечает, что будет создано и изменено.',
    en: 'syncModels without apply is a dry run: it writes nothing and reports what will be created and changed.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'key-case',
    text: 'Значения ключа берутся как есть: email в разном регистре даёт разные id.',
    en: 'Key values are taken as is: the same email in different letter case gives different ids.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'keyless-repeat',
    text: 'Класс без ключа не защищён от повтора: повтор create после сбоя создаёт второй объект.',
    en: 'A class without a key is not protected against repeats: repeating create after a failure creates a second object.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'no-id-in-create',
    text: 'Поле id в данных create — лишнее поле (invalid_data): id вычисляет или выдаёт база.',
    en: 'An id field in the create data is an extra field (invalid_data): the database computes or assigns the id.',
    source: 'пример models/02-keys-and-ids',
  },
  {
    id: 'polymorphic-read',
    text: 'Шаг по классу находит и строки потомков; .exact() — только сам класс.',
    en: 'A class step also finds the rows of descendants; .exact() finds only the class itself.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'refine-lost',
    text: 'refine, superRefine и transform база не исполняет: syncModels возвращает их в lost.',
    en: 'The database does not execute refine, superRefine and transform: syncModels returns them in lost.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'defaults-by-db',
    text: 'Умолчания .default() модели подставляет сама база при вставке.',
    en: 'The database itself fills in the .default() values of the model on insert.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'safe-change',
    text: 'Новое необязательное поле, конец, meta, алиас применяются сразу; остальное — ужесточение с проверкой строк.',
    en: 'A new optional field, end, meta or alias is applied at once; anything else is a tightening with a check of the rows.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'history-false',
    text: 'history: false — нет журнала: ни версий, ни среза на дату, ни восстановления, ни событий подписки.',
    en: 'history: false means no journal: no versions, no point-in-time reads, no restore and no subscription events.',
    source: 'lib/README.md, раздел 4',
  },
  {
    id: 'update-merge',
    text: 'update сливает патч внутри базы: вложенные объекты — рекурсивно, массивы и скаляры заменяются.',
    en: 'update merges the patch inside the database: nested objects recursively, while arrays and scalars are replaced.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'update-empty-target',
    text: 'update без найденных строк возвращает пустой список без ошибки — проверяйте длину ответа.',
    en: 'update with no rows found returns an empty list without an error; check the length of the answer.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'upsert-replaces',
    text: 'upsert заменяет данные целиком: поля, которых нет в объекте, пропадают; затирает параллельные приращения.',
    en: 'upsert replaces the data entirely: fields that are not in the object disappear; it overwrites concurrent increments.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'links-from-path',
    text: 'Ссылки создаваемой строки берутся из пути цепочки: db.Shop(shop).Product().create() ссылается на shop.',
    en: 'The references of a created row are taken from the chain path: db.Shop(shop).Product().create() references shop.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'slots-atomic',
    text: 'Слоты .Роль.set/unset/add/remove меняют links атомарно, без чтения списка.',
    en: 'The .RoleName.set/unset/add/remove slots change links atomically, without reading the list.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'inc-min-check',
    text: 'inc проверяет ограничение модели (min) для получившегося значения: уход в минус — invalid_data.',
    en: 'inc checks the model constraint (min) against the resulting value: going negative gives invalid_data.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'inc-start',
    text: 'inc по отсутствующему полю — ошибка; inc(n, { start }) начинает с заданного значения.',
    en: 'inc on a missing field is an error; inc(n, { start }) starts from the given value.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'rekey-new-id',
    text: 'rekey — новый id; ссылки переводятся, строки с этим концом в ключе тоже получают новый id.',
    en: 'rekey gives a new id; references are moved, and rows with this end in their key get a new id too.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'anonymize-history',
    text: 'anonymize пишет новую версию с [erased] и тегом anonymized; прежние версии остаются в журнале.',
    en: 'anonymize writes a new version with [erased] and the anonymized tag; the earlier versions stay in the journal.',
    source: 'lib/README.md, раздел 5',
  },
  {
    id: 'reason-in-log',
    text: 'Причина изменения (reason) записывается в версию журнала рядом с автором и временем.',
    en: 'The reason for a change (reason) is written into the journal version next to the author and the time.',
    source: 'lib/README.md, раздел 11',
  },
  {
    id: 'batch-own-queue',
    text: 'Очередь батча своя у каждого объекта подключения (db, db.as(), db.begin()); план выполняется от имени того объекта, через который его положили в очередь.',
    en: 'Each connection object (db, db.as(), db.begin()) has its own batch queue; a plan runs on behalf of the object through which it was queued.',
    source: 'lib/README.md, раздел 8',
  },
  {
    id: 'mods-after-verb',
    text: 'Цели правки сужают limit(), offset() и sort() до глагола. Модификатор сразу после глагола перед rows(), first(), ids(), count() или paths() — ошибка invalid_query, и ничего не записано: глагол уже прошёл по всем целям. В батче так же отказывает run().',
    en: 'limit(), offset() and sort() before the verb narrow the targets of a write. A modifier right after the verb, before rows(), first(), ids(), count() or paths(), is an invalid_query error, and nothing is written: the verb has already gone through all targets. In a batch, run() refuses the same way.',
    source: 'lib/README.md, раздел 5, «Как исполняется план»',
  },
  {
    id: 'tags-op-update',
    text: 'Перед update() строка или список в .tags(…) и отбирают строки, и заменяют их теги целиком, а оператор (has, hasAny, hasAll) только отбирает — теги остаются прежними.',
    en: 'Before update(), a string or a list in .tags(...) both selects the rows and replaces their tags entirely, while an operator (has, hasAny, hasAll) only selects; the tags stay as they were.',
    source: 'lib/README.md, раздел 5, «Изменить: update»',
  },
  {
    id: 'hasall-empty',
    text: 'hasAll([]) и .tags([]) подходят любой строке (у каждой есть «все теги из пустого списка»), а hasAny([]) и inList([]) — никакой. Пустой список от пользователя перед update() или delete() заденет все строки шага — проверяйте его до запроса.',
    en: 'hasAll([]) and .tags([]) match any row (every row has "all tags from the empty list"), while hasAny([]) and inList([]) match none. An empty list from a user before update() or delete() will hit all rows of the step; check it before the query.',
    source: 'lib/README.md, раздел 6, операторы фильтра',
  },
  {
    id: 'asof-reverse-once',
    text: 'Объект, к которому ведут несколько путей (например, товар в двух категориях на шаге назад от категорий), приходит в rows() один раз — и в срезе asOf(), и с withDeleted(); count() и итоги его не удваивают, а paths() отдаёт по пути на каждую ссылку.',
    en: 'An object reached by several paths (for example, a product in two categories on a backward step from the categories) comes in rows() once, both in an asOf() slice and with withDeleted(); count() and totals do not count it twice, while paths() returns one path per reference.',
    source: 'lib/README.md, раздел 6, «Терминалы и строка ответа»',
  },
  {
    id: 'step-direction',
    text: 'Шаг цепочки переходит по ссылкам: назад — к объектам, которые ссылаются на текущие; вперёд — к объектам, на которые ссылаются текущие; шаг того же класса — к дочерним узлам дерева.',
    en: 'A chain step follows references: backward to the objects that reference the current ones; forward to the objects the current ones reference; a step of the same class goes to the child nodes of a tree.',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'filter-no-cast',
    text: 'Простое значение фильтра сравнивается без приведения типов: { price: 900 } не найдёт "900".',
    en: 'A plain filter value is compared without type casting: { price: 900 } will not find "900".',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'filter-end-null',
    text: 'Роль конца в фильтре — id цели или null («ссылки нет»): так находятся корневые узлы дерева.',
    en: 'An end role in a filter takes a target id or null ("no reference"): this is how the root nodes of a tree are found.',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'cursor-json',
    text: 'Курсор страницы { v, id } можно сохранить в JSON и восстановить; поле в cursorOf должно совпадать с полем sort; тип значения проверяется до запроса.',
    en: 'A page cursor { v, id } can be saved to JSON and restored; the field in cursorOf must match the sort field; the value type is checked before the query.',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'countby-limit-groups',
    text: 'limit перед countBy относится к группам: самые частые значения.',
    en: 'limit before countBy applies to the groups: the most frequent values.',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'count-paths',
    text: 'count() считает каждый объект один раз; count({ paths: true }) — число путей до объектов.',
    en: 'count() counts each object once; count({ paths: true }) is the number of paths to the objects.',
    source: 'lib/README.md, раздел 6',
  },
  {
    id: 'cascade-unset-restrict',
    text: 'Действие при удалении, заданное у конца, решает судьбу ссылок на удаляемую цель: cascade — удалить вместе, unset — снять ссылку, restrict — отказ delete_restricted.',
    en: 'The on-delete action set on an end decides the fate of references to a target being deleted: cascade deletes the referencing rows together with it, unset removes the reference, restrict refuses with delete_restricted.',
    source: 'lib/README.md, раздел 7',
  },
  {
    id: 'restore-only-targets',
    text: 'restore() возвращает только цели шага; строки, удалённые каскадом, возвращают отдельно через withDeleted().',
    en: 'restore() brings back only the targets of the step; rows deleted by the cascade are brought back separately via withDeleted().',
    source: 'lib/README.md, раздел 7',
  },
  {
    id: 'purge-record',
    text: 'purge стирает версии удалённого объекта, на месте версии 1 остаётся запись purge с числом стёртых версий.',
    en: 'purge erases the versions of a deleted object; in place of version 1, a purge record stays with the number of erased versions.',
    source: 'lib/README.md, раздел 7',
  },
  {
    id: 'tx-all-or-nothing',
    text: 'db.begin(): записи фиксируются вместе commit(); ошибка — rollback(), не записано ничего.',
    en: 'db.begin(): the writes are committed together by commit(); on an error, rollback(), and nothing is written.',
    source: 'lib/README.md, раздел 8',
  },
  {
    id: 'opid-idempotency',
    text: 'Ключ операции [кошелёк, opId] защищает от повтора: повтор той же операции — exists, деньги не спишутся дважды.',
    en: 'The operation key [wallet, opId] protects against repeats: repeating the same operation gives exists, and the money is not debited twice.',
    source: 'lib/README.md, раздел 8',
  },
  {
    id: 'commit-unknown-retry',
    text: 'commit_unknown библиотека не повторяет: исход выясняют повтором той же операции с тем же ключом (exists — уже записано).',
    en: 'The library does not retry commit_unknown: the outcome is found out by repeating the same operation with the same key (exists means it is already written).',
    source: 'lib/README.md, раздел 8',
  },
  {
    id: 'start-from-zero',
    text: 'С нуля: up() → роль приложения → createTenant → connect по ключу и вход → syncModels → данные.',
    en: 'From scratch: up() -> application role -> createTenant -> connect by key and sign-in -> syncModels -> data.',
    source: 'guide/start/start.mjs',
  },
  {
    id: 'aggregate-by-db',
    text: 'Агрегатное поле пересчитывает триггер базы после каждого оператора; писать в него нельзя (aggregate_field); min проверяется для посчитанного значения.',
    en: 'An aggregate field is recalculated by a database trigger after each statement; it cannot be written to (aggregate_field); min is checked against the computed value.',
    source: 'lib/README.md, раздел 4 «Агрегаты в базе»',
  },
  {
    id: 'projector-lag',
    text: 'Проектор пишет итоги из журнала с отставанием: результат — после прохода run(); одновременные записи не ждут друг друга.',
    en: 'A projector writes totals from the journal with a lag: the result appears after a run() pass; concurrent writes do not wait for each other.',
    source: 'lib/README.md, раздел 12 «Проекторы»',
  },
  {
    id: 'projector-out-by-key',
    text: 'out.delete и out.get находят строку класса с ключом по полям ключа, а по id — только строку класса без ключа. Начиная с 1.4.1 один id у класса с ключом — сразу invalid_data, и пачка откатывается.',
    en: 'out.delete and out.get find a row of a class with a key by the key fields, and by id only a row of a class without a key. Since 1.4.1, an id alone for a class with a key is an immediate invalid_data, and the batch is rolled back.',
    source: 'пример derived/03-projector-options; lib/src/project.ts:Out',
  },
  {
    id: 'mass-write-log-order',
    text: 'Правка многих строк одним оператором пишет их версии в журнал в порядке id, а не в порядке обхода таблицы: журнал одинаков от прогона к прогону. Так же упорядочены пакетная вставка (по порядку входа), перестройка проектора, загрузчик с existing: update и надгробия каскада.',
    en: 'Editing many rows with one statement writes their versions to the journal in id order, not in table scan order: the journal is the same from run to run. A batch insert (in input order), a projector rebuild, the loader with existing: update and cascade tombstones are ordered the same way.',
    source: 'lib/sql/60-write.sql:trg_entity_au (коммит 2f977c0); пример write/07-mass-journal-order',
  },
  {
    id: 'lock-all-writers',
    text: 'Запись итога «прочитал — посчитал — записал» без защиты теряет параллельную правку. lock() и forUpdate() ставят второго писателя в очередь, но только если их берут все, кто правит эти данные; для сумм проще inc — база сама сложит приращения.',
    en: 'Writing a total as "read - compute - write" without protection loses a concurrent edit. lock() and forUpdate() queue the second writer, but only if everyone who edits this data takes them; for sums, inc is simpler: the database adds up the increments itself.',
    source: 'lib/test/balance.test.ts №17; пример money/04-race',
  },
  {
    id: 'projector-run-stop',
    text: 'run() без once не завершается сам: догоняет журнал и ждёт новых изменений. Остановить — stop() (промис run() выполнится с отчётом); процесс, который больше не запускает run(), вызывает close() — проектор отключается от сигналов базы.',
    en: 'run() without once does not finish by itself: it catches up with the journal and waits for new changes. To stop it, call stop() (the run() promise resolves with a report); a process that no longer starts run() calls close(), and the projector unsubscribes from database signals.',
    source: 'lib/src/project.ts:Projector.stop, close; пример derived/04-projector-process',
  },
  {
    id: 'registry-refresh',
    text: 'Другое подключение узнаёт о новом классе по сигналу, с задержкой: описания классов оно держит в памяти (реестр классов); сразу — db.refresh().',
    en: 'Another connection learns about a new class from a signal, with a delay: it keeps class descriptions in memory (the class registry); to see it at once, call db.refresh().',
    source: 'lib/src/index.ts:refresh; пример derived/02-projector',
  },
  {
    id: 'login-case-insensitive',
    text: 'Идентификатор при входе сравнивается без учёта регистра (Anna@ и anna@ — один вход).',
    en: 'The sign-in identifier is compared case-insensitively (Anna@ and anna@ are one login).',
    source: 'lib/README.md, раздел 10',
  },
  {
    id: 'password-change-revokes',
    text: 'Смена пароля завершает остальные сессии аккаунта; keepCurrent оставляет текущую.',
    en: 'A password change revokes the other sessions of the account; keepCurrent keeps the current one.',
    source: 'lib/README.md, раздел 10',
  },
  {
    id: 'deny-by-default',
    text: 'Права включены всегда и по умолчанию запрещают всё; createTenant даёт правило «своим можно всё» (вес 10).',
    en: 'Permissions are always on and deny everything by default; createTenant grants the rule "authenticated users may do everything" (weight 10).',
    source: 'lib/README.md, раздел 3',
  },
  {
    id: 'rule-weight',
    text: 'Правило с большим весом сильнее: запрет с весом 50 перекрывает «можно всё» с весом 10.',
    en: 'A rule with a higher weight is stronger: a deny with weight 50 overrides "may do everything" with weight 10.',
    source: 'lib/README.md, раздел 10 «Выдать право»',
  },
  {
    id: 'tenant-classes',
    text: 'Классы, записанные syncModels, принадлежат арендатору: другой арендатор не видит даже класса (invalid_class).',
    en: 'Classes written by syncModels belong to the tenant: another tenant does not even see the class (invalid_class).',
    source: 'пример access/01-rules',
  },
  {
    id: 'watch-cursor-resume',
    text: 'Событие подписки несёт курсор: новая подписка с него получает ровно то, что случилось после, без потерь и повторов.',
    en: 'A subscription event carries a cursor: a new subscription from it gets exactly what happened after it, without losses or repeats.',
    source: 'lib/README.md, раздел 12',
  },
  {
    id: 'watch-subscription-cursor',
    text: 'Начиная с 1.4.1 подписка, догнавшая журнал, обновляет время своего курсора sub.cursor и на пустых опросах: без событий она не устаревает. Курсор события ev.cursor хранит время события, и после суток затишья продолжение с него — cursor_expired; сохраняйте sub.cursor.',
    en: 'Since 1.4.1, a subscription that has caught up with the journal updates the time of its cursor sub.cursor on empty polls too: without events it does not expire. The event cursor ev.cursor keeps the time of the event, and after a day of quiet, resuming from it gives cursor_expired; save sub.cursor.',
    source: 'пример watch/02-quiet-cursor; lib/src/watch.ts:Subscription.fetch',
  },
  {
    id: 'mcp-user-rights',
    text: 'Сервер MCP работает с правами пользователя, чьим подключением создан; правка через letopis_write — только с rev.',
    en: 'The MCP server works with the permissions of the user whose connection created it; editing through letopis_write works only with rev.',
    source: 'lib/README.md, раздел 13 «MCP»',
  },
  {
    id: 'session-starts-personal',
    text: 'Свежая сессия входа работает в личном арендаторе учётной записи; в компанию её переводит auth.switch() — смена видна всем подключениям с этим токеном.',
    en: 'A fresh sign-in session works in the personal tenant of the account; auth.switch() moves it into a company, and the switch is visible to all connections with this token.',
    source: 'lib/sql/20-context.sql:ctx, lib/sql/80-auth.sql:auth_switch',
  },
  {
    id: 'purge-current-tenant',
    text: 'Начиная с 1.4.1 владелец может стереть арендатора, в котором работает (purgeAccount): сессия возвращается в его личный арендатор.',
    en: 'Since 1.4.1, an owner can erase the tenant they are working in (purgeAccount): the session returns to their personal tenant.',
    source: 'пример auth/02-sessions-tenants; lib/sql/90-time.sql:account_purge',
  },
  {
    id: 'account-delete-secrets',
    text: 'Начиная с 1.4.1 удаление учётной записи сразу стирает её строки secret — сессии, пароли, ключи, секреты TOTP, внешние учётные записи; сессии гаснут с сигналом, и кэш их ответов сбрасывается. Учётную запись System удалить нельзя (acl_denied).',
    en: 'Since 1.4.1, deleting an account immediately erases its secret rows: sessions, passwords, keys, TOTP secrets, external accounts; the sessions are revoked with a signal, and the cache of their answers is cleared. The System account cannot be deleted (acl_denied).',
    source: 'пример auth/03-delete-account; lib/sql/60-write.sql:trg_entity_bd_account, внешний ключ secret.account',
  },
  {
    id: 'refresh-never-shortens',
    text: 'auth.refresh({ ttl }) не укорачивает сессию и не продлевает дальше срока входа: новый срок — позднейшее из текущего и «сейчас + min(ttl, срок входа)».',
    en: 'auth.refresh({ ttl }) does not shorten the session and does not extend it beyond the sign-in lifetime: the new expiry is the later of the current one and "now + min(ttl, sign-in lifetime)".',
    source: 'lib/sql/80-auth.sql:auth_refresh',
  },
  {
    id: 'revoked-session-empty',
    text: 'Отозванная или истёкшая сессия при чтении не даёт ошибки: запросы просто возвращают пустой результат. no_session бросают функции входа (auth.*) и connect() с неверным ключом — сервис проверяет сессию в начале каждого запроса.',
    en: 'A revoked or expired session gives no error on reads: queries simply return an empty result. no_session is thrown by the sign-in functions (auth.*) and by connect() with a wrong key; a service checks the session at the start of every request.',
    source: 'lib/sql/20-context.sql:ctx; сервис helpdesk',
  },
  {
    id: 'versions-follow',
    text: 'versions() отдаёт версии одного id; versions({ follow: true }) идёт по moved через rekey и reclass — вся жизнь объекта одной лентой, с надгробиями прежних id.',
    en: 'versions() returns the versions of one id; versions({ follow: true }) follows moved across rekey and reclass: the whole life of the object as one timeline, with the tombstones of the former ids.',
    source: 'lib/src/sql.ts (versions, follow); пример history/02',
  },
  {
    id: 'reclass-keyed-new-id',
    text: 'Класс входит в v5-id: reclass строки класса с ключом даёт новый id (старый — надгробие с moved), у класса без ключа id прежний.',
    en: 'The class is part of the v5 id: reclass of a row of a class with a key gives a new id (the old one becomes a tombstone with moved); for a class without a key, the id stays the same.',
    source: 'lib/sql/60-write.sql:move_row; пример history/02',
  },
  {
    id: 'thinning-not-gap',
    text: 'Прореживание по политике — не разрыв журнала: verify() считает законными пропуски номеров версий старше яруса all.',
    en: 'Thinning under the retention policy is not a break in the journal: verify() treats gaps in version numbers older than the all tier as legitimate.',
    source: 'lib/sql/90-time.sql:verify; пример history/03',
  },
  {
    id: 'load-admin-only',
    text: 'db.load — только администраторское подключение (обход RLS и право стать владельцем схемы): иначе admin_required. От имени пользователя — опция as.',
    en: 'db.load works only on an admin connection (RLS bypass and the right to become the schema owner); otherwise admin_required. On behalf of a user: the as option.',
    source: 'lib/src/load.ts; пример load/01',
  },
  {
    id: 'initial-empty-schema',
    text: 'Первая заливка (load({ initial: true })) — только в пустую схему: допустимы классы, аккаунты, членства и права; иначе not_empty.',
    en: 'The initial load (load({ initial: true })) goes only into an empty schema: classes, accounts, memberships and permissions are allowed; otherwise not_empty.',
    source: 'lib/src/load.ts:initial; пример load/02',
  },
  {
    id: 'reset-tenant-memberships',
    text: 'reset({ level: "tenant" }) стирает и членства, и правила арендатора: сессии его пользователей в нём получают tenant_denied, а createTenant правила «можно всё» заново не выдаёт.',
    en: 'reset({ level: "tenant" }) erases both the memberships and the rules of the tenant: the sessions of its users in it get tenant_denied, and createTenant does not issue the "may do everything" rule again.',
    source: 'lib/sql/90-time.sql:reset; пример ops/02',
  },
  {
    id: 'verify-hash-chain',
    text: 'Хэш версии включает хэш предыдущей: правка журнала в обход библиотеки ломает цепочку, и verify() называет id и номер версии.',
    en: 'The hash of a version includes the hash of the previous one: editing the journal bypassing the library breaks the chain, and verify() names the id and the version number.',
    source: 'lib/sql/10-core.sql (hash); пример ops/01',
  },
  {
    id: 'engine-checks-raw-sql',
    text: 'Правила целостности проверяют триггеры базы: сырой SQL под сессией получает те же коды, что цепочки; ошибку драйвера в LetopisError переводит fromDbError.',
    en: 'Integrity rules are checked by database triggers: raw SQL under a session gets the same codes as chains; fromDbError turns a driver error into a LetopisError.',
    source: 'lib/sql/60-write.sql; пример errors/02',
  },
  {
    id: 'chain-not-thenable',
    text: 'У цепочки нет метода then: await db.Класс(…) отдаёт саму цепочку и ничего не читает — запрос выполняет терминал (rows, first, count…).',
    en: 'A chain has no then method: await db.ClassName(...) returns the chain itself and reads nothing; the query is executed by a terminal (rows, first, count...).',
    source: 'lib/src/chain.ts (then → undefined); пример write/06',
  },
  {
    id: 'cache-raced',
    text: 'Ответ, во время чтения которого пришёл сигнал, способный его изменить (в том числе запоздалый сигнал своей же прошлой записи), в кэш не кладётся: такое же следующее чтение снова пойдёт в базу. Счётчик — raced в db.cache.stats().',
    en: 'An answer is not cached if a signal that could change it arrived while it was being read (including a late signal of an earlier write through the same connection): the next identical read goes to the database again. The counter is raced in db.cache.stats().',
    source: 'lib/src/cache.ts (гонка запроса и сигнала); пример write/06',
  },
  {
    id: 'service-enforces-2fa',
    text: 'letopis не навязывает второй фактор: verifyPassword без totp даёт сессию и при включённом TOTP — требовать код должен сервис (totpEnabled).',
    en: 'letopis does not enforce the second factor: verifyPassword without totp issues a session even when TOTP is enabled; the service must require the code (totpEnabled).',
    source: 'lib/src/auth.ts:verifyPassword; сервис helpdesk',
  },
];

export default nuances;
