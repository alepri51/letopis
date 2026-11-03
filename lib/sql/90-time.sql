-- letopis 1.0 — время и эксплуатация (план, §2.11, этап 6, п. 2–4, 6–8).
--
-- Функции владельца проверяют всё сами, сами пишут журнал и сами посылают сигнал (§2.7):
--   restore()        — последний снимок удалённого объекта новой версией (вид restore), с проверкой
--                      по текущему описанию класса; id прежний;
--   account_purge()  — удаление аккаунта с данными его арендатора (предохранители 0.21);
--   maintain()       — истёкшие сессии и коды, строки-замки удалённых семейств.
-- У id, у которого в журнале есть хоть одна запись, номер версии 1 всегда занят (этап 6, п. 3):
-- на нём держится режим existing: 'error' загрузчика.

-- Действующая роль сеанса, под которой вызывающий работает вне функций владельца: роль SET ROLE (и параметра запуска
-- role), иначе роль входа. Внутри функции владельца current_user — владелец, а session_user — роль входа, даже если
-- поверх неё поставлена роль приложения: привилегированный вход с ролью приложения выглядел бы администратором
-- (автоматическое ревью коммита 1734d21). Подменить её нельзя: SET ROLE проверяет членство.
create or replace function @SCHEMA@.session_role() returns name
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return coalesce(nullif(current_setting('role'), 'none'), session_user)::name;

-- Роль подключения — администраторская (суперпользователь или может стать владельцем): maintain доступен ей и без
-- сессии (CLI, обслуживание по расписанию).
create or replace function @SCHEMA@.admin_role() returns boolean
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
return exists (select 1 from pg_roles where rolname = @SCHEMA@.session_role() and rolsuper)
    or pg_has_role(@SCHEMA@.session_role(), '@OWNER_NAME@', 'SET');

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
    perform @SCHEMA@.lt_fail('sql-time.signals_denied');
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

-- ========================= restore =========================

-- Последняя запись журнала id под блокировкой, если она видна актору в его арендаторе: параллельные
-- restore и воскрешение (trg_entity_bi берёт ту же блокировку) упорядочены.
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
  if l.id is null or l.tenant <> p_tenant
     or not @SCHEMA@.row_visible(l.tenant, l.class, l.id, l.owner, l.tags, l.data, l.links, p_tenant, (p_acl->>'account')::uuid, p_acl->'plan') then
    perform @SCHEMA@.lt_fail('sql-time.target_not_found');
  end if;
  return l;
end $$;

-- Восстановление удалённого объекта (этап 6, п. 2): последний снимок новой версией с видом restore.
-- Снимок перепроверяется по текущему описанию класса (данные, концы с видимостью целей, ключ), право
-- WRITE — на восстановленные значения. id прежний, в том числе у класса без ключа. p_rev (ревизия 9, план 2.1, A1) —
-- ожидаемый номер последней записи журнала (надгробия из ответа delete или withDeleted): другой — отказ restore_stale,
-- проверка под той же блокировкой записи журнала, что у параллельного restore и воскрешения. Прежняя restore(uuid)
-- снимается миграцией 0009: вызов restore(id) попадает сюда с p_rev = null. Отказ — по записи журнала за последним
-- надгробием (второй раунд 2.1, A2): restore — restore_already, create — restore_id_taken (объект живой); иначе с p_rev —
-- restore_stale с after (вид записи сразу за p_rev), deleted и live, без p_rev — restore_not_deleted.
create or replace function @SCHEMA@.restore(p_id uuid, p_rev int default null) returns uuid
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
  v_live boolean;
  v_tomb int;
  v_next text;
