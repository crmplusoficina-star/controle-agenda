import { useState } from 'react';
import { BarChart3, CalendarRange, History, House, ListTodo, Megaphone, UsersRound, X } from 'lucide-react';
import type { ViewName } from '../types';
import { useSession } from '../session';

const items: { id: ViewName; label: string; icon: typeof CalendarRange; managerOnly?: boolean; adminOnly?: boolean }[] = [
  { id: 'inicio', label: 'Início', icon: House },
  { id: 'agenda', label: 'Agenda', icon: CalendarRange },
  { id: 'retencao', label: 'Retenção', icon: History },
  { id: 'followup', label: 'Follow-up', icon: ListTodo },
  { id: 'dashboard', label: 'Dashboard', icon: BarChart3, managerOnly: true },
  { id: 'usuarios', label: 'Usuários e acessos', icon: UsersRound, adminOnly: true },
];

export function Sidebar({ view, onView }: { view: ViewName; onView: (view: ViewName) => void }) {
  const { user } = useSession();
  const [showUpdates, setShowUpdates] = useState(false);
  const visibleItems = items.filter((item) => {
    if (item.adminOnly) return user.role === 'admin';
    if (item.managerOnly) return user.role === 'gestor' || user.role === 'admin';
    return true;
  });
  return (
    <>
      <aside className="sidebar">
        <div className="brand brand-image-wrap">
          <img
            className="brand-image"
            src="/agenda-brand.png?v=20260901-2"
            alt="Agenda"
            style={{ width: '100%', maxWidth: 178, height: 'auto', objectFit: 'contain', display: 'block' }}
          />
        </div>
        <nav>
          {visibleItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              data-tutorial={`nav-${id}`}
              className={view === id ? 'nav-item active' : 'nav-item'}
              onClick={() => onView(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
          <button className="nav-item" type="button" onClick={() => setShowUpdates(true)}>
            <Megaphone size={18} />
            <span>Atualizações</span>
            <small style={{ marginLeft: 'auto', borderRadius: 999, padding: '2px 6px', background: '#fef3c7', color: '#92400e', fontSize: 8, fontWeight: 800 }}>NOVO</small>
          </button>
        </nav>
        <div className="sidebar-foot">
          <span>Base operacional</span>
          <strong>G4</strong>
        </div>
      </aside>

      {showUpdates && <div onClick={() => setShowUpdates(false)} style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(15,23,42,.38)', display: 'grid', placeItems: 'center', padding: 20 }}>
        <div onClick={(event) => event.stopPropagation()} style={{ width: 'min(560px, 100%)', maxHeight: '82vh', overflow: 'auto', background: '#fff', borderRadius: 18, border: '1px solid #e2e8f0', boxShadow: '0 24px 70px rgba(15,23,42,.22)', padding: 22 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 18 }}>
            <div style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', background: '#eff6ff', color: '#2563eb' }}><Megaphone size={19}/></div>
            <div style={{ flex: 1 }}><strong style={{ display: 'block', color: '#172033', fontSize: 18 }}>Atualizações</strong><span style={{ display: 'block', marginTop: 3, color: '#64748b', fontSize: 12 }}>Como funcionam as novas opções da Agenda.</span></div>
            <button type="button" className="icon-button" onClick={() => setShowUpdates(false)} aria-label="Fechar atualizações"><X size={18}/></button>
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ padding: '13px 14px', border: '1px solid #e2e8f0', borderRadius: 12, background: '#f8fafc' }}><strong style={{ display: 'block', marginBottom: 5, color: '#1e293b', fontSize: 13 }}>Contato do cliente</strong><p style={{ margin: 0, color: '#64748b', fontSize: 12, lineHeight: 1.55 }}>Na primeira vez, preencha o número do cliente. Depois, ao carregar o mesmo cliente em outro atendimento, o contato será puxado automaticamente. Com o número preenchido, o botão abre direto a conversa no WhatsApp.</p></div>
            <div style={{ padding: '13px 14px', border: '1px solid #e2e8f0', borderRadius: 12, background: '#f8fafc' }}><strong style={{ display: 'block', marginBottom: 5, color: '#1e293b', fontSize: 13 }}>Descrição no card</strong><p style={{ margin: 0, color: '#64748b', fontSize: 12, lineHeight: 1.55 }}>A descrição informada no atendimento passa a aparecer no topo do card da Agenda para facilitar a leitura sem precisar abrir o atendimento.</p></div>
            <div style={{ padding: '13px 14px', border: '1px solid #e2e8f0', borderRadius: 12, background: '#f8fafc' }}><strong style={{ display: 'block', marginBottom: 5, color: '#1e293b', fontSize: 13 }}>Status do faturamento</strong><p style={{ margin: 0, color: '#64748b', fontSize: 12, lineHeight: 1.55 }}>O atendimento terá somente dois status de faturamento: <b>Pendente</b> e <b>Faturado</b>.</p></div>
          </div>
        </div>
      </div>}
    </>
  );
}
