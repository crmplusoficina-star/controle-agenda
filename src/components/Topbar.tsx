import { useEffect } from 'react';
import { Bell, LogOut, MonitorPlay } from 'lucide-react';
import { CheckboxMultiSelect } from './CheckboxMultiSelect';
import { useSession } from '../session';
import type { Branch, Insight, ViewName } from '../types';
import './session.css';

const titles: Record<ViewName, { title: string; subtitle: string }> = {
  inicio: { title: 'Início', subtitle: 'Seu dia, seus próximos contatos e a meta de prospecção.' },
  agenda: { title: 'Agenda', subtitle: 'Organize o atendimento sem perder o contexto.' },
  retencao: { title: 'Retenção', subtitle: 'Clientes que merecem atenção, sem transformar tudo em oportunidade.' },
  followup: { title: 'Follow-up', subtitle: 'Retornos e oportunidades em uma fila simples.' },
  dashboard: { title: 'Dashboard', subtitle: 'Desempenho comercial, retenção, oportunidades e leitura gerencial.' },
  inspecao150: { title: 'Visita 150h', subtitle: 'Máquinas entregues a partir de agosto/2026 que precisam da inspeção de 150 horas.' },
  campanhas: { title: 'Campanhas', subtitle: 'Campanhas de campo pendentes por máquina.' },
  usuarios: { title: 'Usuários e acessos', subtitle: 'Perfis, matrículas e filiais padrão de acesso.' },
};

const MULTI_SEPARATOR = '||';
const ALL = '__all__';

export function Topbar({ view, branches, branch, onBranch, insights, onBell }: {
  view: ViewName;
  branches: Branch[];
  branch: string;
  onBranch: (branch: string) => void;
  insights: Insight[];
  onBell: () => void;
}) {
  const meta = titles[view];
  const unread = insights.filter((i) => i.status === 'new').length;
  const { user, defaultBranches, logout } = useSession();

  // Consultores podem ver todas as filiais, mas começam sempre com as unidades
  // atribuídas a eles. Isso evita o estado inicial "Todas" antes do filtro padrão.
  const selected = branch === ALL
    ? (user.role === 'consultor' ? defaultBranches : [])
    : branch.split(MULTI_SEPARATOR).filter(Boolean);

  useEffect(() => {
    if (user.role !== 'consultor' || branch !== ALL || !defaultBranches.length) return;
    onBranch(defaultBranches.join(MULTI_SEPARATOR));
  }, [user.role, user.matricula, branch, defaultBranches, onBranch]);

  return (
    <header className="topbar">
      <div className="page-title"><h1>{meta.title}</h1><p>{meta.subtitle}</p></div>
      <div className="topbar-actions">
        {view === 'agenda' && <button
          className="subtle-button"
          type="button"
          title="Abrir modo apresentação para TV ou recepção"
          onClick={() => window.open(`${window.location.origin}${window.location.pathname}?presentation=1`, '_blank', 'noopener,noreferrer')}
        ><MonitorPlay size={16}/> Apresentação</button>}
        {view !== 'usuarios' && <CheckboxMultiSelect
          label="Filial"
          items={branches.map((item) => ({ value: item.name, label: item.name }))}
          selected={selected}
          onChange={(values) => onBranch(values.length ? values.join(MULTI_SEPARATOR) : ALL)}
          allLabel="Todas"
          compact
        />}
        <button className="icon-button bell-button" onClick={onBell} aria-label="Insights">
          <Bell size={19} />
          {unread > 0 && <span className="bell-count">{unread}</span>}
        </button>
        <div className="topbar-user" title={`${user.name} · matrícula ${user.matricula}`}>
          <div className="topbar-user-copy"><strong>{user.name}</strong><span>{user.role}</span></div>
          <button className="logout-button" type="button" onClick={logout} aria-label="Sair"><LogOut size={15}/></button>
        </div>
      </div>
    </header>
  );
}
