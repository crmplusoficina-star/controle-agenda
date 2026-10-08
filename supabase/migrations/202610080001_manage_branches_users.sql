-- ============================================================================
-- GERENCIAMENTO DE FILIAIS E USUÁRIOS
-- ============================================================================
-- Funções seguras para criar filiais e usuários sem quebrar a aplicação
-- ============================================================================

-- 1. FUNÇÃO: Adicionar nova filial
-- Validações: nome não vazio, sem duplicatas
CREATE OR REPLACE FUNCTION public.add_branch(
  p_name text,
  p_active boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Validar entrada
  IF TRIM(p_name) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Nome da filial não pode ser vazio',
      'code', 'EMPTY_NAME'
    );
  END IF;

  -- Converter para maiúsculas (padrão da aplicação)
  p_name := UPPER(TRIM(p_name));

  -- Verificar se já existe
  IF EXISTS (SELECT 1 FROM public.app_branches WHERE name = p_name) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Filial já existe: ' || p_name,
      'code', 'ALREADY_EXISTS',
      'branch', p_name
    );
  END IF;

  -- Inserir nova filial
  INSERT INTO public.app_branches (name, active, created_at)
  VALUES (p_name, p_active, NOW());

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Filial criada com sucesso',
    'branch', p_name,
    'active', p_active,
    'created_at', NOW()
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM,
    'code', 'DATABASE_ERROR'
  );
END;
$$;

-- 2. FUNÇÃO: Adicionar novo usuário com filiais
-- Validações: matricula única, role válido, filiais existentes
CREATE OR REPLACE FUNCTION public.add_user(
  p_matricula text,
  p_name text,
  p_role text,
  p_branches text[] DEFAULT NULL,
  p_active boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_valid_roles text[] := ARRAY['consultor', 'gestor', 'admin'];
  v_branch text;
  v_invalid_branches text[] := ARRAY[]::text[];
  v_created_branches int := 0;
BEGIN
  -- Validar matricula
  IF TRIM(p_matricula) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Matrícula não pode ser vazia',
      'code', 'EMPTY_MATRICULA'
    );
  END IF;

  -- Validar nome
  IF TRIM(p_name) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Nome do usuário não pode ser vazio',
      'code', 'EMPTY_NAME'
    );
  END IF;

  -- Validar role
  p_role := LOWER(TRIM(p_role));
  IF NOT p_role = ANY(v_valid_roles) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Role inválido. Deve ser um de: ' || ARRAY_TO_STRING(v_valid_roles, ', '),
      'code', 'INVALID_ROLE',
      'valid_roles', v_valid_roles
    );
  END IF;

  -- Verificar se matrícula já existe
  IF EXISTS (SELECT 1 FROM public.app_users WHERE matricula = p_matricula) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Usuário já existe: ' || p_matricula,
      'code', 'USER_EXISTS',
      'matricula', p_matricula
    );
  END IF;

  -- Validar filiais se fornecidas
  IF p_branches IS NOT NULL AND ARRAY_LENGTH(p_branches, 1) > 0 THEN
    FOREACH v_branch IN ARRAY p_branches
    LOOP
      v_branch := UPPER(TRIM(v_branch));
      IF NOT EXISTS (SELECT 1 FROM public.app_branches WHERE name = v_branch AND active = true) THEN
        v_invalid_branches := ARRAY_APPEND(v_invalid_branches, v_branch);
      END IF;
    END LOOP;

    IF ARRAY_LENGTH(v_invalid_branches, 1) > 0 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Filiais não encontradas ou inativas',
        'code', 'INVALID_BRANCHES',
        'invalid_branches', v_invalid_branches
      );
    END IF;
  END IF;

  -- Inserir usuário
  INSERT INTO public.app_users (matricula, name, role, active, created_at)
  VALUES (p_matricula, TRIM(p_name), p_role, p_active, NOW());

  -- Associar filiais se fornecidas
  IF p_branches IS NOT NULL AND ARRAY_LENGTH(p_branches, 1) > 0 THEN
    FOREACH v_branch IN ARRAY p_branches
    LOOP
      v_branch := UPPER(TRIM(v_branch));
      INSERT INTO public.app_user_branches (matricula, branch)
      VALUES (p_matricula, v_branch)
      ON CONFLICT (matricula, branch) DO NOTHING;
      v_created_branches := v_created_branches + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Usuário criado com sucesso',
    'matricula', p_matricula,
    'name', p_name,
    'role', p_role,
    'active', p_active,
    'branches_assigned', v_created_branches,
    'created_at', NOW()
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM,
    'code', 'DATABASE_ERROR'
  );
