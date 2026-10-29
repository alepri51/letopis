/**
 * Схемы процессов для `<Flow name>`: схема Mermaid (flowchart) и соответствие «шаг примера → стадии схемы».
 * Схема синхронна с плеером примера `example` на той же странице: стадии текущего шага подсвечены.
 * Стадии взяты из схем глав и трасс `docs/atlas/F-*.md`; шаги — из снимков примеров (`snapshots/<example>.json`).
 * В подписях нельзя ставить «;» — Mermaid принимает её за конец оператора.
 */
export interface FlowStep {
  /** id узлов схемы, которые делает этот шаг. */
  nodes: string[];
  /** Что происходит на шаге — одной фразой. */
  note: string;
}

export interface FlowDef {
  /** Название процесса. */
  title: string;
  /** Пример, с плеером которого схема синхронна. */
  example: string;
  code: string;
  /** Номер шага примера (с 1) → стадии. */
  steps: Record<number, FlowStep>;
}

export const flows: Record<string, FlowDef> = {
  install: {
    title: 'Установка и подключение',
    example: 'install/01-up-and-connect',
    code: `flowchart LR
  up["up(): роли, функции,<br/>триггеры, политики"] --> stamp["штамп схемы:<br/>ревизия, версия, хэш SQL"]
  stamp --> again["повторный up():<br/>ничего не меняет"]
  stamp --> tenant["первый арендатор<br/>и пользователь"]
  tenant --> conn{"connect():<br/>роль обходит RLS?"}
  conn -- "нет, ключ сервиса" --> svc["сервис →<br/>as(пользователь)"]
  conn -- "нет, токен сессии" --> token["подключение<br/>пользователя"]
  conn -- "да, без allowBypassRls" --> deny["отказ bypass_rls"]
  conn -- "да, allowBypassRls: true" --> admin["администраторское<br/>подключение"]`,
    steps: {
      1: { nodes: ['up', 'stamp'], note: 'up() ставит схему и пишет штамп: ревизию, версию пакета и хэш SQL.' },
      2: { nodes: ['again'], note: 'Повторный up() видит ту же ревизию и ничего не ломает.' },
      3: { nodes: ['tenant'], note: 'Первый арендатор «Ромашка» и его пользователь Анна.' },
      4: { nodes: ['conn', 'svc'], note: 'Сервис входит по ключу и действует от имени Анны через as().' },
      5: { nodes: ['conn', 'token'], note: 'Своё подключение по токену сессии Анны.' },
      6: { nodes: ['conn', 'deny'], note: 'Роль, которая обходит RLS, без явного разрешения не пускают: bypass_rls.' },
      7: { nodes: ['conn', 'admin'], note: 'С allowBypassRls: true — администраторское подключение, оно видит всех арендаторов.' },
    },
  },

  write: {
    title: 'Запись: create, update, upsert',
    example: 'write/01-create-update-upsert',
    code: `flowchart LR
  chain["цепочка<br/>с глаголом"] --> pre{"проверки без базы:<br/>ключ upsert, данные"}
  pre -- "upsert без ключа" --> nokey["отказ no_key"]
  pre --> find{"цели<br/>найдены?"}
  find -- "update: нет" --> empty["пустой ответ,<br/>не ошибка"]
  find -- "да или создать" --> trg["триггер: умолчания,<br/>проверка данных, id по ключу"]
  trg --> same{"данные<br/>изменились?"}
  same -- "нет" --> nover["версии нет"]
  same -- "да" --> ver["entity: новая rev,<br/>log: новая версия"]`,
    steps: {
      1: { nodes: ['chain', 'trg', 'ver'], note: 'Модель магазина и магазин: создание — первая версия в entity и log.' },
      2: { nodes: ['chain', 'trg', 'ver'], note: 'Два товара — две строки, у каждой rev 1.' },
      3: { nodes: ['find', 'trg', 'same', 'ver'], note: 'update сливает патч с данными: остальные поля на месте, версия — новая.' },
      4: { nodes: ['find', 'trg', 'ver'], note: 'update по фильтру правит все найденные строки.' },
      5: { nodes: ['find', 'empty'], note: 'Ничего не нашлось — пустой ответ, а не ошибка.' },
      6: { nodes: ['find', 'trg', 'ver'], note: 'upsert: такого ключа нет — создаётся новый объект.' },
      7: { nodes: ['trg', 'same', 'nover'], note: 'upsert тех же данных: правка пустая, версии нет.' },
      8: { nodes: ['trg', 'same', 'ver'], note: 'upsert заменяет данные целиком — новая версия.' },
      9: { nodes: ['pre', 'nokey'], note: 'У класса нет ключа — upsert невозможен ещё до базы: no_key.' },
    },
  },

  read: {
    title: 'Чтение: шаги и переходы',
    example: 'read/01-steps',
    code: `flowchart LR
  parse["разбор цепочки<br/>без базы"] --> sql["один SQL-запрос:<br/>переходы по ссылкам"]
  sql --> rls["RLS отсекает<br/>чужие строки"]
  rls --> last["строки последнего шага,<br/>без повторов"]
  last --> fin{"окончание"}
  fin --> rows["rows() / first()"]
  fin --> ids["ids() / count()"]`,
    steps: {
      1: { nodes: [], note: 'Подготовка: магазины, категории, товары, заказы.' },
      2: { nodes: ['parse', 'sql', 'rls', 'last', 'rows'], note: 'Назад по ссылке: товары, которые ссылаются на магазин.' },
      3: { nodes: ['parse', 'sql', 'rls', 'last', 'rows'], note: 'Вперёд по ссылке: магазин, на который ссылается товар.' },
      4: { nodes: ['parse', 'sql', 'rls', 'last', 'rows'], note: 'Три перехода одним запросом: заказ → строка заказа → товар.' },
      5: { nodes: ['parse', 'sql', 'rls', 'last', 'rows'], note: 'Шаг по роли конца: родительская категория.' },
      6: { nodes: ['parse', 'sql', 'rls', 'last', 'rows'], note: 'Покупатели заказов магазина — каждый один раз.' },
      7: { nodes: ['last', 'fin', 'ids'], note: 'Окончания ids() и count() — без чтения самих строк.' },
    },
  },

  delete: {
    title: 'Удаление: каскад, снятие ссылки, запрет',
    example: 'delete/01-delete-cascade',
    code: `flowchart TD
  prev["delete() без confirm:<br/>предпросмотр, база не меняется"]
  go["delete({ confirm: true })"] --> who{"кто ссылается<br/>на цель?"}
  who -- "никто" --> gone["цель удалена,<br/>надгробие в журнале"]
  who -- "конец cascade" --> casc["удалить и ссылающуюся строку —<br/>каскад идёт дальше"]
  who -- "конец unset" --> unset["снять ссылку —<br/>новая версия строки"]
  who -- "конец restrict (по умолчанию)" --> restrict["отказ delete_restricted —<br/>не удалено ничего"]
  casc --> gone
  unset --> gone`,
    steps: {
      1: { nodes: [], note: 'Подготовка: магазин, товары, заказы со строками.' },
      2: { nodes: ['prev'], note: 'Предпросмотр заказа: сам заказ ($depth 0) и его строки ($depth 1) — удалятся каскадом.' },
      3: { nodes: ['go', 'who', 'casc', 'gone'], note: 'Заказ и обе строки удалены: надгробия по уровням каскада, внутри уровня — по id.' },
      4: { nodes: ['prev'], note: 'Предпросмотр магазина: товары помечены $action: restrict.' },
      5: { nodes: ['go', 'who', 'restrict'], note: 'Товары мешают: delete_restricted, не удалено ничего.' },
      6: { nodes: ['go', 'who', 'unset', 'gone'], note: 'Категория удалена, у товаров ссылка снята — новая версия каждого.' },
    },
  },

  access: {
    title: 'Проверка прав: RLS и правила ACL',
    example: 'access/01-rules',
    code: `flowchart TD
  q["запрос сотрудника"] --> mine{"строка его<br/>арендатора?"}
  mine -- "нет" --> hidden["не видна —<br/>политики доступа (RLS)"]
  mine -- "да" --> rules{"правила:<br/>группа × объект"}
  rules --> weight["выигрывает правило<br/>с большим весом"]
  weight -- "deny сильнее allow" --> denied["отказ acl_denied"]
  weight -- "allow" --> ok["разрешено"]`,
    steps: {
      1: { nodes: [], note: 'Подготовка: магазин и второй сотрудник — Олег.' },
      2: { nodes: ['rules'], note: 'Правило deny: сотрудникам нельзя удалять товары (вес больше, чем у allow).' },
      3: { nodes: ['q', 'mine', 'rules', 'weight', 'ok'], note: 'acl.check: читать и писать Олегу можно, удалять — нет.' },
      4: { nodes: ['q', 'mine', 'rules', 'weight', 'denied'], note: 'Олег удаляет товар — база отказывает: acl_denied.' },
      5: { nodes: ['q', 'mine', 'hidden'], note: 'Чужой арендатор не видит даже класса: invalid_class.' },
    },
  },

  auth: {
    title: 'Вход и сессии',
    example: 'auth/01-login-factors',
    code: `flowchart LR
  how{"способ входа"} --> pw["пароль:<br/>verifyPassword"]
  how --> key["ключ API:<br/>verifyApiKey"]
  how --> otp["одноразовый код:<br/>verifyOtp"]
  how --> ext["внешняя учётная запись:<br/>auth.lookup → sessionFor"]
  pw --> totp{"включён TOTP?"}
  totp -- "да: код из приложения" --> sess["сессия: токен,<br/>строка SESSION в secret"]
  totp -- "нет" --> sess
  key --> sess
  otp --> sess
  ext --> sess
  sess --> short["короткая сессия<br/>для другого процесса"]
  sess --> revoke["отзыв ключа или сессий,<br/>смена пароля гасит остальные"]`,
    steps: {
      1: { nodes: ['how', 'pw', 'totp', 'sess'], note: 'Пароль: верный даёт сессию, неверный — null, логин без учёта регистра.' },
      2: { nodes: ['revoke'], note: 'Смена пароля гасит остальные сессии.' },
      3: { nodes: ['how', 'key', 'sess'], note: 'Ключ API для интеграции — вход без пароля.' },
      4: { nodes: ['revoke'], note: 'Отозванный ключ больше не входит.' },
      5: { nodes: ['how', 'otp', 'sess'], note: 'Одноразовый код: успешная проверка его сжигает — второй раз тот же код не входит.' },
      6: { nodes: ['pw', 'totp', 'sess'], note: 'Второй фактор TOTP: код из приложения-аутентификатора.' },
      7: { nodes: ['how', 'ext', 'sess'], note: 'Внешняя учётная запись (Telegram) привязана к аккаунту: lookup находит его, сессию выдаёт сервис.' },
      8: { nodes: ['sess', 'short'], note: 'Короткая сессия для другого процесса — его собственное подключение.' },
    },
  },

  watch: {
    title: 'Подписка на изменения',
    example: 'watch/01-subscription',
    code: `flowchart LR
  w["запись: версия в журнал,<br/>NOTIFY после COMMIT"] --> sig["сигнал «есть новое»,<br/>без данных"]
  sig --> rd["чтение журнала после курсора<br/>под своими правами"]
  rd --> ev["события по порядку фиксации,<br/>у каждого курсор"]
  ev --> keep["запомнить курсор"]
  keep -. "после перезапуска" .-> rd`,
    steps: {
      1: { nodes: ['w'], note: 'Магазин и два товара — версии в журнале.' },
      2: { nodes: ['rd', 'ev'], note: 'Подписка с начала журнала: все события по порядку.' },
      3: { nodes: ['w', 'sig'], note: 'Изменение, пока подписки нет: событие ждёт в журнале.' },
      4: { nodes: ['keep', 'rd', 'ev'], note: 'Продолжить с курсора — без потерь и повторов.' },
    },
  },

  tx: {
    title: 'Явная транзакция',
    example: 'money/01-transactions',
    code: `flowchart LR
  begin["db.begin()"] --> work["записи и чтения<br/>одной транзакции"]
  work --> locks["lock() и forUpdate():<br/>блокировки до конца"]
  work --> fine{"всё прошло?"}
  fine -- "да" --> commit["commit():<br/>записано всё"]
  fine -- "ошибка" --> rollback["откат:<br/>не записано ничего"]
  outside["forUpdate() вне транзакции"] --> txreq["отказ tx_required"]`,
    steps: {
      1: { nodes: [], note: 'Подготовка: магазин и товары.' },
      2: { nodes: ['begin', 'work', 'fine', 'commit'], note: 'Заказ и строка — одной транзакцией.' },
      3: { nodes: ['begin', 'work', 'fine', 'rollback'], note: 'Ошибка внутри — не записано ничего, даже то, что шло до неё.' },
      4: { nodes: ['begin', 'locks'], note: 'lock() и forUpdate() держат блокировки до конца транзакции.' },
      5: { nodes: ['outside', 'txreq'], note: 'forUpdate() вне транзакции — отказ tx_required.' },
    },
  },

  opid: {
    title: 'Деньги без двойного списания',
    example: 'money/02-wallet-opid',
    code: `flowchart LR
  req["операция с opId"] --> seen{"Movement(opId)<br/>уже есть?"}
  seen -- "нет" --> move["Movement и inc баланса<br/>одной транзакцией"]
  seen -- "да" --> dup["«уже было» —<br/>второго списания нет"]
  move --> rule{"правило модели:<br/>баланс ≥ 0?"}
  rule -- "да" --> done["проведено"]
  rule -- "нет" --> bad["отказ invalid_data"]`,
    steps: {
      1: { nodes: [], note: 'Кошелёк с нулевым балансом.' },
      2: { nodes: ['req', 'seen', 'move', 'rule', 'done'], note: 'Пополнение на 1000: операция и приращение баланса.' },
      3: { nodes: ['req', 'seen', 'dup'], note: 'Ответ потерялся, клиент повторил тот же opId — «уже было».' },
      4: { nodes: ['req', 'seen', 'move', 'rule', 'done'], note: 'Списание 300.' },
      5: { nodes: ['move', 'rule', 'bad'], note: 'Списать больше, чем есть, нельзя: invalid_data.' },
      6: { nodes: ['done'], note: 'Итог: баланс 700, операций две.' },
    },
  },

  history: {
    title: 'История: версии, срез, сравнение, авторство',
    example: 'history/01-versions-asof-diff-blame',
    code: `flowchart LR
  edits["правки с причиной<br/>(reason)"] --> log[("журнал log:<br/>все версии")]
  log --> versions["versions():<br/>все версии по порядку"]
  log --> asof["asOf(момент):<br/>последняя версия не позже"]
  log --> diff["diff():<br/>что изменилось"]
  log --> blame["blame():<br/>кто последним менял поле"]`,
    steps: {
      1: { nodes: ['edits', 'log'], note: 'Товар и три правки — у каждой своя причина.' },
      2: { nodes: ['log', 'versions'], note: 'Все версии по порядку — с автором, временем и причиной.' },
      3: { nodes: ['log', 'asof'], note: 'Товар на момент создания.' },
      4: { nodes: ['log', 'diff'], note: 'Что изменилось между первой и последней версией.' },
      5: { nodes: ['log', 'blame'], note: 'Кто последним менял каждое поле.' },
    },
  },

  retention: {
    title: 'Хранение истории по ярусам',
    example: 'history/03-retention-maintain-trim',
    code: `flowchart LR
  policy["политика history:<br/>all, daily, weekly, monthly"] --> grow["журнал растёт:<br/>версия каждый день"]
  grow --> thin["maintain(): прореживание<br/>старше яруса all"]
  thin --> kept["остаются первая, текущая,<br/>особые и по одной на период"]
  grow --> trim["trimHistory(до даты):<br/>запись trim под номером 1"]
  thin --> expired["курсор старше яруса all:<br/>cursor_expired"]`,
    steps: {
      1: { nodes: ['policy'], note: 'Класс с политикой хранения по ярусам.' },
      2: { nodes: ['grow'], note: 'Архив показаний: 90 дней по версии в день и три правки в последний день.' },
      3: { nodes: ['thin', 'kept'], note: 'maintain() прореживает версии старше яруса all.' },
      4: { nodes: ['kept'], note: 'Прореживание — не разрыв: verify() цепочку принимает.' },
      5: { nodes: ['trim'], note: 'trimHistory стирает версии до даты, на месте первой — запись trim.' },
      6: { nodes: ['expired'], note: 'Подписка с курсором старше яруса all: cursor_expired.' },
    },
  },

  aggregate: {
    title: 'Агрегат: итог считает база',
    example: 'derived/01-aggregate',
    code: `flowchart LR
  src["строка источника:<br/>операция кошелька"] --> trg["триггер после оператора:<br/>приращение агрегата"]
  trg --> rule{"правило модели<br/>над итогом"}
  rule -- "выполнено" --> ver["новая версия кошелька<br/>в журнале"]
  rule -- "нарушено" --> bad["отказ invalid_data"]
  direct["запись в агрегатное поле<br/>напрямую"] --> agg["отказ aggregate_field"]
  rebuild["rebuildAggregates():<br/>пересчёт из источника"] --> ver`,
    steps: {
      1: { nodes: [], note: 'Кошелёк и класс операций — источник агрегата balance.' },
      2: { nodes: ['src', 'trg', 'rule', 'ver'], note: 'Пополнение 1000: баланс пересчитала сама база.' },
      3: { nodes: ['src', 'trg', 'rule', 'ver'], note: 'Списание −300 — баланс 700.' },
      4: { nodes: ['src', 'trg', 'rule', 'bad'], note: 'Уйти в минус нельзя: правило над итогом — invalid_data.' },
      5: { nodes: ['direct', 'agg'], note: 'Писать в агрегатное поле нельзя: aggregate_field.' },
      6: { nodes: ['rebuild', 'ver'], note: 'Ремонт: итог пересчитан из источника.' },
    },
  },

  projector: {
    title: 'Проектор: итоги из журнала',
    example: 'derived/02-projector',
    code: `flowchart LR
  src["строки источника"] --> log[("журнал log")]
  log --> run["run(): чтение журнала<br/>после курсора"]
  run --> handle["handle:<br/>out.inc / out.upsert"]
  handle --> derived["производный класс"]
  run --> cp[("чекпоинт:<br/>курсор в secret")]
  cp --> status["status(): состояние,<br/>версия, отставание"]`,
    steps: {
      1: { nodes: ['src', 'log'], note: 'Магазин с заказами и производный класс итогов.' },
      2: { nodes: ['run', 'handle', 'derived', 'cp'], note: 'Проектор догоняет журнал и запоминает курсор.' },
      3: { nodes: ['src', 'log', 'run', 'handle', 'derived'], note: 'Новая продажа попадает в итог на следующем проходе — писатель проектор не ждёт.' },
      4: { nodes: ['cp', 'status'], note: 'Состояние проектора: работает (running), версия 1, отставание 0.' },
    },
  },

  initial: {
    title: 'Первая заливка',
    example: 'load/02-initial',
    code: `flowchart LR
  empty["пустая схема:<br/>только классы, аккаунты, права"] --> strip["TRUNCATE, снять триггеры,<br/>ограничения и индексы"]
  strip --> copy["COPY … FREEZE<br/>все строки"]
  copy --> back["вернуть индексы и триггеры,<br/>агрегаты, проверки разом"]
  back --> analyze["ANALYZE, сигнал"]
  copy -. "любая ошибка" .-> undo["откат всего"]
  full["в схеме уже есть данные"] --> notempty["отказ not_empty"]`,
    steps: {
      1: { nodes: ['empty'], note: 'Свежая установка и модель — данных ещё нет.' },
      2: { nodes: ['strip', 'copy', 'back', 'analyze'], note: 'Магазин и 300 товаров одной транзакцией через COPY.' },
      3: { nodes: ['full', 'notempty'], note: 'Вторая первая заливка невозможна: not_empty.' },
    },
  },

  mcp: {
    title: 'ИИ-агент через MCP',
    example: 'mcp/01-agent-tools',
    code: `flowchart LR
  agent["ИИ-агент"] --> srv["сервер MCP<br/>от имени пользователя"]
  srv --> model["letopis_model:<br/>классы и поля"]
  srv --> query["letopis_query:<br/>чтение JSON-цепочкой"]
  srv --> hist["letopis_history:<br/>кто и что менял"]
  srv --> write{"letopis_write:<br/>версия указана?"}
  write -- "нет" --> refuse["отказ invalid_query"]
  write -- "да, rev совпал" --> ok["записано —<br/>под правами пользователя"]`,
    steps: {
      1: { nodes: ['agent', 'srv'], note: 'Сервер MCP работает от имени пользователя и под его правами.' },
      2: { nodes: ['srv', 'model'], note: 'Агент узнаёт классы и их поля.' },
      3: { nodes: ['srv', 'query'], note: 'Чтение цепочкой, описанной в JSON.' },
      4: { nodes: ['srv', 'write', 'refuse'], note: 'Запись без версии — отказ: агент должен знать, что правит.' },
      5: { nodes: ['srv', 'write', 'ok'], note: 'Запись с версией rev — прошла.' },
      6: { nodes: ['srv', 'hist'], note: 'История: кто и что менял, с причинами.' },
    },
  },

  verify: {
    title: 'Проверка целостности журнала',
    example: 'ops/01-verify-corrupt',
    code: `flowchart LR
  v1["v1: hash₁ =<br/>sha256(данные₁)"] --> v2["v2: hash₂ =<br/>sha256(hash₁ + данные₂)"]
  v2 --> v3["v3: hash₃ =<br/>sha256(hash₂ + данные₃)"]
  sql["UPDATE log … rev = 2<br/>в обход библиотеки"] -. "hash₂ пересчитан —<br/>не сходится с prev_hash v3" .-> v3
  check{"verify()"} -- "цепочка сходится" --> ok["нарушений нет"]
  check -- "хэш или звено не то" --> bad["список нарушений"]`,
    steps: {
      1: { nodes: ['v1', 'v2', 'v3', 'check', 'ok'], note: 'Данные записаны, verify() нарушений не нашёл.' },
      2: { nodes: ['sql', 'v2', 'v3', 'check', 'bad'], note: 'Цену во второй версии поправили прямо в SQL — её хэш не сходится с prev_hash третьей.' },
      3: { nodes: ['check', 'ok'], note: 'Вернули байт в байт — цепочка снова сходится.' },
      4: { nodes: ['check', 'bad'], note: 'Версию удалили из журнала — звено пропало.' },
    },
  },
};
