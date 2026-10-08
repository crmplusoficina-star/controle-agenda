-- Sininho: volta a guardar as oportunidades da ArIA (campanha/150h) e bloqueia o insight genérico
-- "Clientes ao longo da agenda". O quadro dentro do formulário continua igual.

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
      where public._campaign_matches(v_serial, c.pin, c.serial_number, c.model)
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
            where public._campaign_matches(v_serial, c.pin, c.serial_number, c.model) and c.executed_date is null
              and coalesce(new.service_reason, '') <> 'Campanha de campo'
          ) x;
          if v_exact is not null then
            insert into public.ai_insights(appointment_id, technician_id, branch, insight_type, priority, presentation_level, title, message, rationale, fingerprint, generated_by, expires_at)
            values (new.id, new.technician_id, new.branch, 'alerta', 'alta', 3,
                    'ArIA: oportunidade nesta máquina',
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
                and not public._campaign_matches(v_serial, c.pin, c.serial_number, c.model)
            ) y
          ) x;
          if v_city_count > 0 then
            insert into public.ai_insights(appointment_id, technician_id, branch, insight_type, priority, presentation_level, title, message, rationale, fingerprint, generated_by, expires_at)
            values (new.id, new.technician_id, new.branch, 'comercial', 'normal', 2,
                    'ArIA: pendências na mesma cidade',
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

create or replace function private.block_generic_insights()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.title = 'Clientes ao longo da agenda' then
    return null;
  end if;
  return new;
end $$;

drop trigger if exists ai_insights_block_generic on public.ai_insights;
create trigger ai_insights_block_generic
before insert on public.ai_insights
for each row execute function private.block_generic_insights();

delete from public.ai_insights where title = 'Clientes ao longo da agenda';
