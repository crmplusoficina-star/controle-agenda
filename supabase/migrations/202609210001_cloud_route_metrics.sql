create extension if not exists pgcrypto;
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

create table if not exists public.agenda_route_source_technicians (
  id uuid primary key,
  branch text not null,
  name text not null,
  active boolean not null default true,
  source_seen_at timestamptz not null default now()
);

create table if not exists public.agenda_route_source_appointments (
  id uuid primary key,
  branch text not null,
  appointment_date date not null,
  technician_id uuid not null,
  client_name text,
  equipment_serial text,
  service_city text,
  service_reason text,
  description text,
  created_at timestamptz,
  updated_at timestamptz,
  source_seen_at timestamptz not null default now()
);
create index if not exists agenda_route_source_appointments_tech_date_idx
  on public.agenda_route_source_appointments(technician_id, appointment_date);
create index if not exists agenda_route_source_appointments_updated_idx
  on public.agenda_route_source_appointments(updated_at);

create table if not exists public.agenda_route_branch_locations (
  branch text primary key,
  label text not null,
  lat double precision not null,
  lng double precision not null,
  updated_at timestamptz not null default now()
);

insert into public.agenda_route_branch_locations(branch,label,lat,lng) values
  ('BALSAS','Filial BALSAS',-7.5325,-46.0356),
  ('IMPERATRIZ','Filial IMPERATRIZ',-5.5264,-47.4917),
  ('ITAITINGA','Filial ITAITINGA',-3.9694,-38.5288),
  ('SAO LUIS','Filial SAO LUIS',-2.5307,-44.3068),
  ('TERESINA','Filial TERESINA',-5.0892,-42.8019),
  ('MARITUBA','Filial MARITUBA',-1.3550,-48.3420),
  ('MARABA','Filial MARABA',-5.3686,-49.1178),
  ('MIRITITUBA','Filial MIRITITUBA',-4.2760,-55.9830),
  ('MANAUS','Filial MANAUS',-3.1190,-60.0217)
on conflict (branch) do update set
  label=excluded.label,
  lat=excluded.lat,
  lng=excluded.lng,
  updated_at=now();

create table if not exists public.agenda_route_location_cache (
  location_key text primary key,
  city text not null,
  state text not null,
  lat double precision not null,
  lng double precision not null,
  source text not null default 'open-meteo',
  updated_at timestamptz not null default now()
);

