-- Visita 150h (máquinas com Entrega Técnica a partir de 01/08/2026) e Campanhas de campo.
-- Status (regra da planilha): sem programação -> "Pendente de programação";
-- sem execução -> "Pendente execução"; senão "Concluído".
-- Datas: preenchidas pela agenda ("Visita 150h" / "Campanha de campo") e editáveis à mão.

create table if not exists public.inspection_150h (
  pin text primary key,
  branch text not null,
  client_name text,
  city text,
  brand text,
  model text,
  delivery_date date not null,
  source_os_g4 text,
  programmed_date date,
  programmed_by_agenda boolean not null default false,
  executed_date date,
  executed_by_agenda boolean not null default false,
  appointment_id uuid references public.appointments(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists inspection_150h_branch_idx on public.inspection_150h(branch);

create table if not exists public.service_campaigns (
  code text primary key,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.campaign_machines (
  id uuid primary key default gen_random_uuid(),
  campaign_code text not null references public.service_campaigns(code) on update cascade on delete cascade,
  branch text not null,
  model text not null,
  serial_number text not null,
  pin text,
  recommendation text not null default 'Recommended',
  client_name text,
  city text,
  programmed_date date,
  programmed_by_agenda boolean not null default false,
  executed_date date,
  executed_by_agenda boolean not null default false,
  appointment_id uuid references public.appointments(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_code, model, serial_number)
);
create index if not exists campaign_machines_branch_idx on public.campaign_machines(branch);

alter table public.inspection_150h enable row level security;
alter table public.service_campaigns enable row level security;
alter table public.campaign_machines enable row level security;
drop policy if exists inspection_150h_read on public.inspection_150h;
drop policy if exists service_campaigns_read on public.service_campaigns;
drop policy if exists campaign_machines_read on public.campaign_machines;
create policy inspection_150h_read on public.inspection_150h for select to anon, authenticated using (true);
create policy service_campaigns_read on public.service_campaigns for select to anon, authenticated using (true);
create policy campaign_machines_read on public.campaign_machines for select to anon, authenticated using (true);
grant select on public.inspection_150h, public.service_campaigns, public.campaign_machines to anon, authenticated;

create or replace function public._norm_text(p text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(upper(trim(translate(coalesce(p, ''),
    'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
    'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn'))), '')
$$;

create or replace function public._campaign_matches(p_equipment text, p_pin text, p_serial_number text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(
    upper(trim(p_equipment)) = upper(trim(p_pin))
    or (length(trim(coalesce(p_serial_number, ''))) >= 4
        and upper(trim(p_equipment)) like '%' || upper(trim(p_serial_number))),
    false)
$$;

-- Carga/atualização da lista de 150h a partir do G4 (rodar após cada troca da base G4).
create or replace function private.refresh_inspection_150h()
returns integer
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_count integer;
begin
  insert into public.inspection_150h(pin, branch, client_name, city, brand, delivery_date, source_os_g4)
  select pin, branch, client_name, city,
         case when pin like 'VCE%' then 'VOLVO CE' when pin like 'BCE%' then 'BULL' end,
         delivery_date, codigo_os_g4
  from (
    select distinct on (upper(trim(g.numero_serie)))
      upper(trim(g.numero_serie)) as pin,
      trim(g.filial) as branch,
      nullif(trim(g.razao_social), '') as client_name,
      nullif(trim(coalesce(g.cidade_contato, g.cidade)), '') as city,
      coalesce(g.data_fechamento, g.data_inicio, g.data_abertura)::date as delivery_date,
      g.codigo_os_g4
    from public.g4_ordens_servico g
    where upper(coalesce(g.tipo_de_operacao, '')) like '%ENTREGA T%'
      and coalesce(g.status, '') <> 'Cancelada'
      and nullif(trim(g.numero_serie), '') is not null
      and nullif(trim(g.filial), '') is not null
      and coalesce(g.data_fechamento, g.data_inicio, g.data_abertura) >= date '2026-08-01'
    order by upper(trim(g.numero_serie)), coalesce(g.data_fechamento, g.data_inicio, g.data_abertura) desc
  ) et
  on conflict (pin) do update set
    branch = excluded.branch,
    client_name = coalesce(excluded.client_name, inspection_150h.client_name),
    city = coalesce(excluded.city, inspection_150h.city),
    brand = coalesce(inspection_150h.brand, excluded.brand),
    updated_at = now();
  get diagnostics v_count = row_count;

  update public.campaign_machines c
  set client_name = coalesce(c.client_name, m.client_name),
      city = coalesce(c.city, m.city)
  from public.g4_machine_summary m
  where (c.client_name is null or c.city is null)
    and public._campaign_matches(m.serial, c.pin, c.serial_number);

  return v_count;
end $$;

-- Vínculo com a agenda + sugestões no sininho. Nunca bloqueia o salvamento do atendimento.
create or replace function private.sync_service_programs()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_serial text := upper(trim(coalesce(new.equipment_serial, '')));
  v_city text := public._norm_text(new.service_city);
  v_done boolean := new.status = 'concluido';
  v_exact text;
  v_city_list text;
  v_city_count integer;
begin
  begin
    if new.service_reason = 'Visita 150h' and v_serial <> '' then
      update public.inspection_150h set
        programmed_date = case when programmed_date is null or programmed_by_agenda then new.appointment_date else programmed_date end,
        programmed_by_agenda = case when programmed_date is null or programmed_by_agenda then true else programmed_by_agenda end,
        executed_date = case when v_done and (executed_date is null or executed_by_agenda) then new.appointment_date
                             when not v_done and executed_by_agenda and appointment_id = new.id then null
                             else executed_date end,
        executed_by_agenda = case when v_done and (executed_date is null or executed_by_agenda) then true
                                  when not v_done and executed_by_agenda and appointment_id = new.id then false
                                  else executed_by_agenda end,
        appointment_id = new.id,
        updated_at = now()
      where pin = v_serial;
    end if;

    if new.service_reason = 'Campanha de campo' and v_serial <> '' then
      update public.campaign_machines c set
        programmed_date = case when programmed_date is null or programmed_by_agenda then new.appointment_date else programmed_date end,
        programmed_by_agenda = case when programmed_date is null or programmed_by_agenda then true else programmed_by_agenda end,
        executed_date = case when v_done and (executed_date is null or executed_by_agenda) then new.appointment_date
                             when not v_done and executed_by_agenda and appointment_id = new.id then null
                             else executed_date end,
        executed_by_agenda = case when v_done and (executed_date is null or executed_by_agenda) then true
                                  when not v_done and executed_by_agenda and appointment_id = new.id then false
                                  else executed_by_agenda end,
        appointment_id = new.id,
        updated_at = now()
      where public._campaign_matches(v_serial, c.pin, c.serial_number)
        and exists (select 1 from public.service_campaigns s where s.code = c.campaign_code and s.active);
    end if;
  exception when others then
    raise warning 'sync_service_programs (agenda): %', sqlerrm;
  end;

  begin
    if tg_op = 'INSERT'
       or new.equipment_serial is distinct from old.equipment_serial
       or new.service_city is distinct from old.service_city then
      if coalesce(new.service_reason, '') not in ('Férias','Folga','Sem agenda','Treinamento','Manutenção carro','Retorno à filial') then

        if v_serial <> '' then
          select string_agg(item, '; ') into v_exact from (
            select 'Inspeção 150h pendente (ET ' || to_char(i.delivery_date, 'DD/MM/YYYY') || ')' as item
            from public.inspection_150h i
            where i.pin = v_serial and i.executed_date is null and coalesce(new.service_reason, '') <> 'Visita 150h'
            union all
            select 'Campanha ' || c.campaign_code || ' pendente'
            from public.campaign_machines c join public.service_campaigns s on s.code = c.campaign_code and s.active
            where public._campaign_matches(v_serial, c.pin, c.serial_number) and c.executed_date is null
              and coalesce(new.service_reason, '') <> 'Campanha de campo'
          ) x;
          if v_exact is not null then
            insert into public.ai_insights(appointment_id, technician_id, branch, insight_type, priority, presentation_level, title, message, rationale, fingerprint, generated_by, expires_at)
            values (new.id, new.technician_id, new.branch, 'alerta', 'alta', 3,
                    'Oportunidade nesta máquina',
                    'Aproveite a visita: ' || v_exact || '.',
                    jsonb_build_object('serial', v_serial, 'pendencias', v_exact),
                    'pend|' || new.id || '|maquina|' || v_serial || '|' || md5(v_exact),
                    'rules', (new.appointment_date + 15)::timestamptz)
            on conflict (fingerprint) do nothing;
          end if;
        end if;

        if v_city is not null then
          select count(*), string_agg(item, '; ') filter (where rn <= 5) into v_city_count, v_city_list from (
            select item, row_number() over () as rn from (
              select coalesce(i.client_name, i.pin) || ' (150h)' as item
              from public.inspection_150h i
              where public._norm_text(i.city) = v_city and i.executed_date is null and i.pin <> v_serial
              union all
              select coalesce(c.client_name, c.model || '-' || c.serial_number) || ' (campanha ' || c.campaign_code || ')'
              from public.campaign_machines c join public.service_campaigns s on s.code = c.campaign_code and s.active
              where public._norm_text(c.city) = v_city and c.executed_date is null
                and not public._campaign_matches(v_serial, c.pin, c.serial_number)
            ) y
          ) x;
          if v_city_count > 0 then
            insert into public.ai_insights(appointment_id, technician_id, branch, insight_type, priority, presentation_level, title, message, rationale, fingerprint, generated_by, expires_at)
            values (new.id, new.technician_id, new.branch, 'comercial', 'normal', 2,
                    'Pendências na mesma cidade',
                    v_city_count || ' máquina(s) com pendência em ' || new.service_city || ': ' || v_city_list || case when v_city_count > 5 then '…' else '' end,
                    jsonb_build_object('city', new.service_city, 'total', v_city_count),
                    'pend|' || new.id || '|cidade|' || v_city || '|' || v_city_count,
                    'rules', (new.appointment_date + 15)::timestamptz)
            on conflict (fingerprint) do nothing;
          end if;
        end if;
      end if;
    end if;
  exception when others then
    raise warning 'sync_service_programs (insights): %', sqlerrm;
  end;

  return new;
end $$;

drop trigger if exists appointments_sync_service_programs on public.appointments;
create trigger appointments_sync_service_programs
after insert or update of service_reason, equipment_serial, service_city, appointment_date, status on public.appointments
for each row execute function private.sync_service_programs();

-- Edição manual (qualquer usuário ativo).
create or replace function public.update_service_program(
  p_actor text,
  p_kind text,
  p_id text,
  p_programmed date,
  p_executed date,
  p_notes text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_programmed date := coalesce(p_programmed, p_executed);
begin
  if not exists (select 1 from app_users where matricula = regexp_replace(coalesce(p_actor, ''), '\D', '', 'g') and active) then
    raise exception 'usuário sem acesso';
  end if;

  if p_kind = '150h' then
    update inspection_150h set
      programmed_by_agenda = programmed_by_agenda and programmed_date is not distinct from v_programmed,
      executed_by_agenda = executed_by_agenda and executed_date is not distinct from p_executed,
      programmed_date = v_programmed,
      executed_date = p_executed,
      notes = nullif(trim(p_notes), ''),
      updated_at = now()
    where pin = p_id;
  elsif p_kind = 'campanha' then
    update campaign_machines set
      programmed_by_agenda = programmed_by_agenda and programmed_date is not distinct from v_programmed,
      executed_by_agenda = executed_by_agenda and executed_date is not distinct from p_executed,
      programmed_date = v_programmed,
      executed_date = p_executed,
      notes = nullif(trim(p_notes), ''),
      updated_at = now()
    where id = p_id::uuid;
  else
    raise exception 'tipo inválido: %', p_kind;
  end if;

  if not found then raise exception 'registro não encontrado'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- Cadastro de campanhas (admin).
create or replace function public.admin_save_campaign_machine(
  p_actor text,
  p_campaign text,
  p_description text,
  p_branch text,
  p_model text,
  p_serial_number text,
  p_pin text default null,
  p_recommendation text default 'Recommended'
) returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_code text := upper(trim(coalesce(p_campaign, '')));
  v_branch text := public._norm_branch_name(p_branch);
  v_id uuid;
begin
  perform public._assert_app_admin(p_actor);
  if v_code = '' or coalesce(trim(p_model), '') = '' or coalesce(trim(p_serial_number), '') = '' then
    raise exception 'campanha, modelo e número de série são obrigatórios';
  end if;
  if not exists (select 1 from app_branches where name = v_branch) then
    raise exception 'filial não encontrada: %', v_branch;
  end if;

  insert into service_campaigns(code, description) values (v_code, nullif(trim(p_description), ''))
  on conflict (code) do update set description = coalesce(excluded.description, service_campaigns.description);

  insert into campaign_machines(campaign_code, branch, model, serial_number, pin, recommendation)
  values (v_code, v_branch, upper(trim(p_model)), upper(trim(p_serial_number)), nullif(upper(trim(p_pin)), ''), coalesce(nullif(trim(p_recommendation), ''), 'Recommended'))
  on conflict (campaign_code, model, serial_number) do update set
    branch = excluded.branch,
    pin = coalesce(excluded.pin, campaign_machines.pin),
    recommendation = excluded.recommendation,
    updated_at = now()
  returning id into v_id;

  perform private.refresh_inspection_150h();
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.admin_delete_campaign_machine(p_actor text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public._assert_app_admin(p_actor);
  delete from campaign_machines where id = p_id;
  return jsonb_build_object('ok', found);
end $$;

revoke all on function public.update_service_program(text,text,text,date,date,text) from public;
revoke all on function public.admin_save_campaign_machine(text,text,text,text,text,text,text,text) from public;
revoke all on function public.admin_delete_campaign_machine(text,uuid) from public;
grant execute on function public.update_service_program(text,text,text,date,date,text) to anon, authenticated;
grant execute on function public.admin_save_campaign_machine(text,text,text,text,text,text,text,text) to anon, authenticated;
grant execute on function public.admin_delete_campaign_machine(text,uuid) to anon, authenticated;
revoke all on function private.refresh_inspection_150h() from public, anon, authenticated;

-- Campanhas iniciais.
insert into public.service_campaigns(code) values ('RA006'), ('RE020'), ('RW013'), ('RW017')
on conflict (code) do nothing;

insert into public.campaign_machines(campaign_code, branch, model, serial_number, pin, notes) values
  ('RA006','OURILANDIA','A45J','730009',null,null),
  ('RA006','OURILANDIA','A45J','730010',null,null),
  ('RA006','OURILANDIA','A45J','730011',null,null),
  ('RA006','OURILANDIA','A45J','730012',null,null),
  ('RA006','OURILANDIA','A45J','730013',null,null),
  ('RA006','OURILANDIA','A45J','730018',null,null),
  ('RA006','OURILANDIA','A45J','730019',null,null),
  ('RA006','OURILANDIA','A45J','730020',null,null),
  ('RE020','MACAPA','EC750D','280884',null,null),
  ('RE020','MACAPA','EC750D','280886',null,null),
  ('RW013','MIRITITUBA','L60H','72136','VCE0L60HKR0072136','Sem ET'),
  ('RW017','MIRITITUBA','L60H','72136','VCE0L60HKR0072136','Sem ET'),
  ('RW013','TERESINA','L60H','72084','VCE0L60HTR0072084',null),
  ('RW017','TERESINA','L60H','72084','VCE0L60HTR0072084',null)
on conflict (campaign_code, model, serial_number) do nothing;

select private.refresh_inspection_150h();
