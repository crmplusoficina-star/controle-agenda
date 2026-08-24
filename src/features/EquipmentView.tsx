import { Search } from 'lucide-react';
import { useState } from 'react';
import type { MachineSummary } from '../types';
import { EmptyState } from '../components/EmptyState';

const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

export function EquipmentView({ results, loading, onSearch, onOpen }: { results: MachineSummary[]; loading: boolean; onSearch: (term: string) => void; onOpen: (machine: MachineSummary) => void }) {
  const [term, setTerm] = useState('');
  return <section className="list-page equipment-page">
    <form className="hero-search" onSubmit={(e) => { e.preventDefault(); onSearch(term); }}>
      <Search size={20}/><input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Digite série, cliente ou cidade" autoFocus /><button className="primary-button">Buscar</button>
    </form>
    <div className="table-shell">
      <div className="table-head equipment-columns"><span>Série</span><span>Cliente</span><span>Cidade</span><span>Último atendimento</span><span>OS</span></div>
      {loading ? <div className="table-loading">Buscando equipamentos...</div> : results.length === 0 ? <EmptyState title="Consulte uma máquina" text="A busca usa o histórico consolidado do G4, sem carregar a base inteira na tela." /> : results.map((item) => <button className="table-row equipment-columns clickable-row" key={item.serial} onClick={() => onOpen(item)}>
        <strong>{item.serial}</strong><span>{item.client_name || '—'}</span><span>{item.city || '—'}</span><span>{item.last_service_at ? dateFmt.format(new Date(item.last_service_at)) : '—'}</span><strong>{item.service_count}</strong>
      </button>)}
    </div>
  </section>;
}
