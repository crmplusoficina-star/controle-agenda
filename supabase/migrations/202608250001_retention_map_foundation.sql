alter table public.app_branches add column if not exists address text;

update public.app_branches set address = case name
  when 'MARITUBA' then 'Rodovia BR-316, KM 20, S/N, Riacho Doce, Marituba - PA, Brasil'
  when 'MARABA' then 'Rodovia BR-155, S/N, Lotes 5 e 6, Distrito Industrial, Marabá - PA, Brasil'
  when 'MANAUS' then 'Avenida Torquato Tapajós, 11670, Santa Etelvina, Manaus - AM, Brasil'
  when 'BALSAS' then 'Avenida Governador Luiz Rocha, 9, Balsas - MA, Brasil'
  when 'IMPERATRIZ' then 'BR-010, S/N, KM 1345, Portão da Amazônia, Imperatriz - MA, Brasil'
  when 'ITAITINGA' then 'BR-116, KM 22, 13862, Jibóia, Itaitinga - CE, Brasil'
  when 'SAO LUIS' then 'Avenida Engenheiro Emiliano, BR-135, 2, Rio Grande, São Luís - MA, Brasil'
  when 'TERESINA' then 'Avenida Prefeito Wall Ferraz, 1500, Angelim, Teresina - PI, Brasil'
  when 'MIRITITUBA' then 'Rodovia Transamazônica, S/N, KM 1, Setor 2, Quadra 10, Lote 0989, Miritituba, Itaituba - PA, Brasil'
  else address
end
where name in ('MARITUBA','MARABA','MANAUS','BALSAS','IMPERATRIZ','ITAITINGA','SAO LUIS','TERESINA','MIRITITUBA');

create table if not exists public.map_location_cache (
  cache_key text primary key,
  query text not null,
  lat double precision not null,
  lng double precision not null,
  display_name text,
  precision text not null default 'address',
  source text not null default 'nominatim',
  updated_at timestamptz not null default now()
);

alter table public.map_location_cache enable row level security;
revoke all on table public.map_location_cache from anon, authenticated;
create index if not exists map_location_cache_updated_idx on public.map_location_cache(updated_at desc);
