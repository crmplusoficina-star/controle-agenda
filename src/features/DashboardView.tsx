import { Activity, AlertTriangle, BadgeDollarSign, Building2, CheckCircle2, CircleDollarSign, Crosshair, Filter, Gauge, Lightbulb, PhoneCall, Target, TrendingDown, TrendingUp, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Appointment, Branch, ClientSummary, Followup } from '../types';
import { retentionRecency, recencyBucket } from './retentionRecency';
import './dashboard.css';

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const int = new Intl.NumberFormat('pt-BR');

function saleValue(item: Followup) {
  return Number(item.parts_value || 0) + Number(item.services_value || 0);
}
function opportunityValue(item: Followup) {
  const closed = saleValue(item);
  return closed > 0 ? closed : Number(item.estimated_value || 0);
}
function person(item: Followup) {
  return item.updated_by_name || item.created_by_name || 'Sem responsável';
}
function localDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleDateString('pt-BR') : '—';
}
function daysBetweenDates(older: string | null, newer: string) {
  if (!older) return null;
  const a = new Date(older).getTime();
  const b = new Date(newer).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((b - a) / 86400000));
}
function durationText(days: number | null) {
  if (days == null) return 'sem histórico anterior';
  if (days < 60) return `${days} dias`;
  const months = Math.floor(days / 30.44);
  if (months < 24) return `${months} meses`;
  const years = (days / 365.25).toFixed(1).replace('.', ',');
  return `${years} anos`;
}

