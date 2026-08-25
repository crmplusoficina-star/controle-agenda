create table if not exists public.g4_client_city_summary (
  city_key text primary key,
  client_key text not null,
  client_name text not null,
  branch text not null,
  city text not null,
  first_service_at timestamp without time zone,
  last_service_at timestamp without time zone,
  service_count integer not null default 0,
  machine_count integer not null default 0,
  serials text[] not null default '{}'::text[],
  last_operation_type text,
  last_description text,
  refreshed_at timestamptz not null default now()
);

alter table public.g4_client_city_summary
  add column if not exists serials text[] not null default '{}'::text[];

create index if not exists g4_client_city_summary_branch_city_idx
  on public.g4_client_city_summary(branch, city);
create index if not exists g4_client_city_summary_client_idx
  on public.g4_client_city_summary(client_key);
create index if not exists g4_client_city_summary_last_idx
  on public.g4_client_city_summary(last_service_at);

alter table public.g4_client_city_summary enable row level security;
drop policy if exists g4_client_city_summary_read on public.g4_client_city_summary;
create policy g4_client_city_summary_read
  on public.g4_client_city_summary
  for select to anon, authenticated
  using (true);

grant select on public.g4_client_city_summary to anon, authenticated;

create or replace function private.refresh_g4_client_city_summary() returns void
language plpgsql
security definer
set search_path = public, private as $$
begin
  truncate table public.g4_client_city_summary;

  insert into public.g4_client_city_summary(
    city_key,client_key,client_name,branch,city,
    first_service_at,last_service_at,service_count,machine_count,serials,
    last_operation_type,last_description,refreshed_at
  )
  with base as (
    select
      h.*,
      upper(trim(h.client_name)) as client_norm,
      translate(
        upper(trim(h.city)),
        'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
        'AAAAAEEEEIIIIOOOOOUUUUC'
      ) as city_norm
    from public.g4_history_app h
    where h.client_name is not null
      and h.branch is not null
      and h.city is not null
      and trim(h.city) <> ''
  ), agg as (
    select
      client_norm,
      branch,
      city_norm,
      min(service_date) as first_service_at,
      max(service_date) as last_service_at,
      count(*)::int as service_count,
      count(distinct serial) filter (where serial is not null)::int as machine_count,
      coalesce(
        array_agg(distinct serial order by serial) filter (where serial is not null),
        '{}'::text[]
      ) as serials
    from base
    group by client_norm, branch, city_norm
  ), latest as (
    select distinct on (client_norm, branch, city_norm)
      client_norm,branch,city_norm,client_name,city,operation_type,description
    from base
    order by client_norm, branch, city_norm, service_date desc nulls last, source_id desc
  )
  select
    md5(a.client_norm || '|' || a.branch || '|' || a.city_norm),
    md5(a.client_norm || '|' || a.branch),
    l.client_name,
    a.branch,
    l.city,
    a.first_service_at,
    a.last_service_at,
    a.service_count,
    a.machine_count,
    a.serials,
    l.operation_type,
    l.description,
    now()
  from agg a
  join latest l using(client_norm, branch, city_norm);
end;
$$;

create or replace function private.refresh_g4_client_city_summary_trigger() returns trigger
language plpgsql
security definer
set search_path = public, private as $$
begin
  perform private.refresh_g4_client_city_summary();
  return null;
end;
$$;

drop trigger if exists g4_history_refresh_client_city_summary on public.g4_history_app;
create trigger g4_history_refresh_client_city_summary
after insert on public.g4_history_app
for each statement execute function private.refresh_g4_client_city_summary_trigger();

revoke all on function private.refresh_g4_client_city_summary() from public, anon, authenticated;
revoke all on function private.refresh_g4_client_city_summary_trigger() from public, anon, authenticated;

select private.refresh_g4_client_city_summary();