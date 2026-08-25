import type { FormEvent } from 'react';
import { Drawer } from './Drawer';
import type { Branch } from '../types';
import type { FollowupDraft } from '../drafts';

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

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
  onSubmit: (e: FormEvent) => void;
}) {
  if (!draft) return <Drawer open={false} title="Tratativa" onClose={onClose}>{null}</Drawer>;

  const isClosed = draft.stage === 'encerrar';
  const won = draft.result === 'venda_ganha';
  const total = amount(draft.parts_value) + amount(draft.services_value);

  function setStage(stage: FollowupDraft['stage']) {
    setDraft({
      ...draft,
      stage,
      next_followup_date: stage === 'encerrar' ? '' : draft.next_followup_date,
      result: stage === 'encerrar' ? draft.result : '',
      sale_kind: stage === 'encerrar' ? draft.sale_kind : '',
      parts_value: stage === 'encerrar' ? draft.parts_value : '',
      services_value: stage === 'encerrar' ? draft.services_value : '',
    });
  }

  function setResult(result: FollowupDraft['result']) {
    setDraft({
      ...draft,
      result,
      sale_kind: result === 'venda_ganha' ? draft.sale_kind : '',
      parts_value: result === 'venda_ganha' ? draft.parts_value : '',
      services_value: result === 'venda_ganha' ? draft.services_value : '',
    });
  }

  return <Drawer
    open
    title={draft.id ? 'Tratativa' : 'Nova tratativa'}
    subtitle={draft.id ? 'Atualize somente o que mudou.' : 'Registre o contato em poucos segundos.'}
    onClose={onClose}
  >
    <form className="form-stack followup-simple-form" onSubmit={onSubmit}>
      <label>Cliente<input required value={draft.client_name} onChange={(e) => setDraft({ ...draft, client_name: e.target.value })} placeholder="Cliente" /></label>
      <div className="form-grid two">
        <label>Filial<select value={draft.branch} onChange={(e) => setDraft({ ...draft, branch: e.target.value })}>{branches.map((b) => <option key={b.name}>{b.name}</option>)}</select></label>
        <label>Série<input value={draft.equipment_serial} onChange={(e) => setDraft({ ...draft, equipment_serial: e.target.value.toUpperCase() })} placeholder="Opcional" /></label>
      </div>

      <label className="followup-stage-field">
        <span>Etapa</span>
        <div className="followup-stage-switch">
          <button type="button" className={draft.stage === 'prospectar' ? 'active' : ''} onClick={() => setStage('prospectar')}>Prospectar</button>
          <button type="button" className={draft.stage === 'acompanhar' ? 'active' : ''} onClick={() => setStage('acompanhar')}>Acompanhar</button>
          <button type="button" className={draft.stage === 'encerrar' ? 'active' : ''} onClick={() => setStage('encerrar')}>Encerrar</button>
        </div>
      </label>

      <label>Observação<textarea rows={4} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="O que o cliente informou?" /></label>

      {!isClosed && <label>Próximo retorno<input type="date" value={draft.next_followup_date} onChange={(e) => setDraft({ ...draft, next_followup_date: e.target.value })} /></label>}

      {isClosed && <div className="followup-close-block">
        <label className="followup-stage-field">
          <span>Resultado</span>
          <div className="followup-result-switch">
            <button type="button" className={draft.result === 'venda_ganha' ? 'won active' : ''} onClick={() => setResult('venda_ganha')}>Venda ganha</button>
            <button type="button" className={draft.result === 'venda_perdida' ? 'lost active' : ''} onClick={() => setResult('venda_perdida')}>Venda perdida</button>
          </div>
        </label>

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

      {error && <div className="form-error">{error}</div>}
      <div className="drawer-actions"><span/><button type="button" className="subtle-button" onClick={onClose}>Cancelar</button><button className="primary-button">{draft.id ? 'Atualizar' : 'Salvar'}</button></div>
    </form>
  </Drawer>;
}
