-- letopis 1.0 — время и эксплуатация (план, §2.11, этап 6, п. 2–4, 6–8).
--
-- Функции владельца проверяют всё сами, сами пишут журнал и сами посылают сигнал (§2.7):
--   restore()        — последний снимок удалённого объекта новой версией (вид restore), с проверкой
--                      по текущему описанию класса; id прежний;
--   purge()          — стирание истории удалённого объекта: на место версии 1 встаёт запись purge
--                      с числом стёртых версий и последним хэшем;
--   trim_history()   — обрезка истории до момента: на место версии 1 встаёт запись trim со временем
--                      прежней версии 1, числом стёртых версий и хэшем последней из них;
--   rekey(), rekey_class() — новое значение ключа объекта или новый ключ класса: строка с новым id,
--                      перевод ссылок (move_row), журнал связывает id колонкой moved;
--   account_purge()  — удаление аккаунта с данными его арендатора (предохранители 0.21);
--   reset()          — сброс sessions | tenant | all (флаг allow_reset, право letopis.reset,
--                      подтверждение именем схемы); первая запись журнала после сброса — reset;
--   maintain()       — истёкшие сессии и коды, одна пачка прореживания журнала по политике хранения;
--   verify()         — цепочки хэшей с законными разрывами (purge, trim, reset, прореживание),
--                      якорь, а с p_data — данные, концы, арендаторы, владельцы и id всех строк.
-- У id, у которого в журнале есть хоть одна запись, номер версии 1 всегда занят (этап 6, п. 3):
-- на нём держится режим existing: 'error' загрузчика.

-- Умолчание политики хранения — константа установки up({ history }); null — хранить всё.
create or replace function @SCHEMA@.history_default() returns jsonb
language sql immutable parallel safe
return nullif((@HISTORY_DEFAULT@)::jsonb, 'null'::jsonb);

-- Действующая политика хранения класса по развёрнутому описанию: своя (объект), умолчание установки
-- для классов с журналом, null — хранить всё. Системные классы не прореживаются (§2.11).
create or replace function @SCHEMA@.history_policy(p_res jsonb) returns jsonb
language sql immutable parallel safe
return case
  when (p_res->>'name') = any (array['Class', 'Account', 'member', 'Resource', 'rule']) then null
  when jsonb_typeof(p_res->'history') = 'object' then p_res->'history'
  when p_res->'history' = 'true'::jsonb then @SCHEMA@.history_default()
end;

-- Срок яруса политики: интервал или бесконечность ('forever').
create or replace function @SCHEMA@.history_iv(p_term text) returns interval
language sql immutable parallel safe
return case when p_term = 'forever' then 'infinity'::interval else p_term::interval end;

-- Конец последнего яруса политики: после него история удаляется (бесконечность — хранится всегда).
create or replace function @SCHEMA@.history_horizon(p_pol jsonb) returns interval
language sql immutable parallel safe
return (select @SCHEMA@.history_iv(p_pol->>t.n) from unnest(array['all', 'daily', 'weekly', 'monthly', 'yearly']) with ordinality t(n, i)
        where p_pol ? t.n order by t.i desc limit 1);

-- Нужна ли политике версия (§2.11): в ярусе all — все; дальше — последняя в своём периоде текущего
-- яруса или любого более крупного (недели не вкладываются в месяцы); старше последнего яруса со
-- сроком — не нужна. Время — местное в поясе политики: p_lt — версии, p_nowl — «сейчас», p_nlt —
-- следующей версии того же id (null — следующей нет). Ярус — календарно: моложе срока, если позже
-- «сейчас» минус срок (месяц — месяц, а не 30 дней).
create or replace function @SCHEMA@.history_keep(p_pol jsonb, p_lt timestamp, p_nowl timestamp, p_nlt timestamp) returns boolean
language plpgsql immutable parallel safe
as $$
declare
  tiers text[] := array['all', 'daily', 'weekly', 'monthly', 'yearly'];
  units text[] := array[null, 'day', 'week', 'month', 'year'];
  my int;
  i int;
begin
  for i in 1 .. 5 loop
    continue when not (p_pol ? tiers[i]);
    if p_lt > p_nowl - @SCHEMA@.history_iv(p_pol->>tiers[i]) then
      my := i;
      exit;
    end if;
  end loop;
  if my is null then
    return false;
  end if;
  if my = 1 or p_nlt is null then
    return true;
  end if;
  for i in my .. 5 loop
    continue when not (p_pol ? tiers[i]);
    if date_trunc(units[i], p_nlt) <> date_trunc(units[i], p_lt) then
      return true;
    end if;
  end loop;
  return false;
end $$;

-- Роль подключения — администраторская (суперпользователь или может стать владельцем): verify,
-- reset и maintain доступны ей и без сессии (CLI, обслуживание по расписанию).
create or replace function @SCHEMA@.admin_role() returns boolean
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return exists (select 1 from pg_roles where rolname = session_user and rolsuper)
    or pg_has_role(session_user, '@OWNER_NAME@', 'SET');

-- Право letopis.* актора сессии по правилам System или администраторская роль подключения.
create or replace function @SCHEMA@.letopis_allowed(p_endpoint text) returns boolean
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  if @SCHEMA@.admin_role() then
    return true;
  end if;
  select * into c from @SCHEMA@.ctx();
  return c.account is not null
     and coalesce((@SCHEMA@.acl_api_for(c.tenant, c.categories, c.roles, p_endpoint, true)->>'allow')::boolean, false);
end $$;

-- Срок действующей сессии (кэш результатов не отдаёт ответы истёкшей сессии); нет сессии — null.
create or replace function @SCHEMA@.session_expires() returns timestamptz
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
begin
  select * into c from @SCHEMA@.ctx();
  if c.session is null then
    return null;
  end if;
  return (select s.expires_at from @SCHEMA@.secret s where s.id = c.session);
end $$;

-- ========================= сигналы (план 1.1, §2.2) =========================

-- Режим сигналов установки — константа up({ signals }): class, tenant, opaque, none.
create or replace function @SCHEMA@.signal_mode() returns text
language sql immutable parallel safe
return '@SIGNALS@';

-- Ключ сигналов (hex) для сессии с правом letopis.signals по правилам System (сид выдаёт его сервисам) или
-- администраторского подключения: по нему процесс узнаёт в нагрузке токены классов и арендаторов.
-- Отдаётся производный ключ HMAC(ключ строки KEY, 'letopis:signals'), а не сам ключ: им подписаны пропуска прав.
create or replace function @SCHEMA@.signal_key() returns text
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
begin
  if not @SCHEMA@.letopis_allowed('letopis.signals') then
    perform @SCHEMA@.lt_fail('acl_denied', 'нет права letopis.signals');
  end if;
  return (select encode(@PGCRYPTO@.hmac(convert_to('letopis:signals', 'UTF8'), s.material, 'sha256'), 'hex')
          from @SCHEMA@.secret s where s.id = '@SYSTEM@'::uuid and s.kind = 'KEY');
end $$;

-- Отпечаток описаний классов, видимых сессии (свои и System): в режиме сигналов none реестр библиотеки
-- сверяет его раз в 5 секунд вместо сигнала Class. Под RLS — тот же набор строк, что читает реестр.
create or replace function @SCHEMA@.class_stamp() returns text
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return (select encode(sha256(convert_to(coalesce(string_agg(e.id::text || ':' || e.rev::text, ',' order by e.id), ''), 'UTF8')), 'hex')
        from @SCHEMA@.entity e where e.class = 'Class' and e.tenant in (@SCHEMA@.ctx_tenant(), '@SYSTEM@'::uuid));

-- ========================= restore, purge, обрезка истории =========================

-- Последняя запись журнала id под блокировкой, если она видна актору в его арендаторе: параллельные
-- restore, purge, обрезка и воскрешение (trg_entity_bi берёт ту же блокировку) упорядочены.
create or replace function @SCHEMA@.last_version_visible(p_id uuid, p_tenant uuid, p_acl jsonb) returns @SCHEMA@.log
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  l @SCHEMA@.log;
begin
  -- арендатор id неизменен: блокируется только запись своего арендатора, чужую вызов не задерживает
  -- и по ожиданию не обнаружит (итоговое ревью безопасности)
  select x.* into l from @SCHEMA@.log x where x.id = p_id and x.tenant = p_tenant order by x.rev desc limit 1 for update;
  if l.id is null or l.tenant <> p_tenant or l.op in ('purge', 'reset')
     or not @SCHEMA@.row_visible(l.tenant, l.class, l.id, l.owner, l.tags, l.data, l.links, p_tenant, (p_acl->>'account')::uuid, p_acl->'plan') then
    perform @SCHEMA@.lt_fail('target_not_found', 'цель не найдена');
  end if;
  return l;
