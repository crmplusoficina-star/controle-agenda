-- Cadastro de filial e usuário (app_branches, app_users, app_user_branches).
-- Compatível com src/session.tsx: matrícula só com dígitos, filial em MAIÚSCULAS sem acento,
-- consultor precisa de pelo menos 1 filial ativa. Execução restrita ao service_role.

create or replace function public._norm_branch_name(p text)
returns text
language sql
immutable
set search_path = public
as $$
  select upper(trim(translate(p,
    'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
    'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn')))
$$;

create or replace function public.register_branch_and_user(
  p_branch_name text default null,
  p_branch_address text default null,
  p_matricula text default null,
  p_user_name text default null,
  p_role text default null,        -- null: 'consultor' ao criar; em usuário existente mantém o role atual
  p_branches text[] default null   -- filiais do usuário; novo gestor/admin sem lista = todas as ativas
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch text;
  v_mat text;
  v_role_in text := nullif(lower(trim(p_role)), '');
  v_role text;
  v_targets text[];
  v_b text;
  v_new_user boolean;
begin
  if v_role_in is not null and v_role_in not in ('consultor','gestor','admin') then
    raise exception 'role inválido: %', v_role_in;
  end if;

  if p_branch_name is not null then
    v_branch := public._norm_branch_name(p_branch_name);
    if v_branch = '' then raise exception 'nome de filial vazio'; end if;
    insert into app_branches(name, address, active)
    values (v_branch, nullif(trim(p_branch_address), ''), true)
    on conflict (name) do update
      set active = true,
          address = coalesce(nullif(trim(p_branch_address), ''), app_branches.address);
  end if;

  if p_matricula is not null then
    v_mat := regexp_replace(p_matricula, '\D', '', 'g');
    if v_mat = '' then raise exception 'matrícula inválida'; end if;

    v_new_user := not exists (select 1 from app_users where matricula = v_mat);
    if v_new_user and nullif(trim(p_user_name), '') is null then
      raise exception 'nome do usuário obrigatório para novo cadastro';
    end if;

    insert into app_users(matricula, name, role, active)
    values (v_mat, coalesce(nullif(trim(p_user_name), ''), (select name from app_users where matricula = v_mat)), coalesce(v_role_in, 'consultor'), true)
    on conflict (matricula) do update
      set name = coalesce(nullif(trim(p_user_name), ''), app_users.name),
          role = coalesce(v_role_in, app_users.role),
          active = true;

    select role into v_role from app_users where matricula = v_mat;

    if p_branches is not null then
      select array_agg(public._norm_branch_name(x)) into v_targets from unnest(p_branches) x;
    elsif v_branch is not null and v_role = 'consultor' then
      v_targets := array[v_branch];
    elsif v_new_user and v_role in ('gestor','admin') then
      select array_agg(name) into v_targets from app_branches where active;
    end if;

    foreach v_b in array coalesce(v_targets, '{}') loop
      if not exists (select 1 from app_branches where name = v_b and active) then
        raise exception 'filial inexistente ou inativa: %', v_b;
      end if;
      insert into app_user_branches(matricula, branch) values (v_mat, v_b) on conflict do nothing;
    end loop;

    if v_role = 'consultor' and not exists (
      select 1 from app_user_branches ub join app_branches b on b.name = ub.branch
      where ub.matricula = v_mat and b.active
    ) then
      raise exception 'consultor % precisa de pelo menos 1 filial ativa', v_mat;
    end if;
  end if;

  -- filial nova/reativada: vincula gestores e admins ativos (padrão da migration 202608250007)
  if v_branch is not null then
    insert into app_user_branches(matricula, branch)
    select matricula, v_branch from app_users where role in ('gestor','admin') and active
    on conflict do nothing;
  end if;

  return jsonb_build_object('branch', v_branch, 'matricula', v_mat, 'role', v_role);
end $$;

revoke all on function public._norm_branch_name(text) from public, anon, authenticated;
revoke all on function public.register_branch_and_user(text,text,text,text,text,text[]) from public, anon, authenticated;
grant execute on function public.register_branch_and_user(text,text,text,text,text,text[]) to service_role;
