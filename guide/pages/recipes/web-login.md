# Веб-приложение с входом

## Зачем

Рецепт собирает в одном файле всё, что нужно сайту с входом: создание компании, страницу приглашения, вход паролем, вход кодом с выбором квартиры, сессию в cookie и выход. Сервер — на встроенном модуле `node:http`, без фреймворка: так видно каждое действие.

Слова рецепта: **консьерж** (`db`) — подключение приложения к дому; **квартира** — данные одной компании; **почтальон** — функция приложения, которая доставляет письма; **корень квартиры** (`me`) — объект, от которого идут запросы жильца; **роль** — метка прописки (`owner`, `staff`), права ей даёт матрица. Подробно — [«Дом, пропуск, консьерж»](../house/) и [«Приглашения и почтальон»](../invites/).

## Что получится

Сервис заметок: у каждой компании свои заметки, хозяин зовёт сотрудников.

| Запрос | Что делает | Вызов letopis |
|---|---|---|
| `GET /` | заметки жильца с подписями авторов или формы входа | `db.resume(токен из cookie)`, `me.Note().rows()`, `me.acl.people()` |
| `POST /companies` | новая компания и приглашение хозяину | `db.createTenant`, `(await db.in(имя)).invite(контакт, ['owner'])` |
| `GET /invite/<token>` | страница приглашения — только смотрит | `db.invitation(token)` |
| `POST /invite/<token>` | принять приглашение | `db.accept(token, { password?, name? })` |
| `POST /login` | вход паролем | `db.open({ email, password })` |
| `POST /code` | прислать код на почту | `db.requestCode({ email })` |
| `POST /code/enter` | вход кодом; квартир несколько — список | `db.tenantsOf({ email, code })`, `db.open({ email, code, tenant })` |
| `POST /notes` | записать заметку | `me.Note().create(…)` |
| `GET /team` | страница «Команда»: люди с именами и ролями, приглашения | `me.acl.people()`, `me.invites()` |
| `POST /invites` | позвать сотрудника | `me.invite({ email }, ['staff'])` |
| `POST /team/revoke` | отменить приглашение | `me.revokeInvite(id)` |
| `POST /team/remove` | выписать человека | `me.acl.roles(аккаунт, null)` |
| `GET /profile`, `POST /profile` | страница «Мой профиль»: сменить своё имя | `me.acl.people()`, `me.changeName(имя)` |
| `POST /logout` | выйти | `me.close()` |

```text
 браузер                         сервис (консьерж db)                    почтальон
 ───────                         ────────────────────                    ─────────
 «Создать компанию» ───────────▶ createTenant + invite ────────────────▶ письмо со ссылкой
 открыл ссылку      ───────────▶ db.invitation(token) — показать
 «Принять»          ───────────▶ db.accept(token) ──▶ cookie sid=токен сессии
 любой запрос       ───────────▶ db.resume(sid) ──▶ me ──▶ me.Note()…
 «Прислать код»     ───────────▶ db.requestCode({ email }) ───────────────▶ письмо с кодом
 ввёл код           ───────────▶ db.tenantsOf ──▶ список квартир
 выбрал квартиру    ───────────▶ db.open({ email, code, tenant }) ──▶ cookie
 «Выйти»            ───────────▶ me.close() ──▶ cookie стёрта
```

## Запуск

