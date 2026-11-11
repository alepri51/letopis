/**
 * Схемы процессов для `<Flow name>`: схема Mermaid (flowchart) и соответствие «шаг примера → стадии схемы».
 * Схема синхронна с плеером примера `example` на той же странице: стадии текущего шага подсвечены.
 * Стадии взяты из схем глав и трасс `docs/atlas/F-*.md`; шаги — из снимков примеров (`examples/_snapshots/<example>.json`).
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
    title: 'Дом: установка и подключение',
    example: 'install/01-setup-and-connect',
    code: `flowchart LR
  setup["setup(мастер-ключ, имя):<br/>роли, функции, политики"] --> stamp["штамп схемы:<br/>ревизия, версия, хэш SQL"]
  stamp --> pass["консьерж и пропуск:<br/>роль letopis_c_имя и ключ"]
  pass --> again["повторный setup():<br/>тот же пропуск"]
  pass --> conn["connect(pass):<br/>консьерж, без цепочек"]
  conn --> tenant["createTenant:<br/>квартира и её правила"]
  tenant --> invite["invite → письмо →<br/>accept(token): жилец,<br/>прописка"]
  invite --> room["корень квартиры:<br/>цепочки под правами жильца"]
  conn --> open["open(ключ):<br/>вход жильца"]
  open --> room
  conn --> inq["in(квартира):<br/>консьерж внутри, полный доступ"]`,
    steps: {
      1: { nodes: ['setup', 'stamp', 'pass'], note: 'setup() строит дом, пишет штамп и отдаёт пропуск консьержа.' },
      2: { nodes: ['again'], note: 'Повторный setup() ничего не дублирует и отдаёт тот же пропуск.' },
      3: { nodes: ['conn'], note: 'connect(pass) — консьерж: дверь дома, своих данных и цепочек у него нет.' },
      4: { nodes: ['conn', 'tenant'], note: 'Квартира «Ромашка» и её правила; занятое имя — отказ exists.' },
      5: { nodes: ['tenant', 'invite', 'room'], note: 'Приглашение Анне: письмо со ссылкой получает почтальон, accept(token) даёт аккаунт, прописку owner и корень квартиры.' },
      6: { nodes: ['conn', 'open', 'room'], note: 'Вход по паролю — тот же аккаунт; неверный ключ — auth_failed.' },
      7: { nodes: ['conn', 'inq'], note: 'Консьерж в квартире — для фоновых задач; список квартир дома.' },
    },
  },

  write: {
    title: 'Запись: create, update, upsert',
    example: 'write/01-create-update-upsert',
    code: `flowchart LR
  chain["цепочка<br/>с глаголом"] --> pre{"проверки без базы:<br/>ключ upsert, условие update, данные"}
  pre -- "upsert без ключа" --> nokey["отказ no_key"]
  pre -- "update без фильтра, id и limit" --> nofilter["отказ invalid_query —<br/>все строки только с all: true"]
  pre -- "модификатор после глагола" --> after["отказ invalid_query —<br/>ничего не записано"]
  pre --> find{"цели<br/>найдены?"}
  find -- "update: нет" --> empty["пустой ответ,<br/>не ошибка"]
  find -- "да или создать" --> trg["триггер: умолчания,<br/>проверка данных, id по ключу"]
  trg --> same{"данные<br/>изменились?"}
  same -- "нет" --> nover["версии нет"]
  same -- "да" --> ver["entity: новая rev,<br/>log: новая версия"]`,
    steps: {
      1: { nodes: ['chain', 'trg', 'ver'], note: 'Магазин: создание — первая версия в entity и log.' },
      2: { nodes: ['chain', 'trg', 'ver'], note: 'Два товара — две строки, у каждой rev 1.' },
      3: { nodes: ['find', 'trg', 'same', 'ver'], note: 'update сливает патч с данными: остальные поля на месте, версия — новая.' },
      4: { nodes: ['find', 'trg', 'ver'], note: 'update по фильтру правит все найденные строки.' },
      5: { nodes: ['find', 'empty'], note: 'Ничего не нашлось — пустой ответ, а не ошибка.' },
      6: { nodes: ['pre', 'find', 'trg', 'ver'], note: 'sort и limit до глагола выбирают цели: правится один самый дорогой товар.' },
      7: { nodes: ['find', 'trg', 'ver'], note: 'Ответ правки — в порядке sort() до глагола.' },
      8: { nodes: ['pre', 'after'], note: 'limit после глагола ничего не сужает — отказ до записи.' },
      9: { nodes: ['find', 'trg', 'ver'], note: 'upsert: такого ключа нет — создаётся новый объект.' },
      10: { nodes: ['trg', 'same', 'nover'], note: 'upsert тех же данных: правка пустая, версии нет.' },
      11: { nodes: ['trg', 'same', 'ver'], note: 'upsert заменяет данные целиком — новая версия.' },
      12: { nodes: ['pre', 'nokey'], note: 'У класса нет ключа — upsert невозможен ещё до базы: no_key.' },
    },
  },

  read: {
    title: 'Чтение: шаги и переходы',
    example: 'read/01-steps',
    code: `flowchart LR
  parse["разбор цепочки<br/>без базы"] --> sql["один SQL-запрос:<br/>переходы по концам"]
  sql --> rls["RLS отсекает<br/>чужие строки"]
  rls --> last["строки последнего шага,<br/>без повторов"]
  last --> fin{"окончание"}
  fin --> rows["rows() / first()"]
  fin --> ids["ids() / count()"]`,
    steps: {
      1: { nodes: [], note: 'Подготовка: магазины, категории, товары, заказы.' },
      2: { nodes: ['parse', 'sql', 'rls', 'last', 'rows'], note: 'Назад по концу: товары, которые ссылаются на магазин.' },
      3: { nodes: ['parse', 'sql', 'rls', 'last', 'rows'], note: 'Вперёд по концу: магазин, на который ссылается товар.' },
      4: { nodes: ['parse', 'sql', 'rls', 'last', 'rows'], note: 'Три перехода одним запросом: заказ → строка заказа → товар.' },
      5: { nodes: ['parse', 'sql', 'rls', 'last', 'rows'], note: 'Шаг по роли конца: родительская категория.' },
      6: { nodes: ['parse', 'sql', 'rls', 'last', 'rows'], note: 'Покупатели заказов магазина — каждый один раз.' },
      7: { nodes: ['last', 'fin', 'ids'], note: 'Окончания ids() и count() — без чтения самих строк.' },
    },
  },

  delete: {
    title: 'Удаление: каскад, очистка конца, запрет',
    example: 'delete/01-delete-cascade',
    code: `flowchart TD
  prev["delete() без confirm:<br/>предпросмотр, база не меняется"]
  go["delete({ confirm: true,<br/>expect: предпросмотр })"] --> who{"кто ссылается<br/>на цель?"}
  go -- "без фильтра, id и limit" --> nofilter["отказ invalid_query —<br/>все строки только с all: true"]
  who -- "никто" --> gone["цель удалена,<br/>надгробие в журнале"]
  who -- "конец cascade" --> casc["удалить и ссылающуюся строку —<br/>каскад идёт дальше"]
  who -- "конец unset" --> unset["очистить конец —<br/>новая версия строки"]
  who -- "конец restrict (по умолчанию)" --> restrict["отказ delete_restricted —<br/>не удалено ничего"]
  casc --> gone
  unset --> gone`,
    steps: {
      1: { nodes: [], note: 'Подготовка: магазин, товары, заказы со строками.' },
      2: { nodes: ['prev'], note: 'Предпросмотр заказа: сам заказ ($depth 0) и его строки ($depth 1) — удалятся каскадом.' },
      3: { nodes: ['go', 'who', 'casc', 'gone'], note: 'Заказ и обе строки удалены: надгробия по уровням каскада, внутри уровня — по id.' },
      4: { nodes: ['prev'], note: 'Предпросмотр магазина: товары помечены $action: restrict.' },
      5: { nodes: ['go', 'who', 'restrict'], note: 'Товары мешают: delete_restricted, не удалено ничего.' },
      6: { nodes: ['go', 'who', 'unset', 'gone'], note: 'Категория удалена, у товаров конец очищен — новая версия каждого.' },
    },
  },

  access: {
    title: 'Права: матрица со счётом',
    example: 'access/01-residents',
    code: `flowchart TD
  q["запрос жильца"] --> mine{"строка его<br/>квартиры?"}
  mine -- "нет" --> hidden["не видна —<br/>политики доступа (RLS)"]
  mine -- "да" --> cand["кандидаты: правила,<br/>чья группа и объект совпали"]
  cand --> score["счёт = кто + что + поля<br/>+ запрет + вес"]
  score --> pick{"наибольший счёт среди тех,<br/>чьё условие строка проходит"}
  pick -- "только «можно»" --> ok["видна, разрешено"]
  pick -- "только «нельзя»" --> denied["скрыта, acl_denied"]
  pick -- "«можно» и «нельзя» вровень" --> tie["ничья: строка скрыта,<br/>ошибки нет"]
  pick -- "никто не подошёл" --> def["правило по умолчанию:<br/>deny (setup defaultRule)"]`,
    steps: {
      1: { nodes: ['q', 'mine', 'cand', 'ok'], note: 'Анна — owner: правило роли owner разрешает ей всё в своей квартире.' },
      2: { nodes: ['cand', 'score'], note: 'Роли staff: читать заказы (счёт 52), VIP — нельзя (счёт 54).' },
      3: { nodes: [], note: 'Приглашение Олегу с ролью staff: письмо со ссылкой — почтальону.' },
      4: { nodes: [], note: 'Олег принял приглашение по ссылке: аккаунт, прописка с ролью staff, сессия.' },
      5: { nodes: ['q', 'mine', 'cand', 'score', 'pick', 'ok', 'denied'], note: 'Для каждой строки свой победитель: обычные заказы видны, VIP скрыт.' },
      6: { nodes: ['cand', 'score', 'pick', 'def'], note: 'checkData — кандидаты по счёту; действие без правил решает правило по умолчанию.' },
      7: { nodes: ['score', 'pick', 'ok'], note: 'Роль cashier с весом 60: у VIP-строки разрешение сильнее запрета.' },
      8: { nodes: ['cand', 'score', 'pick', 'denied'], note: 'Роль выдаёт тот, кому это разрешает правило матрицы assign; без правила — role_denied.' },
      9: { nodes: ['q', 'mine', 'hidden'], note: 'Чужая квартира не видит строк «Ромашки» и её своих классов; прописка — только приглашением.' },
    },
  },

  auth: {
    title: 'Вход и ключи',
    example: 'auth/01-keys',
    code: `flowchart LR
  how{"ключ"} --> pw["пароль<br/>(+TOTP)"]
  how --> api["ключ API"]
  how --> ks["ключ и секрет"]
  how --> ext["внешний вход"]
  how --> code["код из письма:<br/>requestCode → почтальон"]
  pw --> open{"db.open(ключ):<br/>консьерж сверяет"}
  api --> open
  ks --> open
  ext --> open
  code --> list["tenantsOf:<br/>список квартир"]
  list --> open
  open -- "не подошёл" --> fail["auth_failed"]
  open -- "TOTP включён,<br/>кода нет" --> totp["auth_failed:<br/>totp_required"]
  open --> sess["сессия в квартире:<br/>токен, строка SESSION"]
  sess --> keys["me.keys: свои ключи<br/>только этой квартиры"]
  keys --> revoke["revoke: ключ<br/>и его сессии гаснут"]`,
    steps: {
      1: { nodes: ['how', 'pw', 'open', 'sess', 'fail'], note: 'Пароль Анны: верный открывает «Ромашку», неверный — auth_failed.' },
      2: { nodes: ['how', 'api', 'open', 'sess', 'keys'], note: 'Ключ API для программы — вход без пароля.' },
      3: { nodes: ['how', 'ks', 'open', 'sess', 'keys'], note: 'Ключ и секрет — для интеграции.' },
      4: { nodes: ['how', 'ext', 'open', 'sess', 'keys'], note: 'Внешний вход (Telegram): токен провайдера проверило приложение.' },
      5: { nodes: ['how', 'code', 'list', 'open', 'sess'], note: 'Вход кодом: requestCode отдаёт код почтальону, tenantsOf показывает квартиры человека, open входит в выбранную.' },
      6: { nodes: ['pw', 'open', 'totp', 'sess'], note: 'Второй фактор TOTP: без кода из приложения — totp_required.' },
      7: { nodes: ['keys', 'revoke'], note: 'Список своих ключей и отзыв: отозванный ключ больше не входит.' },
      8: { nodes: ['how', 'pw', 'open', 'sess'], note: 'Вторая квартира — свой пароль: пароль открывает ровно одну квартиру.' },
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
      5: { nodes: ['sig', 'rd', 'ev'], note: 'Цикл for await: события по мере сигналов, отставание видно по курсору.' },
      6: { nodes: ['rd', 'ev'], note: 'Другая квартира получает только свои события — журнал читается под её правами.' },
    },
  },

  tx: {
    title: 'Явная транзакция',
    example: 'money/01-transactions',
    code: `flowchart LR
  begin["me.begin()"] --> work["записи и чтения<br/>одной транзакции"]
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
  move --> rule{"ограничение модели:<br/>баланс ≥ 0?"}
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
    title: 'История: версии и срез на момент',
    example: 'history/01-versions-asof',
    code: `flowchart LR
  edits["правки с причиной<br/>(reason)"] --> log[("журнал log:<br/>все версии, без прореживания")]
  log --> versions["versions():<br/>все версии по порядку"]
  log --> last["sort() и limit():<br/>последние версии"]
  log --> asof["asOf(момент):<br/>последняя версия не позже"]
  asof --> once["объект на нескольких путях —<br/>в rows() один раз"]`,
    steps: {
      1: { nodes: ['edits', 'log'], note: 'Товар и три правки — у каждой своя причина.' },
      2: { nodes: ['log', 'versions'], note: 'Все версии по порядку — с автором, временем и причиной.' },
      3: { nodes: ['log', 'asof'], note: 'Товар на момент создания.' },
      4: { nodes: ['log', 'last'], note: 'Две последние версии, новые первыми: ограничение — в самом запросе.' },
      5: { nodes: ['asof', 'once'], note: 'Товар в двух категориях в срезе — одна строка, путей два.' },
    },
  },

  initial: {
    title: 'Первая заливка',
    example: 'load/02-initial',
    code: `flowchart LR
  empty["пустой дом:<br/>только классы, аккаунты, права"] --> strip["TRUNCATE, снять триггеры,<br/>ограничения и индексы"]
  strip --> copy["COPY … FREEZE<br/>все строки"]
  copy --> back["вернуть индексы и триггеры,<br/>проверки разом"]
  back --> analyze["ANALYZE, сигнал"]
  copy -. "любая ошибка" .-> undo["откат всего"]
  full["в доме уже есть данные"] --> notempty["отказ not_empty"]`,
    steps: {
      1: { nodes: ['empty'], note: 'Дом с моделью — данных ещё нет.' },
      2: { nodes: ['strip', 'copy', 'back', 'analyze'], note: 'Магазин и 300 товаров одной транзакцией через COPY.' },
      3: { nodes: ['full', 'notempty'], note: 'Вторая первая заливка невозможна: not_empty.' },
    },
  },

  mcp: {
    title: 'ИИ-агент через MCP',
    example: 'mcp/01-agent-tools',
    code: `flowchart LR
  agent["ИИ-агент"] --> srv["сервер MCP<br/>от имени жильца"]
  srv --> model["letopis_model:<br/>классы и поля"]
  srv --> query["letopis_query:<br/>чтение JSON-цепочкой"]
  srv --> hist["letopis_history:<br/>версии объекта"]
  srv --> write{"letopis_write:<br/>версия указана?"}
  write -- "нет" --> refuse["отказ invalid_query"]
  write -- "да, rev совпал" --> ok["записано —<br/>под правами жильца"]`,
    steps: {
      1: { nodes: ['agent', 'srv'], note: 'Сервер MCP работает от имени жильца и под его правами.' },
      2: { nodes: ['srv', 'model'], note: 'Агент узнаёт классы и их поля.' },
      3: { nodes: ['srv', 'query'], note: 'Чтение цепочкой, описанной в JSON.' },
      4: { nodes: ['srv', 'write', 'refuse'], note: 'Запись без версии — отказ: агент должен знать, что правит.' },
      5: { nodes: ['srv', 'write', 'ok'], note: 'Запись с версией rev — прошла.' },
      6: { nodes: ['srv', 'hist'], note: 'Версии объекта: кто, когда и почему менял.' },
    },
  },
};
