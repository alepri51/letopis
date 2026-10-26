-- letopis 1.0 — каталог ошибок базы (план, §7.1, этап 1, п. 7).
-- У ошибок letopis собственный класс кодов SQLSTATE «LT»; текст — «letopis: <имя>: <сообщение>»,
-- детали — JSON в поле DETAIL. Текст «цель не найдена» одинаков для несуществующей и чужой цели.

create or replace function @SCHEMA@.error_catalog() returns table (code text, name text, message text)
language sql immutable parallel safe
as $$
  values
    ('LT001', 'no_session',             'letopis: no_session: нет действующей сессии'),
    ('LT002', 'target_not_found',       'letopis: target_not_found: цель не найдена'),
    ('LT003', 'invalid_data',           'letopis: invalid_data: данные не проходят описание класса'),
    ('LT004', 'undeclared_end',         'letopis: undeclared_end: конец не объявлен в классе'),
    ('LT005', 'tenant_denied',          'letopis: tenant_denied: чужой арендатор'),
    ('LT006', 'acl_denied',             'letopis: acl_denied: отказ по правилам доступа'),
    ('LT007', 'id_mismatch',            'letopis: id_mismatch: id не равен v5 от ключа'),
    ('LT008', 'id_from_db',             'letopis: id_from_db: id класса без ключа выдаёт база'),
    ('LT009', 'immutable_key',          'letopis: immutable_key: ключевое поле менять нельзя'),
    ('LT010', 'invalid_class',          'letopis: invalid_class: описание класса отклонено'),
    ('LT011', 'use_reclass',            'letopis: use_reclass: класс с ключом меняется функцией reclass()'),
    ('LT012', 'reclass_denied',         'letopis: reclass_denied: смена класса отклонена'),
    ('LT013', 'tightening_conflict',    'letopis: tightening_conflict: ужесточению описания мешают строки'),
    ('LT014', 'isolation_level',        'letopis: isolation_level: операция разрешена только в read committed'),
    ('LT015', 'recreated_in_statement', 'letopis: recreated_in_statement: id удалён и создан заново одним оператором'),
    ('LT016', 'cursor_expired',         'letopis: cursor_expired: курсор подписки старше яруса all'),
    ('LT017', 'delete_restricted',      'letopis: delete_restricted: удалению мешают ссылающиеся строки'),
    ('LT018', 'not_deleted',            'letopis: not_deleted: объект не удалён — restore и purge только для удалённых'),
    ('LT019', 'reset_disabled',         'letopis: reset_disabled: reset выключен в этой установке'),
    ('LT020', 'confirm_mismatch',       'letopis: confirm_mismatch: подтверждение не совпадает с именем схемы'),
    ('LT021', 'derived_class',          'letopis: derived_class: строки производного класса пишет только его проектор'),
    ('LT022', 'aggregate_field',        'letopis: aggregate_field: агрегатное поле считает база')
$$;

create or replace function @SCHEMA@.lt_raise(p_code text, p_name text, p_msg text, p_detail jsonb default null)
returns void
language plpgsql
as $$
begin
  raise exception using errcode = p_code, message = 'letopis: ' || p_name || ': ' || p_msg,
    detail = coalesce(p_detail, '{}'::jsonb)::text;
end $$;

-- Ошибка по имени из каталога.
create or replace function @SCHEMA@.lt_fail(p_name text, p_msg text, p_detail jsonb default null)
returns void
language plpgsql
as $$
declare
  c text;
begin
  select e.code into c from @SCHEMA@.error_catalog() e where e.name = p_name;
  perform @SCHEMA@.lt_raise(coalesce(c, 'LT000'), p_name, p_msg, p_detail);
end $$;

do $$
declare f text;
begin
  foreach f in array array['error_catalog()', 'lt_raise(text, text, text, jsonb)', 'lt_fail(text, text, jsonb)'] loop
    execute format('alter function @SCHEMA@.%s owner to @OWNER@', f);
    execute format('revoke all on function @SCHEMA@.%s from public', f);
  end loop;
end $$;
grant execute on function @SCHEMA@.error_catalog() to @APP@;
