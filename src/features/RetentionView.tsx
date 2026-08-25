import { ArrowDown, ArrowUp, Filter, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ClientSummary } from '../types';
import { daysBetween } from '../lib/date';
import { EmptyState } from '../components/EmptyState';
import './retention.css';

const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const retentionKey = (clientName: string, branchName: string) => `${clientName.trim().toUpperCase()}|${branchName.trim().toUpperCase()}`;

type ColumnKey = 'client' | 'serial' | 'city' | 'last' | 'machines' | 'os';
type SortDirection = 'asc' | 'desc';

type ColumnHeaderProps = {
  column: ColumnKey;
  label: string;
  activeColumn: ColumnKey | null;
  setActiveColumn: (column: ColumnKey | null) => void;
  sortKey: ColumnKey;
  sortDirection: SortDirection;
  setSort: (key: ColumnKey, direction: SortDirection) => void;
  filter: string;
  setFilter: (value: string) => void;
  numeric?: boolean;
};

function ColumnHeader({ column, label, activeColumn, setActiveColumn, sortKey, sortDirection, setSort, filter, setFilter, numeric }: ColumnHeaderProps) {
  const active = activeColumn === column;
  const sorted = sortKey === column;
  return <div className="retention-head-cell">
    <button className={`column-head-button ${filter ? 'has-filter' : ''}`} type="button" onClick={() => setActiveColumn(active ? null : column)}>
      <span>{label}</span>
      {sorted ? (sortDirection === 'asc' ? <ArrowUp size={13}/> : <ArrowDown size={13}/>) : <Filter size={13}/>} 
    </button>
    {active && <div className={`column-menu ${column === 'machines' || column === 'os' ? 'align-right' : ''}`}>
      <div className="column-menu-title">{label}</div>
      <div className="column-sort-actions">
        <button type="button" onClick={() => setSort(column, 'asc')}><ArrowUp size={14}/> {numeric ? 'Menor primeiro' : 'A → Z'}</button>
        <button type="button" onClick={() => setSort(column, 'desc')}><ArrowDown size={14}/> {numeric ? 'Maior primeiro' : 'Z → A'}</button>
      </div>
      <label className="column-filter-field">
        <span>Filtrar</span>
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={numeric ? 'Ex.: 2' : 'Digite para filtrar'} inputMode={numeric ? 'numeric' : undefined}/>
      </label>
      {filter && <button className="clear-column-filter" type="button" onClick={() => setFilter('')}><X size={13}/> Limpar filtro</button>}
    </div>}
  </div>;
}

