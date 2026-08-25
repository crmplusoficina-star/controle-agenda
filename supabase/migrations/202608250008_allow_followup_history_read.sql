grant select on table public.followup_updates to anon, authenticated;

drop policy if exists followup_updates_read on public.followup_updates;
create policy followup_updates_read
on public.followup_updates
for select
to anon, authenticated
using (true);
