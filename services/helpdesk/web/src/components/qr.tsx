import { renderSVG } from 'uqr';

/** QR-код адреса otpauth:// — его сканирует приложение-аутентификатор. Рисуется в браузере, без внешних сервисов. */
export function Qr({ text, size = 176 }: { text: string; size?: number }) {
  const src = `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(text, { border: 2 }))}`;
  return <img src={src} width={size} height={size} alt="QR-код для приложения-аутентификатора" className="rounded-md bg-white p-1" />;
}
