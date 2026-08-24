import { Bell, ChevronDown } from 'lucide-react';
import type { Branch, Insight, ViewName } from '../types';

const titles: Record<ViewName, { title: string; subtitle: string }> = {
  agenda: { title: 'Agenda', subtitle: 'Organize o atendimento sem perder o contexto.' },
  retencao: { title: 'Retenção', subtitle: 'Clientes que merecem atenção, sem transformar tudo em oportunidade.' },
  equipamentos: { title: 'Equipamentos', subtitle: 'Histórico G4 pela série da máquina.' },
  followup: { title: 'Follow-up', subtitle: 'Retornos e oportunidades em uma fila simples.' },
};

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
  return (
    <header className="topbar">
      <div className="page-title"><h1>{meta.title}</h1><p>{meta.subtitle}</p></div>
      <div className="topbar-actions">
        <label className="branch-select">
          <span>Filial</span>
          <div><select value={branch} onChange={(e) => onBranch(e.target.value)}>
            <option value="__all__">Todas</option>
            {branches.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select><ChevronDown size={15} /></div>
        </label>
        <button className="icon-button bell-button" onClick={onBell} aria-label="Insights">
          <Bell size={19} />
          {unread > 0 && <span className="bell-count">{unread}</span>}
        </button>
      </div>
    </header>
  );
}