begin
  select * into c from @SCHEMA@.ctx();
  if c.account is null then
    perform @SCHEMA@.lt_fail('sql-time.no_session');
  end if;
  rd := @SCHEMA@.acl_actor('READ');
  l := @SCHEMA@.last_version_visible(p_id, c.tenant, rd);
  -- проигравший гонку: блокировка дождалась чужой фиксации, а запись l прочитана до неё. Новая версия видна следующему
  -- оператору (read committed) — тогда последняя запись берётся заново, под той же блокировкой и проверкой видимости
  if exists (select 1 from @SCHEMA@.log x where x.id = p_id and x.tenant = c.tenant and x.rev > l.rev) then
    l := @SCHEMA@.last_version_visible(p_id, c.tenant, rd);
  end if;
  v_live := exists (select 1 from @SCHEMA@.entity e where e.id = p_id);
  if l.op <> 'delete' or v_live or (p_rev is not null and l.rev <> p_rev) then
    -- что за последним надгробием: restore — уже восстановлен, create — id занял новый объект с тем же ключом
    select max(x.rev) into v_tomb from @SCHEMA@.log x where x.id = p_id and x.tenant = c.tenant and x.op = 'delete';
    select x.op into v_next from @SCHEMA@.log x where x.id = p_id and x.tenant = c.tenant and x.rev > v_tomb order by x.rev limit 1;
    if v_live and v_next = 'restore' then
      perform @SCHEMA@.lt_fail('sql-time.restore_already', jsonb_build_object('id', p_id), jsonb_build_object('id', p_id, 'rev', l.rev));
    elsif v_live and v_next = 'create' then
      perform @SCHEMA@.lt_fail('sql-time.restore_id_taken', jsonb_build_object('id', p_id), jsonb_build_object('id', p_id, 'rev', l.rev));
    elsif p_rev is null then
      perform @SCHEMA@.lt_fail('sql-time.restore_not_deleted');
    end if;
    -- удалён снова, не удалялся, гонка: что было сразу после показанного удаления
    select x.op into v_next from @SCHEMA@.log x where x.id = p_id and x.tenant = c.tenant and x.rev > p_rev order by x.rev limit 1;
    perform @SCHEMA@.lt_fail('sql-time.restore_stale',
      jsonb_build_object('id', p_id, 'rev', l.rev, 'expected', p_rev, 'after', coalesce(v_next, '—')),
      jsonb_build_object('id', p_id, 'rev', l.rev, 'expected', p_rev, 'after', v_next, 'deleted', l.op = 'delete', 'live', v_live));
  end if;
  if l.class = 'Class' then
    perform @SCHEMA@.lt_fail('sql-time.restore_class_row');
  end if;
  cls := @SCHEMA@.class_row(l.class, l.tenant);
  if cls.id is null then
    perform @SCHEMA@.lt_fail('sql-time.class_not_found', jsonb_build_object('cls', l.class));
  end if;
  perform @SCHEMA@.family_lock(cls, false);
  cls := @SCHEMA@.class_row(l.class, l.tenant);
  if cls.id is null then
    perform @SCHEMA@.lt_fail('sql-time.class_deleted', jsonb_build_object('cls', l.class));
  end if;
  res := cls.data->'resolved';
  if coalesce((res->>'abstract')::boolean, false) then
    perform @SCHEMA@.lt_fail('sql-time.class_abstract', jsonb_build_object('cls', l.class));
  end if;
  d := @SCHEMA@.apply_defaults(res->'schema', l.data);
  bad := @SCHEMA@.validate_data(res->'rules', cls.validator, res->'vars', d);
  if bad <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('sql-time.invalid_data', jsonb_build_object('cls', l.class), jsonb_build_object('issues', bad));
  end if;
  select * into lk from @SCHEMA@.check_links(res, l.links, l.tenant, true, rd);
  if lk.key is not null then
    perform @SCHEMA@.lt_fail(lk.key, lk.params);
  end if;
  kid := @SCHEMA@.key_id(res, l.class, l.tenant, d, lk.links);
  if kid is not null and kid <> p_id then
    perform @SCHEMA@.lt_fail('sql-time.restore_key_changed', jsonb_build_object('cls', l.class), jsonb_build_object('expected', kid));
  end if;
  -- владелец — существующий аккаунт или арендатор
  own := l.owner;
  if own <> l.tenant and not exists (select 1 from @SCHEMA@.entity a where a.id = own and a.class = 'Account' and a.tenant = '@SYSTEM@'::uuid) then
    own := l.tenant;
  end if;
  if not @SCHEMA@.acl_row_ok(@SCHEMA@.acl_plan('WRITE'), l.class, p_id, own, l.tenant, l.tags, d, lk.links) then
    perform @SCHEMA@.lt_fail('sql-time.no_write_row', jsonb_build_object('cls', l.class));
  end if;
  ts := greatest(@SCHEMA@.now_ts(), l.at + interval '1 microsecond');
  insert into @SCHEMA@.entity (id, rev, class, cv, tenant, owner, links, data, tags, at, created_at, author, agent, op, reason, validator)
  values (p_id, l.rev + 1, l.class, cls.rev, l.tenant, own, lk.links, d, l.tags, ts, ts, c.author, c.agent, 'restore',
          nullif(current_setting('letopis.reason', true), ''), null)
  returning * into n;
  perform @SCHEMA@.log_version(n);
  if l.class in ('rule', 'Resource', 'member', 'Account') then
    perform @SCHEMA@.acl_bump();
  end if;
  return p_id;
