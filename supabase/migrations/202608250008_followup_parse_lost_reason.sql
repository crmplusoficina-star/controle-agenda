create or replace function private.parse_followup_lost_reason_marker()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  parsed_reason text;
begin
  if new.result = 'venda_perdida' then
    parsed_reason := substring(coalesce(new.notes, '') from '\[\[LOST_REASON:([a-z_]+)\]\]');
    if parsed_reason is not null then
      new.lost_reason := parsed_reason;
      new.notes := nullif(trim(regexp_replace(coalesce(new.notes, ''), E'\\s*\\[\\[LOST_REASON:[a-z_]+\\]\\]\\s*$', '', 'g')), '');
    end if;
  else
    new.lost_reason := null;
  end if;
  return new;
end;
$$;

revoke all on function private.parse_followup_lost_reason_marker() from public, anon, authenticated;
grant execute on function private.parse_followup_lost_reason_marker() to service_role;

drop trigger if exists followups_parse_lost_reason_marker on public.followups;
create trigger followups_parse_lost_reason_marker
before insert or update on public.followups
for each row execute function private.parse_followup_lost_reason_marker();
