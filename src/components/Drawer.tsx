import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export function Drawer({ open, title, subtitle, onClose, children, wide = false, headerAction }: { open: boolean; title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean; headerAction?: ReactNode }) {
  if (!open) return null;
  return <div className="drawer-layer" onMouseDown={onClose}>
    <aside className={wide ? 'drawer drawer-wide' : 'drawer'} onMouseDown={(e) => e.stopPropagation()}>
      <div className="drawer-head">
        <div className="drawer-head-copy"><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <div className="drawer-head-actions">{headerAction}<button className="icon-button" onClick={onClose}><X size={19} /></button></div>
      </div>
      <div className="drawer-body">{children}</div>
    </aside>
  </div>;
}
