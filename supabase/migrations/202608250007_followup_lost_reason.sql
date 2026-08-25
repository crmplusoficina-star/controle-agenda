alter table public.followups
  add column if not exists lost_reason text;

alter table public.followup_updates
  add column if not exists lost_reason text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'followups_lost_reason_check') then
    alter table public.followups add constraint followups_lost_reason_check
      check (lost_reason is null or lost_reason in ('sem_interesse','preco','concorrente','sem_contato','adiado','outro'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'followups_lost_reason_required_check') then
    alter table public.followups add constraint followups_lost_reason_required_check
      check (
        (result = 'venda_perdida' and lost_reason is not null)
        or (result is distinct from 'venda_perdida' and lost_reason is null)
      );
  end if;
end $$;

create or replace function private.capture_followup_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  if tg_op = 'INSERT'
     or new.stage is distinct from old.stage
     or new.result is distinct from old.result
     or new.notes is distinct from old.notes
     or new.next_followup_date is distinct from old.next_followup_date
     or new.sale_kind is distinct from old.sale_kind
     or new.parts_value is distinct from old.parts_value
     or new.services_value is distinct from old.services_value
     or new.lost_reason is distinct from old.lost_reason then
    insert into public.followup_updates (
      followup_id, stage, result, notes, next_followup_date,
      sale_kind, parts_value, services_value, lost_reason
    ) values (
      new.id, new.stage, new.result, new.notes, new.next_followup_date,
      new.sale_kind, new.parts_value, new.services_value, new.lost_reason
    );
  end if;
  return new;
end;
$$;

revoke all on function private.capture_followup_update() from public, anon, authenticated;
grant execute on function private.capture_followup_update() to service_role;
