import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CalendarDays, Check, Filter, History, ListTodo, Plus, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Followup } from '../types';
import { EmptyState } from '../components/EmptyState';
import { supabase } from '../lib/supabase';
import './followup.css';

const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const monthFmt = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const stageLabels: Record<string, string> = { prospectar: 'Prospectar', acompanhar: 'Acompanhar', encerrar: 'Encerrado' };
const resultLabels: Record<string, string> = { venda_ganha: 'Venda ganha', venda_perdida: 'Venda perdida' };
const lostReasonLabels: Record<string, string> = {
  sem_interesse: 'Cliente sem interesse', preco: 'Preço', concorrente: 'Fechou com concorrente',
  sem_contato: 'Não conseguimos contato', adiado: 'Adiou / sem previsão', outro: 'Outro',
};

type ColumnKey = 'client' | 'note' | 'owner' | 'stage' | 'next' | 'result' | 'value';
type SortDirection = 'asc' | 'desc';
type FollowupTab = 'active' | 'calendar' | 'history';

type ColumnHeaderProps = {
  column: ColumnKey; label: string; activeColumn: ColumnKey | null; setActiveColumn: (column: ColumnKey | null) => void;
  sortKey: ColumnKey; sortDirection: SortDirection; setSort: (key: ColumnKey, direction: SortDirection) => void;
  filter: string; setFilter: (value: string) => void; options: string[]; selected: string[]; setSelected: (values: string[]) => void; numeric?: boolean;
};

function ColumnHeader({ column, label, activeColumn, setActiveColumn, sortKey, sortDirection, setSort, filter, setFilter, options, selected, setSelected, numeric }: ColumnHeaderProps) {
  const active = activeColumn === column;
  const sorted = sortKey === column;
  const hasFilter = Boolean(filter || selected.length);
  const visibleOptions = options.filter((option) => !filter || option.toLowerCase().includes(filter.toLowerCase())).slice(0, 80);
  return <div className="followup-head-cell">
    <button className={`followup-column-head ${hasFilter ? 'has-filter' : ''}`} type="button" onClick={() => setActiveColumn(active ? null : column)}>
      <span>{label}</span>{sorted ? (sortDirection === 'asc' ? <ArrowUp size={13}/> : <ArrowDown size={13}/>) : <Filter size={13}/>} {selected.length > 0 && <b>{selected.length}</b>}
    </button>
    {active && <div className={`followup-column-menu ${column === 'result' || column === 'value' ? 'align-right' : ''}`}>
      <div className="followup-column-menu-title">{label}</div>
      <div className="followup-column-sort-actions">
        <button type="button" onClick={() => setSort(column, 'asc')}><ArrowUp size={14}/> {numeric ? 'Menor primeiro' : 'A → Z'}</button>
        <button type="button" onClick={() => setSort(column, 'desc')}><ArrowDown size={14}/> {numeric ? 'Maior primeiro' : 'Z → A'}</button>
      </div>
      <label className="followup-column-filter"><span>Filtrar</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={numeric ? 'Digite um valor' : 'Digite para filtrar'} inputMode={numeric ? 'decimal' : undefined}/></label>
      <div className="followup-option-list">
        {visibleOptions.map((option) => {
          const checked = selected.includes(option);
          return <button type="button" className={checked ? 'selected' : ''} key={option} onClick={() => setSelected(checked ? selected.filter((item) => item !== option) : [...selected, option])}>
            <span className="followup-option-check">{checked && <Check size={12}/>}</span><span>{option}</span>
          </button>;
        })}
      </div>
      {hasFilter && <button className="followup-clear-column-filter" type="button" onClick={() => { setFilter(''); setSelected([]); }}><X size={13}/> Limpar filtro</button>}
    </div>}
  </div>;
}

function saleTotal(item: Followup) { return Number(item.parts_value || 0) + Number(item.services_value || 0); }
function displayValue(item: Followup) { const sale = saleTotal(item); return sale > 0 ? sale : Number(item.estimated_value || 0); }
function stageText(item: Followup) {
  if (item.stage !== 'encerrar' && displayValue(item) > 0) return 'Oportunidade';
  return stageLabels[item.stage] || 'Prospectar';
}
function resultText(item: Followup) {
  const base = item.result ? resultLabels[item.result] : 'Em andamento';
  const reason = item.lost_reason ? lostReasonLabels[item.lost_reason] : '';
  return reason ? `${base} · ${reason}` : base;
}
function ownerText(item: Followup) { return item.updated_by_name || item.created_by_name || 'Anterior ao login'; }
function nextText(item: Followup) { return item.next_followup_date ? dateFmt.format(new Date(`${item.next_followup_date}T12:00:00`)) : 'Sem data'; }
function columnValue(item: Followup, column: ColumnKey) {
  if (column === 'client') return item.client_name;
  if (column === 'note') return item.notes || 'Sem observação';
  if (column === 'owner') return ownerText(item);
  if (column === 'stage') return stageText(item);
  if (column === 'next') return nextText(item);
  if (column === 'result') return resultText(item);
  return displayValue(item) > 0 ? money.format(displayValue(item)) : 'Sem valor';
}