end $$;

-- ========================= удаление аккаунта =========================

-- Удаление аккаунта (этап 6, п. 3; accounts.purge 0.21): вызывающий — системный администратор или
-- владелец арендатора-цели (член с ролью owner); удалить себя нельзя; нельзя оставить арендатора без
-- последнего включённого владельца. Данные и журнал арендатора-цели стираются физически; в чужих
-- арендаторах членства снимаются (надгробия), владение строками переходит арендаторам (§2.10);
-- остались ссылки на аккаунт — delete_restricted. Строка Account удаляется с надгробием (история
-- аккаунтов — аудит), сессии гаснут с сигналом, строки secret аккаунта стирает каскад внешнего ключа.
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
    perform @SCHEMA@.lt_fail('sql-time.no_session');
  end if;
  if p_account = c.account then
    perform @SCHEMA@.lt_fail('sql-time.purge_self');
  end if;
  -- право — до поиска и блокировки цели: без права ответ один (acl_denied), есть ли такой аккаунт,
  -- не видно, и чужую строку Account вызов не блокирует (итоговое ревью безопасности)
  if not (@SCHEMA@.auth_is_sysadmin() or exists (
      select 1 from @SCHEMA@.entity x
      where x.id = @SCHEMA@.v5_id(p_account, 'member', array[c.account::text, p_account::text]) and x.class = 'member'
        and x.tenant = p_account and coalesce(x.data->'roles' ? 'owner', false))) then
    perform @SCHEMA@.lt_fail('sql-time.account_purge_denied');
  end if;
  select x.* into a from @SCHEMA@.entity x where x.id = p_account and x.class = 'Account' and x.tenant = '@SYSTEM@'::uuid for update;
  if a.id is null or p_account = '@SYSTEM@'::uuid then
    perform @SCHEMA@.lt_fail('sql-time.account_not_found');
  end if;
  -- владелец стирает арендатора, в котором работает: его членство уйдёт вместе с данными, а надгробия и
  -- передача владения ниже перечитывают ctx() — остаток операции идёт в личном арендаторе вызывающего,
  -- и его сессия больше не указывает на стёртого арендатора (иначе tenant_denied и откат всего вызова)
  if c.tenant = p_account then
    perform set_config('letopis.tenant', c.account::text, true);
    update @SCHEMA@.secret s set meta = s.meta - 'tenant'
    where s.id = c.session and s.kind = 'SESSION' and s.meta->>'tenant' = p_account::text;
  end if;
  -- последний владелец: в каждом чужом арендаторе, где цель — владелец, должен остаться другой
  for t in select x.tenant from @SCHEMA@.entity x
           where x.class = 'member' and x.links->>'User' = p_account::text and x.tenant <> p_account
             and coalesce(x.data->'roles' ? 'owner', false) loop
    if not exists (select 1 from @SCHEMA@.entity x
                   join @SCHEMA@.entity u on u.id = (x.links->>'User')::uuid and u.class = 'Account' and u.tenant = '@SYSTEM@'::uuid
                   where x.class = 'member' and x.tenant = t.tenant and x.links->>'User' <> p_account::text
                     and coalesce(x.data->'roles' ? 'owner', false) and coalesce((u.data->>'enabled')::boolean, true)) then
      perform @SCHEMA@.lt_fail('sql-time.last_owner', jsonb_build_object('tenant', t.tenant), jsonb_build_object('tenant', t.tenant));
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
  for t in select distinct x.tenant from @SCHEMA@.entity x where x.owner = p_account and x.owner <> x.tenant order by x.tenant loop
    n_own := n_own + @SCHEMA@.owner_to_tenant(t.tenant, p_account);
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'class', x.class, 'tenant', x.tenant)), '[]'::jsonb) into blockers
  from (select x.id, x.class, x.tenant from @SCHEMA@.entity x where x.ends @> array[p_account] order by x.id limit 1000) x;
  if blockers <> '[]'::jsonb then
    perform @SCHEMA@.lt_fail('sql-time.account_referenced', '{}'::jsonb, @SCHEMA@.visible_detail(blockers, c.tenant));
  end if;
  -- сессии аккаунта гасит с сигналом триггер до удаления (trg_entity_bd_account, срабатывает и для владельца), а его
  -- строки secret — сессии и креды — стирает каскад внешнего ключа secret.account (ревизия 7)
  delete from @SCHEMA@.entity x where x.id = p_account;
  perform @SCHEMA@.tombstone(a);
  -- данные арендатора-цели — его парами; Account и member — классы прав, их сигнал сбрасывает всё
  perform @SCHEMA@.signal(classes || array['Account', 'member'],
    array(select p_account from unnest(classes)) || array['@SYSTEM@'::uuid, '@SYSTEM@'::uuid]);
  perform @SCHEMA@.acl_bump();
  return jsonb_build_object('account', p_account, 'rows', n_rows, 'versions', n_log, 'memberships', n_mem, 'owned', n_own);
