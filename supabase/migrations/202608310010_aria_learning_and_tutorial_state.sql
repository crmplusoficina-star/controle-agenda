create table if not exists public.aria_user_state (
  matricula text primary key,
  tutorial_completed_at timestamptz,
  tutorial_skipped_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.aria_learning (
  id bigint generated always as identity primary key,
  original_question text not null,
  original_answer text,
  correction text not null,
  normalized_question text not null,
  created_by_matricula text,
  created_by_name text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists aria_learning_normalized_idx on public.aria_learning (normalized_question);
create index if not exists aria_learning_created_at_idx on public.aria_learning (created_at desc);

alter table public.aria_user_state enable row level security;
alter table public.aria_learning enable row level security;

drop policy if exists aria_user_state_read on public.aria_user_state;
drop policy if exists aria_user_state_write on public.aria_user_state;
drop policy if exists aria_learning_read on public.aria_learning;
drop policy if exists aria_learning_write on public.aria_learning;

create policy aria_user_state_read on public.aria_user_state for select to anon, authenticated using (true);
create policy aria_user_state_write on public.aria_user_state for all to anon, authenticated using (true) with check (true);
create policy aria_learning_read on public.aria_learning for select to anon, authenticated using (active = true);
create policy aria_learning_write on public.aria_learning for insert to anon, authenticated with check (true);

grant select, insert, update on public.aria_user_state to anon, authenticated;
grant select, insert on public.aria_learning to anon, authenticated;
grant usage, select on sequence public.aria_learning_id_seq to anon, authenticated;
