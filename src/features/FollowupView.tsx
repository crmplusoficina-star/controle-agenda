import { Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Followup } from '../types';
import { EmptyState } from '../components/EmptyState';
import './followup.css';

const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const stageLabels: Record<string, string> = {
  prospectar: 'Prospectar',
  acompanhar: 'Acompanhar',
  encerrar: 'Encerrado',
};

const resultLabels: Record<string, string> = {
  venda_ganha: 'Venda ganha',
  venda_perdida: 'Venda perdida',
};

const lostReasonLabels: Record<string, string> = {
  sem_interesse: 'Cliente sem interesse',
  preco: 'Preço',
  concorrente: 'Fechou com concorrente',
  sem_contato: 'Não conseguimos contato',
  adiado: 'Adiou / sem previsão',
  outro: 'Outro',
};

function totalSale(item: Followup) {
  return Number(item.parts_value || 0) + Number(item.services_value || 0);
}

export function FollowupView({ rows, loading, onNew, onEdit }: {
  rows: Followup[];
  loading: boolean;
  onNew: () => void;
  onEdit: (item: Followup) => void;
}) {
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => rows.filter((item) => !search || `${item.client_name} ${item.equipment_serial || ''} ${item.notes || ''}`.toLowerCase().includes(search.toLowerCase())), [rows, search]);

  return <section className="list-page">
    <div className="list-toolbar">
      <div className="search-box"><Search size={18}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar cliente ou série" /></div>
      <button className="primary-button" onClick={onNew}><Plus size={17}/> Nova tratativa</button>
    </div>

    {loading ? <div className="table-shell"><div className="table-loading">Carregando tratativas...</div></div> : filtered.length === 0 ? <div className="table-shell"><EmptyState title="Nenhuma tratativa" text="Os clientes que precisam de atenção aparecem aqui. Atualize e siga o dia." /></div> : <div className="followup-card-list">
      {filtered.map((item) => {
        const total = totalSale(item);
        const lostReason = item.lost_reason ? lostReasonLabels[item.lost_reason] : '';
        return <button className={`followup-control-card ${item.stage === 'encerrar' ? 'is-closed' : ''}`} key={item.id} onClick={() => onEdit(item)}>
          <div className="followup-card-note">
            <div><span>Observação</span><small>{item.updated_at ? dateFmt.format(new Date(item.updated_at)) : ''}</small></div>
            <strong>{item.notes || 'Sem observação registrada'}</strong>
          </div>
          <div className="followup-card-summary">
            <div className="followup-card-client"><strong>{item.client_name}</strong><small>{item.equipment_serial || item.branch}</small></div>
            <div><small>Etapa</small><span className={`followup-stage stage-${item.stage}`}>{stageLabels[item.stage] || 'Prospectar'}</span></div>
            <div><small>Próximo contato</small><strong>{item.next_followup_date ? dateFmt.format(new Date(`${item.next_followup_date}T12:00:00`)) : '—'}</strong></div>
            <div><small>Resultado</small><span className={`followup-result result-${item.result || 'open'}`}>{item.result ? resultLabels[item.result] : '—'}{lostReason ? ` · ${lostReason}` : ''}</span></div>
            <div><small>Valor</small><strong>{total > 0 ? money.format(total) : '—'}</strong></div>
          </div>
        </button>;
      })}
    </div>}
  </section>;
}
