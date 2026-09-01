import { BarChart3, CalendarRange, History, House, ListTodo } from 'lucide-react';
import type { ViewName } from '../types';
import { useSession } from '../session';

const items: { id: ViewName; label: string; icon: typeof CalendarRange; managerOnly?: boolean }[] = [
  { id: 'inicio', label: 'Início', icon: House },
  { id: 'agenda', label: 'Agenda', icon: CalendarRange },
  { id: 'retencao', label: 'Retenção', icon: History },
  { id: 'followup', label: 'Follow-up', icon: ListTodo },
  { id: 'dashboard', label: 'Dashboard', icon: BarChart3, managerOnly: true },
];

export function Sidebar({ view, onView }: { view: ViewName; onView: (view: ViewName) => void }) {
  const { user } = useSession();
  const visibleItems = items.filter((item) => !item.managerOnly || user.role === 'gestor' || user.role === 'admin');
  return (
    <aside className="sidebar">
      <div className="brand brand-image-wrap">
        <img className="brand-image" src="/agenda-brand.svg?v=20260831-4" alt="Agenda" />
      </div>
      <nav>
        {visibleItems.map(({ id, label, icon: Icon }) => (
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
