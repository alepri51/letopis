import { connect, totpCode } from 'letopis';
import { example } from '../../kit/example.ts';

let keyId: string, key: string, secret: string;

export default example({
  title: 'Вход: пароль, ключ API, одноразовый код, TOTP, внешняя учётная запись',
  summary:
    'Все способы входа хранятся в таблице secret: пароль — хэшем, ключ и код — хэшем, сессия — хэшем токена. ' +
    'Проверяет их сервис приложения (он подключён по ключу сервиса), а при успехе выдаёт сессию пользователя.',
  tables: ['secret'],
  covers: [
    'auth.verifyPassword', 'auth.setPassword', 'auth.issueApiKey', 'auth.verifyApiKey', 'auth.revokeCredential',
    'auth.issueOtp', 'auth.verifyOtp', 'auth.enrollTotp', 'auth.verifyTotp', 'auth.totpEnabled', 'auth.link', 'auth.lookup',
    'auth.sessionFor', 'export.totpCode', 'nuance.login-case-insensitive', 'nuance.password-change-revokes',
  ],
  steps: [
    {
      title: 'Пароль: верный, неверный, другой регистр',
      text: 'Неверный пароль — `null`, без подсказки, есть ли такой логин. Идентификатор сравнивается без учёта регистра.',
      run: async ({ svc, user }) => ({
        'верный': !!(await svc.auth.verifyPassword({ identifier: user.login, password: user.password })),
        'неверный': await svc.auth.verifyPassword({ identifier: user.login, password: 'не тот' }),
        'ЗАГЛАВНЫМИ': !!(await svc.auth.verifyPassword({ identifier: user.login.toUpperCase(), password: user.password })),
      }),
    },
    {
      title: 'Смена пароля завершает остальные сессии',
      text: 'Новый пароль хранится хэшем scrypt; сессии Анны завершены (в `secret` у них заполнена колонка «погашен»), старый пароль больше не подходит.',
      run: async ({ svc, up, user }) => {
        await svc.auth.setPassword({ account: up.tenant!.user!, identifier: user.login, password: 'Новый-пароль-2026', confirmed: true });
        return { 'старый пароль': await svc.auth.verifyPassword({ identifier: user.login, password: user.password }) };
      },
    },
    {
      title: 'Ключ API для интеграции',
      text: 'Ключ отдаётся один раз — в базе только его хэш. По ключу входит программа, а не человек.',
      run: async ({ svc, up }) => {
        ({ key, id: keyId } = await svc.auth.issueApiKey({ account: up.tenant!.user!, name: 'интеграция' }));
        const viaKey = await svc.auth.verifyApiKey(key);
        return { 'вход по ключу': !!viaKey };
      },
    },
    {
      title: 'Отозвать ключ',
      run: async ({ svc }) => {
        await svc.auth.revokeCredential(keyId);
        return { 'вход по отозванному ключу': await svc.auth.verifyApiKey(key) };
      },
    },
    {
      title: 'Одноразовый код (OTP)',
      text: '`issueOtp` возвращает код сервису, а отправить его письмом или СМС сервис должен сам. После успешной проверки код больше не действует.',
      run: async ({ svc, up, user }) => {
        const { code } = await svc.auth.issueOtp({ account: up.tenant!.user!, identifier: user.login, ttl: 300 });
        const first = await svc.auth.verifyOtp({ identifier: user.login, code });
        const again = await svc.auth.verifyOtp({ identifier: user.login, code });
        return { 'первый раз': !!first, 'тот же код снова': again };
      },
    },
    {
      title: 'Свой вид кода и уборка: maintain() удаляет использованные коды',
      text:
        'Коду можно дать свой вид — например `OTP_RESET` для сброса пароля. Использованные, истёкшие и исчерпавшие ' +
        'попытки коды больше не нужны: `maintain()` удаляет их из таблицы `secret` — и вида `OTP`, и своих видов ' +
        '`OTP_<ИМЯ>`. Здесь удалены оба использованных кода: из прошлого шага и этот.',
      run: async ({ svc, up, user, dsn, schema }) => {
        const { code } = await svc.auth.issueOtp({ account: up.tenant!.user!, identifier: user.login, kind: 'OTP_RESET', ttl: 300 });
        const ok = !!(await svc.auth.verifyOtp({ identifier: user.login, code, kind: 'OTP_RESET' }));
        const adm = await connect({ dsn: dsn.admin, schema, allowBypassRls: true }); // скрыть
        const report = await adm.maintain();
        await adm.close(); // скрыть
        return { 'код OTP_RESET принят': ok, 'удалено кодов': report.codes };
      },
    },
    {
      title: 'Второй фактор: TOTP',
      text: '`enrollTotp` даёт секрет и адрес `otpauth://` для QR-кода; первая верная проверка включает второй фактор. `totpCode` — помощник для тестов.',
      run: async ({ svc, up }) => {
        ({ secret } = await svc.auth.enrollTotp({ account: up.tenant!.user!, issuer: 'Ромашка' }));
        const ok = await svc.auth.verifyTotp({ account: up.tenant!.user!, code: totpCode(secret) });
        return { 'код принят': ok, 'TOTP включён': await svc.auth.totpEnabled(up.tenant!.user!) };
      },
    },
    {
      title: 'Внешняя учётная запись и вход по ней',
      text: 'Telegram, Google, корпоративный вход (SSO): их токен проверяет сервис, а база хранит привязку к учётной записи. `lookup` — вход по этой привязке.',
      run: async ({ svc, up }) => {
        await svc.auth.link({ account: up.tenant!.user!, kind: 'TELEGRAM', identifier: '100500', confirmed: true });
        return { 'вход через Telegram': !!(await svc.auth.lookup({ kind: 'TELEGRAM', identifier: '100500' })) };
      },
    },
    {
      title: 'Короткая сессия для другого процесса',
      run: async ({ svc, up, connect, dsn, schema }) => {
        const token = await svc.auth.sessionFor(up.tenant!.user!, { ttl: 600 });
        const other = await connect({ dsn: dsn.app, schema, token });
        return { tenant: other.tenant };
      },
    },
  ],
});
