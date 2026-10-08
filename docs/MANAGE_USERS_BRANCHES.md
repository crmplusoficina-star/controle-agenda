# Gerenciamento de Filiais e Usuários

Funções SQL seguras para criar filiais e usuários sem quebrar a aplicação.

## 📋 Funções Disponíveis

### 1. `add_branch()` - Criar Nova Filial

**SQL:**
```sql
SELECT public.add_branch('GUARULHOS', true);
```

**Resposta (sucesso):**
```json
{
  "success": true,
  "message": "Filial criada com sucesso",
  "branch": "GUARULHOS",
  "active": true,
  "created_at": "2026-10-08T10:30:00Z"
}
```

**Resposta (erro - já existe):**
```json
{
  "success": false,
  "error": "Filial já existe: GUARULHOS",
  "code": "ALREADY_EXISTS",
  "branch": "GUARULHOS"
}
```

---

### 2. `add_user()` - Criar Novo Usuário

**SQL - Simples (sem filial):**
```sql
SELECT public.add_user(
  p_matricula := '19999',
  p_name := 'João Silva',
  p_role := 'consultor'
);
```

**SQL - Com filiais:**
```sql
SELECT public.add_user(
  p_matricula := '19999',
  p_name := 'João Silva',
  p_role := 'gestor',
  p_branches := ARRAY['CONTAGEM', 'BELO HORIZONTE', 'DIVINÓPOLIS'],
  p_active := true
);
```

**Resposta (sucesso):**
```json
{
  "success": true,
  "message": "Usuário criado com sucesso",
  "matricula": "19999",
  "name": "João Silva",
  "role": "gestor",
  "active": true,
  "branches_assigned": 3,
  "created_at": "2026-10-08T10:35:00Z"
}
```

**Roles válidos:**
- `consultor` - Acesso de leitura
- `gestor` - Acesso de leitura/escrita para sua região
- `admin` - Acesso total

---

### 3. `assign_user_branch()` - Atribuir Filial a Usuário

**SQL:**
```sql
SELECT public.assign_user_branch(
  p_matricula := '19999',
  p_branch := 'SAO_PAULO'
);
```

**Resposta:**
```json
{
  "success": true,
  "message": "Filial atribuída com sucesso",
  "matricula": "19999",
  "branch": "SAO_PAULO",
  "assigned_at": "2026-10-08T10:40:00Z"
}
```

---

### 4. `list_users_with_branches()` - Listar Usuários

**SQL:**
```sql
SELECT * FROM public.list_users_with_branches();
```

**Resposta:**
```
matricula | name           | role      | active | branches                      | total_branches
----------|----------------|-----------|--------|-------------------------------|----------------
19999     | João Silva     | gestor    | true   | {CONTAGEM,BELO HORIZONTE,...} | 3
19124     | Alisson Mafra  | admin     | true   | {BALSAS,IMPERATRIZ,...}       | 9
```

---

### 5. `check_integrity()` - Validar Dados

**SQL:**
```sql
SELECT public.check_integrity();
```

**Resposta:**
```json
{
  "status": "OK",
  "total_branches": 30,
  "total_users": 8,
  "total_assignments": 45,
  "branches_without_users": 2,
  "users_without_branches": 1
}
```

---

## 🔧 Uso em TypeScript/React

```typescript
import { supabase } from './lib/supabase';

// Criar filial
async function createBranch(name: string) {
  const { data, error } = await supabase
    .rpc('add_branch', {
      p_name: name,
      p_active: true
    });

  if (!data?.success) {
    console.error('Erro:', data?.error);
    return null;
  }

  return data;
}

// Criar usuário com filiais
async function createUser(
  matricula: string,
  name: string,
  role: 'consultor' | 'gestor' | 'admin',
  branches: string[]
) {
  const { data, error } = await supabase
    .rpc('add_user', {
      p_matricula: matricula,
      p_name: name,
      p_role: role,
      p_branches: branches,
      p_active: true
    });

  if (!data?.success) {
    throw new Error(data?.error || 'Erro ao criar usuário');
  }

  return data;
}

// Listar usuários
async function fetchUsersWithBranches() {
  const { data, error } = await supabase
    .rpc('list_users_with_branches');

  if (error) throw error;
  return data;
}

// Exemplo de uso
async function main() {
  try {
    // Criar filial
    await createBranch('GUARULHOS');

    // Criar usuário
    const user = await createUser(
      '19999',
      'João Silva',
      'gestor',
      ['GUARULHOS', 'CONTAGEM']
    );
    console.log('✅ Usuário criado:', user);

    // Listar todos
    const users = await fetchUsersWithBranches();
    console.log('📋 Usuários:', users);

  } catch (err) {
    console.error('❌ Erro:', err);
  }
}
```

---

## 🛡️ Segurança

✅ **Validações:**
- Campos não vazios
- Role do tipo correto (consultor/gestor/admin)
- Filiais existentes
- Sem duplicatas

✅ **SQL Injection Prevention:**
- Prepared statements (PLpgSQL)
- Sem concatenação de strings

✅ **Preservação de RLS:**
- Policies existentes mantidas
- Funções com SECURITY DEFINER
- Grants apropriados

✅ **Tratamento de Erro:**
- Respostas JSON estruturadas
- Códigos de erro específicos
- Mensagens legíveis

---

## 📊 Exemplo: Formulário de Novo Usuário

```typescript
export function NewUserForm() {
  const [formData, setFormData] = useState({
    matricula: '',
    name: '',
    role: 'consultor',
    branches: [] as string[]
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      const res = await createUser(
        formData.matricula,
        formData.name,
        formData.role as any,
        formData.branches
      );

      if (res.success) {
        setResult({ type: 'success', message: res.message });
        setFormData({ matricula: '', name: '', role: 'consultor', branches: [] });
      } else {
        setResult({ type: 'error', message: res.error });
      }
    } catch (err) {
      setResult({ type: 'error', message: String(err) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        placeholder="Matrícula"
        value={formData.matricula}
        onChange={(e) => setFormData({ ...formData, matricula: e.target.value })}
        required
      />

      <input
        type="text"
        placeholder="Nome completo"
        value={formData.name}
        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
        required
      />

      <select
        value={formData.role}
        onChange={(e) => setFormData({ ...formData, role: e.target.value })}
      >
        <option value="consultor">Consultor</option>
        <option value="gestor">Gestor</option>
        <option value="admin">Admin</option>
      </select>

      <button type="submit" disabled={loading}>
        {loading ? 'Criando...' : 'Criar Usuário'}
      </button>

      {result && (
        <div className={`alert alert-${result.type}`}>
          {result.message}
        </div>
      )}
    </form>
  );
}
```

---

## ⚙️ Como Aplicar a Migration

1. **Localmente (desenvolvimento):**
   ```bash
   supabase migration up
   ```

2. **No Supabase Cloud:**
   - Vá para **SQL Editor**
   - Copie o conteúdo de `202610080001_manage_branches_users.sql`
   - Execute

3. **Verificar:**
   ```sql
   SELECT * FROM public.list_users_with_branches();
   ```

---

## 🚀 Próximos Passos

- [ ] Integrar formulário na UI de usuários
- [ ] Adicionar função para remover filial
- [ ] Adicionar função para desativar usuário
- [ ] Logs de auditoria (quem criou/modificou)
- [ ] Testes automáticos das funções
