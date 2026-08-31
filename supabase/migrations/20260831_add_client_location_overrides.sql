create table if not exists public.client_location_overrides (
  client_key text primary key,
  client_name text,
  branch text,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  source text not null default 'manual_map_drag',
  updated_at timestamptz not null default now()
);

alter table public.client_location_overrides enable row level security;

drop policy if exists client_location_overrides_read on public.client_location_overrides;
create policy client_location_overrides_read on public.client_location_overrides
for select to anon, authenticated using (true);

drop policy if exists client_location_overrides_insert on public.client_location_overrides;
create policy client_location_overrides_insert on public.client_location_overrides
for insert to anon, authenticated with check (true);

drop policy if exists client_location_overrides_update on public.client_location_overrides;
create policy client_location_overrides_update on public.client_location_overrides
for update to anon, authenticated using (true) with check (true);

grant select, insert, update on public.client_location_overrides to anon, authenticated;

create index if not exists client_location_overrides_branch_idx on public.client_location_overrides(branch);