end $$;

-- Восстановление удалённого объекта (этап 6, п. 2): последний снимок новой версией с видом restore.
-- Снимок перепроверяется по текущему описанию класса (данные, концы с видимостью целей, ключ), право
-- WRITE — на восстановленные значения. id прежний, в том числе у класса без ключа.
create or replace function @SCHEMA@.restore(p_id uuid) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  rd jsonb;
  l @SCHEMA@.log;
  cls @SCHEMA@.entity;
  res jsonb;
  d jsonb;
  bad jsonb;
  lk record;
  kid uuid;
  own uuid;
  ts timestamptz;
  n @SCHEMA@.entity;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('no_session', 'нет действующей сессии');
  end if;
  rd := @SCHEMA@.acl_actor('READ');
  l := @SCHEMA@.last_version_visible(p_id, c.tenant, rd);
  if l.op <> 'delete' or exists (select 1 from @SCHEMA@.entity e where e.id = p_id) then
    perform @SCHEMA@.lt_fail('not_deleted', 'объект не удалён: restore — только для удалённых');
  end if;
  if l.class = 'Class' then
    perform @SCHEMA@.lt_fail('invalid_class', 'описание класса восстанавливается созданием строки Class');
  end if;
  cls := @SCHEMA@.class_row(l.class, l.tenant);
  if cls.id is null then
    perform @SCHEMA@.lt_fail('invalid_class', format('класс %s не найден', l.class));
  end if;
  perform @SCHEMA@.family_lock(cls, false);
  cls := @SCHEMA@.class_row(l.class, l.tenant);
  res := cls.data->'resolved';
  if coalesce((res->>'abstract')::boolean, false) then
    perform @SCHEMA@.lt_fail('invalid_class', format('класс %s абстрактный', l.class));
  end if;
  if res ? 'derivedBy' then
    perform @SCHEMA@.lt_fail('derived_class', format('класс %s производный: его строки пишет проектор %s', l.class, res->>'derivedBy'));
  end if;
  d := @SCHEMA@.apply_defaults(res->'schema', l.data);
  bad := @SCHEMA@.validate_data(res->'rules', cls.validator, res->'vars', d);
  if bad <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('invalid_data', format('данные не проходят описание класса %s', l.class), jsonb_build_object('issues', bad));
  end if;
  select * into lk from @SCHEMA@.check_links(res, l.links, l.tenant, true, rd);
  if lk.code is not null then
    perform @SCHEMA@.lt_fail(lk.code, lk.msg);
  end if;
  kid := @SCHEMA@.key_id(res, l.class, l.tenant, d, lk.links);
  if kid is not null and kid <> p_id then
    perform @SCHEMA@.lt_fail('id_mismatch', format('ключ класса %s изменился: id объекта не равен v5 от ключа', l.class), jsonb_build_object('expected', kid));
  end if;
  -- владелец — существующий аккаунт или арендатор
  own := l.owner;
  if own <> l.tenant and not exists (select 1 from @SCHEMA@.entity a where a.id = own and a.class = 'Account' and a.tenant = '@SYSTEM@'::uuid) then
    own := l.tenant;
  end if;
  if not @SCHEMA@.acl_row_ok(@SCHEMA@.acl_plan('WRITE'), l.class, p_id, own, l.tenant, l.tags, d, lk.links) then
    perform @SCHEMA@.lt_fail('acl_denied', format('нет права WRITE на строку класса %s', l.class));
  end if;
  ts := greatest(@SCHEMA@.now_ts(), l.at + interval '1 microsecond');
  insert into @SCHEMA@.entity (id, rev, class, cv, tenant, owner, links, data, tags, at, created_at, author, agent, op, reason, moved, prev_hash, validator)
  values (p_id, l.rev + 1, l.class, cls.rev, l.tenant, own, lk.links, d, l.tags, ts, ts, c.author, c.agent, 'restore',
          nullif(current_setting('letopis.reason', true), ''), null, l.hash, null)
  returning * into n;
  -- агрегатные поля восстановленной цели триггер после вставки посчитал из живых источников в эту же версию, а не
  -- взял из надгробия (план 1.1, §2.4): в журнал идёт строка таблицы
  select x.* into n from @SCHEMA@.entity x where x.id = p_id;
  perform @SCHEMA@.log_version(n);
  if l.class in ('rule', 'Resource', 'member', 'Account') then
    perform @SCHEMA@.acl_bump();
  end if;
  return p_id;
end $$;

-- Стирание истории удалённого объекта (этап 6, п. 3): без p_confirm — превью (число версий), с ним —
-- все версии удаляются, а на место версии 1 встаёт запись purge с числом стёртых версий и хэшем
-- последней. Право DELETE на класс по последнему снимку. История системных классов — аудит прав и
-- схемы: её не стирают.
-- Проектор источника ещё не прочёл версию (p_tx, p_seq) строки арендатора p_tenant класса из p_classes (ревью
-- безопасности №3, №5 — purge; хвост ревью №3 — обрезка истории). Проектор касается арендатора, у которого есть его
-- производный класс (derivedBy — имя проектора): брошенный проектор с удалёнными производными классами не держит.
-- Курсор «tx:seq~снимок»: транзакции, видимые в снимке, учла перестройка. Чекпоинт без from (до 1.2.0) касается всех
-- классов.
create or replace function @SCHEMA@.projector_behind(p_tenant uuid, p_classes text[], p_tx xid8, p_seq bigint) returns boolean
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return exists (select 1 from @SCHEMA@.secret s
               cross join lateral (select split_part(s.meta->>'cursor', '~', 1) as head,
                                          nullif(split_part(s.meta->>'cursor', '~', 2), '') as snap) k
               where s.kind = 'PROJECTOR' and s.account = '@SYSTEM@'::uuid and s.deleted_at is null
                 and coalesce(s.meta->>'cursor', '') <> ''
                 and exists (select 1 from @SCHEMA@.entity x where x.class = 'Class' and x.tenant = p_tenant
                             and x.data->'resolved'->>'derivedBy' = s.ident)
                 and (not s.meta ? 'from'
                      or exists (select 1 from unnest(p_classes) c
                                 where coalesce((@SCHEMA@.class_row(c, p_tenant)).data->'resolved'->'ancestors', jsonb_build_array(c))
                                       ?| array(select jsonb_array_elements_text(s.meta->'from'))))
                 and (p_tx, p_seq) > (split_part(k.head, ':', 1)::xid8, split_part(k.head, ':', 2)::bigint)
                 and not coalesce(pg_visible_in_snapshot(p_tx, k.snap::pg_snapshot), false));

