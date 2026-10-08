import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Building2, Pencil, Plus, ShieldCheck, UserRoundCheck, UserRoundX } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useSession } from '../session';
import type { AppRole } from '../session';
import { Drawer } from '../components/Drawer';
import './admin-users.css';

const roleLabel: Record<AppRole, string> = {
  admin: 'Adm',
  gestor: 'Gestor',
  consultor: 'Consultor',
};

type UserRow = { matricula: string; name: string; role: AppRole; active: boolean; branches: string[] };
type BranchRow = { name: string; active: boolean };
type FormState = { matricula: string; name: string; role: AppRole; branches: string[] };

const emptyForm: FormState = { matricula: '', name: '', role: 'consultor', branches: [] };

export function AdminUsersView() {
  const { user } = useSession();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [allBranches, setAllBranches] = useState<BranchRow[]>([]);
  const [busyBranch, setBusyBranch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyMatricula, setBusyMatricula] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    const [{ data: userRows, error: userError }, { data: linkRows, error: linkError }, { data: branchRows, error: branchError }] = await Promise.all([
      supabase.from('app_users').select('matricula,name,role,active').order('name'),
      supabase.from('app_user_branches').select('matricula,branch').order('branch'),
      supabase.from('app_branches').select('name,active').order('name'),
    ]);
    if (userError || linkError || branchError) {
      setLoadError('Não foi possível carregar os usuários.');
      setLoading(false);
      return;
    }
    const branchList = (branchRows || []).map((row) => ({ name: String(row.name), active: Boolean(row.active) }));
    setAllBranches(branchList);
    const activeNames = new Set(branchList.filter((b) => b.active).map((b) => b.name));
    const byUser = new Map<string, string[]>();
    for (const row of linkRows || []) {
      if (!activeNames.has(String(row.branch))) continue;
      const list = byUser.get(String(row.matricula)) || [];
      list.push(String(row.branch));
      byUser.set(String(row.matricula), list);
    }
    const rank: Record<AppRole, number> = { admin: 0, gestor: 1, consultor: 2 };
    const rows = (userRows || []).map((row) => ({
      matricula: String(row.matricula),
      name: String(row.name),
      role: row.role as AppRole,
      active: Boolean(row.active),
      branches: byUser.get(String(row.matricula)) || [],
    }));
    rows.sort((a, b) => Number(b.active) - Number(a.active) || rank[a.role] - rank[b.role] || a.name.localeCompare(b.name));
    setUsers(rows);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const activeCount = useMemo(() => users.filter((item) => item.active).length, [users]);
  const branches = useMemo(() => allBranches.filter((b) => b.active), [allBranches]);

  async function toggleBranchActive(branch: BranchRow) {
    const next = !branch.active;
    if (!next && !window.confirm(`Desativar a filial ${branch.name}? Ela some dos filtros e do histórico do app.`)) return;
    setBusyBranch(branch.name);
    const { error } = await supabase.rpc('admin_set_branch_active', { p_actor: user.matricula, p_branch: branch.name, p_active: next });
    setBusyBranch('');
    if (error) {
      window.alert(error.message);
      return;
    }
    window.location.reload();
  }

  function openNew() {
    setEditing(null);
    setForm(emptyForm);
    setFormError('');
    setDrawerOpen(true);
  }

  function openEdit(item: UserRow) {
    setEditing(item.matricula);
    setForm({ matricula: item.matricula, name: item.name, role: item.role, branches: item.role === 'consultor' ? item.branches : [] });
    setFormError('');
    setDrawerOpen(true);
  }

  function toggleBranch(name: string) {
    setForm((current) => ({
      ...current,
      branches: current.branches.includes(name) ? current.branches.filter((b) => b !== name) : [...current.branches, name],
    }));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError('');
    if (!form.matricula.trim() || !form.name.trim()) {
      setFormError('Preencha matrícula e nome.');
      return;
    }
    if (form.role === 'consultor' && !form.branches.length) {
      setFormError('Selecione pelo menos uma filial para o consultor.');
      return;
    }
    if (!editing && users.some((item) => item.matricula === form.matricula.trim())) {
      setFormError('Essa matrícula já está cadastrada. Use "Editar" na lista.');
      return;
    }
    setSaving(true);
    const { error } = await supabase.rpc('admin_save_user', {
      p_actor: user.matricula,
      p_matricula: form.matricula.trim(),
      p_name: form.name.trim(),
      p_role: form.role,
      p_branches: form.role === 'consultor' ? form.branches : null,
    });
    setSaving(false);
    if (error) {
      setFormError(error.message);
      return;
    }
    setDrawerOpen(false);
    await load();
  }

  async function setActive(item: UserRow, active: boolean) {
    if (!active && !window.confirm(`Desativar ${item.name}? Ele perde o acesso, mas o histórico é mantido.`)) return;
    setBusyMatricula(item.matricula);
    const { error } = await supabase.rpc('admin_set_user_active', {
      p_actor: user.matricula,
      p_matricula: item.matricula,
      p_active: active,
    });
    setBusyMatricula('');
    if (error) {
      window.alert(error.message);
      return;
    }
    await load();
  }

  return (
    <div className="admin-users-page">
      <div className="admin-users-summary">
        <div><UserRoundCheck size={20}/><span><strong>{activeCount}</strong> usuários ativos</span></div>
        <div><ShieldCheck size={20}/><span>Acesso administrativo restrito ao perfil Adm</span></div>
        <button type="button" className="primary-button admin-users-new" onClick={openNew}><Plus size={16}/>Novo usuário</button>
      </div>

      <div className="admin-users-table">
        <div className="admin-users-head">
          <span>Usuário</span><span>Matrícula</span><span>Perfil</span><span>Filiais liberadas</span><span>Status</span><span>Ações</span>
        </div>
        {loading && <div className="admin-users-message">Carregando...</div>}
        {loadError && <div className="admin-users-message">{loadError}</div>}
        {!loading && !loadError && users.map((item) => (
          <div className={`admin-users-row${item.active ? '' : ' admin-users-row-inactive'}`} key={item.matricula}>
            <div className="admin-user-name"><strong>{item.name}</strong><small>{roleLabel[item.role]}</small></div>
            <div className="admin-user-matricula">{item.matricula}</div>
            <div><span className={`admin-role admin-role-${item.role}`}>{roleLabel[item.role]}</span></div>
            <div className="admin-user-branches">
              {item.role !== 'consultor'
                ? <span className="admin-all-branches">Todas as filiais</span>
                : item.branches.map((branch) => <span key={branch}>{branch}</span>)}
            </div>
            <div>{item.active ? <span className="admin-active">Ativo</span> : <span className="admin-inactive">Inativo</span>}</div>
            <div className="admin-user-actions">
              <button type="button" className="icon-button" title="Editar" onClick={() => openEdit(item)}><Pencil size={15}/></button>
              {item.active
                ? <button type="button" className="icon-button" title="Desativar" disabled={busyMatricula === item.matricula || item.matricula === user.matricula} onClick={() => void setActive(item, false)}><UserRoundX size={15}/></button>
                : <button type="button" className="subtle-button" disabled={busyMatricula === item.matricula} onClick={() => void setActive(item, true)}>Reativar</button>}
            </div>
          </div>
        ))}
      </div>

      <div className="admin-branches">
        <div className="admin-branches-head">
          <Building2 size={18}/>
          <div><strong>Filiais</strong><span>{branches.length} de {allBranches.length} habilitadas. Filiais desligadas não aparecem nos filtros nem no histórico G4.</span></div>
        </div>
        <div className="admin-branches-list">
          {allBranches.map((branch) => (
            <button
              type="button"
              key={branch.name}
              className={`admin-branch-toggle${branch.active ? ' is-on' : ''}`}
              disabled={busyBranch === branch.name}
              onClick={() => void toggleBranchActive(branch)}
              title={branch.active ? 'Clique para desativar' : 'Clique para habilitar'}
            >
              <span className="admin-switch" aria-hidden="true"/>
              {branch.name}
            </button>
          ))}
        </div>
      </div>

      <Drawer
        open={drawerOpen}
        title={editing ? 'Editar usuário' : 'Novo usuário'}
        subtitle={editing ? `Matrícula ${editing}` : 'Cadastre matrícula, perfil e filiais de acesso.'}
        onClose={() => setDrawerOpen(false)}
        belowTopbar
      >
        <form className="form-stack" onSubmit={handleSubmit}>
          <label>
            Matrícula
            <input
              autoFocus={!editing}
              inputMode="numeric"
              disabled={Boolean(editing)}
              value={form.matricula}
              onChange={(e) => setForm({ ...form, matricula: e.target.value.replace(/\D/g, '') })}
              placeholder="Somente números"
            />
          </label>
          <label>Nome<input autoFocus={Boolean(editing)} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nome completo" /></label>
          <label>
            Perfil
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as AppRole })}>
              <option value="consultor">Consultor</option>
              <option value="gestor">Gestor</option>
              <option value="admin">Adm</option>
            </select>
          </label>
          {form.role === 'consultor'
            ? <fieldset className="admin-branch-picker">
                <legend>Filiais liberadas</legend>
                {branches.map((branch) => (
                  <label key={branch.name}>
                    <input type="checkbox" checked={form.branches.includes(branch.name)} onChange={() => toggleBranch(branch.name)} />
                    {branch.name}
                  </label>
                ))}
              </fieldset>
            : <div className="admin-branch-note">Gestor e Adm têm acesso a todas as filiais.</div>}
          {formError && <div className="form-error">{formError}</div>}
          <div className="drawer-actions">
            <span/>
            <button type="button" className="subtle-button" onClick={() => setDrawerOpen(false)}>Cancelar</button>
            <button className="primary-button" disabled={saving}>{saving ? 'Salvando...' : 'Salvar'}</button>
          </div>
        </form>
      </Drawer>
    </div>
  );
}
