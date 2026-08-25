create table if not exists public.app_users (
  matricula text primary key,
  name text not null,
  role text not null check (role in ('consultor','gestor','admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.app_users enable row level security;
drop policy if exists app_users_read on public.app_users;
create policy app_users_read on public.app_users for select to anon, authenticated using (true);
grant select on public.app_users to anon, authenticated;

create table if not exists public.app_user_branches (
  matricula text not null references public.app_users(matricula) on update cascade on delete cascade,
  branch text not null references public.app_branches(name) on update cascade on delete cascade,
  primary key (matricula, branch)
);

alter table public.app_user_branches enable row level security;
drop policy if exists app_user_branches_read on public.app_user_branches;
create policy app_user_branches_read on public.app_user_branches for select to anon, authenticated using (true);
grant select on public.app_user_branches to anon, authenticated;

insert into public.app_users (matricula, name, role, active) values
  ('4629','Tiago do Vale Gomes','consultor',true),
  ('4846','Lana Freitas','consultor',true),
  ('19115','Vinicius Veloso','consultor',true),
  ('44031','Alex Barbosa','consultor',true),
  ('4595','Thauana Mattos','consultor',true),
  ('19103','Hamilton Matias','gestor',true),
  ('44033','Delmiro Neto','gestor',true),
  ('19124','Alisson Mafra','admin',true)
on conflict (matricula) do update set name=excluded.name, role=excluded.role, active=excluded.active;

insert into public.app_user_branches (matricula, branch) values
  ('4629','MARABA'),('4629','MANAUS'),
  ('4846','SAO LUIS'),
  ('19115','MARITUBA'),('19115','MIRITITUBA'),
  ('44031','BALSAS'),('44031','IMPERATRIZ'),
  ('4595','ITAITINGA'),('4595','TERESINA')
on conflict do nothing;

insert into public.app_user_branches (matricula, branch)
select u.matricula, b.name
from public.app_users u cross join public.app_branches b
where u.matricula in ('19103','44033','19124')
on conflict do nothing;

alter table public.followups
  add column if not exists created_by_matricula text references public.app_users(matricula) on update cascade,
  add column if not exists created_by_name text,
  add column if not exists updated_by_matricula text references public.app_users(matricula) on update cascade,
  add column if not exists updated_by_name text;

alter table public.followup_updates
  add column if not exists actor_matricula text references public.app_users(matricula) on update cascade,
  add column if not exists actor_name text;

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
      sale_kind, parts_value, services_value, lost_reason,
      actor_matricula, actor_name
    ) values (
      new.id, new.stage, new.result, new.notes, new.next_followup_date,
      new.sale_kind, new.parts_value, new.services_value, new.lost_reason,
      coalesce(new.updated_by_matricula, new.created_by_matricula),
      coalesce(new.updated_by_name, new.created_by_name)
    );
  end if;
  return new;
end;
$$;

create index if not exists idx_app_user_branches_matricula on public.app_user_branches(matricula);
create index if not exists idx_followups_created_by_matricula on public.followups(created_by_matricula);
create index if not exists idx_followups_updated_by_matricula on public.followups(updated_by_matricula);
