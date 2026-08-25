import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Appointment, ClientSummary, Technician } from '../types';
import { RetentionMap } from './RetentionMap';
import { recencyBucket } from './retentionRecency';
import type { RecencyBucket } from './retentionRecency';
import './retention.css';

const shortDateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
const retentionKey = (clientName: string, branchName: string) => `${clientName.trim().toUpperCase()}|${branchName.trim().toUpperCase()}`;

export function RetentionView({ clients, loading, futureClients, serialsByClient, appointments, technicians, weekStart, onFollowup, onOpen, onSchedule }: {
  clients: ClientSummary[];
  loading: boolean;
  futureClients: Set<string>;
  serialsByClient: Record<string, string[]>;
  appointments: Appointment[];
  technicians: Technician[];
  weekStart: Date;
  onFollowup: (client: ClientSummary) => void;
  onOpen: (client: ClientSummary) => void;
  onSchedule: (client: ClientSummary, serial: string, technicianId: string) => void;
}) {
  const [months, setMonths] = useState(0);
  const [search, setSearch] = useState('');
  const [recencyFilter, setRecencyFilter] = useState<RecencyBucket | null>(null);

  function applyRecencyFilter(bucket: RecencyBucket | null) {
    setRecencyFilter(bucket);
    if (bucket) setMonths(0);
  }

  function applyPeriodFilter(value: number) {
    setMonths(value);
    setRecencyFilter(null);
  }

  const filtered = useMemo(() => {
    const now = new Date();
    const cutoff = new Date(now);
    if (months > 0) {
      cutoff.setMonth(cutoff.getMonth() - months);
      cutoff.setHours(0, 0, 0, 0);
    }

    return clients.filter((client) => {
      if (!client.last_service_at) return months === 0 && (!recencyFilter || recencyFilter === '18+');
      const lastDate = new Date(client.last_service_at);
      if (months > 0 && (lastDate < cutoff || lastDate > now)) return false;
      if (recencyFilter && recencyBucket(client.last_service_at) !== recencyFilter) return false;

      const serials = serialsByClient[retentionKey(client.client_name, client.branch)] || [];
      const globalText = `${client.client_name} ${client.city || ''} ${serials.join(' ')}`.toLowerCase();
      const matchSearch = !search || globalText.includes(search.toLowerCase());
      const hasFuture = futureClients.has(retentionKey(client.client_name, client.branch));
      return matchSearch && !hasFuture;
    });
  }, [clients, months, recencyFilter, search, futureClients, serialsByClient]);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 5);
  const weekLabel = `Agenda ${shortDateFmt.format(weekStart)}–${shortDateFmt.format(weekEnd)}`;

  return <section className="list-page retention-map-page">
    <div className="list-toolbar">
      <div className="search-box"><Search size={18}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar cliente, série ou cidade" /></div>
      <div className="retention-toolbar-right">
        <label className="inline-filter"><span>Último atendimento em</span><select value={months} onChange={(e) => applyPeriodFilter(Number(e.target.value))}><option value={0}>sem filtro de data</option><option value={3}>últimos 3 meses</option><option value={6}>últimos 6 meses</option><option value={9}>últimos 9 meses</option><option value={12}>últimos 12 meses</option><option value={18}>últimos 18 meses</option></select></label>
      </div>
    </div>

    {loading && clients.length === 0 ? <div className="table-loading">Analisando histórico G4...</div> : <RetentionMap
      clients={filtered}
      serialsByClient={serialsByClient}
      appointments={appointments}
      technicians={technicians}
      weekLabel={weekLabel}
      recencyFilter={recencyFilter}
      onRecencyFilter={applyRecencyFilter}
      onOpen={onOpen}
      onFollowup={onFollowup}
      onSchedule={onSchedule}
    />}
  </section>;
}