export function DashboardView({ branches, followups, appointments, clients }: {
  branches: Branch[];
  followups: Followup[];
  appointments: Appointment[];
  clients: ClientSummary[];
}) {
  const [branchFilter, setBranchFilter] = useState<string[]>([]);
  const [consultantFilter, setConsultantFilter] = useState<string[]>([]);
  const [period, setPeriod] = useState<'30' | '90' | '365'>('90');

  const consultants = useMemo(() => Array.from(new Set(followups.map(person))).filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt-BR')), [followups]);
  const cutoff = useMemo(() => {
    const date = new Date();
    date.setDate(date.getDate() - Number(period));
    return date.getTime();
  }, [period]);

  const filteredFollowups = useMemo(() => followups.filter((item) => {
    if (branchFilter.length && !branchFilter.includes(item.branch)) return false;
    if (consultantFilter.length && !consultantFilter.includes(person(item))) return false;
    return new Date(item.created_at).getTime() >= cutoff || new Date(item.updated_at).getTime() >= cutoff;
  }), [followups, branchFilter, consultantFilter, cutoff]);
  const filteredAppointments = useMemo(() => appointments.filter((item) => !branchFilter.length || branchFilter.includes(item.branch)), [appointments, branchFilter]);
  const filteredClients = useMemo(() => clients.filter((item) => !branchFilter.length || branchFilter.includes(item.branch)), [clients, branchFilter]);

  const open = filteredFollowups.filter((item) => item.stage !== 'encerrar');
  const won = filteredFollowups.filter((item) => item.result === 'venda_ganha');
  const lost = filteredFollowups.filter((item) => item.result === 'venda_perdida');
  const closed = won.length + lost.length;
  const conversion = closed ? won.length / closed : 0;
  const followupRevenue = won.reduce((sum, item) => sum + saleValue(item), 0);
  const agendaRevenue = filteredAppointments
    .filter((item) => item.billing_status === 'faturado')
    .reduce((sum, item) => sum + Number(item.forecast_amount || 0), 0);
  const revenue = followupRevenue + agendaRevenue;
  const opportunityPipeline = open.reduce((sum, item) => sum + opportunityValue(item), 0);
  const agendaForecast = filteredAppointments
    .filter((item) => item.billing_status !== 'faturado')
    .reduce((sum, item) => sum + Number(item.forecast_amount || 0), 0);
  const activeRetention = filteredClients.filter((item) => ['0-3', '3-6', '6-12'].includes(recencyBucket(item.last_service_at))).length;
  const retentionRate = filteredClients.length ? activeRetention / filteredClients.length : 0;
  const inactive = filteredClients.filter((item) => ['12-18', '18+'].includes(recencyBucket(item.last_service_at))).length;

  const today = new Date().toISOString().slice(0, 10);
  const prospectToday = filteredFollowups.filter((item) => item.created_at?.slice(0, 10) === today).length;
  const interactionsToday = filteredFollowups.filter((item) => item.updated_at?.slice(0, 10) === today).length;
  const overdue = open.filter((item) => item.next_followup_date && item.next_followup_date < today).length;

  const byConsultant = useMemo(() => consultants.map((name) => {
    const rows = filteredFollowups.filter((item) => person(item) === name);
    const wonRows = rows.filter((item) => item.result === 'venda_ganha');
    const lostRows = rows.filter((item) => item.result === 'venda_perdida');
    const closedRows = wonRows.length + lostRows.length;
    return {
      name,
      prospect: rows.filter((item) => item.created_at?.slice(0, 10) === today).length,
      interactions: rows.filter((item) => item.updated_at?.slice(0, 10) === today).length,
      open: rows.filter((item) => item.stage !== 'encerrar').length,
      pipeline: rows.filter((item) => item.stage !== 'encerrar').reduce((sum, item) => sum + opportunityValue(item), 0),
      revenue: wonRows.reduce((sum, item) => sum + saleValue(item), 0),
      conversion: closedRows ? wonRows.length / closedRows : 0,
    };
  }).filter((row) => !consultantFilter.length || consultantFilter.includes(row.name)).sort((a, b) => b.revenue - a.revenue || b.pipeline - a.pipeline), [consultants, filteredFollowups, consultantFilter, today]);

  const byBranch = useMemo(() => branches.map((branch) => {
    const rows = filteredFollowups.filter((item) => item.branch === branch.name);
    const branchAppointments = filteredAppointments.filter((item) => item.branch === branch.name);
    const wonRows = rows.filter((item) => item.result === 'venda_ganha');
    const billedAgenda = branchAppointments
      .filter((item) => item.billing_status === 'faturado')
      .reduce((sum, item) => sum + Number(item.forecast_amount || 0), 0);
    const pendingAgenda = branchAppointments
      .filter((item) => item.billing_status !== 'faturado')
      .reduce((sum, item) => sum + Number(item.forecast_amount || 0), 0);
    return {
      name: branch.name,
      open: rows.filter((item) => item.stage !== 'encerrar').length,
      won: wonRows.length,
      revenue: wonRows.reduce((sum, item) => sum + saleValue(item), 0) + billedAgenda,
      forecast: pendingAgenda,
    };
  }).filter((row) => !branchFilter.length || branchFilter.includes(row.name)).sort((a, b) => b.revenue - a.revenue || b.forecast - a.forecast), [branches, filteredFollowups, filteredAppointments, branchFilter]);

  const lossReasons = useMemo(() => {
    const labels: Record<string, string> = { sem_interesse: 'Sem interesse', preco: 'Preço', concorrente: 'Concorrente', sem_contato: 'Sem contato', adiado: 'Adiado', outro: 'Outro' };
    const counts = new Map<string, number>();
    for (const item of lost) {
      const label = labels[item.lost_reason || 'outro'] || 'Outro';
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  }, [lost]);

  const conversionRows = useMemo(() => won.map((item) => {
    const key = `${item.client_name.trim().toUpperCase()}|${item.branch.trim().toUpperCase()}`;
    const client = filteredClients.find((candidate) => `${candidate.client_name.trim().toUpperCase()}|${candidate.branch.trim().toUpperCase()}` === key);
    const days = daysBetweenDates(client?.last_service_at || null, item.created_at);
    return { item, days };
  }).filter((row) => row.days == null || row.days >= 365).sort((a, b) => (b.days || 0) - (a.days || 0)).slice(0, 12), [won, filteredClients]);

  const swot = useMemo(() => {
    const bestConsultant = byConsultant[0];
    const bestBranch = byBranch[0];
    return {
      strengths: [
        bestConsultant ? `${bestConsultant.name} lidera o período com ${money.format(bestConsultant.revenue)} em vendas registradas.` : 'Ainda não há vendas registradas no período.',
        bestBranch ? `${bestBranch.name} é a filial com maior faturamento registrado no recorte atual.` : 'Aguardando base suficiente por filial.',
      ],
      weaknesses: [
        `${overdue} contato${overdue === 1 ? '' : 's'} de Follow-up estão vencidos.`,
        `${lost.length} venda${lost.length === 1 ? '' : 's'} perdida${lost.length === 1 ? '' : 's'} no período selecionado.`,
      ],
      opportunities: [
        `${inactive} cliente${inactive === 1 ? '' : 's'} estão nas faixas de 12–18 meses ou +18 meses sem atendimento.`,
        `${money.format(opportunityPipeline)} em oportunidades abertas informadas no Follow-up.`,
      ],
      threats: [
        lossReasons[0] ? `${lossReasons[0].label} é hoje o principal motivo registrado de perda.` : 'Sem motivo de perda dominante no período.',
        `${int.format(filteredClients.length - activeRetention)} clientes estão há mais de 12 meses sem atendimento ou sem data válida.`,
      ],
    };
  }, [byConsultant, byBranch, overdue, lost.length, inactive, opportunityPipeline, lossReasons, filteredClients.length, activeRetention]);

  function toggle<T>(current: T[], value: T, setter: (next: T[]) => void) {
    setter(current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  const maxLoss = Math.max(1, ...lossReasons.map((item) => item.value));
  const maxConsultantRevenue = Math.max(1, ...byConsultant.map((item) => item.revenue + item.pipeline));

  return <section className="dashboard-page">
    <div className="dashboard-toolbar">
      <div><h2>Dashboard de gestão</h2><p>Prospecção, oportunidades, retenção e desempenho comercial.</p></div>
      <div className="dashboard-filters">
        <label><span>Período</span><select value={period} onChange={(event) => setPeriod(event.target.value as '30'|'90'|'365')}><option value="30">30 dias</option><option value="90">90 dias</option><option value="365">12 meses</option></select></label>
        <details><summary><Building2 size={14}/> Filiais {branchFilter.length ? `(${branchFilter.length})` : ''}</summary><div className="dash-check-list">{branches.map((item) => <label key={item.name}><input type="checkbox" checked={branchFilter.includes(item.name)} onChange={() => toggle(branchFilter, item.name, setBranchFilter)}/>{item.name}</label>)}{branchFilter.length > 0 && <button type="button" onClick={() => setBranchFilter([])}>Limpar</button>}</div></details>
        <details><summary><Users size={14}/> Consultores {consultantFilter.length ? `(${consultantFilter.length})` : ''}</summary><div className="dash-check-list">{consultants.map((item) => <label key={item}><input type="checkbox" checked={consultantFilter.includes(item)} onChange={() => toggle(consultantFilter, item, setConsultantFilter)}/>{item}</label>)}{consultantFilter.length > 0 && <button type="button" onClick={() => setConsultantFilter([])}>Limpar</button>}</div></details>
        {(branchFilter.length > 0 || consultantFilter.length > 0) && <button className="dash-clear" type="button" onClick={() => { setBranchFilter([]); setConsultantFilter([]); }}><Filter size={14}/> Limpar filtros</button>}
      </div>
    </div>

    <div className="dashboard-kpis">
      <article><span><CircleDollarSign size={17}/> Faturamento</span><strong>{money.format(revenue)}</strong><small>vendas ganhas e atendimentos faturados</small></article>
      <article><span><Target size={17}/> Oportunidades</span><strong>{money.format(opportunityPipeline)}</strong><small>{open.length} em andamento</small></article>
      <article><span><Gauge size={17}/> Conversão</span><strong>{(conversion * 100).toFixed(1).replace('.', ',')}%</strong><small>{won.length} ganhas · {lost.length} perdidas</small></article>
      <article><span><BadgeDollarSign size={17}/> Previsão da agenda</span><strong>{money.format(agendaForecast)}</strong><small>somente valores ainda não faturados</small></article>
      <article><span><Crosshair size={17}/> Retenção ativa</span><strong>{(retentionRate * 100).toFixed(1).replace('.', ',')}%</strong><small>clientes atendidos em até 12 meses</small></article>
      <article><span><PhoneCall size={17}/> Proatividade hoje</span><strong>{prospectToday} novos</strong><small>{interactionsToday} interações registradas hoje</small></article>
    </div>

    <div className="dashboard-grid two">
      <article className="dash-panel"><header><div><TrendingUp size={17}/><strong>Desempenho por consultor</strong></div><small>venda, pipeline e atividade registrada</small></header><div className="consultant-ranking">{byConsultant.length ? byConsultant.map((row) => <div className="consultant-row" key={row.name}><div className="consultant-name"><strong>{row.name}</strong><span>{row.prospect} prospecções hoje · {row.interactions} interações</span></div><div className="consultant-bar"><i style={{ width: `${Math.max(4, ((row.revenue + row.pipeline) / maxConsultantRevenue) * 100)}%` }}/></div><div className="consultant-values"><b>{money.format(row.revenue)}</b><span>{money.format(row.pipeline)} pipeline · {(row.conversion * 100).toFixed(0)}% conv.</span></div></div>) : <div className="dash-empty">Sem dados de consultores no filtro atual.</div>}</div></article>
      <article className="dash-panel"><header><div><Building2 size={17}/><strong>Desempenho por filial</strong></div><small>faturamento e previsão da agenda</small></header><div className="branch-table"><div className="branch-table-head"><span>Filial</span><span>Oport.</span><span>Vendas</span><span>Faturamento</span><span>Previsão</span></div>{byBranch.map((row) => <div key={row.name}><strong>{row.name}</strong><span>{row.open}</span><span>{row.won}</span><span>{money.format(row.revenue)}</span><span>{money.format(row.forecast)}</span></div>)}</div></article>
    </div>

    <div className="dashboard-grid two">
      <article className="dash-panel"><header><div><TrendingDown size={17}/><strong>Vendas perdidas</strong></div><small>motivos registrados</small></header><div className="loss-chart">{lossReasons.length ? lossReasons.map((item) => <div key={item.label}><span>{item.label}</span><div><i style={{ width: `${(item.value / maxLoss) * 100}%` }}/></div><b>{item.value}</b></div>) : <div className="dash-empty">Nenhuma venda perdida no período.</div>}</div></article>
      <article className="dash-panel"><header><div><Activity size={17}/><strong>Oportunidades e retenção</strong></div><small>carteira aberta e tempo sem atendimento</small></header><div className="retention-bars">{retentionRecency.map((bucket) => { const count = filteredClients.filter((item) => recencyBucket(item.last_service_at) === bucket.key).length; const pct = filteredClients.length ? count / filteredClients.length : 0; return <div key={bucket.key}><span><i style={{ background: bucket.color }}/>{bucket.label}</span><div><b style={{ width: `${Math.max(2, pct * 100)}%`, background: bucket.color }}/></div><strong>{count}</strong></div>; })}</div></article>
    </div>

    <article className="dash-panel swot-panel"><header><div><Lightbulb size={17}/><strong>SWOT operacional</strong></div><small>leitura automática dos dados atuais; serve como ponto de partida para gestão</small></header><div className="swot-grid"><div className="strength"><h3><CheckCircle2 size={16}/> Forças</h3>{swot.strengths.map((item) => <p key={item}>{item}</p>)}</div><div className="weakness"><h3><AlertTriangle size={16}/> Fraquezas</h3>{swot.weaknesses.map((item) => <p key={item}>{item}</p>)}</div><div className="opportunity"><h3><TrendingUp size={16}/> Oportunidades</h3>{swot.opportunities.map((item) => <p key={item}>{item}</p>)}</div><div className="threat"><h3><TrendingDown size={16}/> Ameaças</h3>{swot.threats.map((item) => <p key={item}>{item}</p>)}</div></div></article>

    <article className="dash-panel"><header><div><Users size={17}/><strong>Conversão de clientes inativos</strong></div><small>vendas ganhas em clientes com longo intervalo de atendimento identificado</small></header><div className="inactive-table"><div><span>Cliente</span><span>Filial</span><span>Tempo sem atendimento</span><span>Conversão</span><span>Valor</span></div>{conversionRows.length ? conversionRows.map(({ item, days }) => <div key={item.id}><strong>{item.client_name}</strong><span>{item.branch}</span><span>{durationText(days)}</span><span>{localDate(item.updated_at)}</span><b>{money.format(saleValue(item))}</b></div>) : <div className="dash-empty">Nenhuma conversão de cliente inativo identificada neste recorte.</div>}</div></article>
  </section>;
}