create or replace function @SCHEMA@.purge(p_id uuid, p_confirm boolean default false) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  l @SCHEMA@.log;
  n int;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('no_session', 'нет действующей сессии');
  end if;
  l := @SCHEMA@.last_version_visible(p_id, c.tenant, @SCHEMA@.acl_actor('READ'));
  if l.op <> 'delete' or exists (select 1 from @SCHEMA@.entity e where e.id = p_id) then
    perform @SCHEMA@.lt_fail('not_deleted', 'объект не удалён: purge — только для удалённых, сначала delete()');
  end if;
  if l.class in ('Class', 'Account', 'member', 'Resource', 'rule') then
    perform @SCHEMA@.lt_fail('invalid_class', 'история системных классов — аудит прав и схемы: purge недоступен');
  end if;
  if not @SCHEMA@.acl_row_ok(@SCHEMA@.acl_plan('DELETE'), l.class, l.id, l.owner, l.tenant, l.tags, l.data, l.links) then
    perform @SCHEMA@.lt_fail('acl_denied', format('нет права DELETE на класс %s', l.class));
  end if;
  -- проектор источника, чей курсор ещё не прошёл надгробие (в том числе надгробие этой транзакции), об удалении не
  -- узнал бы — вклад строки остался бы в итогах навсегда (ревью безопасности №3, №5)
  if @SCHEMA@.projector_behind(l.tenant, array[l.class], l.tx, l.seq) then
    perform @SCHEMA@.lt_fail('projector_pending', 'проектор источника ещё не прочёл удаление: purge — после его run()');
  end if;
  select count(*)::int into n from @SCHEMA@.log x where x.id = p_id;
  if not coalesce(p_confirm, false) then
    return jsonb_build_object('id', p_id, 'class', l.class, 'versions', n, 'purged', false);
  end if;
  delete from @SCHEMA@.log x where x.id = p_id;
  insert into @SCHEMA@.log (id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason, moved, prev_hash)
  values (p_id, 1, l.class, l.cv, l.tenant, l.tenant, '{}', jsonb_build_object('$purged', n, '$hash', encode(l.hash, 'hex')), '{}',
          greatest(@SCHEMA@.now_ts(), l.at + interval '1 microsecond'), coalesce(c.author, '@SYSTEM@'::uuid), c.agent, 'purge',
          nullif(current_setting('letopis.reason', true), ''), null, null);
  -- воскрешение, зафиксированное, пока purge ждал блокировку, — отказ (снимок нового оператора его видит)
  if exists (select 1 from @SCHEMA@.entity e where e.id = p_id) then
    perform @SCHEMA@.lt_fail('not_deleted', 'объект восстановлен во время purge');
  end if;
  perform @SCHEMA@.signal(array[l.class], array[l.tenant]);
  return jsonb_build_object('id', p_id, 'class', l.class, 'versions', n, 'purged', true);
end $$;

-- Обрезка истории (этап 6, п. 3; замена compact 0.21): версии строже момента p_before удаляются,
-- текущая — никогда. Время версий одного id монотонно, поэтому удаляется начало истории — и всегда
-- версия 1: на её место встаёт запись trim со временем прежней версии 1 (срез на момент знает, когда
-- объект появился), номером последней стёртой версии ($trimmed) и её хэшем ($hash) — по ним verify()
-- проверяет стык. Цели — p_ids или все объекты классов p_classes арендатора; право DELETE на каждую
-- (по последней версии). Возвращает число стёртых версий.
create or replace function @SCHEMA@.trim_history(p_ids uuid[], p_classes text[], p_before timestamptz) returns int
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  rd jsonb;
  dplan jsonb;
  r @SCHEMA@.log;
  first @SCHEMA@.log;
  nxt record;
  j int;
  h bytea;
  k int;
  total int := 0;
  classes text[] := '{}';
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('no_session', 'нет действующей сессии');
  end if;
  if p_before is null or (p_ids is null and p_classes is null) then
    perform @SCHEMA@.lt_fail('invalid_data', 'обрезка истории: нужны цели и момент');
  end if;
  rd := @SCHEMA@.acl_actor('READ');
  dplan := @SCHEMA@.acl_plan('DELETE');
  if p_ids is not null then
    -- явные цели: каждая обязана найтись
    for r in select distinct on (u.x) l.* from unnest(p_ids) u(x)
             left join lateral (select * from @SCHEMA@.log x where x.id = u.x order by x.rev desc limit 1) l on true
             order by u.x loop
      if r.id is null or r.tenant <> c.tenant or r.op in ('purge', 'reset')
         or not @SCHEMA@.row_visible(r.tenant, r.class, r.id, r.owner, r.tags, r.data, r.links, c.tenant, c.account, rd->'plan') then
        perform @SCHEMA@.lt_fail('target_not_found', 'цель не найдена');
      end if;
    end loop;
  end if;
  for r in select distinct on (l.id) l.* from @SCHEMA@.log l
           where l.tenant = c.tenant and (case when p_ids is not null then l.id = any (p_ids) else l.class = any (p_classes) end)
           order by l.id, l.rev desc loop
    continue when r.op in ('purge', 'reset')
      or not @SCHEMA@.row_visible(r.tenant, r.class, r.id, r.owner, r.tags, r.data, r.links, c.tenant, c.account, rd->'plan');
    if r.class in ('Class', 'Account', 'member', 'Resource', 'rule') then
      perform @SCHEMA@.lt_fail('invalid_class', 'история системных классов — аудит прав и схемы: обрезка недоступна');
    end if;
    if not @SCHEMA@.acl_row_ok(dplan, r.class, r.id, r.owner, r.tenant, r.tags, r.data, r.links) then
      perform @SCHEMA@.lt_fail('acl_denied', format('нет права DELETE на класс %s', r.class));
    end if;
    -- версии id под блокировкой: параллельная обрезка и прореживание ждут
    perform 1 from @SCHEMA@.log x where x.id = r.id order by x.rev for update;
    select max(x.rev) into j from @SCHEMA@.log x where x.id = r.id and x.at < p_before and x.rev < r.rev;
    continue when j is null;
    select x.* into first from @SCHEMA@.log x where x.id = r.id order by x.rev limit 1;
    -- до момента — только сама запись trim: стирать нечего
    continue when j = 1 and first.op = 'trim';
    -- проектор источника, чей курсор ещё не прошёл первую оставшуюся версию: читая её, он возьмёт прошлую версию для
    -- before, а её уже не будет — свёртка прибавила бы новую, не вычитая прежнюю (хвост ревью безопасности №3). Класс —
    -- обеих версий у стыка: строка могла уйти из семейства источников сменой класса
    select x.tx, x.seq, x.class into nxt from @SCHEMA@.log x where x.id = r.id and x.rev > j order by x.rev limit 1;
    if @SCHEMA@.projector_behind(r.tenant, array[(select x.class from @SCHEMA@.log x where x.id = r.id and x.rev = j), nxt.class],
                                 nxt.tx, nxt.seq) then
      perform @SCHEMA@.lt_fail('projector_pending', 'проектор источника ещё не прочёл версии: trimHistory — после его run()');
    end if;
    select x.hash into h from @SCHEMA@.log x where x.id = r.id and x.rev = j;
    with d as (delete from @SCHEMA@.log x where x.id = r.id and x.rev <= j returning 1)
    select count(*)::int into k from d;
    insert into @SCHEMA@.log (id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason, moved, prev_hash)
    values (r.id, 1, r.class, r.cv, r.tenant, r.tenant, '{}', jsonb_build_object('$trimmed', j, '$hash', encode(h, 'hex')), '{}',
            first.at, coalesce(c.author, '@SYSTEM@'::uuid), c.agent, 'trim', nullif(current_setting('letopis.reason', true), ''), null, null);
    -- запись trim заменяет версию 1: стёрто на одну меньше, если версия 1 была прежней записью trim
    total := total + k - case when first.op = 'trim' then 1 else 0 end;
    classes := classes || r.class;
  end loop;
  perform @SCHEMA@.signal(array_agg(d.x), array_agg(c.tenant)) from (select distinct x from unnest(classes) x) d;
  return total;
end $$;

-- ========================= смена ключа =========================

