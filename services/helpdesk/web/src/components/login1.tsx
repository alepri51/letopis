// Блок shadcnblocks «login1», доработан для helpdesk: поля задаёт экран (пароль, код из письма, код TOTP),
// отправка, текст ошибки, места над и под формой; локальный логотип (без CDN — стенд работает без интернета).
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface LoginField {
  name: string;
  type?: string;
  placeholder: string;
  autoComplete?: string;
  inputMode?: "numeric" | "email" | "text";
}

interface Login1Props {
  heading?: string;
  hint?: ReactNode;
  error?: string;
  buttonText?: string;
  fields: LoginField[];
  above?: ReactNode;
  below?: ReactNode;
  onSubmit: (values: Record<string, string>) => void;
}

export const LOGO = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#18181b"/><path d="M18 14h8v30h20v8H18z" fill="#fff"/><circle cx="44" cy="22" r="6" fill="#a1a1aa"/></svg>',
)}`;

const Login1 = ({ heading = "Вход", hint, error, buttonText = "Войти", fields, above, below, onSubmit }: Login1Props) => {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <section className="min-h-screen bg-muted">
      <div className="flex min-h-screen items-center justify-center py-10">
        <form
          onSubmit={(e) => { e.preventDefault(); onSubmit(values); }}
          className="flex w-full max-w-sm flex-col items-center gap-y-6 rounded-md border border-muted bg-background px-6 py-10 shadow-md"
        >
          <div className="flex flex-col items-center gap-y-2">
            <img src={LOGO} alt="letopis" title="letopis" className="h-10 dark:invert" />
            {heading && <h1 className="text-xl font-semibold">{heading}</h1>}
            {hint && <div className="text-center text-xs text-muted-foreground">{hint}</div>}
          </div>
          {above}
          <div className="flex w-full flex-col gap-6">
            <div className="flex flex-col gap-2">
              {fields.map((f) => (
                <Input key={f.name} name={f.name} type={f.type ?? "text"} placeholder={f.placeholder} aria-label={f.placeholder}
                  autoComplete={f.autoComplete} inputMode={f.inputMode} value={values[f.name] ?? ""} required
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />
              ))}
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full">{buttonText}</Button>
          </div>
          {below}
        </form>
      </div>
    </section>
  );
};

export { Login1 };
