-- Cidade de atendimento informada pelo consultor (Visita 150h e Campanhas).
-- A cidade do G4 só vale como sugestão quando é diferente do nome da filial.

alter table public.inspection_150h add column if not exists service_city text;
alter table public.campaign_machines add column if not exists service_city text;

drop function if exists public.update_service_program(text, text, text, date, date, text);

create or replace function public.update_service_program(
  p_actor text,
  p_kind text,
  p_id text,
  p_programmed date,
  p_executed date,
  p_notes text,
  p_city text default null
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
      service_city = nullif(trim(p_city), ''),
      updated_at = now()
    where pin = p_id;
  elsif p_kind = 'campanha' then
    update campaign_machines set
      programmed_by_agenda = programmed_by_agenda and programmed_date is not distinct from v_programmed,
      executed_by_agenda = executed_by_agenda and executed_date is not distinct from p_executed,
      programmed_date = v_programmed,
      executed_date = p_executed,
      notes = nullif(trim(p_notes), ''),
      service_city = nullif(trim(p_city), ''),
      updated_at = now()
    where id = p_id::uuid;
  else
    raise exception 'tipo inválido: %', p_kind;
  end if;

  if not found then raise exception 'registro não encontrado'; end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.update_service_program(text,text,text,date,date,text,text) from public;
grant execute on function public.update_service_program(text,text,text,date,date,text,text) to anon, authenticated;
