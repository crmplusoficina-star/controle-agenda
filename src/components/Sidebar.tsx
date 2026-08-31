import { CalendarRange, History, House, ListTodo } from 'lucide-react';
import type { ViewName } from '../types';

const items: { id: ViewName; label: string; icon: typeof CalendarRange }[] = [
  { id: 'inicio', label: 'Início', icon: House },
  { id: 'agenda', label: 'Agenda', icon: CalendarRange },
  { id: 'retencao', label: 'Retenção', icon: History },
  { id: 'followup', label: 'Follow-up', icon: ListTodo },
];

export function Sidebar({ view, onView }: { view: ViewName; onView: (view: ViewName) => void }) {
  return (
    <aside className="sidebar">
      <div className="brand brand-image-wrap">
        <img className="brand-image" src="/agenda-brand.svg?v=20260831-4" alt="Agenda" />
      </div>
      <nav>
        {items.map(({ id, label, icon: Icon }) => (
          <button key={id} className={view === id ? 'nav-item active' : 'nav-item'} onClick={() => onView(id)}>
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <span>Base operacional</span>
        <strong>G4</strong>
      </div>
    </aside>
  );
}
