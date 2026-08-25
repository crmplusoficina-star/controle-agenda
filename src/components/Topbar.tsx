import { Bell } from 'lucide-react';
import { CheckboxMultiSelect } from './CheckboxMultiSelect';
import type { Branch, Insight, ViewName } from '../types';

const titles: Record<ViewName, { title: string; subtitle: string }> = {
  agenda: { title: 'Agenda', subtitle: 'Organize o atendimento sem perder o contexto.' },
  retencao: { title: 'Retenção', subtitle: 'Clientes que merecem atenção, sem transformar tudo em oportunidade.' },
  followup: { title: 'Follow-up', subtitle: 'Retornos e oportunidades em uma fila simples.' },
};

const MULTI_SEPARATOR = '||';

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
  const selected = branch === '__all__' ? [] : branch.split(MULTI_SEPARATOR).filter(Boolean);

  return (
    <header className="topbar">
      <div className="page-title"><h1>{meta.title}</h1><p>{meta.subtitle}</p></div>
      <div className="topbar-actions">
        <CheckboxMultiSelect
          label="Filial"
          items={branches.map((item) => ({ value: item.name, label: item.name }))}
          selected={selected}
          onChange={(values) => onBranch(values.length ? values.join(MULTI_SEPARATOR) : '__all__')}
          allLabel="Todas"
          compact
        />
        <button className="icon-button bell-button" onClick={onBell} aria-label="Insights">
          <Bell size={19} />
          {unread > 0 && <span className="bell-count">{unread}</span>}
        </button>
      </div>
    </header>
  );
}
