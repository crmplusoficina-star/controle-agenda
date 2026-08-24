import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ClientSummary } from '../types';
import { daysBetween } from '../lib/date';
import { EmptyState } from '../components/EmptyState';

const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

export function RetentionView({ clients, loading, futureClients, onFollowup }: { clients: ClientSummary[]; loading: boolean; futureClients: Set<string>; onFollowup: (client: ClientSummary) => void }) {
  const [months, setMonths] = useState(9);
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => clients.filter((client) => {
    const days = client.last_service_at ? daysBetween(client.last_service_at.slice(0, 10)) : 9999;
    const matchAge = days >= months * 30;
    const matchSearch = !search || `${client.client_name} ${client.city || ''}`.toLowerCase().includes(search.toLowerCase());
    const hasFuture = futureClients.has(client.client_name.trim().toUpperCase());
    return matchAge && matchSearch && !hasFuture;
  }).sort((a, b) => (b.last_service_at || '').localeCompare(a.last_service_at || '') * -1), [clients, months, search, futureClients]);

  return <section className="list-page">
    <div className="list-toolbar">
      <div className="search-box"><Search size={18}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar cliente ou cidade" /></div>
      <label className="inline-filter"><span>Sem atendimento há</span><select value={months} onChange={(e) => setMonths(Number(e.target.value))}><option value={6}>6 meses</option><option value={9}>9 meses</option><option value={12}>12 meses</option><option value={18}>18 meses</option></select></label>
    </div>
    <div className="table-shell">
      <div className="table-head retention-columns"><span>Cliente</span><span>Cidade</span><span>Último atendimento</span><span>Máquinas</span><span>OS</span><span></span></div>
      {loading ? <div className="table-loading">Analisando histórico G4...</div> : filtered.length === 0 ? <EmptyState title="Nenhum cliente nessa faixa" text="Isso também é um resultado válido. Ajuste o período se quiser ampliar a análise." /> : filtered.map((client) => {
        const days = client.last_service_at ? daysBetween(client.last_service_at.slice(0, 10)) : 0;
        return <div className="table-row retention-columns" key={client.client_key}>
          <div><strong>{client.client_name}</strong><small>{client.last_operation_type || 'Última operação não informada'}</small></div>
          <span>{client.city || '—'}</span>
          <div><strong>{client.last_service_at ? dateFmt.format(new Date(client.last_service_at)) : '—'}</strong><small>{days ? `${Math.floor(days / 30)} meses atrás` : ''}</small></div>
          <strong>{client.machine_count}</strong>
          <strong>{client.service_count}</strong>
          <button className="row-action" onClick={() => onFollowup(client)}>Criar follow-up</button>
        </div>;
      })}
    </div>
  </section>;
}
