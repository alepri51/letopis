/**
 * Почтальон-заглушка примеров: письма со ссылками и кодами он не отправляет, а складывает в ящик `mail`. Секретов он
 * не придумывает и не проверяет — только доставляет: токен ссылки и код выпускает и проверяет библиотека.
 * Консьерж получает почтальона при подключении — `connect(pass, { postman })` — и отдаёт ему каждое письмо:
 * приглашение (`me.invite`), код входа (`db.requestCode`), код смены контакта (`me.changeContact`). В ответах этих
 * вызовов токена и кода нет, поэтому пример берёт их из ящика (`lastLetter`).
 */
import type { Contact, House, Letter, Room } from 'letopis';

/** Ящик почтальона-заглушки: все письма, которые консьерж ему отдал. */
export const mail: Letter[] = [];

/** Почтальон: в настоящем приложении здесь отправка письма или СМС на letter.to.address. */
export async function postman(letter: Letter): Promise<void> {
  mail.push(letter);
}

/** Последнее письмо на адрес: 'invite' — приглашение (token ссылки), 'code' — код входа, 'contact' — код смены контакта. */
export function lastLetter<K extends Letter['message']['kind']>(address: string, kind: K): Extract<Letter['message'], { kind: K }> {
  const letter = mail.findLast((l) => l.to.address.toLowerCase() === address.toLowerCase() && l.message.kind === kind);
  if (!letter) throw new Error(`письма ${kind} на ${address} нет`);
  return letter.message as Extract<Letter['message'], { kind: K }>;
}

/**
 * Позвать и принять: who (жилец или консьерж в квартире) зовёт человека с ролями, почтальон кладёт ссылку в ящик,
 * человек открывает её и принимает приглашение — db.accept(token). Ответ — корень квартиры нового жильца.
 */
export async function inviteAndAccept(db: House, who: Room, contact: Contact, roles: string[],
  opts: { password?: string; name?: string } = {}): Promise<Room> {
  await who.invite(contact, roles);
  const address = 'address' in contact ? contact.address : String(Object.values(contact)[0]);
  return db.accept(lastLetter(address, 'invite').token, opts);
}
