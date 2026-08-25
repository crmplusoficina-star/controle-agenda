import { ArrowDown, ArrowUp, Filter, List, Map, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Appointment, ClientSummary, Followup, Technician } from '../types';
import { daysBetween } from '../lib/date';
import { supabase } from '../lib/supabase';
import { EmptyState } from '../components/EmptyState';
import { RetentionMap } from './RetentionMap';
import { recencyBucket, recencyColor, retentionRecency } from './retentionRecency';
import type { RecencyBucket } from './retentionRecency';
import './retention.css';

const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const shortDateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
const retentionKey = (clientName: string, branchName: string) => `${clientName.trim().toUpperCase()}|${branchName.trim().toUpperCase()}`;
const PAGE_SIZE = 1000;

const stageLabels: Record<string, string> = { prospectar: 'Prospectar', acompanhar: 'Acompanhar', encerrar: 'Encerrada' };
const lostReasonLabels: Record<string, string> = {
  sem_interesse: 'Sem interesse',
  preco: 'Preço',
  concorrente: 'Concorrente',
  sem_contato: 'Sem contato',
  adiado: 'Adiado',
  outro: 'Outro',
};
const saleKindLabels: Record<string, string> = { pecas: 'Peças', servicos: 'Serviços', pecas_servicos: 'Peças + serviços' };

type ColumnKey = 'client' | 'serial' | 'city' | 'last' | 'machines' | 'os' | 'treatment';
type SortDirection = 'asc' | 'desc';

type ClientCitySummary = {
  city_key: string;
  client_key: string;
  client_name: string;
  branch: string;
  city: string;
  first_service_at: string | null;
  last_service_at: string | null;
  service_count: number;
  machine_count: number;
  serials: string[];
  last_operation_type: string | null;
  last_description: string | null;
};

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

function foldText(value: string | null | undefined) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function ColumnHeader({ column, label, activeColumn, setActiveColumn, sortKey, sortDirection, setSort, filter, setFilter, numeric }: ColumnHeaderProps) {
  const active = activeColumn === column;
  const sorted = sortKey === column;
  return <div className="retention-head-cell">
    <button className={`column-head-button ${filter ? 'has-filter' : ''}`} type="button" onClick={() => setActiveColumn(active ? null : column)}>
      <span>{label}</span>
      {sorted ? (sortDirection === 'asc' ? <ArrowUp size={13}/> : <ArrowDown size={13}/>) : <Filter size={13}/>} 
    </button>
    {active && <div className={`column-menu ${column === 'machines' || column === 'os' || column === 'treatment' ? 'align-right' : ''}`}>
      <div className="column-menu-title">{label}</div>
      <div className="column-sort-actions">
        <button type="button" onClick={() => setSort(column, 'asc')}><ArrowUp size={14}/> {numeric ? 'Menor primeiro' : 'A → Z'}</button>
        <button type="button" onClick={() => setSort(column, 'desc')}><ArrowDown size={14}/> {numeric ? 'Maior primeiro' : 'Z → A'}</button>
      </div>
      <label className="column-filter-field"><span>Filtrar</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={column === 'treatment' ? 'Ex.: Em tratativa' : numeric ? 'Ex.: 2' : 'Digite para filtrar'} inputMode={numeric ? 'numeric' : undefined}/></label>
      {filter && <button className="clear-column-filter" type="button" onClick={() => setFilter('')}><X size={13}/> Limpar filtro</button>}
    </div>}
  </div>;
}

function RecencyLegend({ active, onChange }: { active: RecencyBucket | null; onChange: (bucket: RecencyBucket | null) => void }) {
  return <div className="retention-recency-legend">
    {retentionRecency.map((item) => <button type="button" key={item.key} className={active === item.key ? 'active' : ''} onClick={() => onChange(active === item.key ? null : item.key)} title={active === item.key ? 'Clique novamente para remover o filtro' : `Filtrar ${item.label}`}><i style={{ background: item.color }}/><span>{item.label}</span></button>)}
    {active && <button type="button" className="clear-recency" onClick={() => onChange(null)}><X size={12}/> Limpar</button>}
  </div>;
}

