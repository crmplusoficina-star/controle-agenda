import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export function Drawer({ open, title, subtitle, onClose, children, wide = false }: { open: boolean; title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  if (!open) return null;
  return <div className="drawer-layer" onMouseDown={onClose}>
    <aside className={wide ? 'drawer drawer-wide' : 'drawer'} onMouseDown={(e) => e.stopPropagation()}>
      <div className="drawer-head"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose}><X size={19} /></button></div>
      <div className="drawer-body">{children}</div>
    </aside>
  </div>;
}
