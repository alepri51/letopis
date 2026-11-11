/**
 * Архив старых договоров фирмы — строки первой заливки с историей (letopis load --initial --with-history): три
 * контрагента и двенадцать договоров, у каждого договора четыре версии из прежней системы ($rev и время $at в 2025
 * году). Концы — по внешним id ($ext) внутри заливки. Только данные: файл берёт подготовка дома (src/setup.mjs).
 */

/** Исполнитель версий архива в журнале (agent). */
export const ARCHIVE_AGENT = 'перенос архива';

/** Строки NDJSON заливки: у каждой — класс ($class). */
export function archiveRows() {
  const day = (n) => new Date(Date.UTC(2025, 0, 1) + n * 86_400_000).toISOString();
  const people = [['Ольга Иванова', '4510 123456', '+7 900 111-22-33'], ['ООО «Склад и Ко»', '7701 000001', '+7 495 000-00-01'], ['Пётр Смирнов', '4511 654321', '+7 900 444-55-66']];
  const rows = people.map(([name, passport, phone], i) => ({ $class: 'Party', $ext: `party-${i + 1}`, $rev: 1, $at: day(0), name, passport, phone }));
  for (let k = 1; k <= 12; k++) {
    const base = { $class: 'Contract', number: `А-2025-${String(k).padStart(2, '0')}`, title: `Архивный договор №${k}`, body: 'Перенесён из прежней системы',
      signedBy: 'архив', archived: true, Party: { $ext: `party-${(k % 3) + 1}` } };
    // версии одного договора — по возрастанию времени: $at растёт вместе с $rev
    for (let v = 1; v <= 4; v++) rows.push({ ...base, amount: 50_000 + k * 1000 + v * 500, $rev: v, $at: day((k - 1) * 20 + (v - 1) * 5) });
  }
  return rows;
}