-- Новое значение ключа объекта (этап 6, п. 7): p_data сливается с данными, p_links заменяет концы
-- по ролям; новый id — v5 от нового ключа. Механизм — тот же, что у reclass(): строка с новым id,
-- перевод ссылок (рекурсивно для строк, в ключ которых входит конец), надгробие старого id со
-- ссылкой на новый. Ключ не изменился — обычная правка неключевых полей.
create or replace function @SCHEMA@.rekey(p_id uuid, p_data jsonb default null, p_links jsonb default null) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  rd jsonb;
  wplan jsonb;
  o @SCHEMA@.entity;
  cls @SCHEMA@.entity;
  res jsonb;
  d jsonb;
  bad jsonb;
  lk record;
  nid uuid;
  denied text;
  n_denied int;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('no_session', 'нет действующей сессии');
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    perform @SCHEMA@.lt_fail('isolation_level', 'смена ключа разрешена только в read committed');
  end if;
  rd := @SCHEMA@.acl_actor('READ');
  wplan := @SCHEMA@.acl_plan('WRITE');
  select x.* into o from @SCHEMA@.entity x where x.id = p_id and x.tenant = c.tenant for update;
  if o.id is null or not @SCHEMA@.row_visible(o.tenant, o.class, o.id, o.owner, o.tags, o.data, o.links, c.tenant, c.account, rd->'plan') then
    perform @SCHEMA@.lt_fail('target_not_found', 'цель не найдена');
  end if;
  if not @SCHEMA@.acl_row_ok(wplan, o.class, o.id, o.owner, o.tenant, o.tags, o.data, o.links) then
    perform @SCHEMA@.lt_fail('acl_denied', format('нет права WRITE на строку класса %s', o.class));
  end if;
  if o.class in ('Class', 'Account', 'member', 'Resource', 'rule') then
    perform @SCHEMA@.lt_fail('invalid_class', 'ключ системной строки не меняется');
  end if;
  cls := @SCHEMA@.class_row(o.class, o.tenant);
  perform @SCHEMA@.family_lock(cls, false);
  cls := @SCHEMA@.class_row(o.class, o.tenant);
  res := cls.data->'resolved';
  if res ? 'derivedBy' then
    perform @SCHEMA@.lt_fail('derived_class', format('класс %s производный: его строки пишет проектор %s', o.class, res->>'derivedBy'));
  end if;
  if jsonb_array_length(coalesce(res->'key', '[]'::jsonb)) = 0 then
    perform @SCHEMA@.lt_fail('invalid_class', format('у класса %s нет ключа: id выдаёт база, менять нечего', o.class));
  end if;
  if res ? 'aggregate' and coalesce(p_data, '{}'::jsonb) ?| @SCHEMA@.agg_fields(res) then
    perform @SCHEMA@.lt_fail('aggregate_field', format('агрегатные поля класса %s считает база — в rekey их не передают', o.class));
  end if;
  d := @SCHEMA@.apply_defaults(res->'schema', @SCHEMA@.merge(o.data, coalesce(p_data, '{}'::jsonb)));
  bad := @SCHEMA@.validate_data(res->'rules', cls.validator, res->'vars', d);
  if bad <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('invalid_data', format('данные не проходят описание класса %s', o.class), jsonb_build_object('issues', bad));
  end if;
  select * into lk from @SCHEMA@.check_links(res, o.links || coalesce(p_links, '{}'::jsonb), o.tenant, true, rd);
  if lk.code is not null then
    perform @SCHEMA@.lt_fail(lk.code, lk.msg);
  end if;
  nid := @SCHEMA@.key_id(res, o.class, o.tenant, d, lk.links);
  if not @SCHEMA@.acl_row_ok(wplan, o.class, nid, o.owner, o.tenant, o.tags, d, lk.links) then
    perform @SCHEMA@.lt_fail('acl_denied', format('нет права WRITE на класс %s', o.class));
  end if;
  if nid = o.id then
    if d is distinct from o.data or lk.links is distinct from o.links then
      perform @SCHEMA@.sys_update(o.id, d, lk.links, null, 'update');
    end if;
    return o.id;
  end if;
  -- перевод ссылок пишет ссылающиеся строки: на них тоже нужно право WRITE (глубже первого уровня — move_row); класс
  -- такой строки называется, только если актор её видит (доработки после точки Б)
  select min(x.class) filter (where @SCHEMA@.row_visible(x.tenant, x.class, x.id, x.owner, x.tags, x.data, x.links, c.tenant, c.account, rd->'plan')),
         count(*) into denied, n_denied from @SCHEMA@.entity x
  where x.ends @> array[o.id] and not @SCHEMA@.acl_row_ok(wplan, x.class, x.id, x.owner, x.tenant, x.tags, x.data, x.links);
  if n_denied > 0 then
    perform @SCHEMA@.lt_fail('acl_denied', case when denied is not null then format('нет права WRITE на ссылающиеся строки класса %s', denied)
                                                 else 'нет права WRITE на ссылающиеся строки' end);
  end if;
  perform @SCHEMA@.move_row(o, nid, o.class, d, lk.links, 'rekey', wplan);
  return nid;
end $$;

-- Новый ключ класса (этап 6, п. 7): описание класса и потомков, наследующих ключ, пересчитывается,
-- каждая строка семейства с другим id переносится на новый id (move_row). Исключительная
-- блокировка корня семейства приостанавливает запись в семейство до фиксации. Возвращает число
-- перенесённых строк класса (ссылающиеся строки с концом в ключе переносятся рекурсивно и не считаются).
create or replace function @SCHEMA@.rekey_class(p_class text, p_key jsonb) returns int
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  wplan jsonb;
  cr @SCHEMA@.entity;
  prep record;
  dsc @SCHEMA@.entity;
  classes text[];
  r @SCHEMA@.entity;
  res jsonb;
  nid uuid;
  n int := 0;
  conflicts jsonb;
  dname text;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('no_session', 'нет действующей сессии');
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    perform @SCHEMA@.lt_fail('isolation_level', 'смена ключа разрешена только в read committed');
  end if;
  wplan := @SCHEMA@.acl_plan('WRITE');
  cr := @SCHEMA@.class_row(p_class, c.tenant);
  if cr.id is null or cr.tenant <> c.tenant then
    perform @SCHEMA@.lt_fail('invalid_class', format('класс %s не найден среди классов арендатора', p_class));
  end if;
  if coalesce((cr.data->>'system')::boolean, false) then
    perform @SCHEMA@.lt_fail('invalid_class', 'ключ системного класса не меняется');
  end if;
  -- строки производного класса (и его потомков) переносит только владелец: ключ меняют в описании, а строки
  -- строит заново проектор (rebuild)
  if cr.data->'resolved' ? 'derivedBy' then
    perform @SCHEMA@.lt_fail('derived_class', format('класс %s производный: его строки пишет проектор %s', p_class, cr.data->'resolved'->>'derivedBy'));
  end if;
  -- и потомки: производный потомок непроизводного предка наследует его ключ, а его строки переносит только проектор
  -- (доработки после точки Б)
  select x.data->>'name' into dname from @SCHEMA@.entity x
  where x.class = 'Class' and x.tenant = cr.tenant and x.id <> cr.id
    and x.data->'resolved'->'ancestors' ? p_class and x.data->'resolved' ? 'derivedBy'
  order by x.data->>'name' limit 1;
  if dname is not null then
    perform @SCHEMA@.lt_fail('derived_class', format('у класса %s производный потомок %s: его строки пишет проектор', p_class, dname));
  end if;
  if not @SCHEMA@.acl_row_ok(wplan, 'Class', cr.id, cr.owner, cr.tenant, cr.tags, cr.data, cr.links) then
    perform @SCHEMA@.lt_fail('acl_denied', 'нет права WRITE на класс Class');
  end if;
  -- смена ключа проверяет все строки семейства и отвечает числом нарушающих — как ужесточение, только с правом READ без
  -- условий на все строки класса и потомков (доработки после точки Б)
  perform @SCHEMA@.class_rows_admit(p_class, cr.tenant, array['READ'], format('смена ключа класса %s', p_class));
  perform @SCHEMA@.family_lock(cr, true);
  select x.* into cr from @SCHEMA@.entity x where x.id = cr.id for update;
  select p.data, p.validator into prep from @SCHEMA@.class_prepare(cr.data || jsonb_build_object('key', p_key), cr.tenant) p;
  perform @SCHEMA@.sys_update(cr.id, prep.data, cr.links, prep.validator, 'update');
  classes := array[p_class];
  -- потомки: описание пересчитывается (каждый пересчёт — версия класса в журнале)
  for dsc in select x.* from @SCHEMA@.entity x
             where x.class = 'Class' and x.tenant = cr.tenant and x.id <> cr.id
               and x.data->'resolved'->'ancestors' ? p_class
             order by jsonb_array_length(x.data->'resolved'->'ancestors'), x.id loop
    select p.data, p.validator into prep from @SCHEMA@.class_prepare(dsc.data, dsc.tenant) p;
    if prep.data is distinct from dsc.data or prep.validator::text is distinct from dsc.validator::text then
      perform @SCHEMA@.sys_update(dsc.id, prep.data, dsc.links, prep.validator, 'update');
    end if;
    classes := classes || (dsc.data->>'name');
  end loop;
  for r in select x.* from @SCHEMA@.entity x where x.class = any (classes) and x.tenant = cr.tenant order by x.id loop
    -- строку мог уже перенести перевод ссылок (конец в её ключе): берём свежую
    select x.* into r from @SCHEMA@.entity x where x.id = r.id for update;
    continue when r.id is null;
    if not @SCHEMA@.acl_row_ok(wplan, r.class, r.id, r.owner, r.tenant, r.tags, r.data, r.links) then
      perform @SCHEMA@.lt_fail('acl_denied', format('нет права WRITE на строку класса %s', r.class));
    end if;
    res := (@SCHEMA@.class_row(r.class, r.tenant)).data->'resolved';
    nid := coalesce(@SCHEMA@.key_id(res, r.class, r.tenant, r.data, r.links), r.id);
    if nid <> r.id then
      perform @SCHEMA@.move_row(r, nid, r.class, r.data, r.links, 'rekey', wplan);
      n := n + 1;
    end if;
  end loop;
  conflicts := @SCHEMA@.family_conflicts(classes, cr.tenant, false);
  if conflicts <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('tightening_conflict', format('новому ключу класса %s не соответствуют строки', p_class),
      @SCHEMA@.visible_detail(conflicts, c.tenant));
  end if;
  perform @SCHEMA@.acl_bump();
  return n;