export function RetentionView({ clients, loading, futureClients, serialsByClient, onFollowup }: { clients: ClientSummary[]; loading: boolean; futureClients: Set<string>; serialsByClient: Record<string, string[]>; onFollowup: (client: ClientSummary) => void }) {
  const [months, setMonths] = useState(6);
  const [search, setSearch] = useState('');
  const [activeColumn, setActiveColumn] = useState<ColumnKey | null>(null);
  const [sortKey, setSortKey] = useState<ColumnKey>('last');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [filters, setFilters] = useState<Record<ColumnKey, string>>({ client: '', serial: '', city: '', last: '', machines: '', os: '' });

  function serialsFor(client: ClientSummary) {
    return serialsByClient[retentionKey(client.client_name, client.branch)] || [];
  }

  function updateFilter(column: ColumnKey, value: string) {
    setFilters((current) => ({ ...current, [column]: value }));
  }

  function updateSort(column: ColumnKey, direction: SortDirection) {
    setSortKey(column);
    setSortDirection(direction);
    setActiveColumn(null);
  }

  const filtered = useMemo(() => {
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - months);
    cutoff.setHours(0, 0, 0, 0);

    const rows = clients.filter((client) => {
      if (!client.last_service_at) return false;
      const lastDate = new Date(client.last_service_at);
      const matchPeriod = lastDate >= cutoff && lastDate <= now;
      if (!matchPeriod) return false;

      const clientSerials = serialsByClient[retentionKey(client.client_name, client.branch)] || [];
      const serialText = clientSerials.join(' ');
      const globalText = `${client.client_name} ${client.city || ''} ${serialText}`.toLowerCase();
      const matchSearch = !search || globalText.includes(search.toLowerCase());
      const hasFuture = futureClients.has(retentionKey(client.client_name, client.branch));
      if (!matchSearch || hasFuture) return false;

      const formattedDate = dateFmt.format(lastDate);
      const columnMatches =
        (!filters.client || client.client_name.toLowerCase().includes(filters.client.toLowerCase())) &&
        (!filters.serial || serialText.toLowerCase().includes(filters.serial.toLowerCase())) &&
        (!filters.city || (client.city || '').toLowerCase().includes(filters.city.toLowerCase())) &&
        (!filters.last || formattedDate.includes(filters.last)) &&
        (!filters.machines || String(client.machine_count).includes(filters.machines.trim())) &&
        (!filters.os || String(client.service_count).includes(filters.os.trim()));
      return columnMatches;
    });

    const direction = sortDirection === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      let av: string | number = '';
      let bv: string | number = '';
      if (sortKey === 'client') { av = a.client_name; bv = b.client_name; }
      if (sortKey === 'serial') { av = serialsFor(a).join(', '); bv = serialsFor(b).join(', '); }
      if (sortKey === 'city') { av = a.city || ''; bv = b.city || ''; }
      if (sortKey === 'last') { av = a.last_service_at ? new Date(a.last_service_at).getTime() : 0; bv = b.last_service_at ? new Date(b.last_service_at).getTime() : 0; }
      if (sortKey === 'machines') { av = a.machine_count; bv = b.machine_count; }
      if (sortKey === 'os') { av = a.service_count; bv = b.service_count; }
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * direction;
      return String(av).localeCompare(String(bv), 'pt-BR', { numeric: true, sensitivity: 'base' }) * direction;
    });
    return rows;
  }, [clients, months, search, futureClients, serialsByClient, filters, sortKey, sortDirection]);

  return <section className="list-page">
    <div className="list-toolbar">
      <div className="search-box"><Search size={18}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar cliente, série ou cidade" /></div>
      <label className="inline-filter"><span>Último atendimento em</span><select value={months} onChange={(e) => setMonths(Number(e.target.value))}><option value={6}>últimos 6 meses</option><option value={9}>últimos 9 meses</option><option value={12}>últimos 12 meses</option><option value={18}>últimos 18 meses</option></select></label>
    </div>
    <div className="table-shell retention-table">
      <div className="table-head retention-columns retention-head">
        <ColumnHeader column="client" label="Cliente" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.client} setFilter={(value) => updateFilter('client', value)}/>
        <ColumnHeader column="serial" label="Série" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.serial} setFilter={(value) => updateFilter('serial', value)}/>
        <ColumnHeader column="city" label="Cidade" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.city} setFilter={(value) => updateFilter('city', value)}/>
        <ColumnHeader column="last" label="Último atendimento" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.last} setFilter={(value) => updateFilter('last', value)}/>
        <ColumnHeader column="machines" label="Máquinas" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.machines} setFilter={(value) => updateFilter('machines', value)} numeric/>
        <ColumnHeader column="os" label="OS" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.os} setFilter={(value) => updateFilter('os', value)} numeric/>
        <span></span>
      </div>
      {loading ? <div className="table-loading">Analisando histórico G4...</div> : filtered.length === 0 ? <EmptyState title="Nenhum cliente nessa faixa" text="O período agora considera somente o intervalo selecionado. Ajuste os filtros se quiser ampliar a análise." /> : filtered.map((client) => {
        const days = client.last_service_at ? daysBetween(client.last_service_at.slice(0, 10)) : 0;
        const serials = serialsFor(client);
        const serialText = serials.length ? serials.join(', ') : '—';
        return <div className="table-row retention-columns" key={client.client_key}>
          <div><strong>{client.client_name}</strong><small>{client.last_operation_type || 'Última operação não informada'}</small></div>
          <div className="series-cell" title={serialText}><strong>{serialText}</strong></div>
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
