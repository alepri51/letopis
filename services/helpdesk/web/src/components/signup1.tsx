// Блок shadcnblocks «signup1», доработан для helpdesk: регистрация компании (название, руководитель, email,
// пароль с повтором), отправка, текст ошибки; локальный логотип и переход ко входу без перезагрузки.
import { useState } from "react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface SignupValues { company: string; name: string; login: string; password: string }

interface Signup1Props {
  heading?: string;
  logo: { src: string; alt: string; title?: string };
  buttonText?: string;
  signupText?: string;
  loginText?: string;
  error?: string;
  onLogin: () => void;
  onSubmit: (values: SignupValues) => void;
  className?: string;
}

const Signup1 = ({
  heading = "Регистрация компании",
  logo,
  buttonText = "Создать компанию",
  signupText = "Уже есть вход?",
  loginText = "Войти",
  error,
  onLogin,
  onSubmit,
  className,
}: Signup1Props) => {
  const [v, setV] = useState<SignupValues & { confirm: string }>({ company: "", name: "", login: "", password: "", confirm: "" });
  const [mismatch, setMismatch] = useState(false);
  const field = (k: keyof typeof v) => ({ value: v[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value }) });
  return (
    <section className={cn("min-h-screen bg-muted", className)}>
      <div className="flex min-h-screen items-center justify-center py-10">
        <div className="flex flex-col items-center gap-6 lg:justify-start">
          <img src={logo.src} alt={logo.alt} title={logo.title} className="h-10 dark:invert" />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (v.password !== v.confirm) { setMismatch(true); return; }
              setMismatch(false);
              onSubmit({ company: v.company, name: v.name, login: v.login, password: v.password });
            }}
            className="flex w-full max-w-sm min-w-sm flex-col items-center gap-y-4 rounded-md border border-muted bg-background px-6 py-8 shadow-md"
          >
            {heading && <h1 className="text-xl font-semibold">{heading}</h1>}
            <Input placeholder="Название компании" aria-label="Название компании" className="text-sm" required {...field("company")} />
            <Input placeholder="Ваше имя" aria-label="Ваше имя" className="text-sm" required {...field("name")} />
            <Input type="email" placeholder="Email" aria-label="Email" autoComplete="username" className="text-sm" required {...field("login")} />
            <Input type="password" placeholder="Пароль" aria-label="Пароль" autoComplete="new-password" className="text-sm" required minLength={8} {...field("password")} />
            <Input type="password" placeholder="Повторите пароль" aria-label="Повторите пароль" autoComplete="new-password" className="text-sm" required {...field("confirm")} />
            {(mismatch || error) && <p role="alert" className="text-sm text-destructive">{mismatch ? "Пароли не совпадают" : error}</p>}
            <Button type="submit" className="w-full">{buttonText}</Button>
          </form>
          <div className="flex justify-center gap-1 text-sm text-muted-foreground">
            <p>{signupText}</p>
            <button type="button" onClick={onLogin} className="font-medium text-primary hover:underline">{loginText}</button>
          </div>
        </div>
      </div>
    </section>
  );
};

export { Signup1 };
