create or replace function private.sync_hourmeter_reading() returns trigger
language plpgsql
security definer
set search_path = public as $$
begin
  if new.reported_hourmeter is null or nullif(trim(coalesce(new.equipment_serial,'')), '') is null then
    delete from public.hourmeter_readings where appointment_id = new.id;
    return new;
  end if;
  insert into public.hourmeter_readings(appointment_id,equipment_serial,hourmeter,reading_date)
  values(new.id, upper(trim(new.equipment_serial)), new.reported_hourmeter, new.appointment_date)
  on conflict (appointment_id) do update set
    equipment_serial = excluded.equipment_serial,
    hourmeter = excluded.hourmeter,
    reading_date = excluded.reading_date,
    updated_at = now();
  return new;
end;
$$;
revoke all on function private.sync_hourmeter_reading() from public, anon, authenticated;