create table if not exists public.agenda_route_segment_cache (
  segment_key text primary key,
  origin_label text not null,
  destination_label text not null,
  origin_lat double precision not null,
  origin_lng double precision not null,
  destination_lat double precision not null,
  destination_lng double precision not null,
  distance_km numeric(12,1) not null,
  duration_min integer not null,
  provider text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.agenda_route_metrics (
  appointment_id uuid primary key references public.agenda_route_source_appointments(id) on delete cascade,
  technician_id uuid not null,
  appointment_date date not null,
  week_start date not null,
  origin_kind text not null default 'unknown',
  origin_appointment_id uuid,
  origin_label text,
  destination_label text,
  destination_city text,
  destination_state text,
  distance_km numeric(12,1),
  duration_min integer,
  status text not null check (status in ('ready','location_missing','route_unavailable','ignored')),
  provider text,
  segment_key text,
  calculated_at timestamptz not null default now(),
  source_updated_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists agenda_route_metrics_tech_date_idx
  on public.agenda_route_metrics(technician_id, appointment_date);
create index if not exists agenda_route_metrics_week_idx
  on public.agenda_route_metrics(week_start, technician_id);

create table if not exists public.agenda_route_recalc_queue (
  technician_id uuid not null,
  week_start date not null,
  reason text,
  enqueued_at timestamptz not null default now(),
  attempts integer not null default 0,
  locked_at timestamptz,
  lock_token uuid,
  last_error text,
  primary key (technician_id, week_start)
);
create index if not exists agenda_route_recalc_queue_ready_idx
  on public.agenda_route_recalc_queue(locked_at, enqueued_at);

create table if not exists public.agenda_route_sync_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.agenda_route_sync_state(key,value)
values ('worker_secret', jsonb_build_object('secret', encode(gen_random_bytes(32),'hex')))
on conflict (key) do nothing;

create or replace function public.enqueue_agenda_route_week(
  p_technician_id uuid,
  p_appointment_date date,
  p_reason text default 'appointment_changed'
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week date;
begin
  if p_technician_id is null or p_appointment_date is null then
    return;
  end if;
  v_week := date_trunc('week', p_appointment_date::timestamp)::date;
  insert into public.agenda_route_recalc_queue(
    technician_id, week_start, reason, enqueued_at, attempts, locked_at, lock_token, last_error
  ) values (
    p_technician_id, v_week, p_reason, now(), 0, null, null, null
  )
  on conflict (technician_id, week_start) do update set
    reason = excluded.reason,
    enqueued_at = now(),
    attempts = 0,
    locked_at = null,
    lock_token = null,
    last_error = null;
end;
$$;

create or replace function public.agenda_route_source_queue_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.enqueue_agenda_route_week(new.technician_id, new.appointment_date, 'appointment_inserted');
    return new;
  elsif tg_op = 'DELETE' then
    perform public.enqueue_agenda_route_week(old.technician_id, old.appointment_date, 'appointment_deleted');
    return old;
  end if;

  if (
    old.branch,
    old.appointment_date,
    old.technician_id,
    old.client_name,
    old.equipment_serial,
    old.service_city,
    old.service_reason,
    old.description,
    old.created_at,
    old.updated_at
  ) is distinct from (
    new.branch,
    new.appointment_date,
    new.technician_id,
    new.client_name,
    new.equipment_serial,
    new.service_city,
    new.service_reason,
    new.description,
    new.created_at,
    new.updated_at
  ) then
    perform public.enqueue_agenda_route_week(old.technician_id, old.appointment_date, 'appointment_moved_from');
    perform public.enqueue_agenda_route_week(new.technician_id, new.appointment_date, 'appointment_updated');
  end if;
  return new;
end;
$$;

drop trigger if exists agenda_route_source_queue on public.agenda_route_source_appointments;
create trigger agenda_route_source_queue
after insert or update or delete on public.agenda_route_source_appointments
for each row execute function public.agenda_route_source_queue_trigger();

create or replace function public.claim_agenda_route_jobs(p_limit integer default 25)
returns table (
  technician_id uuid,
  week_start date,
  lock_token uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select q.technician_id, q.week_start
    from public.agenda_route_recalc_queue q
    where q.locked_at is null or q.locked_at < now() - interval '10 minutes'
    order by q.enqueued_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit,25),100))
  ),
  claimed as (
    update public.agenda_route_recalc_queue q
    set locked_at = now(),
        lock_token = gen_random_uuid(),
        attempts = q.attempts + 1
    from picked p
    where q.technician_id = p.technician_id
      and q.week_start = p.week_start
    returning q.technician_id, q.week_start, q.lock_token
  )
  select c.technician_id, c.week_start, c.lock_token from claimed c;
end;
$$;

revoke all on function public.enqueue_agenda_route_week(uuid,date,text) from public, anon, authenticated;
revoke all on function public.agenda_route_source_queue_trigger() from public, anon, authenticated;
revoke all on function public.claim_agenda_route_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_agenda_route_jobs(integer) to service_role;

alter table public.agenda_route_source_technicians enable row level security;
alter table public.agenda_route_source_appointments enable row level security;
alter table public.agenda_route_branch_locations enable row level security;
alter table public.agenda_route_location_cache enable row level security;
alter table public.agenda_route_segment_cache enable row level security;
alter table public.agenda_route_metrics enable row level security;
alter table public.agenda_route_recalc_queue enable row level security;
alter table public.agenda_route_sync_state enable row level security;

drop policy if exists agenda_route_metrics_read on public.agenda_route_metrics;
create policy agenda_route_metrics_read
on public.agenda_route_metrics for select
to anon, authenticated
using (true);

grant select on public.agenda_route_metrics to anon, authenticated;
revoke all on public.agenda_route_source_technicians,
  public.agenda_route_source_appointments,
  public.agenda_route_branch_locations,
  public.agenda_route_location_cache,
  public.agenda_route_segment_cache,
  public.agenda_route_recalc_queue,
  public.agenda_route_sync_state
from anon, authenticated;

do $$
declare
  v_job record;
begin
  for v_job in select jobid from cron.job where jobname = 'agenda-route-worker-every-minute' loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end $$;

select cron.schedule(
  'agenda-route-worker-every-minute',
  '* * * * *',
  $cron$
  select net.http_post(
    url := 'https://lwowtuspbrnbaukakyss.supabase.co/functions/v1/agenda-route-worker',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := jsonb_build_object(
      'mode','scheduled',
      'worker_secret',(select value->>'secret' from public.agenda_route_sync_state where key='worker_secret')
    )
  );
  $cron$
);
