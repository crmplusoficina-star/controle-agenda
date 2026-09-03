import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, Lightbulb, Loader2, MessageCircle, Trash2 } from 'lucide-react';
import { Drawer } from './Drawer';
import { supabase } from '../lib/supabase';
import type { MachineSummary, Technician } from '../types';
import type { AppointmentDraft } from '../drafts';

const reasons = [
  'Garantia',
  'Férias',
  'Aplicação de peças',
  'Medição material rodante',
  'Oficina',
  'Manutenção carro',
  'Diagnóstico',
  'Entrega Técnica',
  'Revisão PMP',
  'Revisão OS cliente',
  'Equipamento parado',
  'Deslocamento garantia',
  'Deslocamento cliente',
  'Deslocamento PMP',
  'Folga',
  'Sem agenda',
  'Treinamento',
];

function clientContactKey(branch: string, clientName: string) {
  const cleanBranch = branch.trim().toUpperCase();
  const cleanClient = clientName.trim().toUpperCase();
  return cleanBranch && cleanClient ? `${cleanClient}|${cleanBranch}` : '';
}

function whatsappNumber(value: string) {
  let digits = value.replace(/\D/g, '');
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) digits = `55${digits}`;
  return digits;
}

export function AppointmentDrawer({ draft, setDraft, technicians, suggestions, machineContext, lastHourmeter, formError, saveBusy, onSubmit, onClose, onDelete, onSelectMachine, onSerialChange }: {
  draft: AppointmentDraft | null;
  setDraft: (draft: AppointmentDraft) => void;
  technicians: Technician[];
  suggestions: MachineSummary[];
  machineContext: MachineSummary | null;
  lastHourmeter: { hourmeter: number; reading_date: string } | null;
  formError: string;
  saveBusy: boolean;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  onDelete: () => void;
  onSelectMachine: (machine: MachineSummary) => void;
  onSerialChange: (value: string) => void;
}) {
  const [clientContact, setClientContact] = useState('');
  const contactKey = draft ? clientContactKey(draft.branch, draft.client_name) : '';
  const waNumber = whatsappNumber(clientContact);

  useEffect(() => {
    let cancelled = false;
    if (!contactKey) {
      setClientContact('');
      return () => { cancelled = true; };
    }

    async function loadClientContact() {
      const { data } = await supabase.from('client_contacts').select('phone').eq('client_key', contactKey).limit(1);
      if (!cancelled) setClientContact(String((data || [])[0]?.phone || ''));
    }

    void loadClientContact();
    return () => { cancelled = true; };
  }, [contactKey]);

  async function saveClientContact() {
    if (!draft || !contactKey || !clientContact.trim()) return;
    await supabase.from('client_contacts').upsert({
      client_key: contactKey,
      branch: draft.branch.trim().toUpperCase(),
      client_name: draft.client_name.trim(),
      phone: clientContact.trim(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'client_key' });
  }

  return <Drawer open={Boolean(draft)} title={draft?.id ? 'Editar atendimento' : 'Novo atendimento'} subtitle="Somente o necessário para organizar bem a visita." onClose={onClose} wide>
    {draft && <form className="form-stack" onSubmit={onSubmit}>
      <div className="form-grid two"><label>Data<input type="date" value={draft.appointment_date} onChange={(e) => setDraft({ ...draft, appointment_date: e.target.value })} /></label><label>Técnico<select value={draft.technician_id} onChange={(e) => { const t = technicians.find((x) => x.id === e.target.value); setDraft({ ...draft, technician_id: e.target.value, branch: t?.branch || draft.branch }); }}><option value="">Selecione o técnico</option>{technicians.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.branch}</option>)}</select></label></div>
      <label className="serial-field">Série da máquina<input value={draft.equipment_serial} onChange={(e) => onSerialChange(e.target.value.toUpperCase())} placeholder="Digite parte da série" autoComplete="off" />{suggestions.length > 0 && <div className="suggestions">{suggestions.map((m) => <button type="button" key={m.serial} onClick={() => onSelectMachine(m)}><strong>{m.serial}</strong><span>{m.client_name || 'Cliente não informado'} · {m.city || 'Cidade não informada'}</span></button>)}</div>}</label>
      {machineContext && <div className="context-strip"><div><span>Último atendimento G4</span><strong>{machineContext.last_service_at ? new Intl.DateTimeFormat('pt-BR').format(new Date(machineContext.last_service_at)) : '—'}</strong></div><div><span>Histórico</span><strong>{machineContext.service_count} OS</strong></div><div><span>Última operação</span><strong>{machineContext.last_operation_type || '—'}</strong></div></div>}
      <div className="form-grid two"><label>Cliente<input value={draft.client_name} onChange={(e) => setDraft({ ...draft, client_name: e.target.value })} /></label><label>Cidade<input value={draft.service_city} onChange={(e) => setDraft({ ...draft, service_city: e.target.value })} /></label></div>
      <label>Contato do cliente <span style={{ color: '#94a3b8', fontWeight: 500 }}>(opcional)</span>
        <div style={{ display: 'grid', gridTemplateColumns: waNumber ? '1fr auto' : '1fr', gap: 8, alignItems: 'center' }}>
          <input inputMode="tel" value={clientContact} onChange={(e) => setClientContact(e.target.value)} onBlur={() => { void saveClientContact(); }} placeholder="Ex.: (91) 99999-9999" />
          {waNumber && <a href={`https://wa.me/${waNumber}`} target="_blank" rel="noreferrer" onClick={() => { void saveClientContact(); }} style={{ minHeight: 42, padding: '0 13px', borderRadius: 9, border: '1px solid #bbf7d0', background: '#f0fdf4', color: '#15803d', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, textDecoration: 'none', fontSize: 12, fontWeight: 750, whiteSpace: 'nowrap' }}><MessageCircle size={16}/> WhatsApp</a>}
        </div>
        <small style={{ marginTop: 5, color: '#94a3b8', fontWeight: 500 }}>Preencha uma vez. Nos próximos atendimentos do mesmo cliente, o número será carregado automaticamente.</small>
      </label>
      <label>Motivo do atendimento<select value={draft.service_reason} onChange={(e) => setDraft({ ...draft, service_reason: e.target.value })}><option value="">Selecione</option>{reasons.map((r) => <option key={r}>{r}</option>)}</select></label>
      <label>Descrição<textarea rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Ex.: ar-condicionado com baixo rendimento" /></label>
      <div style={{ display: 'grid', gap: 7, padding: '12px 14px', border: '1px solid #fde68a', borderRadius: 12, background: '#fffbeb' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#92400e' }}><Lightbulb size={16}/><strong>Insight</strong><small style={{ marginLeft: 'auto', fontWeight: 700 }}>Esboço</small></div>
        <div style={{ color: '#78716c', fontSize: 12, lineHeight: 1.45 }}>Espaço reservado para um insight do atendimento. A lógica desta funcionalidade será desenvolvida depois.</div>
      </div>
      <div className="hourmeter-block"><div><span>Último horímetro conhecido</span><strong>{lastHourmeter ? `${lastHourmeter.hourmeter.toLocaleString('pt-BR')} h` : 'Sem leitura anterior'}</strong>{lastHourmeter && <small>{new Intl.DateTimeFormat('pt-BR').format(new Date(`${lastHourmeter.reading_date}T12:00:00`))}</small>}</div><label>Horímetro atual da máquina<input inputMode="decimal" value={draft.reported_hourmeter} onChange={(e) => setDraft({ ...draft, reported_hourmeter: e.target.value })} placeholder="Opcional" /></label>{lastHourmeter && draft.reported_hourmeter !== '' && Number(draft.reported_hourmeter) >= lastHourmeter.hourmeter && <div className="hourmeter-delta">+{(Number(draft.reported_hourmeter) - lastHourmeter.hourmeter).toLocaleString('pt-BR')} h</div>}</div>
      <div className="form-grid two">
        <label>Previsão de faturamento<input inputMode="decimal" value={draft.forecast_amount} onChange={(e) => setDraft({ ...draft, forecast_amount: e.target.value })} placeholder="0,00" /></label>
        <label>Status do faturamento<select value={draft.billing_status === 'faturado' ? 'faturado' : draft.billing_status === 'aguardando_faturamento' ? 'aguardando_faturamento' : 'nao_precificado'} onChange={(e) => setDraft({ ...draft, billing_status: e.target.value })}><option value="nao_precificado">-</option><option value="aguardando_faturamento">Pendente</option><option value="faturado">Faturado</option></select></label>
      </div>
      {formError && <div className="form-error">{formError}</div>}
      <div className="drawer-actions">{draft.id ? <button type="button" className="danger-button" onClick={onDelete}><Trash2 size={16}/> Excluir</button> : <span/>}<button type="button" className="subtle-button" onClick={onClose}>Cancelar</button><button className="primary-button" disabled={saveBusy}>{saveBusy ? <Loader2 className="spin" size={17}/> : <Check size={17}/>} Salvar</button></div>
    </form>}
  </Drawer>;
}
