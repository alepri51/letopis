// Блок shadcnblocks «changelog1», доработан для документов: лента версий документа (номер версии, время,
// что сделано, причина, изменённые поля), компактные отступы, без демо-данных и картинок с CDN.
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";

export interface ChangelogEntry {
  date: string;
  title: string;
  version?: string;
  description?: string;
  items?: string[];
  body?: React.ReactNode;
}

interface Changelog1Props {
  heading?: string;
  description?: string;
  entries: ChangelogEntry[];
  className?: string;
}

const Changelog1 = ({ heading, description, entries, className }: Changelog1Props) => (
  <section className={cn("py-2", className)}>
    {(heading || description) && (
      <div className="mb-4">
        {heading && <h2 className="mb-1 text-lg font-bold tracking-tight">{heading}</h2>}
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
    )}
    <div className="space-y-5">
      {entries.map((entry, index) => (
        <div key={index} className="relative flex flex-col gap-2 md:flex-row md:gap-6" data-version={entry.version}>
          <div className="flex h-min w-40 shrink-0 items-center gap-2">
            {entry.version && <Badge variant="secondary" className="text-xs">{entry.version}</Badge>}
            <span className="text-xs font-medium text-muted-foreground">{entry.date}</span>
          </div>
          <div className="flex flex-col">
            <h3 className="text-sm leading-tight font-semibold text-foreground/90">{entry.title}</h3>
            {entry.description && <p className="text-sm text-muted-foreground">{entry.description}</p>}
            {entry.items && entry.items.length > 0 && (
              <ul className="mt-1 ml-4 space-y-0.5 text-sm text-muted-foreground">
                {entry.items.map((item, i) => <li key={i} className="list-disc">{item}</li>)}
              </ul>
            )}
            {entry.body}
          </div>
        </div>
      ))}
    </div>
  </section>
);

export { Changelog1 };