Нужны PostgreSQL 18 и Node 22 — [рецепт с Docker на главной](/#run). В пустой папке:

```sh
npm init -y && npm pkg set type=module && npm i letopis@4 zod && npm i -D tsx @types/node
```

Сохраните программу ниже как `web.ts` и запустите:

```sh
ADMIN_DSN=postgres://postgres:guide@127.0.0.1:15440/letopis npx tsx web.ts
```

Откройте `http://localhost:3000`. Писем сервис не шлёт: почтальон печатает их в консоль — ссылку приглашения и код берите оттуда.

1. «Создать компанию»: название и почта хозяина. В консоли появится ссылка `http://localhost:3000/invite/…`.
2. Откройте ссылку, задайте имя и пароль, нажмите «Принять». Вы в квартире. Имя и пароль можно не задавать: без имени коллеги увидят «без имени», без пароля вход — кодом.
3. Запишите заметку — под ней стоит имя автора. Откройте «Команду» и позовите сотрудника — в консоли появится вторая ссылка. Там же приглашение можно отменить, а человека — выписать. Своё имя меняют на странице «Мой профиль».
4. Выйдите и войдите паролем. Потом — кодом: «Прислать код», код — в консоли.
5. Создайте вторую компанию на ту же почту и примите приглашение. Пароль не задавайте или задайте другой: тот же пароль во второй компании не примут (`api.password_reused`) — пароли одного человека в разных квартирах обязаны различаться. Теперь вход кодом спросит, в какую квартиру войти.

## Программа целиком

<!-- web.ts -->
```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { setup, connect, LetopisError, type Letter } from 'letopis'
import { hub } from 'letopis/model'
import { z } from 'zod'

const ADMIN_DSN = process.env.ADMIN_DSN ?? 'postgres://postgres:guide@127.0.0.1:15440/letopis'
const PORT = Number(process.env.PORT ?? 3000)
const SITE = `http://localhost:${PORT}`
const Note = hub('Note', { text: z.string() }, { ownerDefault: 'actor' })   // владелец заметки — тот, кто её записал

// ---------- почтальон: в учебном сервисе письмо печатается в консоль ----------
const postman = async ({ to, message }: Letter) => {
  if (message.kind === 'invite') console.log(`ПИСЬМО ${to.address}: вас зовут в «${message.tenantName}» — ${SITE}/invite/${message.token}`)
  else console.log(`ПИСЬМО ${to.address}: ваш код — ${message.code}`)
}

// ---------- дом и консьерж: один раз при запуске ----------
const { pass } = await setup(ADMIN_DSN, 'weblogin', { models: [Note], quiet: true })   // в настоящем сервисе — скрипт развёртывания
const db = await connect(pass, { postman })                                             // консьерж: один на процесс

// ---------- помощники HTTP ----------
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const page = (res: ServerResponse, body: string, status = 200, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers })
  res.end(`<!doctype html><meta charset="utf-8"><title>Заметки</title>${body}`)
}
const redirect = (res: ServerResponse, to: string, cookie?: string) => {
  res.writeHead(303, { location: to, ...(cookie ? { 'set-cookie': cookie } : {}) })
  res.end()
}
const form = async (req: IncomingMessage) => {
  let body = ''
  for await (const chunk of req) body += chunk
  return Object.fromEntries(new URLSearchParams(body))
}
// токен сессии — в cookie: скриптам страницы не виден (HttpOnly), чужой сайт его не пришлёт (SameSite)
const setCookie = (token: string) => `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`
const dropCookie = 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'

// корень квартиры жильца по cookie; сессии нет, истекла или погашена — null
async function resident(req: IncomingMessage) {
  const token = /(?:^|;\s*)sid=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1]
  if (!token) return null
  return db.resume(token).catch((e) => {
    if (e instanceof LetopisError && (e.code === 'auth_failed' || e.code === 'no_session')) return null
    throw e
  })
}

// ---------- страницы ----------
const loginForms = (note = '') => `${note ? `<p><b>${esc(note)}</b></p>` : ''}
  <h2>Войти паролем</h2>
  <form method="post" action="/login"><input name="email" placeholder="почта"> <input name="password" type="password" placeholder="пароль"> <button>Войти</button></form>
  <h2>Войти кодом из письма</h2>
  <form method="post" action="/code"><input name="email" placeholder="почта"> <button>Прислать код</button></form>
  <h2>Создать компанию</h2>
  <form method="post" action="/companies"><input name="name" placeholder="название"> <input name="email" placeholder="почта хозяина"> <button>Создать</button></form>`

