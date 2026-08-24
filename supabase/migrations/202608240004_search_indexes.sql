create extension if not exists pg_trgm;
create index if not exists g4_machine_summary_serial_trgm_idx on public.g4_machine_summary using gin (serial gin_trgm_ops);
create index if not exists g4_machine_summary_client_trgm_idx on public.g4_machine_summary using gin (client_name gin_trgm_ops);
create index if not exists g4_machine_summary_city_trgm_idx on public.g4_machine_summary using gin (city gin_trgm_ops);
