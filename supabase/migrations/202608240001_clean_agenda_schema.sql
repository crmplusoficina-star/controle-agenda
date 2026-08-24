create extension if not exists pgcrypto;
create schema if not exists private;

create table if not exists public.app_branches (
  name text primary key,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.app_branches(name) values
  ('BALSAS'),('IMPERATRIZ'),('ITAITINGA'),('MANAUS'),('MARABA'),('MARITUBA'),('MIRITITUBA'),('SAO LUIS'),('TERESINA')
on conflict (name) do update set active = true;

create table if not exists public.technicians (
  id uuid primary key default gen_random_uuid(),
  branch text not null references public.app_branches(name) on update cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists technicians_branch_name_uq on public.technicians(branch, lower(name));

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  branch text not null references public.app_branches(name) on update cascade,
  appointment_date date not null,
  technician_id uuid not null references public.technicians(id) on delete restrict,
  client_name text,
  equipment_serial text,
  service_city text,
  status text not null default 'planejado' check (status in ('planejado','confirmado','em_atendimento','concluido','cancelado')),
  service_reason text,
  description text,
  reported_hourmeter numeric(12,1) check (reported_hourmeter is null or reported_hourmeter >= 0),
  forecast_amount numeric(14,2) not null default 0,
  billing_status text not null default 'nao_precificado' check (billing_status in ('nao_precificado','precificado','aguardando_faturamento','faturado','debito_interno')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists appointments_branch_date_idx on public.appointments(branch, appointment_date);
create index if not exists appointments_tech_date_idx on public.appointments(technician_id, appointment_date);
create index if not exists appointments_serial_idx on public.appointments(equipment_serial) where equipment_serial is not null;

create table if not exists public.hourmeter_readings (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null unique references public.appointments(id) on delete cascade,
  equipment_serial text not null,
  hourmeter numeric(12,1) not null check (hourmeter >= 0),
  reading_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists hourmeter_serial_date_idx on public.hourmeter_readings(equipment_serial, reading_date desc);

create table if not exists public.followups (
  id uuid primary key default gen_random_uuid(),
  branch text not null references public.app_branches(name) on update cascade,
  client_name text not null,
  equipment_serial text,
  action_date date not null default current_date,
  treatment_type text not null check (treatment_type in ('atendimento','venda_pecas','venda_servicos','visita','retorno','outro')),
  status text not null check (status in ('contato_realizado','oportunidade','retorno_agendado','agendamento_criado','convertido','sem_resposta','sem_interesse','perdido')),
  estimated_value numeric(14,2),
  next_followup_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists followups_branch_action_idx on public.followups(branch, action_date desc);
create index if not exists followups_next_date_idx on public.followups(next_followup_date) where next_followup_date is not null;

create table if not exists public.ai_insights (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid references public.appointments(id) on delete cascade,
  technician_id uuid references public.technicians(id) on delete set null,
  branch text references public.app_branches(name) on update cascade,
  insight_type text not null check (insight_type in ('operacional','preventivo','comercial','relacionamento','planejamento','historico','proposta','alerta')),
  priority text not null default 'normal' check (priority in ('baixa','normal','alta','critica')),
  presentation_level integer not null default 2 check (presentation_level between 1 and 4),
  title text not null,
  message text not null,
  rationale jsonb not null default '{}'::jsonb,
  fingerprint text not null,
  status text not null default 'new' check (status in ('new','viewed','ignored','useful','converted','expired')),
  generated_by text not null default 'rules' check (generated_by in ('rules','gemini','rules+gemini')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(fingerprint)
);
create index if not exists ai_insights_branch_status_idx on public.ai_insights(branch, status, created_at desc);

create table if not exists public.g4_history_app (
  source_id bigint primary key,
  os_g4 text,
  os_sap bigint,
  client_name text,
  serial text,
  city text,
  state text,
  branch text,
  operation_type text,
  os_type text,
  status text,
  service_date timestamp without time zone,
  description text,
  source_year smallint
);
create index if not exists g4_history_app_serial_date_idx on public.g4_history_app(serial, service_date desc);
create index if not exists g4_history_app_client_date_idx on public.g4_history_app(client_name, service_date desc);
create index if not exists g4_history_app_branch_date_idx on public.g4_history_app(branch, service_date desc);

create table if not exists public.g4_machine_summary (
  serial text primary key,
  client_name text,
  city text,
  state text,
  branch text,
  first_service_at timestamp without time zone,
  last_service_at timestamp without time zone,
  service_count integer not null default 0,
  last_operation_type text,
  last_os_type text,
  last_description text,
  last_os_g4 text,
  last_os_sap bigint,
  refreshed_at timestamptz not null default now()
);
create index if not exists g4_machine_summary_client_idx on public.g4_machine_summary(lower(client_name));
create index if not exists g4_machine_summary_city_idx on public.g4_machine_summary(lower(city));
create index if not exists g4_machine_summary_branch_idx on public.g4_machine_summary(branch);

create table if not exists public.g4_client_summary (
  client_key text primary key,
  client_name text not null,
  branch text not null,
  city text,
  first_service_at timestamp without time zone,
  last_service_at timestamp without time zone,
  service_count integer not null default 0,
  machine_count integer not null default 0,
  last_operation_type text,
  last_description text,
  refreshed_at timestamptz not null default now()
);
create index if not exists g4_client_summary_branch_last_idx on public.g4_client_summary(branch, last_service_at);
create index if not exists g4_client_summary_name_idx on public.g4_client_summary(lower(client_name));

create or replace function private.touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function private.sync_hourmeter_reading() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.reported_hourmeter is null or nullif(trim(coalesce(new.equipment_serial,'')), '') is null then
    delete from public.hourmeter_readings where appointment_id = new.id;
    return new;
  end if;
  insert into public.hourmeter_readings(appointment_id,equipment_serial,hourmeter,reading_date)
  values(new.id, upper(trim(new.equipment_serial)), new.reported_hourmeter, new.appointment_date)
  on conflict (appointment_id) do update set
    equipment_serial = excluded.equipment_serial,
    hourmeter = excluded.hourmeter,
    reading_date = excluded.reading_date,
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists appointments_touch_updated_at on public.appointments;
create trigger appointments_touch_updated_at before update on public.appointments for each row execute function private.touch_updated_at();
drop trigger if exists followups_touch_updated_at on public.followups;
create trigger followups_touch_updated_at before update on public.followups for each row execute function private.touch_updated_at();
drop trigger if exists ai_insights_touch_updated_at on public.ai_insights;
create trigger ai_insights_touch_updated_at before update on public.ai_insights for each row execute function private.touch_updated_at();
drop trigger if exists appointments_sync_hourmeter on public.appointments;
create trigger appointments_sync_hourmeter after insert or update of reported_hourmeter,equipment_serial,appointment_date on public.appointments for each row execute function private.sync_hourmeter_reading();

create or replace function private.refresh_g4_app_cache() returns void
language plpgsql
security definer
set search_path = public, private as $$
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
  join public.app_branches b on b.name = g.filial and b.active = true;

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
$$;

revoke all on function private.refresh_g4_app_cache() from public, anon, authenticated;
revoke all on function private.sync_hourmeter_reading() from public, anon, authenticated;
revoke all on function private.touch_updated_at() from public, anon, authenticated;

select private.refresh_g4_app_cache();

alter table public.app_branches enable row level security;
alter table public.technicians enable row level security;
alter table public.appointments enable row level security;
alter table public.hourmeter_readings enable row level security;
alter table public.followups enable row level security;
alter table public.ai_insights enable row level security;
alter table public.g4_history_app enable row level security;
alter table public.g4_machine_summary enable row level security;
alter table public.g4_client_summary enable row level security;

create policy app_branches_read on public.app_branches for select to anon, authenticated using (true);
create policy technicians_read on public.technicians for select to anon, authenticated using (true);
create policy technicians_write on public.technicians for all to anon, authenticated using (true) with check (true);
create policy appointments_read on public.appointments for select to anon, authenticated using (true);
create policy appointments_write on public.appointments for all to anon, authenticated using (true) with check (true);
create policy hourmeter_read on public.hourmeter_readings for select to anon, authenticated using (true);
create policy followups_read on public.followups for select to anon, authenticated using (true);
create policy followups_write on public.followups for all to anon, authenticated using (true) with check (true);
create policy ai_insights_read on public.ai_insights for select to anon, authenticated using (true);
create policy ai_insights_write on public.ai_insights for all to anon, authenticated using (true) with check (true);
create policy g4_history_app_read on public.g4_history_app for select to anon, authenticated using (true);
create policy g4_machine_summary_read on public.g4_machine_summary for select to anon, authenticated using (true);
create policy g4_client_summary_read on public.g4_client_summary for select to anon, authenticated using (true);

grant usage on schema public to anon, authenticated;
grant select on public.app_branches, public.g4_history_app, public.g4_machine_summary, public.g4_client_summary, public.hourmeter_readings to anon, authenticated;
grant select, insert, update, delete on public.technicians, public.appointments, public.followups, public.ai_insights to anon, authenticated;
