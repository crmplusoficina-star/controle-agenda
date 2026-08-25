import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Drawer } from './Drawer';
import type { Branch, FollowupLostReason } from '../types';
import type { FollowupDraft } from '../drafts';
import { supabase } from '../lib/supabase';

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const lostReasons: { value: Exclude<FollowupLostReason, null>; label: string }[] = [
  { value: 'sem_interesse', label: 'Cliente sem interesse' },
  { value: 'preco', label: 'Preço' },
  { value: 'concorrente', label: 'Fechou com concorrente' },
  { value: 'sem_contato', label: 'Não conseguimos contato' },
  { value: 'adiado', label: 'Adiou / sem previsão' },
  { value: 'outro', label: 'Outro' },
];

function amount(value: string) {
  if (!value.trim()) return 0;
  const normalized = value.replace(/\./g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function FollowupDrawer({ draft, setDraft, branches, error, onClose, onSubmit }: {
  draft: FollowupDraft | null;
  setDraft: (draft: FollowupDraft) => void;
  branches: Branch[];
  error?: string;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void | Promise<void>;
}) {
  const [lostReason, setLostReason] = useState<Exclude<FollowupLostReason, null> | ''>('');
  const [localError, setLocalError] = useState('');
  const [originallyClosed, setOriginallyClosed] = useState(false);

  useEffect(() => {
    setLocalError('');
    setOriginallyClosed(Boolean(draft?.id && draft.stage === 'encerrar'));
  }, [draft?.id]);

  useEffect(() => {
    let active = true;
    if (!draft?.id || draft.result !== 'venda_perdida') {
      setLostReason('');
      return () => { active = false; };
    }
    void supabase.from('followups').select('lost_reason').eq('id', draft.id).maybeSingle().then(({ data }) => {
      if (!active) return;
      setLostReason((data?.lost_reason || '') as Exclude<FollowupLostReason, null> | '');
    });
    return () => { active = false; };
  }, [draft?.id, draft?.result]);

  if (!draft) return <Drawer open={false} title="Tratativa" onClose={onClose}>{null}</Drawer>;

  const isClosed = draft.stage === 'encerrar';
  const won = draft.result === 'venda_ganha';
  const lost = draft.result === 'venda_perdida';
  const total = amount(draft.parts_value) + amount(draft.services_value);
  const stageLabel = draft.stage === 'prospectar' ? 'Prospectar' : draft.stage === 'acompanhar' ? 'Em acompanhamento' : 'Encerrado';

  function markInteraction(changes: Partial<FollowupDraft>) {
    setDraft({
      ...draft,
      ...changes,
      stage: draft.id && draft.stage !== 'encerrar' ? 'acompanhar' : draft.stage,
    });
  }

  function beginClose() {
    setLocalError('');
    setLostReason('');
    setDraft({
      ...draft,
      stage: 'encerrar',
      next_followup_date: '',
      result: '',
      sale_kind: '',
      parts_value: '',
      services_value: '',
    });
  }

  function cancelClose() {
    setLocalError('');
    setLostReason('');
    setDraft({
      ...draft,
      stage: draft.id ? 'acompanhar' : 'prospectar',
      result: '',
      sale_kind: '',
      parts_value: '',
      services_value: '',
    });
  }

  function setResult(result: FollowupDraft['result']) {
    setLocalError('');
    if (result !== 'venda_perdida') setLostReason('');
    setDraft({
      ...draft,
      result,
      sale_kind: result === 'venda_ganha' ? draft.sale_kind : '',
      parts_value: result === 'venda_ganha' ? draft.parts_value : '',
      services_value: result === 'venda_ganha' ? draft.services_value : '',
    });
  }

  function handleSubmit(e: FormEvent) {
    if (lost && !lostReason) {
      e.preventDefault();
      setLocalError('Informe o motivo da venda perdida.');
      return;
    }

    // O App salva a tratativa. Para manter o motivo estruturado sem acrescentar
    // mais campos ao fluxo principal, um marcador temporário é removido no banco
    // por um trigger BEFORE e convertido na coluna lost_reason.
    const originalNotes = draft.notes;
    if (lost && lostReason) {
      const clean = originalNotes.trim();
      draft.notes = `${clean}${clean ? '\n' : ''}[[LOST_REASON:${lostReason}]]`;
    }
    try {
      return onSubmit(e);
    } finally {
      draft.notes = originalNotes;
    }
  }

  return <Drawer
    open
    title={draft.id ? 'Tratativa' : 'Nova tratativa'}
    subtitle={draft.id ? 'Atualize em poucos segundos e siga o dia.' : 'Registre somente o necessário.'}
    onClose={onClose}
  >
    <form className="form-stack followup-simple-form" onSubmit={handleSubmit}>
      <label>Cliente<input required value={draft.client_name} onChange={(e) => setDraft({ ...draft, client_name: e.target.value })} placeholder="Cliente" /></label>
      <div className="form-grid two">
        <label>Filial<select value={draft.branch} onChange={(e) => setDraft({ ...draft, branch: e.target.value })}>{branches.map((b) => <option key={b.name}>{b.name}</option>)}</select></label>
        <label>Série<input value={draft.equipment_serial} onChange={(e) => setDraft({ ...draft, equipment_serial: e.target.value.toUpperCase() })} placeholder="Opcional" /></label>
      </div>

      <div className={`followup-current-stage stage-${draft.stage}`}><span>Situação</span><strong>{stageLabel}</strong></div>

      <label>Observação<textarea rows={4} value={draft.notes} onChange={(e) => markInteraction({ notes: e.target.value })} placeholder="Observação" /></label>

      {!isClosed && <label>Agendar próximo contato<input type="date" value={draft.next_followup_date} onChange={(e) => markInteraction({ next_followup_date: e.target.value })} /></label>}

      {isClosed && <div className="followup-close-block">
        <label className="followup-stage-field">
          <span>Resultado</span>
          <div className="followup-result-switch">
            <button type="button" className={won ? 'won active' : ''} onClick={() => setResult('venda_ganha')}>Venda ganha</button>
            <button type="button" className={lost ? 'lost active' : ''} onClick={() => setResult('venda_perdida')}>Venda perdida</button>
          </div>
        </label>

        {lost && <label>Motivo da venda perdida<select required value={lostReason} onChange={(e) => setLostReason(e.target.value as Exclude<FollowupLostReason, null>)}>
          <option value="">Selecione</option>
          {lostReasons.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select></label>}

        {won && <>
          <label>Venda<select required value={draft.sale_kind} onChange={(e) => setDraft({ ...draft, sale_kind: e.target.value as FollowupDraft['sale_kind'] })}>
            <option value="">Selecione</option>
            <option value="pecas">Peças</option>
            <option value="servicos">Serviços</option>
            <option value="pecas_servicos">Peças + Serviços</option>
          </select></label>

          {draft.sale_kind && <div className="form-grid two">
            {(draft.sale_kind === 'pecas' || draft.sale_kind === 'pecas_servicos') && <label>Valor de peças<input inputMode="decimal" value={draft.parts_value} onChange={(e) => setDraft({ ...draft, parts_value: e.target.value })} placeholder="0,00" /></label>}
            {(draft.sale_kind === 'servicos' || draft.sale_kind === 'pecas_servicos') && <label>Valor de serviços<input inputMode="decimal" value={draft.services_value} onChange={(e) => setDraft({ ...draft, services_value: e.target.value })} placeholder="0,00" /></label>}
          </div>}

          {total > 0 && <div className="followup-total"><span>Venda total</span><strong>{money.format(total)}</strong></div>}
        </>}
      </div>}

      {(localError || error) && <div className="form-error">{localError || error}</div>}
      <div className="drawer-actions followup-drawer-actions">
        <div>{!isClosed && <button type="button" className="subtle-button" onClick={beginClose}>Encerrar tratativa</button>}{isClosed && !originallyClosed && <button type="button" className="subtle-button" onClick={cancelClose}>Voltar</button>}</div>
        <button type="button" className="subtle-button" onClick={onClose}>Cancelar</button>
        <button className="primary-button">{isClosed ? 'Salvar encerramento' : draft.id ? 'Atualizar' : 'Salvar'}</button>
      </div>
    </form>
  </Drawer>;
}
