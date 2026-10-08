-- Sugestões de campanha/150h ficam só dentro do formulário do atendimento (não no sininho).
-- O gatilho mantém apenas o preenchimento automático das datas pela agenda.

create or replace function private.sync_service_programs()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_serial text := upper(trim(coalesce(new.equipment_serial, '')));
  v_done boolean := new.status = 'concluido';
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

  return new;
end $$;

delete from public.ai_insights where fingerprint like 'pend|%';