const routes: Record<string, (req: IncomingMessage, res: ServerResponse, arg: string) => Promise<void>> = {
  // главная: заметки жильца или формы входа
  'GET /': async (req, res) => {
    const me = await resident(req)
    if (!me) return page(res, loginForms())
    const notes = await me.Note().sort('at').rows()
    const names = new Map((await me.acl.people()).map((p) => [p.account, p.name]))   // аккаунт → имя
    // подпись автора: владелец заметки (owner), а не author — тот лишь правил последним; имя пустое — «без имени»
    const signed = (account: string) => (names.has(account) ? names.get(account) || 'без имени' : 'уже не в команде')
    page(res, `<h1>${esc(me.tenantName)}</h1>
      <ul>${notes.map((n) => `<li>${esc(n.data.text)} — ${esc(signed(n.owner))}</li>`).join('')}</ul>
      <form method="post" action="/notes"><input name="text" placeholder="заметка"> <button>Записать</button></form>
      <p><a href="/team">Команда</a> · <a href="/profile">Мой профиль</a></p>
      <form method="post" action="/logout"><button>Выйти</button></form>`)
  },

  // команда: люди квартиры с именами и ролями, приглашения, которые ждут ответа
  'GET /team': async (req, res) => {
    const me = await resident(req)
    if (!me) return redirect(res, '/')
    const people = await me.acl.people()                                    // [{ account, name, roles }] — по имени
    const boss = (await me.acl.checkRole('staff')).allow                    // можно ли мне выдавать роль staff
    const invites = boss ? await me.invites() : []
    const button = (action: string, field: string, value: string, label: string) =>
      `<form method="post" action="${action}" style="display:inline"><input type="hidden" name="${field}" value="${esc(value)}"><button>${label}</button></form>`
    page(res, `<h1>Команда «${esc(me.tenantName)}»</h1>
      <ul>${people.map((p) => `<li>${esc(p.name || 'без имени')} — ${esc(p.roles.join(', '))}${p.account === me.account ? ' (это вы)' : ''}
        ${boss && p.account !== me.account ? button('/team/remove', 'account', p.account, 'Выписать') : ''}</li>`).join('')}</ul>
      ${boss ? `<h2>Позвать сотрудника</h2>
      <form method="post" action="/invites"><input name="email" placeholder="почта"> <button>Позвать</button></form>
      <h2>Ждут ответа</h2>
      <ul>${invites.map((i) => `<li>${esc(i.to.address)} — ${esc(i.roles.join(', '))} ${button('/team/revoke', 'id', i.id, 'Отменить')}</li>`).join('') || '<li>никто</li>'}</ul>` : ''}
      <p><a href="/">Заметки</a></p>`)
  },

  // отменить приглашение: ссылка гаснет
  'POST /team/revoke': async (req, res) => {
    const me = await resident(req)
    if (!me) return redirect(res, '/')
    await me.revokeInvite((await form(req)).id)
    redirect(res, '/team')
  },

  // выписать человека: его ключи и сессии в этой квартире гаснут сразу
  'POST /team/remove': async (req, res) => {
    const me = await resident(req)
    if (!me) return redirect(res, '/')
    await me.acl.roles((await form(req)).account, null)
    redirect(res, '/team')
  },

  // мой профиль: имя человека видят соседи по квартире — в «Команде» и в подписях заметок
  'GET /profile': async (req, res) => {
    const me = await resident(req)
    if (!me) return redirect(res, '/')
    const self = (await me.acl.people()).find((p) => p.account === me.account)   // себя жилец видит всегда
    page(res, `<h1>Мой профиль</h1>
      <form method="post" action="/profile"><input name="name" value="${esc(self?.name ?? '')}" placeholder="как вас зовут"> <button>Сохранить</button></form>
      <p><a href="/">Заметки</a></p>`)
  },

  // сменить своё имя: оно одно на аккаунт и меняется сразу во всех квартирах человека
  'POST /profile': async (req, res) => {
    const me = await resident(req)
    if (!me) return redirect(res, '/')
    await me.changeName((await form(req)).name)
    redirect(res, '/profile')
  },

  // новая компания: квартира и приглашение хозяину — зовёт консьерж
  'POST /companies': async (req, res) => {
    const { name, email } = await form(req)
    await db.createTenant(name)                                              // имя занято — отказ exists
    const flat = await db.in(name)                                           // консьерж в новой квартире
    await flat.acl.grant({ everyone: true, read: 'member' })                 // все жильцы видят команду: имена и роли
    await flat.acl.grant({ role: 'staff', read: 'Note', write: 'Note' })     // сотрудники читают и пишут заметки
    await flat.invite({ email: email.trim().toLowerCase() }, ['owner'])      // письмо хозяину — почтальону
    page(res, `<p>Компания «${esc(name)}» создана. Приглашение отправлено на ${esc(email)}.</p>`)
  },

  // страница приглашения: только смотрит
  'GET /invite/': async (_req, res, token) => {
    const inv = await db.invitation(token)
    if (inv.status !== 'active') {
      const why = { expired: 'срок приглашения вышел', revoked: 'приглашение отменено', used: 'приглашение уже принято — войдите' }[inv.status]
      return page(res, loginForms(why), 410)
    }
    page(res, `<h1>${inv.from ? `${esc(inv.from.name)} зовёт вас` : 'Вас зовут'} в «${esc(inv.tenantName)}»</h1>
      <p>Приглашение для ${esc(inv.to.address)}, роли: ${esc(inv.roles.join(', '))}.</p>
      <form method="post" action="/invite/${esc(token)}">
        ${inv.hasAccount ? '' : '<input name="name" placeholder="как вас зовут (можно позже)"> '}
        <input name="password" type="password" placeholder="пароль (можно не задавать)"> <button>Принять</button>
      </form>
      ${inv.hasAccount ? '' : '<p>Без имени коллеги увидят вас как «без имени». Задать его можно позже — на странице «Мой профиль».</p>'}`)
  },

  // принять приглашение: аккаунт, прописка, сессия — и сразу cookie
  'POST /invite/': async (req, res, token) => {
    const { name, password } = await form(req)
    // имя и пароль — по желанию: без name имя нового аккаунта пустое, без password человек входит кодом
    const me = await db.accept(token, { ...(password ? { password } : {}), ...(name?.trim() ? { name: name.trim() } : {}) })
    redirect(res, '/', setCookie(me.token!))
  },

  // вход паролем: пароль сам выбирает квартиру
  'POST /login': async (req, res) => {
    const { email, password } = await form(req)
    const me = await db.open({ email: email.trim().toLowerCase(), password })
    redirect(res, '/', setCookie(me.token!))
  },

  // вход кодом, шаг 1: код уходит почтальону; ответ одинаков, есть такой адрес или нет
  'POST /code': async (req, res) => {
    const email = (await form(req)).email.trim().toLowerCase()
    await db.requestCode({ email })
    page(res, `<p>Если адрес ${esc(email)} есть в доме, на него отправлен код.</p>
      <form method="post" action="/code/enter"><input type="hidden" name="email" value="${esc(email)}">
        <input name="code" placeholder="код из письма"> <button>Войти</button></form>`)
  },

  // вход кодом, шаг 2: одна квартира — входим; несколько — показываем список
  'POST /code/enter': async (req, res) => {
    const { email, code, tenant } = await form(req)
    const tenants = tenant ? [] : await db.tenantsOf({ email, code })           // код не гасится
    if (tenants.length > 1) {
      return page(res, `<h2>В какую квартиру войти?</h2>
        <form method="post" action="/code/enter"><input type="hidden" name="email" value="${esc(email)}"><input type="hidden" name="code" value="${esc(code)}">
          ${tenants.map((t) => `<label><input type="radio" name="tenant" value="${esc(t.id)}" required> ${esc(t.name)}</label><br>`).join('')}
          <button>Войти</button></form>`)
    }
    const me = await db.open({ email, code, ...(tenant ? { tenant } : {}) })    // успех гасит код
    redirect(res, '/', setCookie(me.token!))
  },

  // запись заметки: права проверяет база
  'POST /notes': async (req, res) => {
    const me = await resident(req)
    if (!me) return redirect(res, '/')
    await me.Note().create({ text: (await form(req)).text }).rows()
    redirect(res, '/')
  },

  // позвать сотрудника: право выдать роль staff проверяет матрица
  'POST /invites': async (req, res) => {
    const me = await resident(req)
    if (!me) return redirect(res, '/')
    await me.invite({ email: (await form(req)).email.trim().toLowerCase() }, ['staff'])
    redirect(res, '/team')
  },

  // выход: сессия погашена, cookie стёрта
  'POST /logout': async (req, res) => {
    await (await resident(req))?.close()
    redirect(res, '/', dropCookie)
  },
}

