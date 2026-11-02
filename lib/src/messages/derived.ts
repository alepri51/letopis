/**
 * Раздел derived: project.ts — проекторы из журнала.
 */
import type { Section } from './types.js';

/** Подсказка к неверному имени или опции db.projector(): что допустимо, называет сам текст ошибки. */
const OPTION_HINT = 'исправить имя или опцию db.projector(имя, опции) по тексту ошибки; имя и все опции — в README, «Справочник API → Проектор»';

export const derived = {
  // project.ts, Out.check: handle пишет в класс не из семейств into арендатора
  'derived.not_into': {
    code: 'derived_class',
    ru: 'проектор {name}: класс {cls} не входит в into',
    hint: 'писать из handle только в классы into и их потомков; нужен другой класс — добавить его в into и пометить опцией derivedBy с именем проектора',
  },
  // project.ts, Out.check: { tenant } вызова out — не арендатор группы изменений
  'derived.foreign_tenant': {
    code: 'tenant_denied',
    ru: 'проектор {name}: арендатор {tenant} — не арендатор изменений',
    hint: 'передавать в out { tenant } арендатора изменений (c.tenant): handle получает изменения одного арендатора',
  },
  // project.ts, Out.rowOf: строка out — не объект и не id; отказ out — арендатор выбывает (status().failed)
  'derived.row_required': {
    code: 'invalid_data',
    ru: 'проектор {name}: нужен ключ строки или id (арендатор {tenant})',
    hint: 'передавать в out строку объектом (поля ключа или $id) либо id строкой',
  },
  // project.ts, Out.inc: приращение — не конечное число; отказ out — арендатор выбывает (status().failed)
  'derived.delta_not_number': {
    code: 'invalid_data',
    ru: 'проектор {name}: приращение поля {field} — не число (арендатор {tenant})',
    hint: 'передавать в out.inc приращения конечными числами: { поле: число }',
  },
  // project.ts, Out.target: delete или get называют строку класса с ключом одним id; key — поля ключа через запятую,
  // example — «поле: …» по каждому из них
  'derived.key_not_id': {
    code: 'invalid_data',
    ru: 'проектор {name}: у класса {cls} есть ключ ({key}) — строку называют полями ключа, например { {example} }, а не id',
    hint: 'у класса с ключом delete и get называют строку полями ключа, id — только у класса без ключа',
  },
  // project.ts, конструктор Projector: имя проектора (оно же derivedBy производных классов)
  'derived.bad_name': {
    code: 'invalid_data',
    ru: 'проектор: имя {name} — строчные латинские буквы, цифры и _.:- (до 64), оно же derivedBy классов',
    hint: OPTION_HINT,
  },
  // project.ts, конструктор Projector: опции from и into
  'derived.bad_from_into': {
    code: 'invalid_data',
    ru: 'проектор {name}: from и into — непустые списки классов',
    hint: OPTION_HINT,
  },
  // project.ts, конструктор Projector: опция version
  'derived.bad_version': {
    code: 'invalid_data',
    ru: 'проектор {name}: version — целое число от 1',
    hint: OPTION_HINT,
  },
  // project.ts, конструктор Projector: опция handle — не функция
  'derived.handle_required': {
    code: 'invalid_data',
    ru: 'проектор {name}: нужна функция handle(changes, out)',
    hint: OPTION_HINT,
  },
  // project.ts, конструктор Projector: опция onExpired
  'derived.bad_on_expired': {
    code: 'invalid_data',
    ru: "проектор {name}: onExpired — 'rebuild' или 'error'",
    hint: OPTION_HINT,
  },
  // project.ts, конструктор Projector: опция tenants
  'derived.bad_tenants': {
    code: 'invalid_data',
    ru: 'проектор {name}: tenants — непустой список id арендаторов',
    hint: OPTION_HINT,
  },
  // project.ts, конструктор Projector: опция lockTimeout
  'derived.bad_lock_timeout': {
    code: 'invalid_data',
    ru: 'проектор {name}: lockTimeout — целое число мс, 0 и больше',
    hint: OPTION_HINT,
  },
  // project.ts, конструктор Projector: опция lockRetries
  'derived.bad_lock_retries': {
    code: 'invalid_data',
    ru: 'проектор {name}: lockRetries — целое число, 0 и больше',
    hint: OPTION_HINT,
  },
  // project.ts, конструктор Projector: опция batch
  'derived.bad_batch': {
    code: 'invalid_data',
    ru: 'проектор {name}: batch — от 1 до 10 000',
    hint: OPTION_HINT,
  },
  // project.ts, run(): опция wait — сколько once ждёт транзакции, открытые в момент вызова
  'derived.bad_wait': {
    code: 'invalid_data',
    ru: 'проектор {name}: run({ wait }) — целое число мс, 0 и больше',
    hint: OPTION_HINT,
  },
  // project.ts, run(): run() того же объекта проектора ещё идёт (проверка до и после env.ready)
  'derived.already_running': {
    code: 'invalid_query',
    ru: 'проектор {name} уже запущен в этом процессе',
    hint: 'не запускать run() того же проектора дважды: дождаться конца прежнего run() или остановить его stop()',
  },
  // project.ts, rebuild({ tenant }): tenant — не uuid
  'derived.bad_rebuild_tenant': {
    code: 'invalid_data',
    ru: 'проектор {name}: rebuild({ tenant }) — id арендатора',
    hint: 'передать в rebuild({ tenant }) id арендатора (uuid); без tenant rebuild() перестраивает всю проекцию',
  },
  // project.ts, advance: условный сдвиг чекпоинта (projector_advance) не прошёл
  'derived.checkpoint_changed': {
    code: 'invalid_query',
    ru: 'проектор {name}: чекпоинт изменился во время пачки',
    hint: 'повторить вызов: пачка откатилась целиком, и следующий проход начнёт с нынешнего чекпоинта',
  },
  // project.ts, blindError: источники арендатора с history: false (classes — через запятую); этот же текст — отметка
  // выбывшего в status().failed (blindFailure)
  'derived.sources_without_journal': {
    code: 'invalid_class',
    ru: 'проектор {name}: у арендатора {tenant} источники {classes} не ведут журнал (history: false) — проектор не увидит их изменений',
    hint: 'включить журнал этих классов (history — не false) и перестроить арендатора: rebuild({ tenant })',
  },
  // project.ts, versionError: в чекпоинте другая version (run(), rebuild({ tenant })); built — версия проекции
  'derived.version_mismatch': {
    code: 'rebuild_required',
    ru: 'проектор {name}: проекция построена версией {built}, а проектор — версии {version}: нужна перестройка rebuild()',
  },
  // project.ts, resolve: ревизия движка схемы не равна ревизии пакета (DDL_REVISION)
  'derived.schema_revision': {
    code: 'invalid_data',
    ru: 'проектор {name}: движок схемы ревизии {rev}, библиотека — {revision}: обновите схему up({ upgrade: true })',
    hint: 'схема старше пакета — обновить её up({ upgrade: true }), новее — обновить пакет letopis',
  },
  // project.ts, resolve: ни у одного арендатора классы into (classes) не помечены derivedBy проектора; с опцией
  // tenants — следующая запись
  'derived.no_participants': {
    code: 'derived_class',
    ru: "проектор {name}: ни у одного арендатора классы {classes} не помечены derivedBy: '{name}'",
    hint: 'пометить каждый класс into опцией derivedBy с именем проектора у арендаторов, для которых он работает',
  },
  // project.ts, resolve: то же с опцией tenants
  'derived.no_participants_listed': {
    code: 'derived_class',
    ru: "проектор {name}: ни у одного арендатора из списка tenants классы {classes} не помечены derivedBy: '{name}'",
    hint: 'пометить каждый класс into опцией derivedBy с именем проектора у арендаторов из списка tenants или поправить список',
  },
  // project.ts, resolve: классов from (classes) нет ни у одного участника
  'derived.no_sources': {
    code: 'invalid_class',
    ru: 'проектор {name}: классов {classes} нет у арендаторов проектора',
  },
  // project.ts, step: курсор старше яруса all у всех участников
  'derived.cursor_expired': {
    code: 'cursor_expired',
    ru: 'проектор {name}: курсор старше яруса all политики хранения источников — изменения могли проредиться, нужна перестройка rebuild()',
  },
  // project.ts, step: текст отметки выбывшего в status().failed (lmsg) — курсор старше яруса all арендатора
  'derived.tenant_cursor_expired': {
    code: 'cursor_expired',
    ru: 'проектор {name}: курсор старше яруса all политики хранения источников арендатора {tenant} — его изменения могли проредиться, нужна перестройка rebuild({ tenant })',
  },
  // project.ts, apply: текст отметки выбывшего по lockRetries в status().failed (lmsg). У отметки код 55P03 — SQLSTATE, а
  // не код letopis, поэтому у записи — ближайший код, projector_busy. Форма числа — по правилу русского языка: 1, 21,
  // 31 … — эта запись («прохода»), иначе — следующая («проходов»)
  'derived.tenant_locked_one': {
    code: 'projector_busy',
    ru: 'проектор {name}: строку арендатора {tenant} держит чужая транзакция — в течение {passes} прохода подряд дольше lockTimeout',
  },
  // project.ts, apply: то же для остальных чисел
  'derived.tenant_locked_many': {
    code: 'projector_busy',
    ru: 'проектор {name}: строку арендатора {tenant} держит чужая транзакция — в течение {passes} проходов подряд дольше lockTimeout',
  },
  // project.ts, busy: строку-замок проектора держит другой процесс (rebuild(), rebuild({ tenant }))
  'derived.busy': {
    code: 'projector_busy',
    ru: 'проектор {name} работает в другом процессе',
  },
  // project.ts, rebuildTenant и tenantAdmit: rebuild({ tenant }) без проекции или во время перестройки пачками
  'derived.no_projection': {
    code: 'rebuild_required',
    ru: 'проектор {name}: проекции ещё нет или идёт перестройка пачками — сначала run() или rebuild()',
    hint: 'сначала построить проекцию — run() или rebuild() (прерванную перестройку пачками продолжит run()), затем повторить rebuild({ tenant })',
  },
  // project.ts, rebuildTenant и tenantAdmit: rebuild({ tenant }) арендатора не из участников (classes — классы into);
  // с опцией tenants — следующая запись
  'derived.not_participant': {
    code: 'tenant_denied',
    ru: "проектор {name}: арендатор {tenant} не участник — у него не все классы {classes} помечены derivedBy: '{name}'",
    hint: 'пометить классы into арендатора опцией derivedBy с именем проектора, затем повторить rebuild({ tenant })',
  },
  // project.ts, rebuildTenant и tenantAdmit: то же с опцией tenants
  'derived.not_participant_listed': {
    code: 'tenant_denied',
    ru: "проектор {name}: арендатор {tenant} не участник — у него не все классы {classes} помечены derivedBy: '{name}' или его нет в списке tenants",
    hint: 'пометить классы into арендатора опцией derivedBy с именем проектора и проверить, что он есть в списке tenants, затем повторить rebuild({ tenant })',
  },
  // project.ts, startTenant: текст отметки выбывшего в status().failed (lmsg) — арендатор перестал быть участником до
  // начала своей перестройки пачками
  'derived.left_before_rebuild': {
    code: 'tenant_denied',
    ru: 'проектор {name}: арендатор {tenant} больше не участник',
  },
  // project.ts, tenantChunk: текст отметки выбывшего в status().failed (lmsg) — арендатор перестал быть участником
  // посреди своей перестройки пачками
  'derived.left_during_rebuild': {
    code: 'tenant_denied',
    ru: 'арендатор {tenant} больше не участник проектора {name}',
  },
} satisfies Section<'derived'>;
