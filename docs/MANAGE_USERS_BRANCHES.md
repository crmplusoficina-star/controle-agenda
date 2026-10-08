# Cadastro de filiais e usuários

Função: `public.register_branch_and_user(p_branch_name, p_branch_address, p_matricula, p_user_name, p_role, p_branches)`
(migration `supabase/migrations/202610080002_register_branch_and_user.sql`).

- Execução **somente `service_role`** (anon/authenticated não têm execute). Não chamar do front.
- Filial: normalizada (acentos removidos, `upper/trim`), ex.: `são luís` → `SAO LUIS`. Upsert; reativa se existir.
- Usuário: matrícula só dígitos (igual ao login em `src/session.tsx`). Novo usuário exige nome.
- `p_role` nulo: cria como `consultor`; em usuário existente **não altera** o role.
- `p_branches`: cada item é normalizado e deve existir/estar ativo. Novo gestor/admin sem lista recebe todas as filiais ativas.
- Consultor sem nenhuma filial ativa ao final → exceção (a transação inteira é revertida).
- Filial nova/reativada é vinculada automaticamente a gestores/admins ativos.

```sql
select public.register_branch_and_user('GUARULHOS','Endereço...','19999','Fulano','consultor');
select public.register_branch_and_user(p_matricula := '19999', p_role := 'gestor');
```

Teste sem efeito colateral: `supabase/tests/register_branch_and_user_rollback_test.sql` (BEGIN … ROLLBACK).