// ---------- отказы letopis → понятный ответ ----------
function refuse(res: ServerResponse, e: unknown) {
  if (!(e instanceof LetopisError)) {
    console.error(e)
    return page(res, '<p>Ошибка сервиса.</p>', 500)
  }
  const relogin = e.key === 'sql-access.bind_denied'                        // нужен недавний вход: смена имени, ключей, контакта
  const text: Record<string, string> = {
    auth_failed: e.key?.startsWith('api.invite') ? 'Приглашение не действует. Попросите прислать новое.' : 'Почта, пароль или код не подошли.',
    acl_denied: relogin ? 'Для этого действия войдите заново: паролем или кодом.' : 'Недостаточно прав.',
    exists: e.key === 'sql-access.tenant_exists' ? 'Компания с таким названием уже есть. Выберите другое название.'
      : e.key === 'sql-access.already_member' ? 'Этот человек уже в команде.' : 'Такая запись уже есть.',
    last_owner: 'Последнего хозяина выписать нельзя.',
    invalid_data: e.key === 'api.password_reused' ? 'Этот пароль уже открывает другую вашу квартиру. Задайте другой.'
      : e.key === 'sql-access.name_args' ? 'Имя — от 1 до 200 знаков.' : 'Проверьте введённые данные.',
    postman_failed: 'Не удалось отправить письмо. Повторите позже.',
  }
  const message = text[e.code] ?? `Отказ: ${e.code}`
  // не вошёл или пора войти заново — формы входа; остальное — сообщение и ссылка назад
  const body = e.code === 'auth_failed' || relogin ? loginForms(message) : `<p><b>${esc(message)}</b></p><p><a href="/">На главную</a></p>`
  page(res, body, e.code === 'acl_denied' ? 403 : 400)
}

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', SITE).pathname
  const inviteToken = /^\/invite\/([0-9a-f]+)$/.exec(path)?.[1]
  const handler = routes[`${req.method} ${inviteToken ? '/invite/' : path}`]
  if (!handler) return page(res, '<p>Нет такой страницы.</p>', 404)
  try {
    await handler(req, res, inviteToken ?? '')
  } catch (e) {
    refuse(res, e)
  }
}).listen(PORT, () => console.log(`сервис: ${SITE}`))

