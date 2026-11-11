/**
 * Раздел sql-access: lib/sql/50-acl.sql, lib/sql/80-auth.sql — матрица, ключи, вход, приглашения, квартиры. Русский
 * текст собирает база из этих же записей: установщик кладёт разделы sql-* в message_catalog() (lib/sql/15-errors.sql),
 * ключ и параметры уходят в DETAIL.
 */
import type { Section } from './types.js';

export const sqlAccess = {
  // 50-acl.sql (acl_check, acl_check_role, acl_require), 80-auth.sql (auth_session_required, auth_self, tenant_delete,
  // invite_create, invite_list, invite_revoke; session_required — корень квартиры жильца с погашенной сессией): сессии нет
  'sql-access.no_session': {
    code: 'no_session',
    ru: 'нет действующей сессии',
  },
  // 50-acl.sql, acl_subject() (загрузчик с опцией as): аккаунт не прописан в квартире или она выключена
  'sql-access.no_membership': {
    code: 'tenant_denied',
    ru: 'аккаунт не прописан в квартире или квартира выключена',
  },
  // 50-acl.sql, acl_plan(): op — переданная операция
  'sql-access.acl_bad_op': {
    code: 'invalid_data',
    ru: 'операция {op}: нужна READ, WRITE или DELETE',
  },
  // 50-acl.sql, acl_subject()
  'sql-access.account_unavailable': {
    code: 'target_not_found',
    ru: 'аккаунт не найден или отключён',
  },
  // 50-acl.sql, acl_require(): endpoint — эндпоинт API
  'sql-access.no_right': {
    code: 'acl_denied',
    ru: 'нет права {endpoint}',
  },
  // 50-acl.sql, acl_api_for(): message решения по эндпоинту без подходящего правила — текст не для ошибки (lt_text)
  'sql-access.default_deny': {
    code: 'acl_denied',
    ru: 'нет подходящего правила (запрет по умолчанию)',
  },
  // 80-auth.sql: auth_self(true) — правка ключей, смена контакта, удаление аккаунта без недавнего интерактивного входа
  // (с TOTP, если он включён); сессия из accept аккаунта, который уже был, недавним входом не считается
  'sql-access.bind_denied': {
    code: 'acl_denied',
    ru: 'нужен недавний вход паролем, кодом или внешним входом (не позже 10 минут назад; с TOTP, если он включён)',
    hint: 'войти заново: db.open(ключ) — и повторить; сессия из accept, по ключу API и по ключу с секретом недавним входом не считается',
  },
  // 80-auth.sql, auth_ident_free() (contact_confirm(), key_link()), invite_accept(), key_set_password(): контакт (имя
  // для входа) или внешний id уже у другого аккаунта
  'sql-access.identifier_taken': {
    code: 'exists',
    ru: 'этот контакт занят другим аккаунтом',
    hint: 'указать другой контакт; если контакт ваш — войти его аккаунтом (db.open с этим контактом)',
  },
  // 80-auth.sql, invite_accept(), key_set_password(): хэш не тот или у аккаунта нет контакта
  'sql-access.password_args': {
    code: 'invalid_data',
    ru: 'пароль: нужен хэш scrypt$… и контакт аккаунта',
  },
  // 80-auth.sql, key_issue_apikey(): SQLSTATE 40001 — повторяемый конфликт
  'sql-access.apikey_prefix_conflict': {
    code: 'conflict',
    ru: 'не удалось выпустить ключ с уникальным префиксом',
  },
  // 80-auth.sql, code_issue(): число знаков кода или попыток не то
  'sql-access.otp_args': {
    code: 'invalid_data',
    ru: 'код входа: от 4 до 10 знаков (digits), от 1 до 10 попыток (maxAttempts)',
  },
  // 80-auth.sql, key_link(): вид или внешний id не те
  'sql-access.identity_args': {
    code: 'invalid_data',
    ru: 'внешний вход: вид (GOOGLE, TELEGRAM, …; не PASSWORD и не служебный) и внешний id обязательны',
  },
  // 80-auth.sql, invite_create(), code_issue(), contact_change(), contact_confirm(): контакт не тот
  'sql-access.contact_args': {
    code: 'invalid_data',
    ru: 'контакт: вид — строчные латинские буквы, цифры, подчёркивание (email, phone, telegram, …); адрес — непустая строка до 320 знаков',
  },
  // 80-auth.sql, account_rename() (me.changeName): имя пустое после обрезки пробелов, длиннее 200 знаков или не строка
  'sql-access.name_args': {
    code: 'invalid_data',
    ru: 'имя: непустая строка до 200 знаков (пробелы по краям не считаются)',
    hint: "передать имя строкой: me.changeName('Анна Петрова')",
  },
  // 80-auth.sql, invite_create(), invite_accept(): аккаунт этого контакта уже прописан в квартире
  'sql-access.already_member': {
    code: 'exists',
    ru: 'этот контакт уже прописан в квартире',
    hint: 'роли прописанного жильца меняет me.acl.roles(аккаунт, роли) — приглашение не нужно',
  },
  // 50-acl.sql, trg_entity_acl() (правка и удаление прописки), 80-auth.sql, invite_create(): матрица не разрешает
  // актору выдать или снять роль; role — имя роли
  'sql-access.role_denied': {
    code: 'acl_denied',
    ru: 'нет права выдать или снять роль {role}',
    hint: "право даёт правило матрицы на роль: me.acl.grant({ role: 'ваша роль', assign: 'эта роль' }); проверить заранее — me.acl.checkRole('эта роль')",
  },
  // 80-auth.sql, invite_create(): приглашение без ролей, а права на все роли у актора нет
  'sql-access.invite_denied': {
    code: 'acl_denied',
    ru: 'нет права звать без ролей: нужно право на все роли',
    hint: "позвать с ролью, которую вам можно выдать, или получить право на все роли: me.acl.grant({ role: 'ваша роль', assign: '*' })",
  },
  // 50-acl.sql, trg_entity_acl(): вес правила квартиры без признака concierge; weight — как передан
  'sql-access.rule_weight': {
    code: 'invalid_data',
    ru: 'вес правила {weight}: целое от 0 до 999',
    hint: 'вес правила квартиры — 0…999 (у обёртки me.acl — 1…999); больше — только у правил, которые заводит createTenant',
  },
  // 50-acl.sql, trg_entity_acl(): обратное решение поверх правила той же пары КТО → ЧТО; permission — прежнее решение;
  // detail.rule — id правила
  'sql-access.rule_flip': {
    code: 'exists',
    ru: 'у этой пары КТО → ЧТО уже есть правило {permission}: обратное поверх него не пишется',
    hint: 'сначала снять прежнее — me.acl.revoke(…) с тем же описанием, — потом записать новое',
  },
  // 50-acl.sql, trg_entity_acl(): новое правило при тех же масках КТО и ЧТО и равном счёте спорит с действующим;
  // permission, weight — новое правило; rule, other, other_weight — действующее; detail.rule — его id
  'sql-access.rule_tie': {
    code: 'acl_ambiguous',
    ru: 'правило спорит с действующим: те же КТО и ЧТО, равный счёт, обратное решение — новое: {permission}, вес {weight}; действующее {rule}: {other}, вес {other_weight}',
    hint: 'поднять или опустить weight нового правила либо снять прежнее (me.acl.revoke); правила — me.acl.list()',
  },
  // 50-acl.sql, acl_api_for(), acl_check_data(), acl_check_role(): ничья «можно» и «нельзя» по счёту; rules — id правил
  'sql-access.acl_ambiguous': {
    code: 'acl_ambiguous',
    ru: 'правила с равным счётом спорят (одно разрешает, другое запрещает): {rules}',
    hint: 'посмотреть правила — me.acl.list() — и поднять вес нужного (weight) или снять лишнее (me.acl.revoke)',
  },
  // 50-acl.sql, trg_entity_acl(), acl_delete_guard() (каскад удаления, предпросмотр): правило чужое; detail.rule — id,
  // если актор правило видит
  'sql-access.rule_foreign': {
    code: 'acl_denied',
    ru: 'правило меняет и удаляет только тот, кто его завёл, или консьерж',
  },
  // 50-acl.sql, trg_entity_acl(), acl_delete_guard() (каскад удаления, предпросмотр): правило по умолчанию
  'sql-access.rule_default_protected': {
    code: 'acl_denied',
    ru: 'правило по умолчанию не удаляется и не меняется: allow или deny — setup({ defaultRule })',
  },
  // 50-acl.sql, trg_entity_acl(): жилец ставит или меняет признаки default и concierge (правка чужого правила с такими
  // признаками — rule_foreign)
  'sql-access.rule_reserved': {
    code: 'acl_denied',
    ru: 'признаки default и concierge у правила ставит только консьерж',
  },
  // 50-acl.sql, trg_entity_acl(): строку member жилец заводит или переносит на другой аккаунт
  'sql-access.member_invite_only': {
    code: 'acl_denied',
    ru: 'прописка — только по приглашению: позовите человека me.invite(), он примет его db.accept(); роли меняет правка прописки',
    hint: 'позвать me.invite({ email }, [роли]) — почтальон доставит ссылку, db.accept(token) пропишет человека в квартире',
  },
  // 80-auth.sql, auth_service_required(): вызов только для консьержа (не от имени жильца)
  'sql-access.not_service': {
    code: 'acl_denied',
    ru: 'это делает только консьерж',
  },
  // 80-auth.sql, auth_self(): ключи, смена контакта, выписка и удаление аккаунта — только сам жилец
  'sql-access.resident_only': {
    code: 'acl_denied',
    ru: 'это делает только сам жилец в своей квартире',
    hint: 'войти ключом жильца: db.open(ключ); консьерж (db.in, db.as) этого не делает',
  },
  // 80-auth.sql, tenant_create(): name — имя
  'sql-access.tenant_name': {
    code: 'invalid_data',
    ru: 'имя квартиры {name}: непустая строка без крайних пробелов, до 200 знаков',
  },
  // 80-auth.sql, tenant_create(): name — имя квартиры, которая уже есть (сравнение без учёта регистра)
  'sql-access.tenant_exists': {
    code: 'exists',
    ru: 'квартира «{name}» уже есть: имена квартир сравниваются без учёта регистра',
    hint: 'открыть существующую — db.in(имя) — или выбрать другое имя',
  },
  // 80-auth.sql, invite_create(); 50-acl.sql, trg_entity_acl() (запись прописки): роли не те
  'sql-access.roles_args': {
    code: 'invalid_data',
    ru: 'роли — массив разных имён без запятых, фигурных скобок, крайних пробелов и «!» в начале',
  },
  // 80-auth.sql, key_link(): внешний id этого аккаунта уже открывает другую квартиру
  'sql-access.key_bound_elsewhere': {
    code: 'exists',
    ru: 'этот внешний вход уже открывает другую квартиру: один внешний id — одна квартира',
  },
  // 80-auth.sql, member_owner_check() (триггер entity_member_owner: выписка, правка ролей и удаление прописки, удаление
  // аккаунта — жильцом или консьержем): name — имя квартиры; detail — { tenant: id, name }
  'sql-access.last_owner': {
    code: 'last_owner',
    ru: 'квартира «{name}» осталась бы без owner',
    hint: 'сначала дать роль owner другому жильцу (me.acl.roles или правка его прописки) — или удалить квартиру целиком (me.deleteTenant)',
  },
  // 50-acl.sql, trg_entity_acl(), acl_delete_guard() (каскад удаления, предпросмотр): ресурс матрицы чужой;
  // detail.resource — id, если актор ресурс видит
  'sql-access.resource_foreign': {
    code: 'acl_denied',
    ru: 'ресурс матрицы (маску правила) меняет и удаляет только тот, кто его завёл, или консьерж',
  },
} satisfies Section<'sql-access'>;
