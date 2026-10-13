import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Plus, Search, Trash2, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { ColumnFilterHeader, foldText } from '../components/ColumnFilterHeader';
import { useSession } from '../session';
import type { Branch } from '../types';
import './service-programs.css';

export type ProgramKind = '150h' | 'campanha';
type ProgramStatus = 'Pendente de programação' | 'Pendente execução' | 'Concluído';

type ProgramRow = {
  id: string;
  branch: string;
  campaign_code?: string;
  pin: string | null;
  client_name: string | null;
  city: string | null;
  service_city?: string | null;
  brand?: string | null;
  model: string | null;
  serial_number?: string;
  recommendation?: string;
  repair_deadline?: string | null;
  last_visit?: string | null;
  opportunity_lost?: boolean;
  delivery_date?: string | null;
  programmed_date: string | null;
  executed_date: string | null;
  notes: string | null;
};

const STATUSES: ProgramStatus[] = ['Pendente de programação', 'Pendente execução', 'Concluído'];

export function programStatus(row: { programmed_date: string | null; executed_date: string | null }): ProgramStatus {
  if (!row.programmed_date) return 'Pendente de programação';
  if (!row.executed_date) return 'Pendente execução';
  return 'Concluído';
}

const statusClass: Record<ProgramStatus, string> = {
  'Pendente de programação': 'sp-status-red',
  'Pendente execução': 'sp-status-amber',
  'Concluído': 'sp-status-green',
};

const normText = (value?: string | null) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();

export function effectiveCity(row: { branch: string; city: string | null; service_city?: string | null }) {
  if (row.service_city) return row.service_city;
  return row.city && normText(row.city) !== normText(row.branch) ? row.city : '';
}

const fmt = (value?: string | null) => value ? new Intl.DateTimeFormat('pt-BR').format(new Date(`${value.slice(0, 10)}T12:00:00`)) : '—';

type ProgramColumn = { key: string; label: string; text: (row: ProgramRow) => string; sort?: (row: ProgramRow) => string };

const dash = (value?: string | null) => value || '—';
const COMMON_COLUMNS: ProgramColumn[] = [
  { key: 'programmed', label: 'Data programação', text: (r) => fmt(r.programmed_date), sort: (r) => r.programmed_date || '' },
  { key: 'executed', label: 'Data execução', text: (r) => fmt(r.executed_date), sort: (r) => r.executed_date || '' },
  { key: 'notes', label: 'Observação', text: (r) => dash(r.notes) },
  { key: 'status', label: 'Status', text: (r) => programStatus(r) },
];
const COLUMNS: Record<ProgramKind, ProgramColumn[]> = {
  '150h': [
    { key: 'pin', label: 'PIN', text: (r) => dash(r.pin) },
    { key: 'branch', label: 'Filial', text: (r) => dash(r.branch) },
    { key: 'client', label: 'Cliente', text: (r) => dash(r.client_name) },
    { key: 'brand', label: 'Marca', text: (r) => dash(r.brand) },
    { key: 'delivery', label: 'Data ET', text: (r) => fmt(r.delivery_date), sort: (r) => r.delivery_date || '' },
    { key: 'city', label: 'Cidade', text: (r) => dash(effectiveCity(r)) },
    ...COMMON_COLUMNS,
  ],
  campanha: [
    { key: 'campaign', label: 'Campanha', text: (r) => dash(r.campaign_code) },
    { key: 'branch', label: 'Filial', text: (r) => dash(r.branch) },
    { key: 'machine', label: 'Máquina', text: (r) => `${r.model || ''}-${r.serial_number || ''}` },
    { key: 'client', label: 'Cliente', text: (r) => r.client_name || 'Pendente de validação' },
    { key: 'type', label: 'Tipo / prazo', text: (r) => dash(r.recommendation), sort: (r) => `${r.recommendation || ''}${r.repair_deadline || ''}` },
    { key: 'city', label: 'Cidade', text: (r) => dash(effectiveCity(r)) },
    ...COMMON_COLUMNS,
  ],
};

