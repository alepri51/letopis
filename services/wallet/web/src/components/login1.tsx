// Блок shadcnblocks «login1», доработан для сервисов-примеров: управляемые поля, отправка, текст ошибки,
// локальный логотип (без CDN — стенд работает без интернета).
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Login1Props {
  heading?: string;
  hint?: string;
  error?: string;
  buttonText?: string;
  onSubmit: (login: string, password: string) => void;
}

export const LOGO = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#18181b"/><path d="M18 14h8v30h20v8H18z" fill="#fff"/><circle cx="44" cy="22" r="6" fill="#a1a1aa"/></svg>',
)}`;

const Login1 = ({ heading = "Вход", hint, error, buttonText = "Войти", onSubmit }: Login1Props) => {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  return (
    <section className="h-screen bg-muted">
      <div className="flex h-full items-center justify-center">
        <form
          onSubmit={(e) => { e.preventDefault(); onSubmit(login, password); }}
          className="flex w-full max-w-sm flex-col items-center gap-y-8 rounded-md border border-muted bg-background px-6 py-12 shadow-md"
        >
          <div className="flex flex-col items-center gap-y-2">
            <img src={LOGO} alt="letopis" title="letopis" className="h-10 dark:invert" />
            {heading && <h1 className="text-xl font-semibold">{heading}</h1>}
            {hint && <p className="text-center text-xs text-muted-foreground">{hint}</p>}
          </div>
          <div className="flex w-full flex-col gap-8">
            <div className="flex flex-col gap-2">
              <Input type="email" placeholder="Email" aria-label="Email" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required />
              <Input type="password" placeholder="Пароль" aria-label="Пароль" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full">{buttonText}</Button>
          </div>
        </form>
      </div>
    </section>
  );
};

export { Login1 };
