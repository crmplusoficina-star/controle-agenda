import type { FormEvent } from 'react';
import { Check, Loader2, Trash2 } from 'lucide-react';
import { Drawer } from './Drawer';
import type { Appointment, MachineSummary, Technician } from '../types';
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
const statuses = [['planejado','Planejado'],['confirmado','Confirmado'],['em_atendimento','Em atendimento'],['concluido','Concluído'],['cancelado','Cancelado']] as const;

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
  return <Drawer open={Boolean(draft)} title={draft?.id ? 'Editar atendimento' : 'Novo atendimento'} subtitle="Somente o necessário para organizar bem a visita." onClose={onClose} wide>
    {draft && <form className="form-stack" onSubmit={onSubmit}>
      <div className="form-grid two"><label>Data<input type="date" value={draft.appointment_date} onChange={(e) => setDraft({ ...draft, appointment_date: e.target.value })} /></label><label>Técnico<select value={draft.technician_id} onChange={(e) => { const t = technicians.find((x) => x.id === e.target.value); setDraft({ ...draft, technician_id: e.target.value, branch: t?.branch || draft.branch }); }}><option value="">Selecione o técnico</option>{technicians.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.branch}</option>)}</select></label></div>
      <label className="serial-field">Série da máquina<input value={draft.equipment_serial} onChange={(e) => onSerialChange(e.target.value.toUpperCase())} placeholder="Digite parte da série" autoComplete="off" />{suggestions.length > 0 && <div className="suggestions">{suggestions.map((m) => <button type="button" key={m.serial} onClick={() => onSelectMachine(m)}><strong>{m.serial}</strong><span>{m.client_name || 'Cliente não informado'} · {m.city || 'Cidade não informada'}</span></button>)}</div>}</label>
      {machineContext && <div className="context-strip"><div><span>Último atendimento G4</span><strong>{machineContext.last_service_at ? new Intl.DateTimeFormat('pt-BR').format(new Date(machineContext.last_service_at)) : '—'}</strong></div><div><span>Histórico</span><strong>{machineContext.service_count} OS</strong></div><div><span>Última operação</span><strong>{machineContext.last_operation_type || '—'}</strong></div></div>}
      <div className="form-grid two"><label>Cliente<input value={draft.client_name} onChange={(e) => setDraft({ ...draft, client_name: e.target.value })} /></label><label>Cidade<input value={draft.service_city} onChange={(e) => setDraft({ ...draft, service_city: e.target.value })} /></label></div>
      <div className="form-grid two"><label>Motivo do atendimento<select value={draft.service_reason} onChange={(e) => setDraft({ ...draft, service_reason: e.target.value })}><option value="">Selecione</option>{reasons.map((r) => <option key={r}>{r}</option>)}</select></label><label>Status<select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as Appointment['status'] })}>{statuses.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
      <label>Descrição<textarea rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Ex.: ar-condicionado com baixo rendimento" /></label>
      <div className="hourmeter-block"><div><span>Último horímetro conhecido</span><strong>{lastHourmeter ? `${lastHourmeter.hourmeter.toLocaleString('pt-BR')} h` : 'Sem leitura anterior'}</strong>{lastHourmeter && <small>{new Intl.DateTimeFormat('pt-BR').format(new Date(`${lastHourmeter.reading_date}T12:00:00`))}</small>}</div><label>Horímetro atual da máquina<input inputMode="decimal" value={draft.reported_hourmeter} onChange={(e) => setDraft({ ...draft, reported_hourmeter: e.target.value })} placeholder="Opcional" /></label>{lastHourmeter && draft.reported_hourmeter !== '' && Number(draft.reported_hourmeter) >= lastHourmeter.hourmeter && <div className="hourmeter-delta">+{(Number(draft.reported_hourmeter) - lastHourmeter.hourmeter).toLocaleString('pt-BR')} h</div>}</div>
      <label>Previsão de faturamento<input inputMode="decimal" value={draft.forecast_amount} onChange={(e) => setDraft({ ...draft, forecast_amount: e.target.value })} placeholder="0,00" /></label>
      {formError && <div className="form-error">{formError}</div>}
      <div className="drawer-actions">{draft.id ? <button type="button" className="danger-button" onClick={onDelete}><Trash2 size={16}/> Excluir</button> : <span/>}<button type="button" className="subtle-button" onClick={onClose}>Cancelar</button><button className="primary-button" disabled={saveBusy}>{saveBusy ? <Loader2 className="spin" size={17}/> : <Check size={17}/>} Salvar</button></div>
    </form>}
  </Drawer>;
}