end $$;

-- ========================= удаление аккаунта =========================

-- Удаление аккаунта (этап 6, п. 3; accounts.purge 0.21): вызывающий — системный администратор или
-- владелец арендатора-цели (член с ролью owner); удалить себя нельзя; нельзя оставить арендатора без
-- последнего включённого владельца. Данные и журнал арендатора-цели стираются физически; в чужих
-- арендаторах членства снимаются (надгробия), владение строками переходит арендаторам (§2.10);
-- остались ссылки на аккаунт — delete_restricted. Строка Account удаляется с надгробием (история
-- аккаунтов — аудит), сессии гаснут, креды удаляются.
create or replace function @SCHEMA@.account_purge(p_account uuid) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  a @SCHEMA@.entity;
  t record;
  m @SCHEMA@.entity;
  n_rows int;
  n_log int;
  n_mem int := 0;
  n_own int := 0;
  classes text[];
  blockers jsonb;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('no_session', 'нет действующей сессии');
  end if;
  if p_account = c.account then
    perform @SCHEMA@.lt_fail('acl_denied', 'удалить себя нельзя');
  end if;
  -- право — до поиска и блокировки цели: без права ответ один (acl_denied), есть ли такой аккаунт,
  -- не видно, и чужую строку Account вызов не блокирует (итоговое ревью безопасности)
  if not (@SCHEMA@.auth_is_sysadmin() or exists (
      select 1 from @SCHEMA@.entity x
      where x.id = @SCHEMA@.v5_id(p_account, 'member', array[c.account::text, p_account::text]) and x.class = 'member'
        and x.tenant = p_account and coalesce(x.data->'roles' ? 'owner', false))) then
    perform @SCHEMA@.lt_fail('acl_denied', 'удалить аккаунт может системный администратор или владелец его арендатора');
  end if;
  select x.* into a from @SCHEMA@.entity x where x.id = p_account and x.class = 'Account' and x.tenant = '@SYSTEM@'::uuid for update;
  if a.id is null or p_account = '@SYSTEM@'::uuid then
    perform @SCHEMA@.lt_fail('target_not_found', 'аккаунт не найден');
  end if;
  -- последний владелец: в каждом чужом арендаторе, где цель — владелец, должен остаться другой
  for t in select x.tenant from @SCHEMA@.entity x
           where x.class = 'member' and x.links->>'User' = p_account::text and x.tenant <> p_account
             and coalesce(x.data->'roles' ? 'owner', false) loop
    if not exists (select 1 from @SCHEMA@.entity x
                   join @SCHEMA@.entity u on u.id = (x.links->>'User')::uuid and u.class = 'Account' and u.tenant = '@SYSTEM@'::uuid
                   where x.class = 'member' and x.tenant = t.tenant and x.links->>'User' <> p_account::text
                     and coalesce(x.data->'roles' ? 'owner', false) and coalesce((u.data->>'enabled')::boolean, true)) then
      perform @SCHEMA@.lt_fail('acl_denied', format('аккаунт — последний владелец арендатора %s', t.tenant), jsonb_build_object('tenant', t.tenant));
    end if;
  end loop;
  -- данные арендатора-цели — физически, вместе с журналом
  select coalesce(array_agg(distinct x.class), '{}') into classes from @SCHEMA@.entity x where x.tenant = p_account;
  with d as (delete from @SCHEMA@.entity x where x.tenant = p_account returning 1) select count(*)::int into n_rows from d;
  with d as (delete from @SCHEMA@.log x where x.tenant = p_account returning 1) select count(*)::int into n_log from d;
  -- членства в чужих арендаторах: надгробия; владение строками — арендаторам
  for m in select x.* from @SCHEMA@.entity x where x.class = 'member' and x.links->>'User' = p_account::text order by x.id for update loop
    delete from @SCHEMA@.entity x where x.id = m.id;
    perform @SCHEMA@.tombstone(m);
    n_mem := n_mem + 1;
  end loop;
  for t in select distinct x.tenant from @SCHEMA@.entity x where x.owner = p_account and x.owner <> x.tenant loop
    n_own := n_own + @SCHEMA@.owner_to_tenant(t.tenant, p_account);
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'class', x.class, 'tenant', x.tenant)), '[]'::jsonb) into blockers
  from (select x.id, x.class, x.tenant from @SCHEMA@.entity x where x.ends @> array[p_account] order by x.id limit 1000) x;
  if blockers <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('delete_restricted', 'на аккаунт ссылаются другие строки', @SCHEMA@.visible_detail(blockers, c.tenant));
  end if;
  delete from @SCHEMA@.entity x where x.id = p_account;
  perform @SCHEMA@.tombstone(a);
  perform @SCHEMA@.auth_kill(p_account, null);
  delete from @SCHEMA@.secret s where s.account = p_account;
  -- данные арендатора-цели — его парами; Account и member — классы прав, их сигнал сбрасывает всё
  perform @SCHEMA@.signal(classes || array['Account', 'member'],
    array(select p_account from unnest(classes)) || array['@SYSTEM@'::uuid, '@SYSTEM@'::uuid]);
  perform @SCHEMA@.acl_bump();
  return jsonb_build_object('account', p_account, 'rows', n_rows, 'versions', n_log, 'memberships', n_mem, 'owned', n_own);
end $$;

-- ========================= сброс =========================

-- Запись reset — первая запись журнала после сброса: свой id в арендаторе, класс #reset (такое имя
-- класс получить не может), вид reset.
create or replace function @SCHEMA@.reset_mark(p_tenant uuid, p_level text, p_author uuid) returns void
language sql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  insert into @SCHEMA@.log (id, rev, class, tenant, owner, links, data, tags, at, author, agent, op, reason)
  values (@SCHEMA@.v5_id(p_tenant, '#reset', array[gen_random_uuid()::text]), 1, '#reset', p_tenant, p_tenant, '{}',
          jsonb_build_object('$reset', p_level), '{}', @SCHEMA@.now_ts(), coalesce(p_author, '@SYSTEM@'::uuid), null, 'reset',
          nullif(current_setting('letopis.reason', true), ''))
$$;

-- Сброс (этап 6, п. 6): sessions — все сессии, кроме текущей; tenant — строки и журнал арендатора
-- (пачками по p_limit: done = false — вызвать ещё раз); all — всё, затем системный сид и новый
-- сервисный ключ (возвращается). Предохранители: флаг allow_reset (по умолчанию выключен — отказ
-- даже System), право letopis.reset, подтверждение именем схемы.
create or replace function @SCHEMA@.reset(p_level text, p_confirm text, p_tenant uuid default null, p_limit int default null) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  c record;
  t uuid;
  n int;
  m int;
  key text;
  held boolean;
