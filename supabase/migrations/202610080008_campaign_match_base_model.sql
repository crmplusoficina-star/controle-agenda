-- Casamento campanha x máquina pela parte principal do modelo (A45J -> A45, L60H -> L60, EC750D -> EC750),
-- porque o PIN do G4 nem sempre traz o sufixo do modelo.

create or replace function public._campaign_matches(p_equipment text, p_pin text, p_serial_number text, p_model text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(
    upper(trim(p_equipment)) = upper(trim(p_pin))
    or (length(trim(coalesce(p_serial_number, ''))) >= 4
        and coalesce(substring(replace(upper(trim(p_model)), '-', '') from '^[A-Z]+[0-9]+'), '') <> ''
        and upper(trim(p_equipment)) like '%' || upper(trim(p_serial_number))
        and upper(trim(p_equipment)) like '%' || substring(replace(upper(trim(p_model)), '-', '') from '^[A-Z]+[0-9]+') || '%'),
    false)
$$;

update public.campaign_machines set client_name = null, city = null where pin is null;
select private.refresh_inspection_150h();
