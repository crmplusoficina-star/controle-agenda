import type { FormEvent } from 'react';
import { Drawer } from './Drawer';
import type { Branch, Technician } from '../types';

export function TechnicianDrawer({ open, name, branch, branches, technicians, existingId, error, onName, onBranch, onExisting, onClose, onSubmit }: {
  open: boolean;
  name: string;
  branch: string;
  branches: Branch[];
  technicians: Technician[];
  existingId: string;
  error: string;
  onName: (v: string) => void;
  onBranch: (v: string) => void;
  onExisting: (v: string) => void;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void;
}) {
  const selected = technicians.find((item) => item.id === existingId) || null;
  return <Drawer open={open} title="Adicionar técnico" subtitle="Cadastre um novo ou traga um técnico de outra filial." onClose={onClose}>
    <form className="form-stack" onSubmit={onSubmit}>
      <label>
        Trazer técnico já cadastrado
        <select value={existingId} onChange={(e) => onExisting(e.target.value)}>
          <option value="">Cadastrar novo técnico</option>
          {technicians.map((item) => <option key={item.id} value={item.id}>{item.name} — {item.branch}</option>)}
        </select>
      </label>
      {!selected && <label>Nome<input autoFocus value={name} onChange={(e) => onName(e.target.value)} placeholder="Nome do técnico" /></label>}
      {selected && <div className="context-strip"><div><span>Técnico</span><strong>{selected.name}</strong></div><div><span>Atual</span><strong>{selected.branch}</strong></div><div><span>Ação</span><strong>Trocar filial</strong></div></div>}
      <label>Filial<select value={branch} onChange={(e) => onBranch(e.target.value)}>{branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}</select></label>
      {error && <div className="form-error">{error}</div>}
      <div className="drawer-actions"><span/><button type="button" className="subtle-button" onClick={onClose}>Cancelar</button><button className="primary-button">{selected ? 'Trazer técnico' : 'Adicionar'}</button></div>
    </form>
  </Drawer>;
}