END;
$$;

-- 3. FUNÇÃO: Atribuir filial a usuário existente
CREATE OR REPLACE FUNCTION public.assign_user_branch(
  p_matricula text,
  p_branch text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Validar inputs
  IF TRIM(p_matricula) = '' OR TRIM(p_branch) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Matrícula e filial são obrigatórias',
      'code', 'EMPTY_PARAMS'
    );
  END IF;

  p_branch := UPPER(TRIM(p_branch));

  -- Verificar se usuário existe
  IF NOT EXISTS (SELECT 1 FROM public.app_users WHERE matricula = p_matricula) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Usuário não encontrado: ' || p_matricula,
      'code', 'USER_NOT_FOUND'
    );
  END IF;

  -- Verificar se filial existe
  IF NOT EXISTS (SELECT 1 FROM public.app_branches WHERE name = p_branch AND active = true) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Filial não encontrada ou inativa: ' || p_branch,
      'code', 'BRANCH_NOT_FOUND'
    );
  END IF;

  -- Verificar se já está associado
  IF EXISTS (SELECT 1 FROM public.app_user_branches WHERE matricula = p_matricula AND branch = p_branch) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Usuário já tem acesso a esta filial',
      'code', 'ALREADY_ASSIGNED'
    );
  END IF;

  -- Inserir associação
  INSERT INTO public.app_user_branches (matricula, branch)
  VALUES (p_matricula, p_branch);

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Filial atribuída com sucesso',
    'matricula', p_matricula,
    'branch', p_branch,
    'assigned_at', NOW()
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM,
    'code', 'DATABASE_ERROR'
  );
END;
$$;

-- 4. FUNÇÃO: Listar usuários com suas filiais
CREATE OR REPLACE FUNCTION public.list_users_with_branches()
RETURNS TABLE (
  matricula text,
  name text,
  role text,
  active boolean,
  branches text[],
  total_branches int,
  created_at timestamptz
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    u.matricula,
    u.name,
    u.role,
    u.active,
    ARRAY_AGG(DISTINCT ub.branch ORDER BY ub.branch) as branches,
    COUNT(DISTINCT ub.branch)::int as total_branches,
    u.created_at
  FROM public.app_users u
  LEFT JOIN public.app_user_branches ub ON u.matricula = ub.matricula
  GROUP BY u.matricula, u.name, u.role, u.active, u.created_at
  ORDER BY u.matricula;
$$;

-- 5. FUNÇÃO: Validar integridade (verificar usuários órfãos ou filiais sem usuários)
CREATE OR REPLACE FUNCTION public.check_integrity()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_orphaned_branches int;
  v_users_without_branches int;
BEGIN
  -- Contar filiais sem usuários
  SELECT COUNT(*) INTO v_orphaned_branches
  FROM public.app_branches ab
  WHERE NOT EXISTS (
    SELECT 1 FROM public.app_user_branches aub
    WHERE aub.branch = ab.name
  );

  -- Contar usuários sem filial atribuída
  SELECT COUNT(*) INTO v_users_without_branches
  FROM public.app_users au
  WHERE NOT EXISTS (
    SELECT 1 FROM public.app_user_branches aub
    WHERE aub.matricula = au.matricula
  );

  RETURN jsonb_build_object(
    'status', 'OK',
    'total_branches', (SELECT COUNT(*) FROM public.app_branches),
    'total_users', (SELECT COUNT(*) FROM public.app_users),
    'total_assignments', (SELECT COUNT(*) FROM public.app_user_branches),
    'branches_without_users', v_orphaned_branches,
    'users_without_branches', v_users_without_branches
  );
END;
$$;

-- Grant permissões
GRANT EXECUTE ON FUNCTION public.add_branch TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_user TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_user_branch TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_users_with_branches TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_integrity TO anon, authenticated;