function InlineValue({ item, onSave }: { item: Followup; onSave: (item: Followup, value: number | null) => Promise<void> }) {
  const initial = displayValue(item);
  const [displayed, setDisplayed] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial > 0 ? String(initial).replace('.', ',') : '');
  const [saving, setSaving] = useState(false);
  async function save() {
    const normalized = value.trim().replace(/\./g, '').replace(',', '.');
    const parsed = normalized ? Number(normalized) : null;
    if (normalized && !Number.isFinite(parsed)) return;
    setSaving(true);
    await onSave(item, parsed);
    setDisplayed(parsed || 0);
    setSaving(false);
    setEditing(false);
  }
  if (!editing) return <button type="button" className="followup-inline-value" onClick={(e) => { e.stopPropagation(); setValue(displayed > 0 ? String(displayed).replace('.', ',') : ''); setEditing(true); }}>{displayed > 0 ? money.format(displayed) : <><Plus size={12}/> Informar</>}</button>;
  return <input className="followup-inline-value-input" autoFocus value={value} inputMode="decimal" disabled={saving} onClick={(e) => e.stopPropagation()} onChange={(e) => setValue(e.target.value)} onBlur={() => void save()} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } if (e.key === 'Escape') setEditing(false); }}/ >;
}

function CalendarView({ rows, onEdit }: { rows: Followup[]; onEdit: (item: Followup) => void }) {
  const [cursor, setCursor] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); });
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const mondayIndex = (first.getDay() + 6) % 7;
  const cells = Array.from({ length: Math.ceil((mondayIndex + last.getDate()) / 7) * 7 }, (_, index) => {
    const day = index - mondayIndex + 1;
    return day >= 1 && day <= last.getDate() ? day : null;
  });
  const byDay = new Map<number, Followup[]>();
  for (const item of rows) {
    if (!item.next_followup_date) continue;
    const d = new Date(`${item.next_followup_date}T12:00:00`);
    if (d.getFullYear() !== cursor.getFullYear() || d.getMonth() !== cursor.getMonth()) continue;
    const list = byDay.get(d.getDate()) || []; list.push(item); byDay.set(d.getDate(), list);
  }
  return <div className="followup-calendar-shell">
    <div className="followup-calendar-toolbar"><strong>{monthFmt.format(cursor)}</strong><div><button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}><ArrowLeft size={16}/></button><button onClick={() => setCursor(new Date())}>Hoje</button><button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}><ArrowRight size={16}/></button></div></div>
    <div className="followup-calendar-weekdays">{['SEG','TER','QUA','QUI','SEX','SÁB','DOM'].map((day) => <span key={day}>{day}</span>)}</div>
    <div className="followup-calendar-grid">{cells.map((day, index) => <div className={`followup-calendar-day ${day ? '' : 'empty'}`} key={index}>{day && <><b>{day}</b><div className="followup-calendar-items">{(byDay.get(day) || []).map((item) => <button type="button" key={item.id} onClick={() => onEdit(item)}><strong>{item.client_name}</strong><span>{item.notes || 'Entrar em contato'}</span>{displayValue(item) > 0 && <small>{money.format(displayValue(item))}</small>}</button>)}</div></>}</div>)}</div>
  </div>;
}