begin
  if not @ALLOW_RESET@ then
    perform @SCHEMA@.lt_fail('reset_disabled', 'reset выключен в этой установке (up({ allowReset }))');
  end if;
  select * into c from @SCHEMA@.ctx();
  if not @SCHEMA@.letopis_allowed('letopis.reset') then
    perform @SCHEMA@.lt_fail('acl_denied', 'нет права letopis.reset');
  end if;
  if p_confirm is distinct from '@SCHEMA_NAME@' then
    perform @SCHEMA@.lt_fail('confirm_mismatch', 'подтверждение сброса — имя схемы установки');
  end if;
  case p_level
    when 'sessions' then
      with d as (delete from @SCHEMA@.secret s where s.kind = 'SESSION' and s.id is distinct from c.session returning 1)
      select count(*)::int into n from d;
      perform @SCHEMA@.reset_mark('@SYSTEM@'::uuid, p_level, c.author);
      perform @SCHEMA@.signal_raw(array['session:*']);
      return jsonb_build_object('level', p_level, 'sessions', n);
    when 'tenant' then
      t := coalesce(p_tenant, c.tenant);
      if t is null or t = '@SYSTEM@'::uuid then
        perform @SCHEMA@.lt_fail('tenant_denied', 'System сбрасывается только целиком (level all)');
      end if;
      if not exists (select 1 from @SCHEMA@.entity a where a.id = t and a.class = 'Account' and a.tenant = '@SYSTEM@'::uuid) then
        perform @SCHEMA@.lt_fail('target_not_found', 'арендатор не найден');
      end if;
      -- строки арендатора стираются пачками в любом порядке: агрегаты его целей (план 1.1, §2.4) не пересчитываются —
      -- цели уходят вместе с источниками, а промежуточный итог пачки мог бы выйти за правило класса
      held := @SCHEMA@.agg_hold_begin('off');
      with d as (delete from @SCHEMA@.entity x where x.id in (
          select y.id from @SCHEMA@.entity y where y.tenant = t limit coalesce(p_limit, 2147483647)) returning 1)
      select count(*)::int into n from d;
      if held then
        perform @SCHEMA@.agg_hold_end(false);
      end if;
      with d as (delete from @SCHEMA@.log x where x.seq in (
          select y.seq from @SCHEMA@.log y where y.tenant = t limit coalesce(p_limit, 2147483647)) returning 1)
      select count(*)::int into m from d;
      if exists (select 1 from @SCHEMA@.entity y where y.tenant = t) or exists (select 1 from @SCHEMA@.log y where y.tenant = t) then
        return jsonb_build_object('level', p_level, 'tenant', t, 'rows', n, 'versions', m, 'done', false);
      end if;
      perform @SCHEMA@.reset_mark(t, p_level, c.author);
      perform @SCHEMA@.signal_raw(array['*']);
      perform @SCHEMA@.acl_bump();
      return jsonb_build_object('level', p_level, 'tenant', t, 'rows', n, 'versions', m, 'done', true);
    when 'all' then
      truncate @SCHEMA@.entity, @SCHEMA@.log, @SCHEMA@.secret;
      perform @SCHEMA@.reset_mark('@SYSTEM@'::uuid, p_level, c.author);
      perform @SCHEMA@.seed_system();
      key := 'lts_' || encode(@PGCRYPTO@.gen_random_bytes(32), 'hex');
      perform @SCHEMA@.bootstrap_service(key);
      perform @SCHEMA@.signal_raw(array['*', 'session:*']);
      return jsonb_build_object('level', p_level, 'serviceKey', key);
    else
      perform @SCHEMA@.lt_fail('invalid_data', format('уровень сброса %s: sessions, tenant или all', p_level));
  end case;
  return null;
end $$;

-- ========================= обслуживание =========================

-- Одна пачка прореживания журнала (§2.11): версии, которые не нужны действующей политике хранения
-- своего класса. Не трогаются версия 1, текущая и версии особых видов (create, delete, reclass,
-- rekey, restore, purge, reset, trim); история удалённого объекта, надгробие которого старше
-- последнего яруса со сроком, стирается целиком. Пачка — до 100 объектов после курсора (meta
-- строки ключа: участки по порядку id), не больше p_limit версий; объект, не вошедший целиком,
-- достаётся следующей пачке. Курсор дошёл до конца — сбрасывается (more = false).
create or replace function @SCHEMA@.thin_batch(p_now timestamptz, p_limit int) returns jsonb
language plpgsql volatile
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  cur uuid;
  ids uuid[];
  vid uuid[];
  vrev int[];
  total int;
  k int;
  nxt uuid;
  more boolean;
begin
  select (s.meta->>'thin')::uuid into cur from @SCHEMA@.secret s where s.id = '@SYSTEM@'::uuid for update;
  -- умолчание установки прореживает журнал: verify() и после его снятия считает такие пропуски законными
  if @SCHEMA@.history_default() is not null then
    update @SCHEMA@.secret s set meta = s.meta || '{"default_policy": true}' where s.id = '@SYSTEM@'::uuid and not (s.meta ? 'default_policy');
  end if;
  with pol as (
    select x.data->>'name' as cls, x.tenant as ct, @SCHEMA@.history_policy(x.data->'resolved') as p
    from @SCHEMA@.entity x where x.class = 'Class'
  )
  select array_agg(q.id order by q.id) into ids from (
    select distinct l.id from @SCHEMA@.log l
    join pol on pol.p is not null and pol.cls = l.class and (pol.ct = l.tenant or pol.ct = '@SYSTEM@'::uuid)
    where l.at < p_now - @SCHEMA@.history_iv(pol.p->>'all') and (cur is null or l.id > cur)
    order by l.id limit 100) q;
  if ids is null then
    update @SCHEMA@.secret s set meta = s.meta - 'thin' where s.id = '@SYSTEM@'::uuid;
    return jsonb_build_object('thinned', 0, 'more', false);
  end if;
  with pol as (
    select x.data->>'name' as cls, x.tenant as ct, @SCHEMA@.history_policy(x.data->'resolved') as p
    from @SCHEMA@.entity x where x.class = 'Class'
  ), v as (
    select l.id, l.rev, l.at, l.op, pol.p, coalesce(pol.p->>'tz', 'UTC') as tz,
           max(l.rev) over (partition by l.id) as last_rev,
           first_value(l.op) over (partition by l.id order by l.rev desc) as last_op,
           first_value(l.at) over (partition by l.id order by l.rev desc) as last_at,
           lead(l.at) over (partition by l.id order by l.rev) as next_at
    from @SCHEMA@.log l
    join pol on pol.p is not null and pol.cls = l.class and (pol.ct = l.tenant or pol.ct = '@SYSTEM@'::uuid)
    where l.id = any (ids)
  )
  select array_agg(v.id order by v.id, v.rev), array_agg(v.rev order by v.id, v.rev) into vid, vrev
  from v
  where (v.last_op = 'delete' and timezone(v.tz, v.last_at) <= timezone(v.tz, p_now) - @SCHEMA@.history_horizon(v.p))
     or (v.rev <> 1 and v.rev <> v.last_rev
         and v.op not in ('create', 'delete', 'reclass', 'rekey', 'restore', 'purge', 'reset', 'trim')
         and not @SCHEMA@.history_keep(v.p, timezone(v.tz, v.at), timezone(v.tz, p_now), timezone(v.tz, v.next_at)));
  total := coalesce(cardinality(vid), 0);
  k := least(total, p_limit);
  if k > 0 then
    delete from @SCHEMA@.log l using unnest(vid[1:k], vrev[1:k]) u(id, rev) where l.id = u.id and l.rev = u.rev;
  end if;
  if total > p_limit then
    -- объект на границе пачки — снова в следующей
    nxt := vid[p_limit + 1];
    cur := (select x from unnest(ids) x where x < nxt order by x desc limit 1);
    more := true;
  elsif cardinality(ids) = 100 then
    cur := ids[100];
    more := true;
  else
    cur := null;
    more := false;
  end if;
  update @SCHEMA@.secret s set meta = case when cur is null then s.meta - 'thin' else s.meta || jsonb_build_object('thin', cur) end
  where s.id = '@SYSTEM@'::uuid;
  return jsonb_build_object('thinned', k, 'more', more);
end $$;

-- Обслуживание (этап 6, п. 8): истёкшие и погашенные сессии и одноразовые коды, одна пачка
-- прореживания журнала, заполнение очереди сигналов. Вызывает системный администратор, роль с
-- правом letopis.maintain или администраторское подключение. p_now — момент «сейчас» для
-- прореживания, только при allow_reset (тесты): иначе одним вызовом можно было бы проредить всю историю.
create or replace function @SCHEMA@.maintain(p_now timestamptz default null, p_limit int default 10000) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  ts timestamptz := clock_timestamp();
  s int;
  o int;
