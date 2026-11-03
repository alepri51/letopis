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
  chain["цепочка<br/>с глаголом"] --> pre{"проверки без базы:<br/>ключ upsert, условие update, данные"}
  pre -- "upsert без ключа" --> nokey["отказ no_key"]
  pre -- "update без фильтра, id и limit" --> nofilter["отказ invalid_query —<br/>все строки только с all: true"]
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
  go["delete({ confirm: true })"] --> who{"кто ссылается<br/>на цель?"}
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
  empty["пустая схема:<br/>только классы, аккаунты, права"] --> strip["TRUNCATE, снять триггеры,<br/>ограничения и индексы"]
  strip --> copy["COPY … FREEZE<br/>все строки"]
  copy --> back["вернуть индексы и триггеры,<br/>проверки разом"]
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
  srv --> hist["letopis_history:<br/>версии объекта"]
  srv --> write{"letopis_write:<br/>версия указана?"}
  write -- "нет" --> refuse["отказ invalid_query"]
  write -- "да, rev совпал" --> ok["записано —<br/>под правами пользователя"]`,
    steps: {
      1: { nodes: ['agent', 'srv'], note: 'Сервер MCP работает от имени пользователя и под его правами.' },
      2: { nodes: ['srv', 'model'], note: 'Агент узнаёт классы и их поля.' },
      3: { nodes: ['srv', 'query'], note: 'Чтение цепочкой, описанной в JSON.' },
      4: { nodes: ['srv', 'write', 'refuse'], note: 'Запись без версии — отказ: агент должен знать, что правит.' },
      5: { nodes: ['srv', 'write', 'ok'], note: 'Запись с версией rev — прошла.' },
      6: { nodes: ['srv', 'hist'], note: 'Версии объекта: кто, когда и почему менял.' },
    },
  },
};
