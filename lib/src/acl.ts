/**
 * db.acl — решения прав для приложения (план, §2.8, этап 5, п. 7). Сами права применяет база
 * (политики RLS по плану прав, 50-acl.sql); эти вызовы отвечают «можно ли» заранее — для интерфейса
 * и эндпоинтов приложения. Правила — строки Resource и rule (группа → объект, allow | deny, вес);
 * решение — ровно одно правило с наибольшим весом, при равном весе запрет сильнее, нет правил — запрет.
 */
import { removed } from './errors.js';
import type { Executor } from './tx.js';

export type AclOp = 'READ' | 'WRITE' | 'DELETE';

/** Решение по эндпоинту API. */
export interface AclDecision {
  allow: boolean;
  /** Победившее правило: id, группа и объект (alias ресурсов), вес, разрешение. */
  rule?: { id: string; group: string; object: string; weight: number; permission: 'allow' | 'deny' };
  /** Код и сообщение запрещающего правила (поля code, message строки rule). */
  code?: number;
  message?: string;
}

/** Решение по операции над классом: разрешено и, если есть, условие на строки (шаблон колонок). */
export interface AclDataDecision {
  allow: boolean;
  filter?: Record<string, unknown>;
}

export interface AclApi {
  /** Может ли актор вызвать эндпоинт (ресурсы категории API; правила System и арендатора). */
  check(endpoint: string): Promise<AclDecision>;
  /** Решение операции над классом для актора: allow и условие на строки (filter). */
  checkData(className: string, op: AclOp): Promise<AclDataDecision>;
}

export function makeAcl(S: string, exec: Executor): AclApi {
  const api: AclApi = {
    async check(endpoint) {
      const [r] = await exec.run((q) => q.unsafe(`select ${S}.acl_check($1) as d`, [endpoint]), { read: true });
      return r.d as AclDecision;
    },
    async checkData(className, op) {
      const [r] = await exec.run((q) => q.unsafe(`select ${S}.acl_check_data($1, $2) as d`, [className, op]), { read: true });
      return r.d as AclDataDecision;
    },
  };
  return new Proxy(api, {
    get(t, p, r) {
      if (p === 'reload') throw removed('db.acl.reload()', 'права обновляются сами: база применяет действующие правила');
      return Reflect.get(t, p, r);
    },
  });
}
