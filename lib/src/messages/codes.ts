/**
 * Коды ошибок: заголовок (что значит код) и подсказка «что делать» на обоих языках — по одной записи на каждый код
 * (полноту и совпадение кода с ключом проверяет тип). Подсказку кода получает каждая ошибка с этим кодом
 * (`LetopisError.hint`), если у её записи каталога нет своей. Из этих записей собрана таблица «Все коды» на странице
 * ошибок сайта (guide/scripts/gen-errors.ts). Порядок — как в разделе «Ошибки» README: коды базы (LT001–LT023), затем
 * коды библиотеки.
 */
import type { ErrorCode, Msg, Text } from './types.js';

export const codes = {
  'codes.no_session': {
    code: 'no_session',
    ru: 'нет действующей сессии',
    en: 'there is no valid session',
    hint: {
      ru: 'войти заново: истёкшую или отозванную сессию не вернуть',
      en: 'log in again: an expired or revoked session cannot be brought back',
    },
  },
  'codes.target_not_found': {
    code: 'target_not_found',
    ru: 'цель не найдена — одинаково для несуществующей, чужой и невидимой',
    en: 'the target is not found — the same for a nonexistent, a foreign and an invisible one',
    hint: {
      ru: 'проверить id и права: чужой и невидимый объект неотличим от несуществующего',
      en: 'check the id and the rights: a foreign or an invisible object is indistinguishable from a nonexistent one',
    },
  },
  'codes.invalid_data': {
    code: 'invalid_data',
    ru: 'данные не подходят к описанию класса; подробности — в `issues`',
    en: 'the data does not match the class description; the details are in `issues`',
    hint: {
      ru: 'исправить данные по `issues` (путь, правило, сообщение); проверить до отправки — `compileValidator`',
      en: 'fix the data by `issues` (path, rule, message); to check before sending — `compileValidator`',
    },
  },
  'codes.undeclared_end': {
    code: 'undeclared_end',
    ru: 'у класса нет такого конца (ссылки)',
    en: 'the class has no such end (link)',
    hint: {
      ru: 'объявить конец в модели класса (`ends`) или исправить имя роли',
      en: 'declare the end in the class model (`ends`) or fix the role name',
    },
  },
  'codes.tenant_denied': {
    code: 'tenant_denied',
    ru: 'чужой арендатор или нет членства в нём',
    en: 'a foreign tenant or no membership in it',
    hint: {
      ru: 'работать в арендаторе, где у пользователя есть членство, — сменить его `auth.switch()`',
      en: 'work in a tenant where the user is a member — switch to it with `auth.switch()`',
    },
  },
  'codes.acl_denied': {
    code: 'acl_denied',
    ru: 'правила доступа запрещают это действие',
    en: 'the access rules forbid this action',
    hint: {
      ru: 'добавить правило доступа (`Rule`) или выполнить действие от пользователя, которому оно разрешено; проверить заранее — `db.acl.checkData`, `db.acl.check`',
      en: 'add an access rule (`Rule`) or perform the action as a user who is allowed to; to check in advance — `db.acl.checkData`, `db.acl.check`',
    },
  },
  'codes.id_mismatch': {
    code: 'id_mismatch',
    ru: 'переданный id не совпадает с id, вычисленным из ключа',
    en: 'the given id does not match the id computed from the key',
    hint: {
      ru: 'не передавать `id` у класса с ключом — база вычислит его из ключа; узнать заранее — `db.idOf(класс, ключ)`',
      en: 'do not pass `id` for a class with a key — the database computes it from the key; to know it in advance — `db.idOf(class, key)`',
    },
  },
  'codes.id_from_db': {
    code: 'id_from_db',
    ru: 'у класса без ключа id выдаёт база — свой id передавать нельзя',
    en: 'the database assigns the id of a class without a key — you cannot pass your own',
    hint: {
      ru: 'не передавать `id` — база выдаст его сама; нужен постоянный id — дать классу ключ',
      en: 'do not pass `id` — the database assigns it; for a stable id give the class a key',
    },
  },
  'codes.immutable_key': {
    code: 'immutable_key',
    ru: 'ключевые поля, id, арендатора и владельца правкой не изменить (новый ключ — `rekey`)',
    en: 'an update cannot change key fields, the id, the tenant or the owner (a new key — `rekey`)',
    hint: {
      ru: 'новый ключ — `rekey()`; id, арендатор и владелец строки не меняются',
      en: 'a new key — `rekey()`; the id, the tenant and the owner of a row do not change',
    },
  },
  'codes.invalid_class': {
    code: 'invalid_class',
    ru: 'описание класса отклонено, класс не найден или абстрактный, либо удаляют класс, у которого есть строки, потомки или история',
    en: 'the class description is rejected, the class is not found or is abstract, or a class with rows, descendants or history is being deleted',
    hint: {
      ru: 'проверить имя (`db.registry.has`) и описание класса (`syncModels` без `apply` покажет план); удалить класс можно только без строк, потомков и истории',
      en: 'check the name (`db.registry.has`) and the class description (`syncModels` without `apply` shows the plan); a class can be deleted only without rows, descendants and history',
    },
  },
  'codes.use_reclass': {
    code: 'use_reclass',
    ru: 'класс объекта с ключом меняют не `update`, а `reclass()`: id при этом меняется',
    en: 'the class of an object with a key is changed by `reclass()`, not by `update`: the id changes',
    hint: {
      ru: 'сменить класс через `reclass()`: у объекта будет новый id, ссылки переведутся сами',
      en: 'change the class with `reclass()`: the object gets a new id, the references move by themselves',
    },
  },
  'codes.reclass_denied': {
    code: 'reclass_denied',
    ru: 'ссылки других строк не допускают новый класс',
    en: 'the references of other rows do not accept the new class',
    hint: {
      ru: 'сначала перевести ссылки других строк — или выбрать класс, который их роли принимают',
      en: 'first move the references of other rows — or choose a class that their roles accept',
    },
  },
  'codes.tightening_conflict': {
    code: 'tightening_conflict',
    ru: 'ужесточению модели мешают строки, которые ей не подходят',
    en: 'rows that do not fit the model prevent tightening it',
    hint: {
      ru: 'исправить или удалить строки из списка ошибки и снова вызвать `syncModels`',
      en: 'fix or delete the rows listed in the error and call `syncModels` again',
    },
  },
  'codes.isolation_level': {
    code: 'isolation_level',
    ru: 'удаление и смена класса или ключа работают только на уровне `read committed`',
    en: 'deleting and changing the class or the key work only at the `read committed` level',
    hint: {
      ru: 'удалять, менять класс и ключ в транзакции уровня `read committed` — он стоит по умолчанию',
      en: 'delete, change the class and the key in a `read committed` transaction — it is the default',
    },
  },
  'codes.recreated_in_statement': {
    code: 'recreated_in_statement',
    ru: 'объект удалён и создан заново одним оператором',
    en: 'the object was deleted and created again by one statement',
    hint: {
      ru: 'удалить и создать объект разными операторами',
      en: 'delete and create the object with separate statements',
    },
  },
  'codes.cursor_expired': {
    code: 'cursor_expired',
    ru: 'курсор подписки или проектора старше прореженной части журнала (яруса `all`)',
    en: 'the cursor of a subscription or a projector is older than the thinned part of the log (the `all` tier)',
    hint: {
      ru: "подписку начать заново (`from: 'now'` или `'start'`) и перечитать нужное состояние, проектору — `rebuild()` или `onExpired: 'rebuild'`; сохранять `sub.cursor`, а не курсор события",
      en: "start the subscription again (`from: 'now'` or `'start'`) and reread the needed state; for a projector — `rebuild()` or `onExpired: 'rebuild'`; save `sub.cursor`, not the cursor of an event",
    },
  },
  'codes.delete_restricted': {
    code: 'delete_restricted',
    ru: 'удалить нельзя: на объект ссылаются строки с действием при удалении `restrict`',
    en: 'cannot delete: rows with the `restrict` delete action reference the object',
    hint: {
      ru: 'сначала удалить или перевести ссылающиеся строки — или сменить у их конца действие при удалении (`onDelete`)',
      en: 'first delete or move the referencing rows — or change the delete action of their end (`onDelete`)',
    },
  },
  'codes.not_deleted': {
    code: 'not_deleted',
    ru: '`restore` и `purge` работают только для удалённых объектов',
    en: '`restore` and `purge` work only for deleted objects',
    hint: {
      ru: 'сначала `delete()`, потом `restore()` или `purge()`',
      en: 'first `delete()`, then `restore()` or `purge()`',
    },
  },
  'codes.reset_disabled': {
    code: 'reset_disabled',
    ru: 'сброс выключен: установка поставлена без `allowReset`',
    en: 'reset is disabled: the installation was set up without `allowReset`',
    hint: {
      ru: 'сброс работает только в установке с `up({ allowReset: true })`; рабочей базе его лучше не включать',
      en: 'reset works only in an installation with `up({ allowReset: true })`; better not to enable it for a production database',
    },
  },
  'codes.confirm_mismatch': {
    code: 'confirm_mismatch',
    ru: 'подтверждение сброса не совпадает с именем схемы',
    en: 'the reset confirmation does not match the schema name',
    hint: {
      ru: 'передать в `confirm` точное имя схемы установки',
      en: 'pass the exact schema name of the installation in `confirm`',
    },
  },
  'codes.derived_class': {
    code: 'derived_class',
    ru: 'в производный класс (`derivedBy`) пишет не его проектор',
    en: 'someone other than its projector writes to a derived class (`derivedBy`)',
    hint: {
      ru: 'писать в производный класс только его проектором (`db.projector`); приложение такие строки только читает',
      en: 'write to a derived class only with its projector (`db.projector`); the application only reads such rows',
    },
  },
  'codes.aggregate_field': {
    code: 'aggregate_field',
    ru: 'агрегатное поле считает база — передавать или менять его нельзя',
    en: 'the database calculates the aggregate field — you cannot pass or change it',
    hint: {
      ru: 'не передавать агрегатное поле в `create`, `update` и `upsert` — его посчитает база; починить расхождение — `rebuildAggregates(класс)`',
      en: 'do not pass the aggregate field to `create`, `update` and `upsert` — the database calculates it; to repair a mismatch — `rebuildAggregates(class)`',
    },
  },
  'codes.projector_pending': {
    code: 'projector_pending',
    ru: 'проектор ещё не прочёл удаление или обрезаемые версии: сначала `run()` проектора',
    en: 'the projector has not read the deletion or the trimmed versions yet: first `run()` the projector',
    hint: {
      ru: 'запустить `run()` проектора и повторить',
      en: 'call `run()` of the projector and retry',
    },
  },
  'codes.exists': {
    code: 'exists',
    ru: 'объект с таким id уже существует',
    en: 'an object with this id already exists',
    hint: {
      ru: 'при повторе операции с ключом это ответ «уже записано»; иначе — `update`, `upsert` или другой ключ',
      en: 'when an operation with a key is retried, this means "already written"; otherwise — `update`, `upsert` or another key',
    },
  },
  'codes.duplicate': {
    code: 'duplicate',
    ru: 'загрузчик: id повторяется во входных данных',
    en: 'loader: an id repeats in the input',
    hint: {
      ru: 'убрать повторы id из входных данных: первые 100 — в `detail.rows`',
      en: 'remove the repeated ids from the input: the first 100 are in `detail.rows`',
    },
  },
  'codes.deleted': {
    code: 'deleted',
    ru: 'загрузчик: объект с этим id уже жил раньше и был удалён',
    en: 'loader: an object with this id existed before and was deleted',
    hint: {
      ru: "загрузить с `existing: 'update'` — объект оживёт новой версией — или дать ему другой id",
      en: "load with `existing: 'update'` — the object comes back as a new version — or give it another id",
    },
  },
  'codes.conflict': {
    code: 'conflict',
    ru: '`update` с `{ rev }`: строку уже изменили после того, как вы её прочли',
    en: '`update` with `{ rev }`: the row was changed after you read it',
    hint: {
      ru: 'перечитать строку и повторить правку с новым `rev`; для чисел — `inc` вместо записи итога',
      en: 'reread the row and repeat the update with the new `rev`; for numbers — `inc` instead of writing the total',
    },
  },
  'codes.rev_ambiguous': {
    code: 'rev_ambiguous',
    ru: '`{ rev }` указан у шага, который выбрал больше одного объекта',
    en: '`{ rev }` is given on a step that selected more than one object',
    hint: {
      ru: 'сузить шаг до одной строки (id или ключ) или убрать `{ rev }`',
      en: 'narrow the step down to one row (an id or a key) or remove `{ rev }`',
    },
  },
  'codes.tx_required': {
    code: 'tx_required',
    ru: '`forUpdate()`, `lock()`, `commit()` и `rollback()` работают только внутри `db.begin()`',
    en: '`forUpdate()`, `lock()`, `commit()` and `rollback()` work only inside `db.begin()`',
    hint: {
      ru: 'вызывать внутри транзакции: `const tr = await db.begin()` … `await tr.commit()`',
      en: 'call inside a transaction: `const tr = await db.begin()` … `await tr.commit()`',
    },
  },
  'codes.lock_unsupported': {
    code: 'lock_unsupported',
    ru: '`forUpdate()` нельзя сочетать с агрегатом, `asOf`, `versions`, `withDeleted`, `deep` или глаголом',
    en: '`forUpdate()` cannot be combined with an aggregate, `asOf`, `versions`, `withDeleted`, `deep` or a verb',
    hint: {
      ru: 'брать `forUpdate()` в простом чтении строк, а итоги, срезы и правки делать отдельными шагами',
      en: 'use `forUpdate()` in a plain read of rows and do totals, snapshots and updates as separate steps',
    },
  },
  'codes.commit_unknown': {
    code: 'commit_unknown',
    ru: 'связь оборвалась во время `COMMIT` — неизвестно, записалась ли транзакция',
    en: 'the connection dropped during `COMMIT` — it is unknown whether the transaction was written',
    hint: {
      ru: 'повторить ту же операцию с тем же ключом: `exists` — она уже записана, успех — в первый раз не записалась; без ключа исход не выяснить, поэтому операциям с деньгами нужен ключ',
      en: 'repeat the same operation with the same key: `exists` means it was already written, success means it was not written the first time; without a key the outcome cannot be found out, so money operations need a key',
    },
  },
  'codes.tx_rolled_back': {
    code: 'tx_rolled_back',
    ru: 'PostgreSQL откатил транзакцию на `COMMIT`: ошибку перехватили внутри `tr.transaction(fn)`',
    en: 'PostgreSQL rolled the transaction back on `COMMIT`: an error was caught inside `tr.transaction(fn)`',
    hint: {
      ru: 'не глушить ошибки внутри `tr.transaction(fn)`: устранить причину и повторить весь блок',
      en: 'do not swallow errors inside `tr.transaction(fn)`: fix the cause and repeat the whole block',
    },
  },
  'codes.no_key': {
    code: 'no_key',
    ru: 'у класса нет ключа, а `upsert`, `rekey` и `idOf` без ключа не работают',
    en: 'the class has no key, and `upsert`, `rekey` and `idOf` do not work without one',
    hint: {
      ru: 'дать классу ключ (`key` в модели) или работать по id: `update` вместо `upsert`',
      en: 'give the class a key (`key` in the model) or work by id: `update` instead of `upsert`',
    },
  },
  'codes.no_path': {
    code: 'no_path',
    ru: 'между классами соседних шагов цепочки нет перехода',
    en: 'there is no hop between the classes of neighboring chain steps',
    hint: {
      ru: 'переходить по объявленным концам: между классами шагов нужна ссылка, роль конца — имя шага',
      en: 'hop along declared ends: the classes of the steps need a link, and the role of the end is the step name',
    },
  },
  'codes.invalid_query': {
    code: 'invalid_query',
    ru: 'цепочка или вызов API построены неверно',
    en: 'the chain or the API call is built incorrectly',
    hint: {
      ru: 'исправить цепочку или вызов: текст ошибки называет неверный шаг или аргумент',
      en: 'fix the chain or the call: the error text names the wrong step or argument',
    },
  },
  'codes.admin_required': {
    code: 'admin_required',
    ru: 'нужно подключение администратора: его требуют загрузчик, проектор и `rebuildAggregates`',
    en: 'an admin connection is needed: the loader, a projector and `rebuildAggregates` require it',
    hint: {
      ru: 'запускать загрузчик, проектор и `rebuildAggregates` на администраторском подключении (`allowBypassRls: true`) в отдельном процессе',
      en: 'run the loader, a projector and `rebuildAggregates` on an admin connection (`allowBypassRls: true`) in a separate process',
    },
  },
  'codes.rebuild_required': {
    code: 'rebuild_required',
    ru: 'данные проектора построены другой его версией — нужна перестройка `rebuild()`',
    en: 'the projector data was built by another version of it — a rebuild with `rebuild()` is needed',
    hint: {
      ru: 'выполнить `rebuild()` проектора: логика `handle` сменилась вместе с `version`',
      en: 'call `rebuild()` of the projector: the `handle` logic changed together with `version`',
    },
  },
  'codes.projector_busy': {
    code: 'projector_busy',
    ru: 'перестройку не начать: проектор сейчас работает в другом процессе',
    en: 'a rebuild cannot start: the projector is running in another process right now',
    hint: {
      ru: 'дождаться конца прохода другого процесса и повторить',
      en: 'wait until the other process finishes its pass and retry',
    },
  },
  'codes.not_empty': {
    code: 'not_empty',
    ru: 'первая заливка возможна только в пустую схему',
    en: 'the initial load is possible only into an empty schema',
    hint: {
      ru: 'первую заливку делать в новую схему (`up({ fresh: true })`), в заполненную — загрузка без `initial`',
      en: 'do the initial load into a new schema (`up({ fresh: true })`); into a filled one — a load without `initial`',
    },
  },
  'codes.class_not_loadable': {
    code: 'class_not_loadable',
    ru: 'загрузчик не принимает строки классов (`Class`) — классы записывает `syncModels`',
    en: 'the loader does not accept class rows (`Class`) — classes are written by `syncModels`',
    hint: {
      ru: 'классы записывать `syncModels`, а загрузчику передавать только строки данных',
      en: 'write classes with `syncModels` and pass only data rows to the loader',
    },
  },
  'codes.bypass_rls': {
    code: 'bypass_rls',
    ru: 'роль подключения обходит RLS: `connect()` без `allowBypassRls` или сервер MCP поверх такого подключения',
    en: 'the connection role bypasses RLS: `connect()` without `allowBypassRls` or an MCP server over such a connection',
    hint: {
      ru: 'подключать приложение отдельной ролью из группы `letopis_app`; администраторскому подключению — `allowBypassRls: true`; сервер MCP — только поверх подключения приложения',
      en: 'connect the application with a separate role from the `letopis_app` group; an admin connection — with `allowBypassRls: true`; an MCP server — only over an application connection',
    },
  },
  'codes.user_session_required': {
    code: 'user_session_required',
    ru: 'серверу MCP нужна сессия пользователя, а не ключ сервиса или пустое подключение',
    en: 'the MCP server needs a user session, not a service key or a connection without a session',
    hint: {
      ru: 'создавать сервер MCP на подключении пользователя (`svc.as(…)` или `connect({ token })`), а не на корне сервиса',
      en: 'create the MCP server on a user connection (`svc.as(…)` or `connect({ token })`), not on the service root',
    },
  },
  'codes.confirmation_required': {
    code: 'confirmation_required',
    ru: 'MCP: удаление не подтвердил человек',
    en: 'MCP: a human did not confirm the deletion',
    hint: {
      ru: 'подтвердить удаление в клиенте MCP; клиенту, который не умеет спрашивать человека, удаление недоступно',
      en: 'confirm the deletion in the MCP client; a client that cannot ask a human cannot delete',
    },
  },
  'codes.removed': {
    code: 'removed',
    ru: 'вызвано снятое API; в тексте ошибки — чем его заменить',
    en: 'a removed API was called; the error text says what replaces it',
    hint: {
      ru: 'заменить вызов тем, что назван в тексте ошибки',
      en: 'replace the call with the one named in the error text',
    },
  },
} satisfies { [K in ErrorCode as `codes.${K}`]: Msg & { code: K; hint: Text } };