end $$;

-- ========================= обслуживание =========================

-- Обслуживание (этап 6, п. 8): истёкшие и погашенные сессии и одноразовые коды, строки-замки удалённых семейств,
-- заполнение очереди сигналов. Вызывает системный администратор, роль с правом letopis.maintain или администраторское
-- подключение. Один исполнитель: обслуживание идёт одной транзакцией под строкой-замком; занята — null.
create or replace function @SCHEMA@.maintain() returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  s int;
  o int;
  fam text := '@SCHEMA_NAME@:family:';
begin
  if not @SCHEMA@.letopis_allowed('letopis.maintain') then
    perform @SCHEMA@.lt_fail('sql-time.maintain_denied');
  end if;
  -- один исполнитель: строка-замок до конца транзакции (lock_try) — посторонняя роль её не займёт (ревью
  -- безопасности №3, №2); занята — null, обслуживание продолжит держатель
  if not @SCHEMA@.lock_try('@SCHEMA_NAME@:maintain') then
    return null;
  end if;
  with d as (delete from @SCHEMA@.secret x where x.kind = 'SESSION'
             and (x.deleted_at is not null or x.expires_at <= clock_timestamp()) returning 1)
  select count(*)::int into s from d;
  -- коды всех видов, которые выпускает auth_issue_otp: OTP и OTP_<имя> (тот же шаблон вида), — использованные,
  -- заменённые, исчерпавшие попытки (deleted_at) и истёкшие
  with d as (delete from @SCHEMA@.secret x where x.kind ~ '^OTP(_[A-Z0-9]{1,27})?$'
             and (x.deleted_at is not null or x.expires_at <= clock_timestamp()) returning 1)
  select count(*)::int into o from d;
  -- строки-замки семейств, чьего корня больше нет — удалён класс или его арендатор (план 2.0, 7.7 №8, долгий
  -- прогон): их заранее заводит запись строки Class (family_rows), а сами они не уходили — заведение и удаление
  -- классов копило их без предела. Корень жив — строка Class с этим именем у арендатора семейства (family_name;
  -- в имени класса двоеточия нет). Занятую строку не трогаем (skip locked), а строку-замок семейства — только вместе
  -- с её шлюзом или без шлюза: исключительная блокировка берёт шлюз первым, и строка-замок, до которой она ещё не
  -- дошла, у неё не пропадёт. Пропавшую строку lock_row и family_lock заводят заново, если класс с этим именем
  -- появится снова.
  with stale as (
    select l.id, l.meta->>'name' as n
    from @SCHEMA@.secret l
    where l.kind = 'LOCK' and l.account = '@SYSTEM@'::uuid and l.deleted_at is null
      and left(l.meta->>'name', length(fam)) = fam
      and not exists (
        select 1 from @SCHEMA@.entity c
        where c.class = 'Class'
          and c.data->>'name' = split_part(substr(l.meta->>'name', length(fam) + 1), ':', 2)
          and c.tenant::text = split_part(substr(l.meta->>'name', length(fam) + 1), ':', 1))
    for update of l skip locked)
  delete from @SCHEMA@.secret x using stale st
  where x.id = st.id
    and (st.n like '%:gate'
         or exists (select 1 from stale g where g.n = st.n || ':gate')
         or not exists (select 1 from @SCHEMA@.secret y where y.id = @SCHEMA@.lock_id(st.n || ':gate')));
  return jsonb_build_object('sessions', s, 'codes', o, 'queue', pg_notification_queue_usage());
