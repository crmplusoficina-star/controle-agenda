-- Filiais do G4 cadastradas desativadas; ligar/desligar pela tela, sem recalcular nada.
-- Os resumos G4 passam a cobrir todas as filiais e o RLS esconde as inativas.

insert into public.app_branches(name, active)
select distinct trim(filial), false
from public.g4_ordens_servico
where nullif(trim(filial), '') is not null
on conflict (name) do nothing;

create or replace function private.refresh_g4_app_cache()
returns void
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
begin
  truncate table public.g4_history_app;
  insert into public.g4_history_app(source_id,os_g4,os_sap,client_name,serial,city,state,branch,operation_type,os_type,status,service_date,description,source_year)
  select
    g.id,
    g.codigo_os_g4,
    g.codigo_os_sap,
    nullif(trim(g.razao_social),''),
    nullif(upper(trim(g.numero_serie)),''),
    nullif(trim(coalesce(g.cidade_contato,g.cidade)),''),
    nullif(trim(g.estado),''),
    nullif(trim(g.filial),''),
    nullif(trim(g.tipo_de_operacao),''),
    nullif(trim(g.tipo_de_os),''),
    nullif(trim(g.status),''),
    coalesce(g.data_fechamento,g.data_inicio,g.data_abertura,g.data_primeiro_contato),
    nullif(trim(g.descricao),''),
    g.ano_origem
  from public.g4_ordens_servico g
  join public.app_branches b on b.name = g.filial;

  truncate table public.g4_machine_summary;
  insert into public.g4_machine_summary(serial,client_name,city,state,branch,first_service_at,last_service_at,service_count,last_operation_type,last_os_type,last_description,last_os_g4,last_os_sap,refreshed_at)
  with ranked as (
    select h.*,
      count(*) over(partition by h.serial) as total_count,
      min(h.service_date) over(partition by h.serial) as first_date,
      row_number() over(partition by h.serial order by h.service_date desc nulls last, h.source_id desc) as rn
    from public.g4_history_app h
    where h.serial is not null
  )
  select serial,client_name,city,state,branch,first_date,service_date,total_count,last_operation_type,last_os_type,description,os_g4,os_sap,now()
  from (
    select serial,client_name,city,state,branch,first_date,service_date,total_count,operation_type as last_operation_type,os_type as last_os_type,description,os_g4,os_sap,rn
    from ranked
  ) x where rn=1;

  truncate table public.g4_client_summary;
  insert into public.g4_client_summary(client_key,client_name,branch,city,first_service_at,last_service_at,service_count,machine_count,last_operation_type,last_description,refreshed_at)
  with base as (
    select *, upper(trim(client_name)) as client_norm
    from public.g4_history_app
    where client_name is not null and branch is not null
  ), agg as (
    select client_norm, branch,
      min(service_date) as first_service_at,
      max(service_date) as last_service_at,
      count(*)::int as service_count,
      count(distinct serial) filter (where serial is not null)::int as machine_count
    from base group by client_norm, branch
  ), latest as (
    select distinct on (client_norm, branch) client_norm, branch, client_name, city, operation_type, description
    from base
    order by client_norm, branch, service_date desc nulls last, source_id desc
  )
  select md5(a.client_norm || '|' || a.branch), l.client_name, a.branch, l.city, a.first_service_at, a.last_service_at, a.service_count, a.machine_count, l.operation_type, l.description, now()
  from agg a join latest l using(client_norm, branch);
end;
$function$;

create or replace function private.refresh_g4_client_location_summary()
returns void
language plpgsql
security definer
set search_path to 'public', 'private'
as $function$
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
    join public.app_branches b on upper(trim(b.name)) = upper(trim(o.filial))
    where nullif(trim(o.razao_social), '') is not null
      and nullif(trim(o.filial), '') is not null
    order by
      upper(trim(o.razao_social)),
      upper(trim(o.filial)),
      coalesce(o.data_fechamento, o.data_inicio, o.data_abertura, o.data_primeiro_contato) desc nulls last,
      o.id desc
  ) g;
end;
$function$;

-- Leitura dos resumos G4 só para filiais ativas.
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['g4_history_app','g4_machine_summary','g4_client_summary','g4_client_city_summary','g4_client_location_summary'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t and cmd = 'SELECT' loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format(
      'create policy %I on public.%I for select to anon, authenticated using (exists (select 1 from public.app_branches b where b.name = %I.branch and b.active))',
      t || '_active_branch_read', t, t);
  end loop;
end $$;

create or replace function public.admin_set_branch_active(
  p_actor text,
  p_branch text,
  p_active boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch text := public._norm_branch_name(p_branch);
  v_orphans text;
begin
  perform public._assert_app_admin(p_actor);

  if not exists (select 1 from app_branches where name = v_branch) then
    raise exception 'filial não encontrada: %', v_branch;
  end if;

  if not p_active then
    select string_agg(u.name, ', ' order by u.name) into v_orphans
    from app_users u
    where u.active and u.role = 'consultor'
      and not exists (
        select 1 from app_user_branches ub join app_branches b on b.name = ub.branch
        where ub.matricula = u.matricula and b.active and b.name <> v_branch
      );
    if v_orphans is not null then
      raise exception 'antes de desativar %, libere outra filial para: %', v_branch, v_orphans;
    end if;
  end if;

  update app_branches set active = p_active where name = v_branch;

  if p_active then
    insert into app_user_branches(matricula, branch)
    select matricula, v_branch from app_users where role in ('gestor','admin') and active
    on conflict do nothing;
  end if;

  return jsonb_build_object('branch', v_branch, 'active', p_active);
end $$;

revoke all on function public.admin_set_branch_active(text,text,boolean) from public;
grant execute on function public.admin_set_branch_active(text,text,boolean) to anon, authenticated;

select private.refresh_g4_app_cache();
select private.refresh_g4_client_city_summary();
select private.refresh_g4_client_location_summary();
