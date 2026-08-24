import type { FormEvent } from 'react';
import { Drawer } from './Drawer';
import type { Branch } from '../types';

export function TechnicianDrawer({ open, name, branch, branches, onName, onBranch, onClose, onSubmit }: { open: boolean; name: string; branch: string; branches: Branch[]; onName: (v: string) => void; onBranch: (v: string) => void; onClose: () => void; onSubmit: (e: FormEvent) => void }) {
  return <Drawer open={open} title="Adicionar técnico" subtitle="Um nome e uma filial. Só isso." onClose={onClose}><form className="form-stack" onSubmit={onSubmit}><label>Nome<input autoFocus value={name} onChange={(e) => onName(e.target.value)} placeholder="Nome do técnico" /></label><label>Filial<select value={branch} onChange={(e) => onBranch(e.target.value)}>{branches.map((b) => <option key={b.name}>{b.name}</option>)}</select></label><div className="drawer-actions"><span/><button type="button" className="subtle-button" onClick={onClose}>Cancelar</button><button className="primary-button">Adicionar</button></div></form></Drawer>;
}
