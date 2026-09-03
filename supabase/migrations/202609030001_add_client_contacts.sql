create table if not exists public.client_contacts (
  client_key text primary key,
  branch text not null,
  client_name text not null,
  phone text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists client_contacts_branch_name_idx
  on public.client_contacts(branch, lower(client_name));

alter table public.client_contacts enable row level security;

drop policy if exists client_contacts_select on public.client_contacts;
create policy client_contacts_select on public.client_contacts
  for select to anon, authenticated using (true);

drop policy if exists client_contacts_insert on public.client_contacts;
create policy client_contacts_insert on public.client_contacts
  for insert to anon, authenticated with check (true);

drop policy if exists client_contacts_update on public.client_contacts;
create policy client_contacts_update on public.client_contacts
  for update to anon, authenticated using (true) with check (true);