begin
  if not @SCHEMA@.letopis_allowed('letopis.maintain') then
    perform @SCHEMA@.lt_fail('acl_denied', 'нет права letopis.maintain');
  end if;
  -- один исполнитель: строка-замок до конца транзакции пачки (lock_try) — посторонняя роль её не займёт (ревью
  -- безопасности №3, №2); занята — null, обслуживание продолжит держатель
  if not @SCHEMA@.lock_try('@SCHEMA_NAME@:maintain') then
    return null;
  end if;
  if p_now is not null then
    if not @ALLOW_RESET@ then
      perform @SCHEMA@.lt_fail('reset_disabled', 'maintain(now) — только в установке с allow_reset');
    end if;
    ts := p_now;
  end if;
  with d as (delete from @SCHEMA@.secret x where x.kind = 'SESSION'
             and (x.deleted_at is not null or x.expires_at <= clock_timestamp()) returning 1)
  select count(*)::int into s from d;
  with d as (delete from @SCHEMA@.secret x where x.kind = 'OTP'
             and (x.deleted_at is not null or x.expires_at <= clock_timestamp()) returning 1)
  select count(*)::int into o from d;
  return jsonb_build_object('sessions', s, 'codes', o, 'queue', pg_notification_queue_usage())
    || @SCHEMA@.thin_batch(ts, greatest(coalesce(p_limit, 10000), 1));
end $$;

-- ========================= verify =========================

-- Проверка цепочек хэшей (этап 1, п. 11; этап 6, п. 4): номера версий подряд с 1, prev_hash каждой
-- версии равен хэшу предыдущей, строка entity совпадает с последней версией журнала. Законные
-- разрывы: после записи trim (стык — по $trimmed и $hash), запись purge и reset — начало цепочки,
-- прореживание — пропуск после версии старше яруса all класса, у которого есть (или была) политика
-- хранения — своя или умолчание установки (метка default_policy в строке ключа). p_data — ещё и все строки: данные по проверке класса, концы (цель существует, её
-- арендатор — тот же или System, класс принимается концом), арендатор и владелец существуют, id
-- класса с ключом — v5 от ключа, агрегатные поля равны итогу живых источников (план 1.1, §2.4; ремонт —
-- rebuild_aggregates). Возвращает находки и якорь — хэш всех голов цепочек. Только
-- системный администратор (право letopis.verify) или администраторское подключение.
create or replace function @SCHEMA@.verify(p_data boolean default false) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  issues jsonb;
  data_issues jsonb := '[]'::jsonb;
  anchor text;
  ts timestamptz := clock_timestamp();
