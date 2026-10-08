-- TESTE (SQL Editor do agendatendimentos). Tudo dentro de transação com ROLLBACK: nada é gravado.
begin;

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

create temp table _t(n int, caso text, ok boolean, detalhe text) on commit drop;

do $$
declare r jsonb; v text; c int;
begin
  -- 1. filial com acento/minúscula + consultor novo vinculado a ela
  r := register_branch_and_user('  são  teste ', 'Rua X, 1', '99999001', 'Usuário Teste', null, null);
  insert into _t values (1,'filial normalizada + consultor default', r->>'branch'='SAO  TESTE' or r->>'branch'='SAO TESTE', r::text);
  select count(*) into c from app_user_branches where matricula='99999001' and branch like 'SAO%TESTE';
  insert into _t values (2,'vínculo consultor-filial', c=1, c::text);

  -- 2. p_role null em usuário existente NÃO rebaixa
  update app_users set role='gestor' where matricula='99999001';
  perform register_branch_and_user(null,null,'99999001','Usuário Teste 2',null,null);
  select role into v from app_users where matricula='99999001';
  insert into _t values (3,'p_role null não rebaixa gestor', v='gestor', v);

  -- 3. p_role preenchido altera
  perform register_branch_and_user(null,null,'99999001',null,'consultor',null);
  select role into v from app_users where matricula='99999001';
  insert into _t values (4,'p_role explícito altera', v='consultor', v);

  -- 4. normalização em p_branches (acento/minúscula)
  perform register_branch_and_user(null,null,'99999001',null,null,array[' marabá ','são luís']);
  select count(*) into c from app_user_branches where matricula='99999001' and branch in ('MARABA','SAO LUIS');
  insert into _t values (5,'normaliza itens de p_branches', c=2, c::text);

  -- 5. consultor sem filial -> exceção
  begin
    perform register_branch_and_user(null,null,'99999002','Sem Filial',null,null);
    insert into _t values (6,'consultor sem filial rejeitado', false, 'não levantou exceção');
  exception when others then
    insert into _t values (6,'consultor sem filial rejeitado', true, sqlerrm);
  end;
  select count(*) into c from app_users where matricula='99999002';
  insert into _t values (7,'usuário sem filial não ficou gravado', c=0, c::text);

  -- 6. filial inexistente -> exceção
  begin
    perform register_branch_and_user(null,null,'99999003','X',null,array['NAOEXISTE']);
    insert into _t values (8,'filial inexistente rejeitada', false, 'não levantou exceção');
  exception when others then
    insert into _t values (8,'filial inexistente rejeitada', true, sqlerrm);
  end;

  -- 7. novo gestor sem lista = todas as filiais ativas
  perform register_branch_and_user(null,null,'99999004','Gestor Teste','gestor',null);
  select count(*) into c from app_user_branches where matricula='99999004';
  insert into _t values (9,'novo gestor recebe todas', c=(select count(*) from app_branches where active), c::text);

  -- 8. permissões: anon/authenticated sem execute
  insert into _t values (10,'anon sem execute', not has_function_privilege('anon','public.register_branch_and_user(text,text,text,text,text,text[])','execute'), '');
  insert into _t values (11,'authenticated sem execute', not has_function_privilege('authenticated','public.register_branch_and_user(text,text,text,text,text,text[])','execute'), '');
  insert into _t values (12,'service_role com execute', has_function_privilege('service_role','public.register_branch_and_user(text,text,text,text,text,text[])','execute'), '');
end $$;

-- O SQL Editor só exibe o último comando; por isso o resultado sai como erro proposital.
-- Este bloco SEMPRE aborta a transação: nada é gravado, passe ou falhe.
do $$
declare
  v_total int;
  v_ok int;
  v_falhas text;
begin
  select count(*), count(*) filter (where ok) into v_total, v_ok from _t;
  select string_agg(n || ' ' || caso || ' [' || coalesce(detalhe, '') || ']', ' | ' order by n)
    into v_falhas from _t where ok is not true;
  if v_falhas is null then
    raise exception 'TESTE OK: %/% casos passaram. Nada foi gravado (rollback automático).', v_ok, v_total;
  else
    raise exception 'TESTE FALHOU: %/% passaram. Falhas: %. Nada foi gravado.', v_ok, v_total, v_falhas;
  end if;
end $$;

rollback;
