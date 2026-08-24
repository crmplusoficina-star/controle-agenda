drop policy if exists technicians_write on public.technicians;
create policy technicians_insert on public.technicians for insert to anon, authenticated with check (true);
create policy technicians_update on public.technicians for update to anon, authenticated using (true) with check (true);
create policy technicians_delete on public.technicians for delete to anon, authenticated using (true);

drop policy if exists appointments_write on public.appointments;
create policy appointments_insert on public.appointments for insert to anon, authenticated with check (true);
create policy appointments_update on public.appointments for update to anon, authenticated using (true) with check (true);
create policy appointments_delete on public.appointments for delete to anon, authenticated using (true);

drop policy if exists followups_write on public.followups;
create policy followups_insert on public.followups for insert to anon, authenticated with check (true);
create policy followups_update on public.followups for update to anon, authenticated using (true) with check (true);
create policy followups_delete on public.followups for delete to anon, authenticated using (true);

drop policy if exists ai_insights_write on public.ai_insights;
create policy ai_insights_insert on public.ai_insights for insert to anon, authenticated with check (true);
create policy ai_insights_update on public.ai_insights for update to anon, authenticated using (true) with check (true);
create policy ai_insights_delete on public.ai_insights for delete to anon, authenticated using (true);

create index if not exists ai_insights_appointment_idx on public.ai_insights(appointment_id);
create index if not exists ai_insights_technician_idx on public.ai_insights(technician_id);

do $$
begin
  if exists (select 1 from pg_namespace where nspname='extensions') then
    alter extension pg_trgm set schema extensions;
  end if;
end $$;
