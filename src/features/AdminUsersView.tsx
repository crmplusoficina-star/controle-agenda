import { ShieldCheck, UserRoundCheck } from 'lucide-react';
import type { Branch } from '../types';
import { CANONICAL_APP_USERS } from '../lib/appUsers';
import './admin-users.css';

const roleLabel = {
  admin: 'Adm',
  gestor: 'Gestor',
  consultor: 'Consultor',
};

export function AdminUsersView({ branches }: { branches: Branch[] }) {
  const allBranches = branches.map((item) => item.name);

  return (
    <div className="admin-users-page">
      <div className="admin-users-summary">
        <div><UserRoundCheck size={20}/><span><strong>{CANONICAL_APP_USERS.length}</strong> usuários ativos</span></div>
        <div><ShieldCheck size={20}/><span>Acesso administrativo restrito ao perfil Adm</span></div>
      </div>

      <div className="admin-users-table">
        <div className="admin-users-head">
          <span>Usuário</span><span>Matrícula</span><span>Perfil</span><span>Filiais liberadas</span><span>Status</span>
        </div>
        {CANONICAL_APP_USERS.map((item) => {
          const allowed = item.branches === 'all' ? allBranches : item.branches;
          return (
            <div className="admin-users-row" key={item.matricula}>
              <div className="admin-user-name"><strong>{item.name}</strong><small>{roleLabel[item.role]}</small></div>
              <div className="admin-user-matricula">{item.matricula}</div>
              <div><span className={`admin-role admin-role-${item.role}`}>{roleLabel[item.role]}</span></div>
              <div className="admin-user-branches">
                {item.branches === 'all' ? <span className="admin-all-branches">Todas as filiais</span> : allowed.map((branch) => <span key={branch}>{branch}</span>)}
              </div>
              <div><span className="admin-active">Ativo</span></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
