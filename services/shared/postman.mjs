/**
 * Почтальон-заглушка сервисов-примеров.
 *
 * letopis сам писем не отправляет: ссылку-приглашение (me.invite), код входа (db.requestCode) и код смены контакта
 * (me.changeContact) консьерж отдаёт почтальону — функции приложения из connect(pass, { postman }). Настоящий сервис
 * здесь отправил бы письмо или СМС на letter.to.address. Заглушка ничего не отправляет: письмо ложится в ящик
 * (letters — его показывает страница «Демо-почта» helpdesk) и одной строкой печатается в лог сервиса — без токена и
 * кода, только кому и что.
 *
 * Только встроенные модули Node: файл общий для четырёх сервисов (из src/*.mjs — '../../shared/postman.mjs').
 */
const KIND_RU = { invite: 'приглашение', code: 'код входа', contact: 'код смены контакта' };

/**
 * Почтальон сервиса. service — имя в строке лога; compose(letter) — тема, текст и ссылка письма (по умолчанию — простой
 * текст); quiet(address) — служебный адрес: письмо в ящик и лог не идёт, его забирает сам сервис (lastLetter);
 * keep — сколько писем держать в ящике.
 */
export function createPostman({ service, compose = plain, quiet = () => false, keep = 50, log = true } = {}) {
  /** Ящик: новые письма первыми. */
  const letters = [];
  /** Последние письма на служебные адреса — их забирает сам сервис. */
  const inner = [];
  let seq = 0;

  /** Почтальон для connect(pass, { postman }). В настоящем сервисе здесь отправка письма или СМС. */
  async function postman(letter) {
    const { to, message } = letter;
    if (quiet(to.address)) {
      inner.unshift(letter);
      inner.length = Math.min(inner.length, keep);
      return;
    }
    letters.unshift({ id: ++seq, at: new Date().toISOString(), to: to.address, kind: message.kind, message, ...compose(letter) });
    letters.length = Math.min(letters.length, keep);
    if (log) console.log(`${service}: почтальон-заглушка — ${KIND_RU[message.kind] ?? message.kind} для ${to.address} (письмо не отправлено, лежит в демо-почте)`);
  }

  /** Последнее письмо на адрес: 'invite' — приглашение (message.token), 'code' — код входа, 'contact' — код смены контакта. */
  function lastLetter(address, kind) {
    const a = address.toLowerCase();
    const found = inner.find((l) => l.to.address.toLowerCase() === a && l.message.kind === kind)
      ?? letters.find((l) => l.to.toLowerCase() === a && l.kind === kind);
    if (!found) throw new Error(`${service}: письма ${kind} на ${address} нет`);
    return found.message;
  }

  /**
   * Позвать и принять — для засева демо-жильцов (src/setup.mjs) и служебных аккаунтов: who зовёт с ролями, почтальон
   * получает ссылку, сервис тут же принимает её (house.accept). Живой человек принимает приглашение сам — по ссылке.
   */
  async function inviteAndAccept(house, who, contact, roles, opts = {}) {
    await who.invite(contact, roles);
    const address = 'address' in contact ? contact.address : String(Object.values(contact)[0]);
    return house.accept(lastLetter(address, 'invite').token, opts);
  }

  return { postman, letters, lastLetter, inviteAndAccept };
}

/** Письмо по умолчанию: тема и текст без оформления. */
function plain({ message: m }) {
  if (m.kind === 'invite') {
    return { subject: `Приглашение в «${m.tenantName}»`, text: `${m.from?.name ?? 'Сервис'} приглашает вас (роли: ${m.roles.join(', ') || '—'}). Токен ссылки: ${m.token}` };
  }
  return { subject: m.kind === 'code' ? 'Код входа' : 'Код смены контакта', text: `Ваш код: ${m.code}. Действует до ${m.expiresAt}.` };
}
