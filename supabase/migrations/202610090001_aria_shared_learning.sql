-- Aprendizado compartilhado da ArIA: o que cada frase significa (com votos de acerto/erro)
-- e apelidos de técnicos/clientes. Vale para todos os usuários.

create table if not exists public.aria_intent_memory (
  id bigserial primary key,
  phrase_key text not null,
  tokens text[] not null,
  sample text,
  intent text not null,
  positive integer not null default 0,
  negative integer not null default 0,
  users text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  unique (phrase_key, intent)
);

create table if not exists public.aria_aliases (
  id bigserial primary key,
  kind text not null check (kind in ('tech', 'client')),
  alias text not null,
  value text not null,
  extra text,
  uses integer not null default 1,
  created_by text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  unique (kind, alias)
);

alter table public.aria_intent_memory enable row level security;
alter table public.aria_aliases enable row level security;
drop policy if exists aria_intent_memory_read on public.aria_intent_memory;
create policy aria_intent_memory_read on public.aria_intent_memory for select using (true);
drop policy if exists aria_aliases_read on public.aria_aliases;
create policy aria_aliases_read on public.aria_aliases for select using (true);
grant select on public.aria_intent_memory, public.aria_aliases to anon, authenticated;

create or replace function public.aria_intent_feedback(p_actor text, p_tokens text[], p_sample text, p_intent text, p_signal integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := regexp_replace(coalesce(p_actor, ''), '\D', '', 'g');
  v_key text;
begin
  if not exists (select 1 from app_users where matricula = v_actor and active) then raise exception 'usuário sem acesso'; end if;
  if coalesce(array_length(p_tokens, 1), 0) = 0 or coalesce(p_intent, '') = '' then return; end if;
  select string_agg(t, ' ' order by t) into v_key from (select distinct lower(unnest(p_tokens)) t) s;
  insert into aria_intent_memory (phrase_key, tokens, sample, intent, positive, negative, users)
  values (v_key, p_tokens, left(p_sample, 300), p_intent, greatest(p_signal, 0), greatest(-p_signal, 0), array[v_actor])
  on conflict (phrase_key, intent) do update set
    positive = aria_intent_memory.positive + greatest(p_signal, 0),
    negative = aria_intent_memory.negative + greatest(-p_signal, 0),
    users = case when v_actor = any(aria_intent_memory.users) then aria_intent_memory.users else aria_intent_memory.users || v_actor end,
    sample = coalesce(left(p_sample, 300), aria_intent_memory.sample),
    last_used_at = now();
end $$;

create or replace function public.aria_save_alias(p_actor text, p_kind text, p_alias text, p_value text, p_extra text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := regexp_replace(coalesce(p_actor, ''), '\D', '', 'g');
begin
  if not exists (select 1 from app_users where matricula = v_actor and active) then raise exception 'usuário sem acesso'; end if;
  if coalesce(trim(p_alias), '') = '' or coalesce(trim(p_value), '') = '' then return; end if;
  insert into aria_aliases (kind, alias, value, extra, created_by)
  values (p_kind, lower(trim(p_alias)), trim(p_value), p_extra, v_actor)
  on conflict (kind, alias) do update set value = excluded.value, extra = excluded.extra, uses = aria_aliases.uses + 1, last_used_at = now();
end $$;

revoke all on function public.aria_intent_feedback(text, text[], text, text, integer) from public;
revoke all on function public.aria_save_alias(text, text, text, text, text) from public;
grant execute on function public.aria_intent_feedback(text, text[], text, text, integer) to anon, authenticated;
grant execute on function public.aria_save_alias(text, text, text, text, text) to anon, authenticated;
