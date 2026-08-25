import { Building2, CalendarDays, MapPin, MessageSquareText, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Drawer } from './Drawer';
import { supabase } from '../lib/supabase';
import type { ClientSummary, Followup, HistoryRow, MachineSummary } from '../types';

const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const stageLabels: Record<string, string> = { prospectar: 'Prospectar', acompanhar: 'Acompanhar', encerrar: 'Encerrada' };
const lostReasonLabels: Record<string, string> = {
  sem_interesse: 'Cliente sem interesse',
  preco: 'Preço',
  concorrente: 'Fechou com concorrente',
  sem_contato: 'Não conseguimos contato',
  adiado: 'Adiou / sem previsão',
  outro: 'Outro',
};
const saleKindLabels: Record<string, string> = { pecas: 'Peças', servicos: 'Serviços', pecas_servicos: 'Peças + serviços' };

type FollowupUpdate = {
  id: string;
  followup_id: string;
  stage: string;
  result: string | null;
  notes: string | null;
  next_followup_date: string | null;
  sale_kind: string | null;
  parts_value: number | null;
  services_value: number | null;
  lost_reason: string | null;
  actor_matricula: string | null;
  actor_name: string | null;
  created_at: string;
};

function formatDate(value: string | null) {
  if (!value) return '—';
  return dateFmt.format(new Date(value));
}

function followupLabel(item: Followup) {
  if (item.stage !== 'encerrar') return { label: 'Em tratativa', kind: 'open' };
  if (item.result === 'venda_ganha') return { label: 'Venda ganha', kind: 'won' };
  if (item.result === 'venda_perdida') return { label: 'Venda perdida', kind: 'lost' };
  return { label: 'Encerrada', kind: 'closed' };
}

function updateLabel(item: FollowupUpdate) {
  if (item.result === 'venda_ganha') return 'Venda ganha';
  if (item.result === 'venda_perdida') return 'Venda perdida';
  return stageLabels[item.stage] || 'Atualização';
}

