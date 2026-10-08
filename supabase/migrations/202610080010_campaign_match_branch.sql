-- Campanha: aceita também série + mesma filial (o PIN do G4 nem sempre traz o modelo, ex.: A45J = VCE0A1CJ...).
-- O PIN encontrado é gravado na campanha e passa a valer o casamento exato.

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
  set client_name = coalesce(c.client_name, x.client_name),
      city = coalesce(c.city, x.city),
      pin = coalesce(c.pin, x.serial)
  from (
    select distinct on (c2.id) c2.id, m.serial, m.client_name, m.city
    from public.campaign_machines c2
    join public.g4_machine_summary m
      on public._campaign_matches(m.serial, c2.pin, c2.serial_number, c2.model)
      or (c2.pin is null
          and length(trim(c2.serial_number)) >= 4
          and upper(trim(m.serial)) like '%' || upper(trim(c2.serial_number))
          and upper(trim(m.branch)) = upper(trim(c2.branch)))
    where c2.client_name is null or c2.city is null or c2.pin is null
    order by c2.id, (m.serial = c2.pin) desc, public._campaign_matches(m.serial, c2.pin, c2.serial_number, c2.model) desc, m.last_service_at desc nulls last
  ) x
  where c.id = x.id;

  return v_count;
end $$;

update public.campaign_machines set client_name = null, city = null where pin is null;
select private.refresh_inspection_150h();
