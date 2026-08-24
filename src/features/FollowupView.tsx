import { Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Followup } from '../types';
import { EmptyState } from '../components/EmptyState';

const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const labels: Record<string, string> = {
  contato_realizado: 'Contato realizado', oportunidade: 'Oportunidade', retorno_agendado: 'Retorno agendado', agendamento_criado: 'Agendamento criado', convertido: 'Convertido', sem_resposta: 'Sem resposta', sem_interesse: 'Sem interesse', perdido: 'Perdido',
};

export function FollowupView({ rows, loading, onNew }: { rows: Followup[]; loading: boolean; onNew: () => void }) {
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => rows.filter((item) => !search || `${item.client_name} ${item.equipment_serial || ''}`.toLowerCase().includes(search.toLowerCase())), [rows, search]);
  return <section className="list-page">
    <div className="list-toolbar"><div className="search-box"><Search size={18}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar cliente ou série" /></div><button className="primary-button" onClick={onNew}><Plus size={17}/> Novo follow-up</button></div>
    <div className="table-shell">
      <div className="table-head followup-columns"><span>Cliente</span><span>Tipo</span><span>Status</span><span>Próximo retorno</span><span>Valor</span></div>
      {loading ? <div className="table-loading">Carregando follow-ups...</div> : filtered.length === 0 ? <EmptyState title="Nenhum follow-up" text="Quando um cliente precisar de retorno, ele aparece aqui — sem misturar com a agenda." /> : filtered.map((item) => <div className="table-row followup-columns" key={item.id}><div><strong>{item.client_name}</strong><small>{item.equipment_serial || item.branch}</small></div><span>{item.treatment_type.replaceAll('_', ' ')}</span><span className={`status-text status-${item.status}`}>{labels[item.status] || item.status}</span><span>{item.next_followup_date ? dateFmt.format(new Date(`${item.next_followup_date}T12:00:00`)) : '—'}</span><strong>{item.estimated_value ? money.format(item.estimated_value) : '—'}</strong></div>)}
    </div>
  </section>;
}