export function FollowupView({ rows, loading, onNew, onEdit, onQuickValue }: {
  rows: Followup[]; loading: boolean; onNew: () => void; onEdit: (item: Followup) => void; onQuickValue?: (item: Followup, value: number | null) => Promise<void>;
}) {
  const [tab, setTab] = useState<FollowupTab>('active');
  const [search, setSearch] = useState('');
  const [activeColumn, setActiveColumn] = useState<ColumnKey | null>(null);
  const [sortKey, setSortKey] = useState<ColumnKey>('next');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [filters, setFilters] = useState<Record<ColumnKey, string>>({ client: '', note: '', owner: '', stage: '', next: '', result: '', value: '' });
  const [selectedFilters, setSelectedFilters] = useState<Record<ColumnKey, string[]>>({ client: [], note: [], owner: [], stage: [], next: [], result: [], value: [] });
  const [valueRevision, setValueRevision] = useState(0);

  const baseQuickValue = onQuickValue || (async (item: Followup, value: number | null) => {
    const { error } = await supabase.from('followups').update({ estimated_value: value }).eq('id', item.id);
    if (error) console.error('followup_quick_value_failed', error);
  });
  const saveQuickValue = async (item: Followup, value: number | null) => {
    await baseQuickValue(item, value);
    item.estimated_value = value;
    setValueRevision((current) => current + 1);
  };
  const activeRows = useMemo(() => rows.filter((item) => item.stage !== 'encerrar'), [rows]);
  const historyRows = useMemo(() => rows.filter((item) => item.stage === 'encerrar' || Boolean(item.result)), [rows]);
  const sourceRows = tab === 'history' ? historyRows : activeRows;
  const optionMap = useMemo(() => {
    const map = {} as Record<ColumnKey, string[]>;
    (['client','note','owner','stage','next','result','value'] as ColumnKey[]).forEach((column) => { map[column] = Array.from(new Set(sourceRows.map((item) => columnValue(item, column)))).sort((a,b) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' })); });
    return map;
  }, [sourceRows, valueRevision]);

  function updateSort(column: ColumnKey, direction: SortDirection) { setSortKey(column); setSortDirection(direction); setActiveColumn(null); }
  const filtered = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    const list = sourceRows.filter((item) => {
      const globalText = `${item.client_name} ${item.equipment_serial || ''} ${item.branch} ${item.notes || ''} ${ownerText(item)} ${stageText(item)} ${nextText(item)} ${resultText(item)}`.toLowerCase();
      if (normalizedSearch && !globalText.includes(normalizedSearch)) return false;
      return (['client','note','owner','stage','next','result','value'] as ColumnKey[]).every((column) => {
        const value = columnValue(item, column);
        const typed = filters[column].trim().toLowerCase();
        if (typed && !value.toLowerCase().includes(typed)) return false;
        return !selectedFilters[column].length || selectedFilters[column].includes(value);
      });
    });
    const direction = sortDirection === 'asc' ? 1 : -1;
    list.sort((a,b) => {
      if (sortKey === 'value') return (displayValue(a) - displayValue(b)) * direction;
      if (sortKey === 'next') return (((a.next_followup_date ? new Date(`${a.next_followup_date}T12:00:00`).getTime() : Number.MAX_SAFE_INTEGER) - (b.next_followup_date ? new Date(`${b.next_followup_date}T12:00:00`).getTime() : Number.MAX_SAFE_INTEGER)) * direction);
      return columnValue(a, sortKey).localeCompare(columnValue(b, sortKey), 'pt-BR', { numeric: true, sensitivity: 'base' }) * direction;
    });
    return list;
  }, [sourceRows, search, filters, selectedFilters, sortKey, sortDirection, valueRevision]);

  const headers = (column: ColumnKey, label: string, numeric = false) => <ColumnHeader column={column} label={label} activeColumn={activeColumn} setActiveColumn={setActiveColumn} sortKey={sortKey} sortDirection={sortDirection} setSort={updateSort} filter={filters[column]} setFilter={(value) => setFilters((current) => ({ ...current, [column]: value }))} options={optionMap[column] || []} selected={selectedFilters[column]} setSelected={(values) => setSelectedFilters((current) => ({ ...current, [column]: values }))} numeric={numeric}/>;

  return <section className="list-page followup-workspace">
    <div className="list-toolbar">
      <div className="search-box"><Search size={18}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar cliente ou série" /></div>
      <button className="primary-button" onClick={onNew}><Plus size={17}/> Nova tratativa</button>
    </div>
    <div className="followup-tabs">
      <button className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}><ListTodo size={15}/> Em andamento <b>{activeRows.length}</b></button>
      <button className={tab === 'calendar' ? 'active' : ''} onClick={() => setTab('calendar')}><CalendarDays size={15}/> Agenda</button>
      <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}><History size={15}/> Histórico de vendas <b>{historyRows.length}</b></button>
    </div>

    {tab === 'calendar' ? <CalendarView rows={activeRows} onEdit={onEdit}/> : <div className="table-shell followup-table-shell">
      <div className="table-head followup-table-columns followup-table-head">{headers('client','Cliente')}{headers('note','Observação')}{headers('owner','Consultor')}{headers('stage','Etapa')}{headers('next','Próximo contato')}{headers('result','Resultado')}{headers('value','Valor', true)}</div>
      {loading ? <div className="table-loading">Carregando tratativas...</div> : filtered.length === 0 ? <EmptyState title={tab === 'history' ? 'Nenhuma venda encerrada' : 'Nenhuma tratativa em andamento'} text="Nenhum registro corresponde aos filtros aplicados." /> : filtered.map((item) => <button className="table-row followup-table-columns followup-table-row" key={item.id} onClick={() => onEdit(item)}>
        <div className="followup-client-cell"><strong>{item.client_name}</strong><small>{item.equipment_serial || item.branch}</small></div>
        <div className="followup-note-cell"><strong>{item.notes || 'Sem observação registrada'}</strong><small>{item.updated_at ? dateFmt.format(new Date(item.updated_at)) : ''}</small></div>
        <div className="followup-owner-cell"><strong>{ownerText(item)}</strong></div>
        <span className={`followup-stage ${stageText(item) === 'Oportunidade' ? 'stage-opportunity' : `stage-${item.stage}`}`}>{stageText(item)}</span>
        <strong>{item.next_followup_date ? dateFmt.format(new Date(`${item.next_followup_date}T12:00:00`)) : '—'}</strong>
        <span className={`followup-result result-${item.result || 'open'}`}>{resultText(item)}</span>
        <InlineValue item={item} onSave={saveQuickValue}/>
      </button>)}
    </div>}
  </section>;
}
