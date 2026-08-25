do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'followups_simple_flow_check') then
    alter table public.followups add constraint followups_simple_flow_check check (
      (stage in ('prospectar','acompanhar') and result is null and sale_kind is null and parts_value is null and services_value is null)
      or
      (stage = 'encerrar' and result = 'venda_perdida' and sale_kind is null and parts_value is null and services_value is null)
      or
      (stage = 'encerrar' and result = 'venda_ganha' and sale_kind is not null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'followups_sale_values_match_kind_check') then
    alter table public.followups add constraint followups_sale_values_match_kind_check check (
      sale_kind is null
      or (sale_kind = 'pecas' and services_value is null)
      or (sale_kind = 'servicos' and parts_value is null)
      or sale_kind = 'pecas_servicos'
    );
  end if;
end $$;