export function ClientDetailDrawer({ client, machines, history, loading, onClose }: {
  client: ClientSummary | null;
  machines: MachineSummary[];
  history: HistoryRow[];
  loading: boolean;
  onClose: () => void;
}) {
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [followupUpdates, setFollowupUpdates] = useState<FollowupUpdate[]>([]);
  const [followupLoading, setFollowupLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!client) {
      setFollowups([]);
      setFollowupUpdates([]);
      return;
    }

    async function loadFollowupHistory() {
      setFollowupLoading(true);
      const { data, error } = await supabase
        .from('followups')
        .select('*')
        .eq('branch', client!.branch)
        .ilike('client_name', client!.client_name)
        .order('updated_at', { ascending: false });

      if (cancelled) return;
      if (error) {
        console.error('client_followup_history_failed', error);
        setFollowups([]);
        setFollowupUpdates([]);
        setFollowupLoading(false);
        return;
      }

      const rows = (data || []) as Followup[];
      setFollowups(rows);
      const ids = rows.map((item) => item.id);
      if (!ids.length) {
        setFollowupUpdates([]);
        setFollowupLoading(false);
        return;
      }

      const { data: updates, error: updatesError } = await supabase
        .from('followup_updates')
        .select('id,followup_id,stage,result,notes,next_followup_date,sale_kind,parts_value,services_value,lost_reason,actor_matricula,actor_name,created_at')
        .in('followup_id', ids)
        .order('created_at', { ascending: false });

      if (cancelled) return;
      if (updatesError) console.error('client_followup_updates_failed', updatesError);
      setFollowupUpdates((updates || []) as FollowupUpdate[]);
      setFollowupLoading(false);
    }

    void loadFollowupHistory();
    return () => { cancelled = true; };
  }, [client?.client_key, client?.branch, client?.client_name]);

  const updatesByFollowup = useMemo(() => {
    const grouped: Record<string, FollowupUpdate[]> = {};
    for (const item of followupUpdates) {
      if (!grouped[item.followup_id]) grouped[item.followup_id] = [];
      grouped[item.followup_id].push(item);
    }
    return grouped;
  }, [followupUpdates]);

  if (!client) return null;

  return <Drawer open title={client.client_name} subtitle={`${client.branch}${client.city ? ` · ${client.city}` : ''}`} onClose={onClose} wide>
    <div className="client-file">
      <div className="client-file-summary">
        <div><Building2 size={17}/><span>Filial</span><strong>{client.branch}</strong></div>
        <div><MapPin size={17}/><span>Cidade</span><strong>{client.city || '—'}</strong></div>
        <div><Wrench size={17}/><span>Máquinas</span><strong>{machines.length || client.machine_count}</strong></div>
        <div><CalendarDays size={17}/><span>Último atendimento</span><strong>{formatDate(client.last_service_at)}</strong></div>
      </div>

      <section className="client-file-section">
        <div className="client-file-heading"><div><h3>Tratativas</h3><p>O que já foi trabalhado com este cliente.</p></div><strong>{followups.length}</strong></div>
        {followupLoading ? <div className="table-loading">Carregando tratativas...</div> : followups.length === 0 ? <div className="client-file-empty">Nenhuma tratativa registrada para este cliente.</div> : <div className="client-treatment-list">
          {followups.map((item) => {
            const status = followupLabel(item);
            const updates = updatesByFollowup[item.id] || [];
            const owner = item.updated_by_name || item.created_by_name || 'Anterior ao login';
            const total = Number(item.parts_value || 0) + Number(item.services_value || 0);
            return <div className="client-treatment-card" key={item.id}>
              <div className="client-treatment-head">
                <div><span className={`client-treatment-badge treatment-${status.kind}`}>{status.label}</span><strong>{owner}</strong></div>
                <small>{dateTimeFmt.format(new Date(item.updated_at))}</small>
              </div>
              {item.notes && <p className="client-treatment-note">{item.notes}</p>}
              <div className="client-treatment-meta">
                {item.stage !== 'encerrar' && <span>{stageLabels[item.stage] || 'Prospectar'}</span>}
                {item.next_followup_date && <span>Próximo contato: {formatDate(item.next_followup_date)}</span>}
                {item.result === 'venda_ganha' && item.sale_kind && <span>{saleKindLabels[item.sale_kind] || item.sale_kind}{total > 0 ? ` · ${money.format(total)}` : ''}</span>}
                {item.result === 'venda_perdida' && <span>{item.lost_reason ? lostReasonLabels[item.lost_reason] || item.lost_reason : 'Motivo não informado'}</span>}
              </div>
              {updates.length > 0 && <div className="client-treatment-timeline">
                <div className="client-treatment-timeline-title"><MessageSquareText size={13}/> Histórico da tratativa</div>
                {updates.map((update) => <div className="client-treatment-update" key={update.id}>
                  <i></i>
                  <div>
                    <div><strong>{updateLabel(update)}</strong><small>{dateTimeFmt.format(new Date(update.created_at))}</small></div>
                    {update.notes && <p>{update.notes}</p>}
                    <span>{update.actor_name || 'Anterior ao login'}{update.next_followup_date ? ` · próximo contato ${formatDate(update.next_followup_date)}` : ''}{update.result === 'venda_perdida' && update.lost_reason ? ` · ${lostReasonLabels[update.lost_reason] || update.lost_reason}` : ''}</span>
                  </div>
                </div>)}
              </div>}
            </div>;
          })}
        </div>}
      </section>

      <section className="client-file-section">
        <div className="client-file-heading"><div><h3>Máquinas</h3><p>Séries conhecidas deste cliente no G4.</p></div><strong>{machines.length}</strong></div>
        {loading ? <div className="table-loading">Carregando máquinas...</div> : machines.length === 0 ? <div className="client-file-empty">Nenhuma série identificada.</div> : <div className="client-machine-list">
          {machines.map((machine) => <div className="client-machine-row" key={machine.serial}>
            <div><strong>{machine.serial}</strong><span>{machine.city || 'Cidade não informada'}</span></div>
            <div><span>Último atendimento</span><strong>{formatDate(machine.last_service_at)}</strong></div>
            <div><span>OS</span><strong>{machine.service_count}</strong></div>
          </div>)}
        </div>}
      </section>

      <section className="client-file-section">
        <div className="client-file-heading"><div><h3>Histórico de atendimentos</h3><p>Atendimentos mais recentes encontrados no G4.</p></div><strong>{history.length}</strong></div>
        {loading ? <div className="table-loading">Carregando histórico...</div> : history.length === 0 ? <div className="client-file-empty">Nenhum atendimento encontrado.</div> : <div className="client-history-list">
          {history.map((item) => <div className="client-history-row" key={item.source_id}>
            <div className="client-history-top"><div><strong>{formatDate(item.service_date)}</strong><span>{item.operation_type || item.os_type || 'Atendimento'}</span></div><div className="client-history-os">{item.serial || 'Sem série'}{item.os_g4 ? ` · G4 ${item.os_g4}` : ''}</div></div>
            {item.description && <p>{item.description}</p>}
            <div className="client-history-meta"><span>{item.city || 'Cidade não informada'}</span>{item.status && <span>{item.status}</span>}</div>
          </div>)}
        </div>}
      </section>
    </div>
  </Drawer>;
}
