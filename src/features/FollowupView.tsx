import { Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Followup } from '../types';
import { EmptyState } from '../components/EmptyState';

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
    <div className="table-shell">
      <div className="table-head followup-simple-columns"><span>Cliente</span><span>Etapa</span><span>Última atualização</span><span>Próximo retorno</span><span>Resultado</span><span>Valor</span></div>
      {loading ? <div className="table-loading">Carregando tratativas...</div> : filtered.length === 0 ? <EmptyState title="Nenhuma tratativa" text="Os clientes que precisam de atenção aparecem aqui. Atualize e siga o dia." /> : filtered.map((item) => {
        const total = totalSale(item);
        return <button className="table-row followup-simple-columns followup-click-row" key={item.id} onClick={() => onEdit(item)}>
          <div><strong>{item.client_name}</strong><small>{item.equipment_serial || item.branch}</small></div>
          <span className={`followup-stage stage-${item.stage}`}>{stageLabels[item.stage] || 'Prospectar'}</span>
          <div className="followup-last-note"><strong>{item.notes || 'Sem observação'}</strong><small>{item.updated_at ? dateFmt.format(new Date(item.updated_at)) : '—'}</small></div>
          <span>{item.next_followup_date ? dateFmt.format(new Date(`${item.next_followup_date}T12:00:00`)) : '—'}</span>
          <span className={`followup-result result-${item.result || 'open'}`}>{item.result ? resultLabels[item.result] : '—'}</span>
          <strong>{total > 0 ? money.format(total) : '—'}</strong>
        </button>;
      })}
    </div>
  </section>;
}