begin
  if not @SCHEMA@.letopis_allowed('letopis.verify') then
    perform @SCHEMA@.lt_fail('acl_denied', 'verify доступен только системному администратору');
  end if;
  with pol as (
    -- классы с политикой хранения сейчас или в истории строки Class; ярус all — действующий или сутки
    select x.data->>'name' as cls, x.tenant as ct,
           coalesce(@SCHEMA@.history_iv(@SCHEMA@.history_policy(x.data->'resolved')->>'all'), interval '1 day') as all_iv
    from @SCHEMA@.entity x
    where x.class = 'Class'
      and (@SCHEMA@.history_policy(x.data->'resolved') is not null
           or exists (select 1 from @SCHEMA@.log h where h.id = x.id and jsonb_typeof(h.data->'resolved'->'history') = 'object')
           or (x.data->'resolved'->'history' = 'true'::jsonb and x.data->>'name' not in ('Class', 'Account', 'member', 'Resource', 'rule')
               and exists (select 1 from @SCHEMA@.secret k where k.id = '@SYSTEM@'::uuid and k.meta ? 'default_policy')))
  ), chain as (
    select l.id, l.rev, l.class, l.tenant, l.prev_hash,
           lag(l.rev) over w as prev_rev, lag(l.hash) over w as prev_h, lag(l.op) over w as prev_op,
           lag(l.data) over w as prev_data, lag(l.at) over w as prev_at
    from @SCHEMA@.log l
    window w as (partition by l.id order by l.rev)
  ), exp as (
    select chain.*,
           case when prev_op = 'trim' then (prev_data->>'$trimmed')::int + 1 else prev_rev + 1 end as want_rev,
           case when prev_op = 'trim' then decode(prev_data->>'$hash', 'hex') else prev_h end as want_hash
    from chain where prev_rev is not null
  ), found as (
    select jsonb_build_object('id', id, 'rev', rev, 'problem', 'цепочка начинается не с версии 1') as f
      from chain where prev_rev is null and (rev <> 1 or prev_hash is not null)
    union all
    select jsonb_build_object('id', id, 'rev', prev_rev, 'problem', 'хэш версии не совпадает с prev_hash следующей')
      from exp where rev = want_rev and prev_hash is distinct from want_hash
    union all
    select jsonb_build_object('id', id, 'rev', want_rev, 'problem', 'разрыв: нет версий ' || want_rev || '…' || (rev - 1))
      from exp
      where rev > want_rev
        and not exists (select 1 from pol where pol.cls = exp.class and (pol.ct = exp.tenant or pol.ct = '@SYSTEM@'::uuid)
                                            and exp.prev_at < ts - pol.all_iv)
    union all
    select jsonb_build_object('id', id, 'rev', rev, 'problem', 'номер версии меньше ожидаемого после обрезки')
      from exp where rev < want_rev
    union all
    select jsonb_build_object('id', e.id, 'rev', e.rev, 'problem', 'строка entity не совпадает с последней версией журнала')
      from @SCHEMA@.entity e
      left join lateral (select l.hash, l.rev from @SCHEMA@.log l where l.id = e.id order by l.rev desc limit 1) l on true
      where coalesce((@SCHEMA@.class_row(e.class, e.tenant)).data->'resolved'->>'history', 'true') <> 'false'
        and (l.hash is distinct from e.hash or l.rev is distinct from e.rev)
  )
  select coalesce(jsonb_agg(f), '[]'::jsonb) into issues from found;
  if coalesce(p_data, false) then
    with cls as (
      select x.tenant as ct, x.data->>'name' as name, x.data->'resolved' as res, x.validator
      from @SCHEMA@.entity x where x.class = 'Class'
    ), rows_ as (
      select e.*, k.res, k.validator as vld
      from @SCHEMA@.entity e
      left join lateral (select cls.res, cls.validator from cls where cls.name = e.class and cls.ct in (e.tenant, '@SYSTEM@'::uuid)
                         order by cls.ct = '@SYSTEM@'::uuid limit 1) k on true
    ), found as (
      select jsonb_build_object('id', r.id, 'class', r.class, 'problem', 'класс строки не найден или абстрактный') as f
        from rows_ r where r.class <> 'Class' and (r.res is null or coalesce((r.res->>'abstract')::boolean, false))
      union all
      select jsonb_build_object('id', r.id, 'class', r.class, 'problem', 'данные не проходят описание класса',
                                'issues', @SCHEMA@.validate_data(r.res->'rules', r.vld, r.res->'vars', r.data))
        from rows_ r where r.class <> 'Class' and r.res is not null
          and @SCHEMA@.validate_data(r.res->'rules', r.vld, r.res->'vars', r.data) <> '[]'::jsonb
      union all
      select jsonb_build_object('id', r.id, 'class', r.class, 'problem', 'id не равен v5 от ключа класса')
        from rows_ r where r.res is not null and jsonb_array_length(coalesce(r.res->'key', '[]'::jsonb)) > 0
          and @SCHEMA@.key_id(r.res, r.class, r.tenant, r.data, r.links) is distinct from r.id
      union all
      select jsonb_build_object('id', r.id, 'class', r.class, 'problem', 'арендатор строки не существует', 'tenant', r.tenant)
        from rows_ r
        where r.tenant <> '@SYSTEM@'::uuid
          and not exists (select 1 from @SCHEMA@.entity a where a.id = r.tenant and a.class = 'Account' and a.tenant = '@SYSTEM@'::uuid)
      union all
      select jsonb_build_object('id', r.id, 'class', r.class, 'problem', 'владелец строки не существует', 'owner', r.owner)
        from rows_ r
        where r.owner <> r.tenant
          and not exists (select 1 from @SCHEMA@.entity a where a.id = r.owner and a.class = 'Account' and a.tenant = '@SYSTEM@'::uuid)
      union all
      select jsonb_build_object('id', p.id, 'class', p.class, 'problem', 'цель конца не найдена', 'role', p.role, 'target', p.tid)
        from (select r.id, r.class, r.tenant, r.res, k.key as role,
                     (case jsonb_typeof(k.value) when 'array' then a.value else k.value end #>> '{}')::uuid as tid
              from rows_ r
              cross join lateral jsonb_each(r.links) k
              left join lateral jsonb_array_elements(case jsonb_typeof(k.value) when 'array' then k.value else '[]'::jsonb end) a on true
              where jsonb_typeof(k.value) = 'string' or a.value is not null) p
        left join @SCHEMA@.entity t on t.id = p.tid
        where t.id is null
           or t.tenant not in (p.tenant, '@SYSTEM@'::uuid)
           or (p.res is not null and not (
                 @SCHEMA@.class_set(p.res->'ends'->p.role->'class') ? t.class
                 or @SCHEMA@.class_set(p.res->'ends'->p.role->'class') ?| coalesce(
                      (select array(select jsonb_array_elements_text(k2.data->'resolved'->'ancestors'))
                       from @SCHEMA@.entity k2
                       where k2.class = 'Class' and k2.data->>'name' = t.class and k2.tenant in (t.tenant, '@SYSTEM@'::uuid)
                       order by k2.tenant = '@SYSTEM@'::uuid limit 1), '{}')))
      union all
      select jsonb_build_object('id', a.id, 'class', a.class, 'field', a.field, 'stored', a.stored, 'expected', a.expected,
               'problem', format('агрегат %s не равен итогу живых источников: в строке %s, по источникам %s — ремонт rebuildAggregates',
                 a.field, coalesce(a.stored::text, 'нет значения'), a.expected::text))
        from @SCHEMA@.agg_issues() a
    )
    select coalesce(jsonb_agg(f), '[]'::jsonb) into data_issues from found;
  end if;
  select encode(sha256(coalesce(string_agg(e.hash, ''::bytea order by e.id), ''::bytea)), 'hex') into anchor
  from @SCHEMA@.entity e;
  issues := issues || data_issues;
  return jsonb_build_object('ok', issues = '[]'::jsonb, 'issues', issues, 'anchor', anchor);
end $$;

-- ========================= подписка =========================

-- Пачка событий подписки (этап 6, п. 5): версии журнала после курсора (tx, seq) ниже горизонта
-- завершённых транзакций (pg_snapshot_xmin) — их уже ничто не обгонит, поэтому без потерь и повторов.
-- Выполняется с правами вызывающего: RLS журнала показывает только своё. p_at — время последнего
-- события курсора: старше яруса all какого-либо класса подписки — cursor_expired (события могли
-- проредиться). p_classes null — все классы. p_snap — снимок момента подписки «now»: транзакции,
-- видимые в нём (зафиксированные до подписки), не отдаются.
-- p_leaving (проектор, ревью безопасности №3, №4): ещё смены класса без смены id (reclass без moved), уводящие строку из
-- p_classes, — версия уже другого класса, а прошлая была в p_classes; иначе уход строки из семейства не виден.
create or replace function @SCHEMA@.watch_read(p_tx xid8, p_seq bigint, p_at timestamptz, p_classes text[], p_limit int,
  p_snap pg_snapshot default null, p_leaving boolean default false)
returns setof @SCHEMA@.log
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  horizon xid8 := pg_snapshot_xmin(pg_current_snapshot());
  lim interval;
begin
  if p_at is not null then
    select min(@SCHEMA@.history_iv(p.p->>'all')) into lim
    from @SCHEMA@.entity x cross join lateral (select @SCHEMA@.history_policy(x.data->'resolved') as p) p
    where x.class = 'Class' and p.p is not null and (p_classes is null or x.data->>'name' = any (p_classes));
    if lim is not null and p_at < clock_timestamp() - lim then
      raise exception using errcode = 'LT016',
        message = 'letopis: cursor_expired: курсор подписки старше яруса all — события могли проредиться, перечитайте текущее состояние';
    end if;
  end if;
  -- колонки — явно: changed приложению не выдана (ревью №1 точки А плана 1.1), в ответе подписки она null
  return query select l.seq, l.tx, l.id, l.rev, l.class, l.cv, l.tenant, l.owner, l.links, l.data, l.tags, l.at, l.author,
      l.agent, l.op, l.reason, l.moved, l.prev_hash, l.hash, null::jsonb
    from @SCHEMA@.log l
    where (l.tx, l.seq) > (p_tx, p_seq) and l.tx < horizon
      and (p_classes is null or l.class = any (p_classes)
           or (p_leaving and l.op = 'reclass' and l.moved is null
               and (select p.class from @SCHEMA@.log p where p.id = l.id and p.rev < l.rev and p.op not in ('purge', 'trim', 'reset')
                    order by p.rev desc limit 1) = any (p_classes)))
      and (p_snap is null or not pg_visible_in_snapshot(l.tx, p_snap))
    order by l.tx, l.seq limit p_limit;
end $$;

-- Точка подписки «с этого момента»: курсор — горизонт завершённых транзакций, снимок — чтобы не
-- отдавать транзакции, зафиксированные до подписки, но ещё не ушедшие за горизонт.
drop function if exists @SCHEMA@.watch_head();
create or replace function @SCHEMA@.watch_head(out tx xid8, out seq bigint, out snap pg_snapshot)
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  select pg_snapshot_xmin(s), 0::bigint, s from pg_current_snapshot() s
$$;
-- до исправления подписки «now»: без снимка; до ревью безопасности №3 — без p_leaving
drop function if exists @SCHEMA@.watch_read(xid8, bigint, timestamptz, text[], int);
drop function if exists @SCHEMA@.watch_read(xid8, bigint, timestamptz, text[], int, pg_snapshot);

do $$
declare f text;
begin
  foreach f in array array[
    'history_default()', 'history_policy(jsonb)', 'history_iv(text)', 'history_horizon(jsonb)',
    'history_keep(jsonb, timestamp, timestamp, timestamp)', 'admin_role()', 'letopis_allowed(text)', 'session_expires()', 'signal_mode()', 'signal_key()', 'class_stamp()',
    'last_version_visible(uuid, uuid, jsonb)', 'restore(uuid)', 'projector_behind(uuid, text[], xid8, bigint)', 'purge(uuid, boolean)', 'trim_history(uuid[], text[], timestamptz)',
    'rekey(uuid, jsonb, jsonb)', 'rekey_class(text, jsonb)', 'account_purge(uuid)', 'reset_mark(uuid, text, uuid)',
    'reset(text, text, uuid, int)', 'thin_batch(timestamptz, int)', 'maintain(timestamptz, int)', 'verify(boolean)',
    'watch_read(xid8, bigint, timestamptz, text[], int, pg_snapshot, boolean)', 'watch_head()'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
-- приложению: функции владельца этапа 6 (проверяют права сами), подписка (под RLS) и чистые помощники политики
grant execute on function @SCHEMA@.restore(uuid), @SCHEMA@.purge(uuid, boolean), @SCHEMA@.trim_history(uuid[], text[], timestamptz),
  @SCHEMA@.rekey(uuid, jsonb, jsonb), @SCHEMA@.rekey_class(text, jsonb), @SCHEMA@.account_purge(uuid),
  @SCHEMA@.reset(text, text, uuid, int), @SCHEMA@.maintain(timestamptz, int), @SCHEMA@.verify(boolean),
  @SCHEMA@.session_expires(), @SCHEMA@.watch_read(xid8, bigint, timestamptz, text[], int, pg_snapshot, boolean), @SCHEMA@.watch_head(),
  @SCHEMA@.history_default(), @SCHEMA@.history_policy(jsonb), @SCHEMA@.history_iv(text),
  @SCHEMA@.signal_mode(), @SCHEMA@.signal_key(), @SCHEMA@.class_stamp() to @APP@;
