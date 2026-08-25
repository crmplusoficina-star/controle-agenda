import { Building2, CalendarDays, MapPin, Wrench } from 'lucide-react';
import { Drawer } from './Drawer';
import type { ClientSummary, HistoryRow, MachineSummary } from '../types';

const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

function formatDate(value: string | null) {
  if (!value) return '—';
  return dateFmt.format(new Date(value));
}

export function ClientDetailDrawer({ client, machines, history, loading, onClose }: {
  client: ClientSummary | null;
  machines: MachineSummary[];
  history: HistoryRow[];
  loading: boolean;
  onClose: () => void;
}) {
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