// остановка: закрыть пул консьержа
process.on('SIGINT', async () => { await db.close(); process.exit(0) })
```
<!-- /web.ts -->

## Разбор по частям

### Один консьерж на процесс

```ts
const db = await connect(pass, { postman })
```

- `connect` вызывают один раз при запуске. Пул соединений один — у консьержа; корни жильцов работают на нём же.
- **Почтальон** задают здесь же. Без него `invite` и `requestCode` ответят `no_postman`.
- В рецепте дом строит сам сервис (`setup` мастер-ключом) — так проще запустить. В настоящем сервисе `setup` вызывает скрипт развёртывания, а сервис получает только пропуск: `connect(process.env.LETOPIS_PASS!, { postman })` — [«Старт с нуля»](../start/).
- При остановке — `db.close()`.

### Новая компания

Квартиру заводит консьерж, и первого жильца зовёт он же: в пустой квартире звать некому. Заодно консьерж пишет правила квартиры — правила, которые завёл консьерж, жильцы не снимут:

| Правило | Зачем |
|---|---|
| `{ everyone: true, read: 'member' }` | все жильцы читают прописки: видят команду и имена авторов заметок |
| `{ role: 'staff', read: 'Note', write: 'Note' }` | сотрудники читают и пишут заметки |

Хозяину (`owner`) правила не нужны: «можно всё» ему даёт `createTenant`.

Название компании — имя квартиры, а оно в доме одно, без учёта регистра букв. «Мир» уже есть — `db.createTenant('мир')` отвечает отказом `exists` (ключ `sql-access.tenant_exists`), и ничего не создано. `refuse` показывает: «Компания с таким названием уже есть. Выберите другое название». Проверять заранее, свободно ли имя, не нужно: проверка и создание — один вызов, между ними никто не вклинится.

### Команда {#команда}

Страница нужна почти любому приложению: кто у нас работает, кого позвали, кого выписать.

```text
 me.acl.people()      люди квартиры:  [{ account, name, roles }] — по имени
 me.invites()         приглашения, которые ждут ответа:  to.address, roles, id