end $$;

-- ========================= подписка =========================

-- Пачка событий подписки (этап 6, п. 5): версии журнала после курсора (tx, seq) ниже горизонта
-- завершённых транзакций (pg_snapshot_xmin) — их уже ничто не обгонит, поэтому без потерь и повторов.
-- Выполняется с правами вызывающего: RLS журнала показывает только своё. p_classes null — все классы. p_snap — снимок
-- момента подписки «now»: транзакции, видимые в нём (зафиксированные до подписки), не отдаются.
create or replace function @SCHEMA@.watch_read(p_tx xid8, p_seq bigint, p_classes text[], p_limit int,
  p_snap pg_snapshot default null)
returns setof @SCHEMA@.log
language plpgsql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
declare
  horizon xid8 := pg_snapshot_xmin(pg_current_snapshot());
begin
  return query select l.*
    from @SCHEMA@.log l
    where (l.tx, l.seq) > (p_tx, p_seq) and l.tx < horizon
      and (p_classes is null or l.class = any (p_classes))
      and (p_snap is null or not pg_visible_in_snapshot(l.tx, p_snap))
    order by l.tx, l.seq limit p_limit;
end $$;

-- Точка подписки «с этого момента»: курсор — горизонт завершённых транзакций, снимок — чтобы не
-- отдавать транзакции, зафиксированные до подписки, но ещё не ушедшие за горизонт.
create or replace function @SCHEMA@.watch_head(out tx xid8, out seq bigint, out snap pg_snapshot)
language sql stable
set search_path = pg_catalog, @SCHEMA@, pg_temp
as $$
  select pg_snapshot_xmin(s), 0::bigint, s from pg_current_snapshot() s
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'session_role()', 'admin_role()', 'letopis_allowed(text)', 'session_expires()', 'signal_mode()', 'signal_key()', 'class_stamp()',
    'last_version_visible(uuid, uuid, jsonb)', 'restore(uuid, int)', 'account_purge(uuid)', 'maintain()',
    'watch_read(xid8, bigint, text[], int, pg_snapshot)', 'watch_head()'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
-- приложению: функции владельца этапа 6 (проверяют права сами) и подписка (под RLS)
grant execute on function @SCHEMA@.restore(uuid, int), @SCHEMA@.account_purge(uuid), @SCHEMA@.maintain(),
  @SCHEMA@.session_expires(), @SCHEMA@.watch_read(xid8, bigint, text[], int, pg_snapshot), @SCHEMA@.watch_head(),
  @SCHEMA@.signal_mode(), @SCHEMA@.signal_key(), @SCHEMA@.class_stamp() to @APP@;
