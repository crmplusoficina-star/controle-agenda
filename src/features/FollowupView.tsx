import { ArrowDown, ArrowUp, Filter, Plus, Search, X } from 'lucide-react';
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

type ColumnKey = 'client' | 'note' | 'stage' | 'next' | 'result' | 'value';
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
  return <div className="followup-head-cell">
    <button className={`followup-column-head ${filter ? 'has-filter' : ''}`} type="button" onClick={() => setActiveColumn(active ? null : column)}>
      <span>{label}</span>
      {sorted ? (sortDirection === 'asc' ? <ArrowUp size={13}/> : <ArrowDown size={13}/>) : <Filter size={13}/>}
    </button>
    {active && <div className={`followup-column-menu ${column === 'result' || column === 'value' ? 'align-right' : ''}`}>
      <div className="followup-column-menu-title">{label}</div>
      <div className="followup-column-sort-actions">
        <button type="button" onClick={() => setSort(column, 'asc')}><ArrowUp size={14}/> {numeric ? 'Menor primeiro' : 'A → Z'}</button>
        <button type="button" onClick={() => setSort(column, 'desc')}><ArrowDown size={14}/> {numeric ? 'Maior primeiro' : 'Z → A'}</button>
      </div>
      <label className="followup-column-filter"><span>Filtrar</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={numeric ? 'Ex.: 1000' : 'Digite para filtrar'} inputMode={numeric ? 'decimal' : undefined}/></label>
      {filter && <button className="followup-clear-column-filter" type="button" onClick={() => setFilter('')}><X size={13}/> Limpar filtro</button>}
    </div>}
  </div>;
}

function totalSale(item: Followup) {
  return Number(item.parts_value || 0) + Number(item.services_value || 0);
}

function resultText(item: Followup) {
  const base = item.result ? resultLabels[item.result] : 'Em andamento';
  const reason = item.lost_reason ? lostReasonLabels[item.lost_reason] : '';
  return reason ? `${base} · ${reason}` : base;
}

export function FollowupView({ rows, loading, onNew, onEdit }: {
  rows: Followup[];
  loading: boolean;
  onNew: () => void;
  onEdit: (item: Followup) => void;
}) {
  const [search, setSearch] = useState('');
  const [activeColumn, setActiveColumn] = useState<ColumnKey | null>(null);
  const [sortKey, setSortKey] = useState<ColumnKey>('next');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [filters, setFilters] = useState<Record<ColumnKey, string>>({ client: '', note: '', stage: '', next: '', result: '', value: '' });

  function updateFilter(column: ColumnKey, value: string) {
    setFilters((current) => ({ ...current, [column]: value }));
  }

  function updateSort(column: ColumnKey, direction: SortDirection) {
    setSortKey(column);
    setSortDirection(direction);
    setActiveColumn(null);
  }

  const filtered = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const list = rows.filter((item) => {
      const total = totalSale(item);
      const nextText = item.next_followup_date ? dateFmt.format(new Date(`${item.next_followup_date}T12:00:00`)) : '—';
      const stageText = stageLabels[item.stage] || 'Prospectar';
      const result = resultText(item);
      const globalText = `${item.client_name} ${item.equipment_serial || ''} ${item.branch} ${item.notes || ''} ${stageText} ${nextText} ${result}`.toLowerCase();
      if (normalizedSearch && !globalText.includes(normalizedSearch)) return false;
      return (!filters.client || `${item.client_name} ${item.equipment_serial || ''} ${item.branch}`.toLowerCase().includes(filters.client.toLowerCase())) &&
        (!filters.note || (item.notes || '').toLowerCase().includes(filters.note.toLowerCase())) &&
        (!filters.stage || stageText.toLowerCase().includes(filters.stage.toLowerCase())) &&
        (!filters.next || nextText.includes(filters.next)) &&
        (!filters.result || result.toLowerCase().includes(filters.result.toLowerCase())) &&
        (!filters.value || String(total).includes(filters.value.replace(',', '.').trim()));
    });

    const direction = sortDirection === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      let av: string | number = '';
      let bv: string | number = '';
      if (sortKey === 'client') { av = a.client_name; bv = b.client_name; }
      if (sortKey === 'note') { av = a.notes || ''; bv = b.notes || ''; }
      if (sortKey === 'stage') { av = stageLabels[a.stage] || ''; bv = stageLabels[b.stage] || ''; }
      if (sortKey === 'next') {
        av = a.next_followup_date ? new Date(`${a.next_followup_date}T12:00:00`).getTime() : Number.MAX_SAFE_INTEGER;
        bv = b.next_followup_date ? new Date(`${b.next_followup_date}T12:00:00`).getTime() : Number.MAX_SAFE_INTEGER;
      }
      if (sortKey === 'result') { av = resultText(a); bv = resultText(b); }
      if (sortKey === 'value') { av = totalSale(a); bv = totalSale(b); }
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * direction;
      return String(av).localeCompare(String(bv), 'pt-BR', { numeric: true, sensitivity: 'base' }) * direction;
    });
    return list;
  }, [rows, search, filters, sortKey, sortDirection]);

  return <section className="list-page">
    <div className="list-toolbar">
      <div className="search-box"><Search size={18}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar cliente ou série" /></div>
      <button className="primary-button" onClick={onNew}><Plus size={17}/> Nova tratativa</button>
    </div>

    <div className="table-shell followup-table-shell">
      <div className="table-head followup-table-columns followup-table-head">
        <ColumnHeader column="client" label="Cliente" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.client} setFilter={(value) => updateFilter('client', value)}/>
        <ColumnHeader column="note" label="Observação" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.note} setFilter={(value) => updateFilter('note', value)}/>
        <ColumnHeader column="stage" label="Etapa" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.stage} setFilter={(value) => updateFilter('stage', value)}/>
        <ColumnHeader column="next" label="Próximo contato" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.next} setFilter={(value) => updateFilter('next', value)}/>
        <ColumnHeader column="result" label="Resultado" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.result} setFilter={(value) => updateFilter('result', value)}/>
        <ColumnHeader column="value" label="Valor" activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters.value} setFilter={(value) => updateFilter('value', value)} numeric/>
      </div>

      {loading ? <div className="table-loading">Carregando tratativas...</div> : filtered.length === 0 ? <EmptyState title="Nenhuma tratativa" text="Nenhuma tratativa corresponde aos filtros aplicados." /> : filtered.map((item) => {
        const total = totalSale(item);
        return <button className="table-row followup-table-columns followup-table-row" key={item.id} onClick={() => onEdit(item)}>
          <div className="followup-client-cell"><strong>{item.client_name}</strong><small>{item.equipment_serial || item.branch}</small></div>
          <div className="followup-note-cell"><strong>{item.notes || 'Sem observação registrada'}</strong><small>{item.updated_at ? dateFmt.format(new Date(item.updated_at)) : ''}</small></div>
          <span className={`followup-stage stage-${item.stage}`}>{stageLabels[item.stage] || 'Prospectar'}</span>
          <strong>{item.next_followup_date ? dateFmt.format(new Date(`${item.next_followup_date}T12:00:00`)) : '—'}</strong>
          <span className={`followup-result result-${item.result || 'open'}`}>{resultText(item)}</span>
          <strong>{total > 0 ? money.format(total) : '—'}</strong>
        </button>;
      })}
    </div>
  </section>;
}