```

- **Люди — одним вызовом.** `me.acl.people()` отдаёт id аккаунта, имя и роли каждого. Своего справочника имён сервису не нужно.
- **Имя бывает пустым.** Человек принял приглашение без имени — в списке у него `name: ''`. Сервис пишет «без имени».
- **Кому что видно — решает матрица.** Хозяин видит всех. Остальные видят команду потому, что сервис дал всем жильцам читать прописки (`member`). Без этого правила сотрудник увидел бы в списке только себя.
- **Кнопки** «Позвать», «Отменить», «Выписать» показаны тому, кому можно выдавать роль `staff` (`me.acl.checkRole('staff')`). Это только удобство: запрещает всё равно база.
- **Отменить приглашение** — `me.revokeInvite(id)`: ссылка гаснет.
- **Выписать** — `me.acl.roles(аккаунт, null)`: ключи и сессии человека в этой квартире гаснут сразу, его следующий запрос попадёт на формы входа. Последнего хозяина выписать нельзя — `last_owner`.

**Подписи авторов** на главной берутся из того же списка. У класса `Note` в модели стоит `ownerDefault: 'actor'`, поэтому `owner` заметки — id аккаунта, который её записал; он не меняется, даже если заметку потом правит или удаляет и возвращает хозяин. Поле `author` для подписи не годится: это тот, кто правил заметку последним. Имя — из `people()`. Автора нет в списке — его выписали: сервис пишет «уже не в команде». Что значат `author` и `owner` — [«Подпись автора»](../access/#подпись-автора).

Подробно, с таблицей «кто кого видит», — [«Список людей квартиры»](../access/#список-людеи-квартиры).

### Мой профиль {#мои-профиль}

Имя человека одно на аккаунт. Его видят соседи по квартире — в «Команде» и в подписях заметок. Страница `/profile` — форма с одним полем.

```text
 await me.changeName( 'Олег Иванович' )   ──▶ { name: 'Олег Иванович' }
                            │
                            └─ от 1 до 200 знаков; пробелы по краям отбрасываются
