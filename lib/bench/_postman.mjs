/**
 * Почтальон-заглушка замеров и скриптов пакета (L6-spec §10): письма складываются в массив, токен приглашения и код
 * входа берутся оттуда. Почтальон только доставляет: токены и коды придумывает, хранит и проверяет библиотека; в
 * приложении здесь отправка письма или СМС.
 *
 * Модуль без импортов: его берут и замеры (через _core.mjs, исходники lib/src), и живой прогон
 * scripts/check-package.mjs (установленный пакет). Один помощник на всю обвязку lib — не копировать.
 *
 *   const db = await connect(pass, { postman });
 *   const me = await inviteAndAccept(db, await db.in('Мир'), { email: 'anna@x.ru' }, ['owner'], { password: 'p1' });
 *   const again = await db.open({ email: 'anna@x.ru', password: 'p1' });
 *   const byCode = await db.open({ email: 'anna@x.ru', code: await loginCode(db, { email: 'anna@x.ru' }) });
 */

/** Письма, которые почтальон получил и которые ещё не забрали (takeLetter убирает письмо из массива). */
export const mail = [];

/** Почтальон для connect(pass, { postman }): кладёт письмо { to, message } в mail. */
export const postman = async (letter) => {
  mail.push(letter);
};

/**
 * Последнее письмо вида kind ('invite' | 'code' | 'contact') на адрес контакта — его message; письмо уходит из mail
 * (долгий прогон просит коды каждую секунду: массив не растёт). Письма нет — ошибка.
 */
export function takeLetter(address, kind) {
  const want = String(address).trim().toLowerCase();
  for (let i = mail.length - 1; i >= 0; i--) {
    const l = mail[i];
    if (l.message.kind === kind && String(l.to.address).toLowerCase() === want) {
      mail.splice(i, 1);
      return l.message;
    }
  }
  throw new Error(`почтальон: письма ${kind} на ${address} нет`);
}

/** Адрес контакта в любой форме: { email } | { phone } | { telegram } | { kind, address }. */
export const addressOf = (contact) => ('address' in contact ? contact.address : Object.values(contact)[0]);

/**
 * Позвать и принять: who — тот, кто зовёт (жилец или консьерж в квартире, db.in), house — консьерж, чей accept
 * принимает приглашение (у него почтальон не нужен). opts — { password?, name?, ttl? } для accept. Ответ — корень
 * квартиры принявшего (me).
 */
export async function inviteAndAccept(house, who, contact, roles, opts = {}) {
  await who.invite(contact, roles);
  const m = takeLetter(addressOf(contact), 'invite');
  return house.accept(m.token, opts);
}

/** Код входа: db.requestCode(contact) и код из письма. house — консьерж с этим почтальоном. */
export async function loginCode(house, contact, opts) {
  await house.requestCode(contact, ...(opts ? [opts] : []));
  return takeLetter(addressOf(contact), 'code').code;
}