function treatmentStatus(item?: Followup) {
  if (!item) return { label: 'Sem tratativa', detail: 'Nunca trabalhado', kind: 'none' as const, open: false };
  if (item.stage !== 'encerrar') {
    const owner = item.updated_by_name || item.created_by_name || '';
    return { label: 'Em tratativa', detail: `${stageLabels[item.stage] || 'Prospectar'}${owner ? ` · ${owner}` : ''}`, kind: 'open' as const, open: true };
  }
  if (item.result === 'venda_ganha') {
    const kind = item.sale_kind ? saleKindLabels[item.sale_kind] || '' : '';
    return { label: 'Venda ganha', detail: kind || (item.updated_by_name || item.created_by_name || 'Encerrada'), kind: 'won' as const, open: false };
  }
  if (item.result === 'venda_perdida') {
    const reason = item.lost_reason ? lostReasonLabels[item.lost_reason] || '' : '';
    return { label: 'Venda perdida', detail: reason || (item.updated_by_name || item.created_by_name || 'Encerrada'), kind: 'lost' as const, open: false };
  }
  return { label: 'Encerrada', detail: item.updated_by_name || item.created_by_name || '', kind: 'closed' as const, open: false };
}

export function RetentionView({ clients, loading, futureClients, serialsByClient, appointments, technicians, weekStart, onFollowup, onOpen, onSchedule }: {
  clients: ClientSummary[];
  loading: boolean;
  futureClients: Set<string>;
  serialsByClient: Record<string, string[]>;
  appointments: Appointment[];
  technicians: Technician[];
  weekStart: Date;
  onFollowup: (client: ClientSummary) => void;
  onOpen: (client: ClientSummary) => void;
  onSchedule: (client: ClientSummary, serial: string, technicianId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'list' | 'map'>('list');
  const [recencyFilter, setRecencyFilter] = useState<RecencyBucket | null>(null);
  const [activeColumn, setActiveColumn] = useState<ColumnKey | null>(null);
  const [sortKey, setSortKey] = useState<ColumnKey>('last');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [filters, setFilters] = useState<Record<ColumnKey, string>>({ client: '', serial: '', city: '', last: '', machines: '', os: '', treatment: '' });
  const [treatments, setTreatments] = useState<Record<string, Followup>>({});
  const [citySummaries, setCitySummaries] = useState<Record<string, ClientCitySummary[]>>({});

  const clientBranchesKey = useMemo(() => Array.from(new Set(clients.map((client) => client.branch))).sort().join('|'), [clients]);

  useEffect(() => {
    let cancelled = false;
    const branchNames = clientBranchesKey ? clientBranchesKey.split('|').filter(Boolean) : [];
    if (!branchNames.length) {
      setTreatments({});
      setCitySummaries({});
      return;
    }

    async function loadTreatmentSummary() {
      const rows: Followup[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase.from('followups').select('*').in('branch', branchNames).order('updated_at', { ascending: false }).range(from, from + PAGE_SIZE - 1);
        if (error) {
          console.error('retention_followups_failed', error);
          return;
        }
        const page = (data || []) as Followup[];
        rows.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
      if (cancelled) return;

      const open: Record<string, Followup> = {};
      const closed: Record<string, Followup> = {};
      for (const item of rows) {
        const key = retentionKey(item.client_name, item.branch);
        if (item.stage !== 'encerrar') {
          if (!open[key]) open[key] = item;
        } else if (!closed[key]) {
          closed[key] = item;
        }
      }
      setTreatments({ ...closed, ...open });
    }

    async function loadCitySummaries() {
      const rows: ClientCitySummary[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
          .from('g4_client_city_summary')
          .select('city_key,client_key,client_name,branch,city,first_service_at,last_service_at,service_count,machine_count,serials,last_operation_type,last_description')
          .in('branch', branchNames)
          .order('last_service_at', { ascending: false })
          .range(from, from + PAGE_SIZE - 1);
        if (error) {
          console.error('retention_city_summary_failed', error);
          return;
        }
        const page = (data || []) as ClientCitySummary[];
        rows.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
      if (cancelled) return;
      const grouped: Record<string, ClientCitySummary[]> = {};
      for (const row of rows) {
        const bucket = grouped[row.client_key] || [];
        bucket.push(row);
        grouped[row.client_key] = bucket;
      }
      setCitySummaries(grouped);
    }

    void loadTreatmentSummary();
    void loadCitySummaries();
    return () => { cancelled = true; };
  }, [clientBranchesKey]);

  const cityNeedle = foldText(filters.city);

  function cityContextFor(client: ClientSummary) {
    if (!cityNeedle) return null;
    return (citySummaries[client.client_key] || []).find((row) => foldText(row.city).includes(cityNeedle)) || null;
  }

  function effectiveClientFor(client: ClientSummary): ClientSummary {
    const cityContext = cityContextFor(client);
    if (!cityContext) return client;
    return {
      ...client,
      city: cityContext.city,
      first_service_at: cityContext.first_service_at,
      last_service_at: cityContext.last_service_at,
      service_count: cityContext.service_count,
      machine_count: cityContext.machine_count,
      last_operation_type: cityContext.last_operation_type,
      last_description: cityContext.last_description,
    };
  }

  function serialsFor(client: ClientSummary) {
    const cityContext = cityContextFor(client);
    if (cityContext) return cityContext.serials || [];
    return serialsByClient[retentionKey(client.client_name, client.branch)] || [];
  }

  function citiesForSearch(client: ClientSummary) {
    return (citySummaries[client.client_key] || []).map((row) => row.city).join(' ');
  }

  function treatmentFor(client: ClientSummary) { return treatments[retentionKey(client.client_name, client.branch)]; }
  function treatmentText(client: ClientSummary) {
    const state = treatmentStatus(treatmentFor(client));
    return `${state.label} ${state.detail}`.trim();
  }
  function updateFilter(column: ColumnKey, value: string) { setFilters((current) => ({ ...current, [column]: value })); }
  function updateSort(column: ColumnKey, direction: SortDirection) { setSortKey(column); setSortDirection(direction); setActiveColumn(null); }
  function applyRecencyFilter(bucket: RecencyBucket | null) { setRecencyFilter(bucket); }

  const filtered = useMemo(() => {
    const rows = clients.flatMap((original) => {
      const cityContext = cityContextFor(original);
      if (cityNeedle && !cityContext) return [];
      const client = cityContext ? effectiveClientFor(original) : original;
      if (!client.last_service_at) return (!recencyFilter || recencyFilter === '18+') ? [client] : [];
      if (recencyFilter && recencyBucket(client.last_service_at) !== recencyFilter) return [];
      const clientSerials = serialsFor(client);
      const serialText = clientSerials.join(' ');
      const treatment = treatmentText(client);
      const globalText = `${client.client_name} ${client.city || ''} ${citiesForSearch(original)} ${serialText} ${treatment}`.toLowerCase();
      if (search && !globalText.includes(search.toLowerCase())) return [];
      if (futureClients.has(retentionKey(client.client_name, client.branch))) return [];
      const formattedDate = dateFmt.format(new Date(client.last_service_at));
      const matches = (!filters.client || client.client_name.toLowerCase().includes(filters.client.toLowerCase())) &&
        (!filters.serial || serialText.toLowerCase().includes(filters.serial.toLowerCase())) &&
        (!filters.last || formattedDate.includes(filters.last)) &&
        (!filters.machines || String(client.machine_count).includes(filters.machines.trim())) &&
        (!filters.os || String(client.service_count).includes(filters.os.trim())) &&
        (!filters.treatment || treatment.toLowerCase().includes(filters.treatment.toLowerCase()));
      return matches ? [client] : [];
    });

    const direction = sortDirection === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      let av: string | number = ''; let bv: string | number = '';
      if (sortKey === 'client') { av = a.client_name; bv = b.client_name; }
      if (sortKey === 'serial') { av = serialsFor(a).join(', '); bv = serialsFor(b).join(', '); }
      if (sortKey === 'city') { av = a.city || ''; bv = b.city || ''; }
      if (sortKey === 'last') { av = a.last_service_at ? new Date(a.last_service_at).getTime() : 0; bv = b.last_service_at ? new Date(b.last_service_at).getTime() : 0; }
      if (sortKey === 'machines') { av = a.machine_count; bv = b.machine_count; }
      if (sortKey === 'os') { av = a.service_count; bv = b.service_count; }
      if (sortKey === 'treatment') { av = treatmentText(a); bv = treatmentText(b); }
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * direction;
      return String(av).localeCompare(String(bv), 'pt-BR', { numeric: true, sensitivity: 'base' }) * direction;
    });
    return rows;
  }, [clients, recencyFilter, search, futureClients, serialsByClient, filters, sortKey, sortDirection, treatments, citySummaries, cityNeedle]);

  const mapClients = useMemo(() => {
    if (!cityNeedle) return filtered;
    return filtered.map((client) => ({
      ...client,
      client_key: `${client.client_key}::CITY::${foldText(client.city)}`,
    }));
  }, [filtered, cityNeedle]);

  const mapOriginalByKey = useMemo(() => {
    const result = new globalThis.Map<string, ClientSummary>();
    mapClients.forEach((mapClient, index) => result.set(mapClient.client_key, filtered[index]));
    return result;
  }, [mapClients, filtered]);

  function originalMapClient(client: ClientSummary) {
    return mapOriginalByKey.get(client.client_key) || client;
  }

  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 5);
  const weekLabel = `Agenda ${shortDateFmt.format(weekStart)}–${shortDateFmt.format(weekEnd)}`;

  return <section className="list-page">
    <div className="list-toolbar">
      <div className="search-box"><Search size={18}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar cliente, série ou cidade" /></div>
      <div className="retention-toolbar-right">
        <div className="retention-view-switch" aria-label="Alternar visualização">
          <button type="button" className={mode === 'list' ? 'active' : ''} onClick={() => setMode('list')}><List size={14}/> Lista</button>
          <button type="button" className={mode === 'map' ? 'active' : ''} onClick={() => setMode('map')}><Map size={14}/> Mapa</button>
        </div>
      </div>
    </div>

    {mode === 'list' && <RecencyLegend active={recencyFilter} onChange={applyRecencyFilter}/>} 

    {mode === 'map' ? <RetentionMap clients={mapClients} serialsByClient={serialsByClient} appointments={appointments} technicians={technicians} weekLabel={weekLabel} recencyFilter={recencyFilter} onRecencyFilter={applyRecencyFilter} onOpen={(client) => onOpen(originalMapClient(client))} onFollowup={(client) => onFollowup(originalMapClient(client))} onSchedule={(client, serial, technicianId) => onSchedule(originalMapClient(client), serial, technicianId)} /> : <div className="table-shell retention-table">
      <div className="table-head retention-columns retention-head">
        <ColumnHeader column="client" label="Cliente" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.client} setFilter={(value) => updateFilter('client', value)}/>
        <ColumnHeader column="serial" label="Série" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.serial} setFilter={(value) => updateFilter('serial', value)}/>
        <ColumnHeader column="city" label="Cidade" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.city} setFilter={(value) => updateFilter('city', value)}/>
        <ColumnHeader column="last" label="Último atendimento" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.last} setFilter={(value) => updateFilter('last', value)}/>
        <ColumnHeader column="machines" label="Máquinas" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.machines} setFilter={(value) => updateFilter('machines', value)} numeric/>
        <ColumnHeader column="os" label="OS" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.os} setFilter={(value) => updateFilter('os', value)} numeric/>
        <ColumnHeader column="treatment" label="Tratativa" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.treatment} setFilter={(value) => updateFilter('treatment', value)}/>
        <span></span>
      </div>
      {loading ? <div className="table-loading">Analisando histórico G4...</div> : filtered.length === 0 ? <EmptyState title="Nenhum cliente nessa faixa" text="Nenhum cliente corresponde aos filtros aplicados." /> : filtered.map((client) => {
        const days = client.last_service_at ? daysBetween(client.last_service_at.slice(0, 10)) : 0;
        const serials = serialsFor(client);
        const serialText = serials.length ? serials.join(', ') : '—';
        const treatment = treatmentStatus(treatmentFor(client));
        const actionLabel = treatment.open ? 'Abrir tratativa' : treatment.kind === 'none' ? 'Criar tratativa' : 'Nova tratativa';
        return <div className="table-row retention-columns retention-click-row" key={client.client_key} role="button" tabIndex={0} onClick={() => onOpen(client)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onOpen(client); }}>
          <div><div className="retention-client-line"><i className="retention-row-dot" style={{ background: recencyColor(client.last_service_at) }}/><strong>{client.client_name}</strong></div><small>{client.last_operation_type || 'Última operação não informada'}</small></div>
          <div className="series-cell" title={serialText}><strong>{serialText}</strong></div>
          <span>{client.city || '—'}</span>
          <div><strong>{client.last_service_at ? dateFmt.format(new Date(client.last_service_at)) : '—'}</strong><small>{days ? `${Math.floor(days / 30)} meses atrás` : ''}</small></div>
          <strong>{client.machine_count}</strong>
          <strong>{client.service_count}</strong>
          <div className={`treatment-summary treatment-${treatment.kind}`}><strong>{treatment.label}</strong><small>{treatment.detail}</small></div>
          <button className="row-action" onClick={(event) => { event.stopPropagation(); onFollowup(client); }}>{actionLabel}</button>
        </div>;
      })}
    </div>}
  </section>;
}