insert into public.agenda_share_recipients (name, email, active, sort_order)
values
  ('Hamilton Matias', 'hamilton.santos@tracbel.com.br', true, 130),
  ('Delmiro Neto', 'delmiro.neto@tracbel.com.br', true, 140)
on conflict (email) do update
set name = excluded.name,
    active = excluded.active,
    sort_order = excluded.sort_order;
