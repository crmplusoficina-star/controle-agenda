import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
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

const fmt = (value?: string | null) => value ? new Intl.DateTimeFormat('pt-BR').format(new Date(`${value.slice(0, 10)}T12:00:00`)) : '—';

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
  const isAdmin = user.role === 'admin';
  const branchKey = branches.join('|');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const query = kind === '150h'
      ? supabase.from('inspection_150h').select('pin,branch,client_name,city,brand,model,delivery_date,programmed_date,executed_date,notes').order('delivery_date')
      : supabase.from('campaign_machines').select('id,campaign_code,branch,model,serial_number,pin,recommendation,repair_deadline,last_visit,opportunity_lost,client_name,city,programmed_date,executed_date,notes').order('campaign_code').order('serial_number');
    const { data, error: loadError } = await (branches.length ? query.in('branch', branches) : query);
    if (loadError) {
      setError('Não foi possível carregar a lista.');
      setLoading(false);
      return;
    }
    setRows((data || []).map((row: any) => ({ ...row, id: kind === '150h' ? row.pin : row.id })));
    setLoading(false);
  }, [kind, branchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => {
    const result: Record<string, number> = { todos: rows.length };
    for (const s of STATUSES) result[s] = 0;
    for (const row of rows) result[programStatus(row)] += 1;
    return result;
  }, [rows]);

  const visible = useMemo(() => {
    const term = search.trim().toUpperCase();
    return rows.filter((row) => {
      if (statusFilter !== 'todos' && programStatus(row) !== statusFilter) return false;
      if (!term) return true;
      return [row.pin, row.client_name, row.city, row.branch, row.campaign_code, row.model, row.serial_number]
        .some((value) => String(value || '').toUpperCase().includes(term));
    });
  }, [rows, statusFilter, search]);

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
          {kind === '150h'
            ? <><span>PIN</span><span>Filial</span><span>Cliente</span><span>Marca</span><span>Data ET</span></>
            : <><span>Campanha</span><span>Filial</span><span>Máquina</span><span>Cliente</span><span>Tipo / prazo</span></>}
          <span>Data programação</span><span>Data execução</span><span>Observação</span><span>Status</span>
        </div>
        {loading && <div className="sp-message">Carregando...</div>}
        {error && <div className="sp-message">{error}</div>}
        {!loading && !error && !visible.length && <div className="sp-message">Nenhuma máquina nesta seleção.</div>}
        {!loading && !error && visible.map((row) => {
          const status = programStatus(row);
          return (
            <div className={`sp-row sp-grid-${kind}${savingId === row.id ? ' is-saving' : ''}`} key={row.id}>
              {kind === '150h'
                ? <>
                    <strong className="sp-mono">{row.pin}</strong>
                    <span>{row.branch}</span>
                    <span className="sp-client"><b>{row.client_name || '—'}</b><small>{row.city || ''}</small></span>
                    <span>{row.brand || '—'}</span>
                    <span>{fmt(row.delivery_date)}</span>
                  </>
                : <>
                    <strong>{row.campaign_code}</strong>
                    <span>{row.branch}</span>
                    <span className="sp-client"><b>{row.model}-{row.serial_number}</b><small className="sp-mono">{row.pin || ''}</small></span>
                    <span className="sp-client"><b>{row.client_name || '—'}</b><small>{row.city || ''}{row.last_visit ? `${row.city ? ' · ' : ''}últ. visita ${fmt(row.last_visit)}` : ''}</small>{row.opportunity_lost && <em className="sp-lost">Oportunidade perdida</em>}</span>
                    <span className="sp-client"><b className={row.recommendation === 'Mandatory' ? 'sp-mandatory' : ''}>{row.recommendation}</b><small>prazo {fmt(row.repair_deadline)}</small></span>
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
