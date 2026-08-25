alter table public.followups
  add column if not exists stage text not null default 'prospectar',
  add column if not exists result text,
  add column if not exists sale_kind text,
  add column if not exists parts_value numeric,
  add column if not exists services_value numeric;

alter table public.followups
  alter column treatment_type set default 'retorno',
  alter column status set default 'contato_realizado';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'followups_stage_check') then
    alter table public.followups add constraint followups_stage_check check (stage in ('prospectar','acompanhar','encerrar'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'followups_result_check') then
    alter table public.followups add constraint followups_result_check check (result is null or result in ('venda_ganha','venda_perdida'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'followups_sale_kind_check') then
    alter table public.followups add constraint followups_sale_kind_check check (sale_kind is null or sale_kind in ('pecas','servicos','pecas_servicos'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'followups_parts_value_check') then
    alter table public.followups add constraint followups_parts_value_check check (parts_value is null or parts_value >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'followups_services_value_check') then
    alter table public.followups add constraint followups_services_value_check check (services_value is null or services_value >= 0);
  end if;
end $$;

create unique index if not exists followups_one_open_per_client_branch
  on public.followups (branch, upper(client_name))
  where stage <> 'encerrar';

create table if not exists public.followup_updates (
  id uuid primary key default gen_random_uuid(),
  followup_id uuid not null references public.followups(id) on delete cascade,
  stage text not null,
  result text,
  notes text,
  next_followup_date date,
  sale_kind text,
  parts_value numeric,
  services_value numeric,
  created_at timestamptz not null default now()
);

alter table public.followup_updates enable row level security;
revoke all on public.followup_updates from anon, authenticated;
grant all on public.followup_updates to service_role;

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
     or new.services_value is distinct from old.services_value then
    insert into public.followup_updates (
      followup_id, stage, result, notes, next_followup_date,
      sale_kind, parts_value, services_value
    ) values (
      new.id, new.stage, new.result, new.notes, new.next_followup_date,
      new.sale_kind, new.parts_value, new.services_value
    );
  end if;
  return new;
end;
$$;

revoke all on function private.capture_followup_update() from public, anon, authenticated;
grant execute on function private.capture_followup_update() to service_role;

drop trigger if exists followups_capture_update on public.followups;
create trigger followups_capture_update
after insert or update on public.followups
for each row execute function private.capture_followup_update();