// A Visita 150h vale só para séries VC (VL e BC ficam de fora)
const isVisita150hSerial = (pin?: string | null) => String(pin || '').trim().toUpperCase().startsWith('VC');

export function ServiceProgramsView({ kind, branches, allBranches }: { kind: ProgramKind; branches: string[]; allBranches: Branch[] }) {
  const { user } = useSession();
  const [rows, setRows] = useState<ProgramRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProgramStatus | 'todos'>('todos');
  const [search, setSearch] = useState('');
  const [savingId, setSavingId] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ campaign: '', description: '', branch: '', model: '', serial: '', pin: '' });
  const [formError, setFormError] = useState('');
  const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [textFilters, setTextFilters] = useState<Record<string, string>>({});
  const [selectedFilters, setSelectedFilters] = useState<Record<string, string[]>>({});
  const isAdmin = user.role === 'admin';
  const columns = COLUMNS[kind];
  const branchKey = branches.join('|');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const query = kind === '150h'
      ? supabase.from('inspection_150h').select('pin,branch,client_name,city,service_city,brand,model,delivery_date,programmed_date,executed_date,notes').order('delivery_date')
      : supabase.from('campaign_machines').select('id,campaign_code,branch,model,serial_number,pin,recommendation,repair_deadline,last_visit,opportunity_lost,client_name,city,service_city,programmed_date,executed_date,notes').order('campaign_code').order('serial_number');
    const scoped = kind === '150h' ? query.ilike('pin', 'VC%') : query;
    const { data, error: loadError } = await (branches.length ? scoped.in('branch', branches) : scoped);
    if (loadError) {
      setError('Não foi possível carregar a lista.');
      setLoading(false);
      return;
    }
    setRows((data || [])
      .filter((row: any) => kind !== '150h' || isVisita150hSerial(row.pin))
      .map((row: any) => ({ ...row, id: kind === '150h' ? row.pin : row.id })));
    setLoading(false);
  }, [kind, branchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSort(null); setTextFilters({}); setSelectedFilters({}); }, [kind]);

  const counts = useMemo(() => {
    const result: Record<string, number> = { todos: rows.length };
    for (const s of STATUSES) result[s] = 0;
    for (const row of rows) result[programStatus(row)] += 1;
    return result;
  }, [rows]);

  const optionsByColumn = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const column of columns) {
      const values = new Set(rows.map((row) => column.text(row)));
      result[column.key] = [...values].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
    }
    return result;
  }, [rows, columns]);

  const hasColumnFilters = columns.some((c) => textFilters[c.key] || selectedFilters[c.key]?.length);

  const visible = useMemo(() => {
    const term = search.trim().toUpperCase();
    const filtered = rows.filter((row) => {
      if (statusFilter !== 'todos' && programStatus(row) !== statusFilter) return false;
      for (const column of columns) {
        const needle = textFilters[column.key];
        const picked = selectedFilters[column.key];
        if (!needle && !picked?.length) continue;
        const text = column.text(row);
        if (needle && !foldText(text).includes(foldText(needle))) return false;
        if (picked?.length && !picked.includes(text)) return false;
      }
      if (!term) return true;
      return [row.pin, row.client_name || (kind === 'campanha' ? 'PENDENTE DE VALIDAÇÃO' : ''), effectiveCity(row), row.branch, row.campaign_code, row.model, row.serial_number]
        .some((value) => String(value || '').toUpperCase().includes(term));
    });
    const sortColumn = sort && columns.find((c) => c.key === sort.key);
    if (!sort || !sortColumn) return filtered;
    const value = (row: ProgramRow) => (sortColumn.sort ? sortColumn.sort(row) : sortColumn.text(row));
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (!av && bv) return 1;
      if (av && !bv) return -1;
      return av.localeCompare(bv, 'pt-BR', { numeric: true }) * factor;
    });
  }, [rows, statusFilter, search, columns, textFilters, selectedFilters, sort, kind]);

  function clearColumnFilters() { setTextFilters({}); setSelectedFilters({}); setSort(null); }

  async function saveRow(row: ProgramRow, patch: Partial<ProgramRow>) {
    const next = { ...row, ...patch };
    if (next.executed_date && !next.programmed_date) next.programmed_date = next.executed_date;
    setRows((current) => current.map((item) => item.id === row.id ? next : item));
    setSavingId(row.id);
    const { error: saveError } = await supabase.rpc('update_service_program', {
      p_actor: user.matricula,
      p_kind: kind,
      p_id: row.id,
      p_programmed: next.programmed_date || null,
      p_executed: next.executed_date || null,
      p_notes: next.notes || null,
      p_city: next.service_city || null,
    });
    setSavingId('');
    if (saveError) {
      window.alert(saveError.message);
      await load();
    }
  }

  async function addMachine(event: FormEvent) {
    event.preventDefault();
    setFormError('');
    const { error: saveError } = await supabase.rpc('admin_save_campaign_machine', {
      p_actor: user.matricula,
      p_campaign: form.campaign,
      p_description: form.description || null,
      p_branch: form.branch,
      p_model: form.model,
      p_serial_number: form.serial,
      p_pin: form.pin || null,
      p_recommendation: 'Recommended',
    });
    if (saveError) {
      setFormError(saveError.message);
      return;
    }
    setForm({ campaign: form.campaign, description: form.description, branch: form.branch, model: '', serial: '', pin: '' });
    await load();
  }

  async function removeMachine(row: ProgramRow) {
    if (!window.confirm(`Remover ${row.model}-${row.serial_number} da campanha ${row.campaign_code}?`)) return;
    const { error: deleteError } = await supabase.rpc('admin_delete_campaign_machine', { p_actor: user.matricula, p_id: row.id });
    if (deleteError) {
      window.alert(deleteError.message);
      return;
    }
    await load();
  }

  function cityInput(row: ProgramRow) {
    const current = effectiveCity(row);
    return (
      <input
        key={`city-${row.id}-${current}`}
        className={current ? '' : 'sp-city-missing'}
        defaultValue={current}
        placeholder="Informar cidade"
        title={!current && row.city ? `G4 informa ${row.city}, igual à filial` : undefined}
        onBlur={(e) => { const value = e.target.value.trim(); if (value !== current) void saveRow(row, { service_city: value || null }); }}
      />
    );
  }

  return (
    <div className="sp-page">
      <div className="sp-toolbar">
        <div className="sp-filters">
          <button type="button" className={statusFilter === 'todos' ? 'is-active' : ''} onClick={() => setStatusFilter('todos')}>Todos <b>{counts.todos}</b></button>
          {STATUSES.map((s) => (
            <button type="button" key={s} className={statusFilter === s ? 'is-active' : ''} onClick={() => setStatusFilter(s)}>
              <span className={`sp-dot ${statusClass[s]}`}/>{s} <b>{counts[s]}</b>
            </button>
          ))}
        </div>
        <div className="sp-actions">
          <label className="search-box"><Search size={15}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={kind === '150h' ? 'PIN, cliente ou cidade' : 'Campanha, série ou cliente'} /></label>
          {(hasColumnFilters || sort) && <button type="button" className="subtle-button" onClick={clearColumnFilters} title="Limpar filtros e ordenação das colunas"><X size={14}/> Limpar filtros</button>}
          {kind === 'campanha' && isAdmin && <button type="button" className="primary-button" onClick={() => setShowForm((v) => !v)}><Plus size={16}/>Máquina na campanha</button>}
        </div>
      </div>

      {kind === 'campanha' && isAdmin && showForm && (
        <form className="sp-form form-stack" onSubmit={addMachine}>
          <div className="sp-form-grid">
            <label>Campanha<input value={form.campaign} onChange={(e) => setForm({ ...form, campaign: e.target.value.toUpperCase() })} placeholder="Ex.: RW013" /></label>
            <label>Descrição<input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Opcional" /></label>
            <label>Filial<select value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })}><option value="">Selecione</option>{allBranches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}</select></label>
            <label>Modelo<input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value.toUpperCase() })} placeholder="Ex.: L60H" /></label>
            <label>Nº de série<input value={form.serial} onChange={(e) => setForm({ ...form, serial: e.target.value.toUpperCase() })} placeholder="Ex.: 72136" /></label>
            <label>PIN<input value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value.toUpperCase() })} placeholder="Opcional" /></label>
          </div>
          {formError && <div className="form-error">{formError}</div>}
          <div className="sp-form-actions"><button type="button" className="subtle-button" onClick={() => setShowForm(false)}>Fechar</button><button className="primary-button">Adicionar</button></div>
        </form>
      )}

      <div className="sp-table">
        <div className={`sp-head sp-grid-${kind}`}>
          {columns.map((column) => (
            <ColumnFilterHeader
              key={column.key}
              label={column.label}
              sortDirection={sort?.key === column.key ? sort.direction : null}
              onSort={(direction) => setSort({ key: column.key, direction })}
              filter={textFilters[column.key] || ''}
              setFilter={(value) => setTextFilters((current) => ({ ...current, [column.key]: value }))}
              options={optionsByColumn[column.key] || []}
              selected={selectedFilters[column.key] || []}
              setSelected={(values) => setSelectedFilters((current) => ({ ...current, [column.key]: values }))}
            />
          ))}
        </div>
        {loading && <div className="sp-message">Carregando...</div>}
        {error && <div className="sp-message">{error}</div>}
        {!loading && !error && !visible.length && <div className="sp-message">Nenhuma máquina nesta seleção.</div>}
        {!loading && !error && visible.map((row) => {
          const status = programStatus(row);
          return (
            <div className={`sp-row sp-grid-${kind} sp-row-${statusClass[status].replace('sp-status-', '')}${savingId === row.id ? ' is-saving' : ''}`} key={row.id}>
              {kind === '150h'
                ? <>
                    <strong className="sp-mono">{row.pin}</strong>
                    <span>{row.branch}</span>
                    <span className="sp-client"><b>{row.client_name || '—'}</b></span>
                    <span>{row.brand || '—'}</span>
                    <span>{fmt(row.delivery_date)}</span>
                    {cityInput(row)}
                  </>
                : <>
                    <strong>{row.campaign_code}</strong>
                    <span>{row.branch}</span>
                    <span className="sp-client"><b>{row.model}-{row.serial_number}</b><small className="sp-mono">{row.pin || ''}</small></span>
                    <span className="sp-client">{row.client_name ? <b>{row.client_name}</b> : <em className="sp-pending">Pendente de validação</em>}{row.last_visit && <small>últ. visita {fmt(row.last_visit)}</small>}{row.opportunity_lost && <em className="sp-lost">Oportunidade perdida</em>}</span>
                    <span className="sp-client"><b className={row.recommendation === 'Mandatory' ? 'sp-mandatory' : ''}>{row.recommendation}</b><small>prazo {fmt(row.repair_deadline)}</small></span>
                    {cityInput(row)}
                  </>}
              <input type="date" value={row.programmed_date || ''} onChange={(e) => void saveRow(row, { programmed_date: e.target.value || null })} />
              <input type="date" value={row.executed_date || ''} onChange={(e) => void saveRow(row, { executed_date: e.target.value || null })} />
              <input
                defaultValue={row.notes || ''}
                placeholder="—"
                onBlur={(e) => { if ((e.target.value || null) !== (row.notes || null)) void saveRow(row, { notes: e.target.value || null }); }}
              />
              <span className="sp-status-cell">
                <span className={`sp-status ${statusClass[status]}`}>{status}</span>
                {kind === 'campanha' && isAdmin && <button type="button" className="icon-button" title="Remover" onClick={() => void removeMachine(row)}><Trash2 size={14}/></button>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
