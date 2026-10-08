-- Sininho: só oportunidades da ArIA (campanha/150h) e "dia sem programação".
-- Bloqueia horímetro, permanência na região, contexto de garantia, histórico e afins.

create or replace function private.block_generic_insights()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(new.fingerprint, '') like 'pend|%' then
    return new;
  end if;
  if coalesce(new.rationale, '{}'::jsonb) ? 'free_date' then
    return new;
  end if;
  return null;
end $$;

delete from public.ai_insights
where coalesce(fingerprint, '') not like 'pend|%'
  and not (coalesce(rationale, '{}'::jsonb) ? 'free_date');
