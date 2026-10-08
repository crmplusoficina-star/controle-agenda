-- Gestão de usuários pela tela "Usuários e acessos".
-- O app usa login só por matrícula; estas funções exigem que p_actor seja admin ativo.
-- "Apagar" = desativar (preserva histórico de follow-ups e agendas).

-- Nomes exibidos hoje vinham de uma lista fixa no código; o banco passa a ser a fonte.
update public.app_users u set name = v.name
from (values
  ('19124','Alisson Mafra'), ('19103','Hamilton Matias'), ('44033','Delmiro Neto'),
  ('19115','Vinicius Furtado'), ('4629','Tiago Gomes'), ('4846','Lana Freitas'),
  ('44031','Alex Barbosa'), ('4595','Thauana Matos')
) as v(matricula, name)
where u.matricula = v.matricula and u.name is distinct from v.name;

create or replace function public._assert_app_admin(p_actor text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from app_users
    where matricula = regexp_replace(coalesce(p_actor, ''), '\D', '', 'g')
      and role = 'admin' and active
  ) then
    raise exception 'acesso restrito ao perfil admin';
  end if;
end $$;

create or replace function public.admin_save_user(
  p_actor text,
  p_matricula text,
  p_name text,
  p_role text,
  p_branches text[] default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mat text := regexp_replace(coalesce(p_matricula, ''), '\D', '', 'g');
  v_name text := nullif(trim(p_name), '');
  v_role text := lower(trim(coalesce(p_role, '')));
  v_targets text[];
  v_b text;
begin
  perform public._assert_app_admin(p_actor);

  if v_mat = '' then raise exception 'matrícula inválida'; end if;
  if v_name is null then raise exception 'nome obrigatório'; end if;
  if v_role not in ('consultor','gestor','admin') then raise exception 'perfil inválido: %', v_role; end if;

  if v_mat = regexp_replace(p_actor, '\D', '', 'g') and v_role <> 'admin' then
    raise exception 'você não pode remover o seu próprio perfil admin';
  end if;

  if v_role = 'consultor' then
    select coalesce(array_agg(distinct public._norm_branch_name(x)), '{}')
      into v_targets from unnest(coalesce(p_branches, '{}')) x
      where nullif(trim(x), '') is not null;
    if cardinality(v_targets) = 0 then raise exception 'consultor precisa de pelo menos 1 filial'; end if;
    foreach v_b in array v_targets loop
      if not exists (select 1 from app_branches where name = v_b and active) then
        raise exception 'filial inexistente ou inativa: %', v_b;
      end if;
    end loop;
  else
    select coalesce(array_agg(name), '{}') into v_targets from app_branches where active;
  end if;

  insert into app_users(matricula, name, role, active)
  values (v_mat, v_name, v_role, true)
  on conflict (matricula) do update set name = excluded.name, role = excluded.role, active = true;

  delete from app_user_branches where matricula = v_mat and branch <> all(v_targets);
  insert into app_user_branches(matricula, branch)
  select v_mat, unnest(v_targets)
  on conflict do nothing;

  return jsonb_build_object('matricula', v_mat, 'name', v_name, 'role', v_role, 'branches', to_jsonb(v_targets));
end $$;

create or replace function public.admin_set_user_active(
  p_actor text,
  p_matricula text,
  p_active boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mat text := regexp_replace(coalesce(p_matricula, ''), '\D', '', 'g');
begin
  perform public._assert_app_admin(p_actor);

  if not exists (select 1 from app_users where matricula = v_mat) then
    raise exception 'usuário não encontrado: %', v_mat;
  end if;
  if not p_active and v_mat = regexp_replace(p_actor, '\D', '', 'g') then
    raise exception 'você não pode desativar a si mesmo';
  end if;

  update app_users set active = p_active where matricula = v_mat;
  return jsonb_build_object('matricula', v_mat, 'active', p_active);
end $$;

revoke all on function public._assert_app_admin(text) from public, anon, authenticated;
revoke all on function public.admin_save_user(text,text,text,text,text[]) from public;
revoke all on function public.admin_set_user_active(text,text,boolean) from public;
grant execute on function public.admin_save_user(text,text,text,text,text[]) to anon, authenticated;
grant execute on function public.admin_set_user_active(text,text,boolean) to anon, authenticated;
