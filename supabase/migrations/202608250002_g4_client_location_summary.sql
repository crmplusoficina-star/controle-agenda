create table if not exists public.g4_client_location_summary (
  client_key text primary key,
  client_name text not null,
  branch text not null,
  address text,
  neighborhood text,
  city text,
  state text,
  source_date timestamptz,
  refreshed_at timestamptz not null default now()
);

create index if not exists g4_client_location_summary_branch_idx on public.g4_client_location_summary(branch);
create index if not exists g4_client_location_summary_city_idx on public.g4_client_location_summary(city);

create or replace function private.refresh_g4_client_location_summary() returns void
language plpgsql
security definer
set search_path = public, private as $$
begin
  truncate table public.g4_client_location_summary;

  insert into public.g4_client_location_summary(
    client_key, client_name, branch, address, neighborhood, city, state, source_date, refreshed_at
  )
  select
    md5(upper(trim(g.razao_social)) || '|' || upper(trim(g.filial))) as client_key,
    trim(g.razao_social) as client_name,
    trim(g.filial) as branch,
    nullif(trim(g.endereco), '') as address,
    nullif(trim(g.bairro), '') as neighborhood,
    nullif(trim(coalesce(g.cidade_contato, g.cidade)), '') as city,
    nullif(trim(g.estado), '') as state,
    coalesce(g.data_fechamento, g.data_inicio, g.data_abertura, g.data_primeiro_contato) as source_date,
    now()
  from (
    select distinct on (upper(trim(o.razao_social)), upper(trim(o.filial))) o.*
    from public.g4_ordens_servico o
    join public.app_branches b on upper(trim(b.name)) = upper(trim(o.filial)) and b.active = true
    where nullif(trim(o.razao_social), '') is not null
      and nullif(trim(o.filial), '') is not null
    order by
      upper(trim(o.razao_social)),
      upper(trim(o.filial)),
      coalesce(o.data_fechamento, o.data_inicio, o.data_abertura, o.data_primeiro_contato) desc nulls last,
      o.id desc
  ) g;
end;
$$;

revoke all on function private.refresh_g4_client_location_summary() from public, anon, authenticated;
select private.refresh_g4_client_location_summary();

alter table public.g4_client_location_summary enable row level security;
revoke all on table public.g4_client_location_summary from anon, authenticated;