```

- Текущее имя сервис берёт из `me.acl.people()`: себя жилец видит всегда.
- Новое имя сразу видно во всех квартирах человека: аккаунт у него один.
- **Нужен недавний вход** — не позже 10 минут после входа паролем или кодом. Сессия старше или получена по приглашению, которое принял человек с аккаунтом, — отказ `acl_denied` (ключ `sql-access.bind_denied`): сервис показывает формы входа и просит войти заново. Новичок, который только что принял приглашение, задать имя может сразу.
- Пустое имя или длиннее 200 знаков — `invalid_data` (ключ `sql-access.name_args`).

Подробно — [«Имя человека»](../auth/#имя-человека).

### Страница приглашения

- `GET /invite/<token>` вызывает только `db.invitation(token)`. Он ничего не меняет: почтовые сервисы сами открывают ссылки из писем, и приглашение не должно приниматься от этого.
- **`from` бывает пустым.** Когда зовёт консьерж — как здесь при создании компании, — поля `from` в ответе нет: страница пишет «Вас зовут в …». Когда зовёт жилец, `from` — `{ account, name }`, и страница пишет «Аня зовёт вас в …». У звавшего без имени `from.name` — пустая строка.
- **Адрес приходит под маской.** `to.address` в ответе `db.invitation()` — `a***@mir.ru`, а не полный адрес: ссылку мог открыть посторонний. Полный адрес страница не узнает и узнавать не должна.
- `status` решает, что показать: `active` — форму, остальное — «приглашение не действует».
- `hasAccount` решает, спрашивать ли имя: у человека с аккаунтом имя уже есть, и `accept` его не меняет.
- `POST /invite/<token>` — `db.accept`. **Имя и пароль — по желанию.** Без пароля человек будет входить кодом. Без имени оно у нового аккаунта пустое — адрес почты именем не становится: коллеги увидят «без имени», пока человек не задаст имя сам на странице «Мой профиль».
- Ответ `accept` — корень квартиры: его `token` сразу кладём в cookie, человек уже вошёл.

### Вход паролем

`db.open({ email, password })`. Квартиру не спрашиваем: пароль сам её выбирает — у человека в двух компаниях пароли разные.

### Вход кодом и выбор квартиры

1. `POST /code` — `db.requestCode({ email })`. Ответ страницы одинаков, есть такой адрес или нет: так посторонний не узнает, чьи адреса есть в сервисе.
2. `POST /code/enter` без квартиры — `db.tenantsOf({ email, code })`. Код при этом не гаснет.
3. Квартира одна — сразу `db.open({ email, code })`. Несколько — показываем список, форма присылает тот же код и выбранный `tenant` (id квартиры).
4. `db.open({ email, code, tenant })` — вход; код погашен.

Код между шагами лежит в скрытом поле формы. Это нормально: без него форма бесполезна, а живёт он 10 минут и гаснет после входа.

### Сессия в cookie

- Токен сессии — `me.token`. Кладём в cookie `sid` с `HttpOnly` (скрипты страницы его не прочтут) и `SameSite=Lax` (чужой сайт его не пришлёт). На HTTPS добавьте `Secure`.
- Каждый запрос начинается с `resident(req)`: `db.resume(токен)` отдаёт корень квартиры жильца. Аккаунт и квартиру помнит сессия — из адреса и полей формы их не берём.
- Сессия погашена, истекла, жилец выписан — `db.resume` отвечает `auth_failed`: показываем формы входа.
- Корень после запроса **не закрываем**: `me.close()` — это выход.

### Права

Сервис сам ничего не проверяет. Заметку пишет `me.Note().create(…)` — база решает, можно ли. Форму «Позвать сотрудника» на странице «Команда» показываем тому, кому матрица разрешает выдать роль `staff` (`me.acl.checkRole('staff')`), но это только удобство: запрещает всё равно база, отказом `acl_denied`.

### Выход

`me.close()` гасит сессию, cookie стираем (`Max-Age=0`). «Выйти на всех устройствах» — `me.closeAll()`.

### Отказы

Функция `refuse` превращает отказ letopis в ответ для человека. Программа смотрит на `err.code`, уточняет по `err.key`:

| `err.code` | Когда | Что показать |
|---|---|---|
| `auth_failed` | неверный пароль или код; приглашение не действует | «не подошло» — без подробностей |
| `acl_denied` | матрица не разрешает; для смены имени нужен недавний вход (`sql-access.bind_denied`) | «недостаточно прав»; «войдите заново» и формы входа |
| `exists` | название компании занято (`sql-access.tenant_exists`); человек уже в команде (`sql-access.already_member`) | «выберите другое название»; «этот человек уже в команде» |
| `last_owner` | выписывают последнего хозяина | «последнего хозяина выписать нельзя» |
| `invalid_data` | пароль совпал с паролем другой квартиры (`api.password_reused`); имя пустое или длиннее 200 знаков (`sql-access.name_args`); неверные данные | «задайте другой пароль»; «имя — от 1 до 200 знаков»; «проверьте введённые данные» |
| `postman_failed` | письмо не ушло | «повторите позже» |

Все коды — [«Ошибки»](../errors/).

## Чего в рецепте нет

Рецепт учебный. Настоящему сервису нужны ещё:

- **Настоящий почтальон**: отправка письма или СМС вместо `console.log`.
- **Ограничение частоты**: сколько раз в минуту можно просить код и создавать компании. Библиотека частоту не ограничивает.
- **Защита форм от подделки запроса (CSRF)**: `SameSite=Lax` закрывает основное, для важных действий добавляют токен формы.
- **HTTPS и `Secure` у cookie.**
- **Проверка почты**: приведите адрес к одному виду (рецепт убирает пробелы и приводит к строчным буквам) и проверьте, что это адрес.
- **Второй фактор**: если жилец включил TOTP, `db.open` ответит `api.totp_required` — форма должна спросить код: [«Вход и ключи»](../auth/#второи-фактор-totp).
- **Дом строит скрипт развёртывания**, а не сам сервис.

## Подводные камни

- **Страница приглашения не принимает сама.** `GET` — только `db.invitation`; `db.accept` — по кнопке.
- **Токен приглашения и токен сессии — разные вещи.** Первый приходит в ссылке и гаснет при принятии; второй лежит в cookie.
- **Не закрывайте корень после запроса.** `me.close()` погасит сессию человека.
- **Не открывайте консьержа на каждый запрос.** Один `connect` на процесс.
- **Квартиру не берут из запроса.** Её знает сессия: `me.tenant`, `me.tenantName`.
- **Имя может быть пустым.** Его задают по желанию при принятии приглашения. Везде, где показываете имя, держите запасную подпись.
- **Список квартир — только после кода.** Не показывайте его по одной почте.
- **Сессия из принятого приглашения у человека с аккаунтом — не «недавний вход».** Править ключи и контакт он сможет после входа паролем или кодом.

## Что дальше

- Человек живёт в двух квартирах — рецепт [«Несколько квартир»](./rooms).
- Задачи без человека: рассылки, отчёты, очистка — рецепт [«Фоновые задачи консьержа»](./background).
- Те же приёмы в больших сервисах — [сервисы-примеры](../services/).
