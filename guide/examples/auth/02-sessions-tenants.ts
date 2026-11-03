import { createTenant, syncModels, totpCode } from 'letopis';
import type { Db } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

// класс компании: его описание есть только в арендаторе «Ромашка»
const Item = hub('Item', { code: z.string() }, { key: ['code'] });

let anna: Db, pairId: string, pair: { key: string; secret: string }, temp: { tenant: string; token: string | null };

export default example({
  title: 'Сессии и арендаторы: переключение, способы входа, выход, закрытие арендатора',
  summary:
    'Сессия входа сначала работает в личном арендаторе аккаунта: классов компании там нет. В компанию её переводит ' +
    'auth.switch(), список — auth.tenants() с именами. Способы входа видны без секретов, сессию можно продлить и ' +
    'завершить — свою, по токену или все. Владелец может стереть арендатора целиком, даже тот, в котором сейчас работает.',
  tables: ['secret'],
  covers: [
    'auth.tenants', 'auth.switch', 'auth.credentials', 'auth.issueKeySecret', 'auth.verifyKeySecret', 'auth.setFlags',
    'auth.refresh', 'auth.revoke', 'auth.revokeAll', 'auth.purgeAccount', 'auth.session',
    'error.invalid_class', 'nuance.session-starts-personal', 'nuance.revoke-by-token', 'nuance.purge-current-tenant', 'nuance.service-enforces-2fa', 'nuance.refresh-never-shortens', 'nuance.revoked-session-empty',
  ],
  steps: [
    {
      title: 'Вход паролем: сессия в личном арендаторе',
      text:
        'У каждого аккаунта есть свой, личный арендатор; свежая сессия работает в нём. `auth.tenants()` — куда ' +
        'можно перейти: `tenant`, роли, имя арендатора `name` и `personal` — личный ли (он первым, с ролью `owner`), ' +
        'затем компании по членству. Классы компании (здесь `Item`) в личном арендаторе не видны: шаг `anna.Item()` — ' +
        '`invalid_class` с подсказкой (`err.hint`) про `auth.tenants()` и `auth.switch()`.',
      run: async ({ db, svc, user, connect, dsn, schema, up }) => {
        await syncModels(db, [Item], { apply: true }); // скрыть
        const ok = (await svc.auth.verifyPassword({ identifier: user.login, password: user.password }))!;
        anna = await connect({ dsn: dsn.app, schema, token: ok.token });
        const item = await (async () => anna.Item().count())().then(String, (e) => ({ code: e.code, message: e.message, hint: e.hint }));
        return {
          'сейчас': anna.tenant === ok.account ? 'личный арендатор' : anna.tenant,
          'можно': await anna.auth.tenants(),
          'компания': up.tenant!.tenant,
          'anna.Item().count()': item,
        };
      },
    },
    {
      title: 'Перейти в компанию',
      text:
        '`auth.switch()` пишет арендатора в строку сессии: смена видна всем подключениям с этим токеном, реестр классов ' +
        'перечитан — классы компании теперь видны. Компанию берут из `auth.tenants()`: первая не личная — ' +
        '`.find((t) => !t.personal)`; если их несколько, пусть выберет пользователь (по `name`).',
      run: async () => {
        const club = (await anna.auth.tenants()).find((t) => !t.personal)!;
        await anna.auth.switch(club.tenant);
        return { 'сейчас': club.name, 'anna.Item().count()': await anna.Item().count() };
      },
    },
    {
      title: 'Способы входа — без секретов',
      text: 'Пароль, ключи, TOTP — строки `secret`; `credentials()` отдаёт их вид, признаки и сроки, но не хэши.',
      run: async ({ svc, up }) => (await svc.auth.credentials(up.tenant!.user!)).map((c) => ({ kind: c.kind, ident: c.ident, confirmed: c.confirmed, enabled: c.enabled })),
    },
    {
      title: 'Пара «ключ + секрет» и её отключение',
      text: 'Для интеграций, которым нужен отдельный секрет. `setFlags(id, { enabled: false })` выключает этот способ входа, не удаляя его.',
      run: async ({ svc, up }) => {
        const issued = await svc.auth.issueKeySecret({ account: up.tenant!.user!, name: 'склад' });
        pair = { key: issued.key, secret: issued.secret }; pairId = issued.id;
        const before = !!(await svc.auth.verifyKeySecret(pair.key, pair.secret));
        const wrong = await svc.auth.verifyKeySecret(pair.key, 'не тот секрет');
        await svc.auth.setFlags(pairId, { enabled: false });
        return { 'вход парой': before, 'неверный секрет': wrong, 'после отключения': await svc.auth.verifyKeySecret(pair.key, pair.secret) };
      },
    },
    {
      title: 'Второй фактор требует сервис',
      text:
        'TOTP включён, но `verifyPassword` без кода всё равно выдаёт сессию — без отметки TOTP. Требовать код должен ' +
        'сервис: проверить `totpEnabled` и попросить код (так делает helpdesk).',
      run: async ({ svc, up, user }) => {
        const { secret } = await svc.auth.enrollTotp({ account: up.tenant!.user! });
        await svc.auth.verifyTotp({ account: up.tenant!.user!, code: totpCode(secret) });
        const noCode = await svc.auth.verifyPassword({ identifier: user.login, password: user.password });
        return { 'TOTP включён': await svc.auth.totpEnabled(up.tenant!.user!), 'сессия без кода': !!noCode };
      },
    },
    {
      title: 'Продлить сессию и завершить другую',
      text:
        '`refresh({ ttl })` продлевает срок от «сейчас», но не дальше срока, выданного при входе, и никогда не ' +
        'укорачивает: семидневная сессия Анны так и осталась на 7 дней, десятиминутная продлилась лишь на свои 10 минут. ' +
        '`revoke()` завершает сессию своего подключения — следующий вызов получит `no_session`.',
      run: async ({ svc, up, connect, dsn, schema }) => {
        const week = await anna.auth.refresh({ ttl: 3600 });
        const other = await connect({ dsn: dsn.app, schema, token: await svc.auth.sessionFor(up.tenant!.user!, { ttl: 600 }) });
        const short = await other.auth.refresh({ ttl: 3600 });
        await other.auth.revoke();
        return {
          'сессия на 7 дн после refresh({ ttl: 3600 })': week,
          'сессия на 10 мин после refresh({ ttl: 3600 })': short,
          'после revoke()': await other.auth.tenants().then(() => 'работает', (e) => e.code),
        };
      },
    },
    {
      title: 'Выход в веб-сервисе: сервис гасит сессию по токену',
      text:
        'Веб-сервис держит токен пользователя в cookie и сам к базе по нему не подключается. Кнопка «Выйти» — ' +
        '`svc.auth.revoke(token)`: сервис гасит сессию по токену (нужно право `auth.session`, оно у сервиса есть). ' +
        'Ответ `true` — погашена; повторный вызов — `false` (токен неверный, сессия погашена или истекла). После ' +
        'этого `svc.auth.session(token)` — `null`. `revoke()` без аргумента гасит сессию самого подключения — у ' +
        'сервиса это был бы его собственный вход.',
      run: async ({ svc, up }) => {
        const token = await svc.auth.sessionFor(up.tenant!.user!, { ttl: 3600 }); // вход пользователя: токен — в cookie
        return {
          'до выхода': (await svc.auth.session(token)) ? 'сессия жива' : null,
          'revoke(token)': await svc.auth.revoke(token),
          'ещё раз': await svc.auth.revoke(token),
          'session(token) после выхода': await svc.auth.session(token),
        };
      },
    },
    {
      title: 'Выйти везде',
      text:
        '`revokeAll()` завершает все сессии аккаунта, включая текущую. Внимание: чтение по завершённой сессии ' +
        'ошибки не даёт — запросы просто возвращают пустой результат (правила в компании есть, а счёт — 0). ' +
        '`no_session` бросают функции входа (`auth.*`), поэтому веб-сервис проверяет сессию в начале каждого запроса.',
      run: async () => ({
        'погашено': await anna.auth.revokeAll(),
        'auth.tenants()': await anna.auth.tenants().then(() => 'работает', (e) => e.code),
        'правил видно': await anna.rule().count(),
      }),
    },
    {
      title: 'Закрыть арендатора, в котором работаешь',
      text:
        'Анна заводит пробную компанию (она — владелец) и стирает её `purgeAccount`, работая прямо в ней. Данные и ' +
        'журнал компании стёрты, сессия Анны вернулась в её личный арендатор.',
      run: async ({ admin, schema, user, connect, dsn }) => {
        temp = await createTenant(admin, schema, { name: 'Пробная', user: { name: 'Анна', login: user.login, password: user.password } });
        const inTemp = await connect({ dsn: dsn.app, schema, token: temp.token! });
        const was = inTemp.tenant === temp.tenant ? 'пробная компания' : inTemp.tenant;
        const res = await inTemp.auth.purgeAccount(temp.tenant);
        return { 'работала в': was, 'стёрто': { rows: res.rows, versions: res.versions }, 'теперь': inTemp.tenant === temp.tenant ? 'пробная компания' : 'личный арендатор' };
      },
    },
    {
      title: 'Сервис узнаёт сессию по токену',
      text:
        'Веб-сервис хранит токен в cookie и в начале каждого запроса спрашивает базу `svc.auth.session(token)`: чья ' +
        'сессия, в каком арендаторе работает, цело ли там членство, когда истечёт, как был вход. Подключение по токену ' +
        'не открывается, срок не продлевается. Сессия, которой Анна закрыла пробную компанию, жива и вернулась в личный ' +
        'арендатор; способов входа у неё нет — её выдал `createTenant`. Сессия после «выйти везде» — `null`, как и ' +
        'неверный или истёкший токен. Спросить может только сервис (право `auth.session`).',
      run: async ({ svc }) => ({
        'сессия из пробной компании': await svc.auth.session(temp.token!),
        'после «выйти везде»': await svc.auth.session(anna.token!),
      }),
    },
  ],
});
