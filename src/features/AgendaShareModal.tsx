import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, Mail, Save, Search, Users, X } from 'lucide-react';
import type { Appointment, Technician } from '../types';
import { addDays, isoDate, startOfWeek } from '../lib/date';
import { supabase } from '../lib/supabase';
import { useSession } from '../session';
import './agenda-share.css';

type ShareRecipient = {
  id: number;
  name: string;
  email: string;
  active: boolean;
  sort_order: number;
};

type ShareRow = {
  date: string;
  technician: string;
  client: string;
  city: string;
  reason: string;
};

const dateLabel = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
const shortDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });

function escapeXml(value: string) {
  return value.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char] || char));
}

function cut(value: string, max: number) {
  const clean = value.trim() || '—';
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(1, max - 1))}…`;
}

function formatDay(date: Date) {
  const raw = dateLabel.format(date).replace('.', '');
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function buildAgendaSvg(weekStart: Date, rows: ShareRow[]) {
  const days = Array.from({ length: 6 }, (_, index) => addDays(weekStart, index));
  const width = 1400;
  const margin = 36;
  const contentWidth = width - margin * 2;
  const titleHeight = 92;
  const columnHeight = 38;
  const dayHeight = 38;
  const rowHeight = 58;
  const footerHeight = 34;
  const rowsByDate = new Map(days.map((day) => [isoDate(day), rows.filter((row) => row.date === isoDate(day))]));
  const visibleDays = days.filter((day) => (rowsByDate.get(isoDate(day)) || []).length > 0);
  const bodyHeight = visibleDays.reduce((sum, day) => sum + dayHeight + (rowsByDate.get(isoDate(day)) || []).length * rowHeight, 0);
  const height = Math.max(260, margin + titleHeight + columnHeight + bodyHeight + footerHeight + margin);
  const columns = [
    { label: 'Técnico', x: margin, width: 250 },
    { label: 'Cliente', x: margin + 250, width: 440 },
    { label: 'Cidade', x: margin + 690, width: 250 },
    { label: 'Tipo de atendimento', x: margin + 940, width: contentWidth - 940 },
  ];

  let y = margin;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    `<rect x="${margin}" y="${y}" width="${contentWidth}" height="${titleHeight}" rx="18" fill="#101827"/>`,
    `<text x="${margin + 28}" y="${y + 38}" font-family="Arial, sans-serif" font-size="26" font-weight="700" fill="#ffffff">Agenda da semana</text>`,
    `<text x="${margin + 28}" y="${y + 68}" font-family="Arial, sans-serif" font-size="16" fill="#cbd5e1">${escapeXml(shortDate.format(weekStart))} — ${escapeXml(shortDate.format(addDays(weekStart, 5)))}</text>`,
  ];

  y += titleHeight + 14;
  parts.push(`<rect x="${margin}" y="${y}" width="${contentWidth}" height="${columnHeight}" rx="9" fill="#eff4fb"/>`);
  columns.forEach((column) => {
    parts.push(`<text x="${column.x + 14}" y="${y + 25}" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="#475569">${column.label}</text>`);
  });
  y += columnHeight + 8;

  visibleDays.forEach((day) => {
    const dayRows = rowsByDate.get(isoDate(day)) || [];
    parts.push(`<rect x="${margin}" y="${y}" width="${contentWidth}" height="${dayHeight}" rx="8" fill="#f8fafc" stroke="#e2e8f0"/>`);
    parts.push(`<text x="${margin + 14}" y="${y + 25}" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#172033">${escapeXml(formatDay(day))}</text>`);
    y += dayHeight;

    dayRows.forEach((row, index) => {
      const fill = index % 2 === 0 ? '#ffffff' : '#fbfcfe';
      parts.push(`<rect x="${margin}" y="${y}" width="${contentWidth}" height="${rowHeight}" fill="${fill}" stroke="#edf1f5"/>`);
      parts.push(`<text x="${columns[0].x + 14}" y="${y + 34}" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#172033">${escapeXml(cut(row.technician, 26))}</text>`);
      parts.push(`<text x="${columns[1].x + 14}" y="${y + 34}" font-family="Arial, sans-serif" font-size="15" fill="#334155">${escapeXml(cut(row.client, 44))}</text>`);
      parts.push(`<text x="${columns[2].x + 14}" y="${y + 34}" font-family="Arial, sans-serif" font-size="15" fill="#475569">${escapeXml(cut(row.city, 25))}</text>`);
      parts.push(`<text x="${columns[3].x + 14}" y="${y + 34}" font-family="Arial, sans-serif" font-size="15" fill="#334155">${escapeXml(cut(row.reason, 38))}</text>`);
      y += rowHeight;
    });
    y += 8;
  });

  parts.push(`<text x="${margin}" y="${height - 28}" font-family="Arial, sans-serif" font-size="12" fill="#94a3b8">Gerado pela Agenda Técnica</text>`);
  parts.push('</svg>');
  return { svg: parts.join(''), width, height };
}

async function agendaPng(weekStart: Date, rows: ShareRow[]) {
  const rendered = buildAgendaSvg(weekStart, rows);
  const svgBlob = new Blob([rendered.svg], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    image.src = svgUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    const scale = 1.25;
    canvas.width = Math.round(rendered.width * scale);
    canvas.height = Math.round(rendered.height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas_context_unavailable');
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, rendered.width, rendered.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('png_generation_failed')), 'image/png'));
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AgendaShareModal({ open, onClose, anchorDate, technicians, appointments }: {
  open: boolean;
  onClose: () => void;
  anchorDate: Date;
  technicians: Technician[];
  appointments: Appointment[];
}) {
  const { user } = useSession();
  const [recipients, setRecipients] = useState<ShareRecipient[]>([]);
  const [selectedEmails, setSelectedEmails] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState('');
  const shareWeekStart = useMemo(() => startOfWeek(anchorDate), [anchorDate]);
  const weekDates = useMemo(() => new Set(Array.from({ length: 6 }, (_, index) => isoDate(addDays(shareWeekStart, index)))), [shareWeekStart]);

  const rows = useMemo<ShareRow[]>(() => {
    const techMap = new Map(technicians.map((item) => [item.id, item.name]));
    return appointments
      .filter((item) => weekDates.has(item.appointment_date) && techMap.has(item.technician_id))
      .map((item) => ({
        date: item.appointment_date,
        technician: techMap.get(item.technician_id) || '',
        client: item.client_name || '—',
        city: item.service_city || '—',
        reason: item.service_reason || '—',
      }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.technician.localeCompare(b.technician) || a.client.localeCompare(b.client));
  }, [appointments, technicians, weekDates]);

  const days = useMemo(() => Array.from({ length: 6 }, (_, index) => addDays(shareWeekStart, index)), [shareWeekStart]);
  const filteredRecipients = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return recipients;
    return recipients.filter((item) => item.name.toLowerCase().includes(term) || item.email.toLowerCase().includes(term));
  }, [recipients, search]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setNotice('');
    setSearch('');

    async function loadShareConfig() {
      const [recipientResult, defaultResult] = await Promise.all([
        supabase.from('agenda_share_recipients').select('id,name,email,active,sort_order').eq('active', true).order('sort_order').order('name'),
        supabase.from('agenda_share_user_defaults').select('recipient_emails').eq('matricula', user.matricula).maybeSingle(),
      ]);
      if (cancelled) return;
      setRecipients((recipientResult.data || []) as ShareRecipient[]);
      const defaults = Array.isArray(defaultResult.data?.recipient_emails) ? defaultResult.data.recipient_emails.map(String) : [];
      setSelectedEmails(defaults);
      setLoading(false);
    }

    void loadShareConfig();
    return () => { cancelled = true; };
  }, [open, user.matricula]);

  function toggleRecipient(email: string) {
    setSelectedEmails((current) => current.includes(email) ? current.filter((item) => item !== email) : [...current, email]);
  }

  async function saveDefault(showNotice = true) {
    setSaving(true);
    const { error } = await supabase.from('agenda_share_user_defaults').upsert({
      matricula: user.matricula,
      recipient_emails: selectedEmails,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'matricula' });
    setSaving(false);
    if (showNotice) setNotice(error ? 'Não foi possível salvar a seleção.' : 'Seleção salva como padrão para o seu usuário.');
    return !error;
  }

  async function openOutlook() {
    if (!selectedEmails.length || !rows.length || opening) return;
    setOpening(true);
    setNotice('Preparando a agenda...');
    await saveDefault(false);

    let copied = false;
    try {
      const png = await agendaPng(shareWeekStart, rows);
      const filename = `agenda-${isoDate(shareWeekStart)}-${isoDate(addDays(shareWeekStart, 5))}.png`;
      try {
        if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
          copied = true;
        }
      } catch (error) {
        console.warn('agenda_clipboard_failed', error);
      }
      if (!copied) downloadBlob(png, filename);
    } catch (error) {
      console.error('agenda_share_image_failed', error);
    }

    const period = `${shortDate.format(shareWeekStart)} a ${shortDate.format(addDays(shareWeekStart, 5))}`;
    const subject = `Agenda atualizada - ${period}`;
    const body = `Olá,\r\n\r\nCompartilho com vocês a agenda atualizada dos colaboradores da regional.\r\n\r\nPeríodo: ${period}.\r\n`;
    const outlookUrl = `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(selectedEmails.join(';'))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(outlookUrl, '_blank', 'noopener,noreferrer');
    setNotice(copied ? 'Outlook aberto. A agenda formatada foi copiada para a área de transferência.' : 'Outlook aberto. A imagem da agenda foi baixada para anexar ao e-mail.');
    setOpening(false);
  }

  if (!open) return null;

  return <div className="agenda-share-layer" onClick={onClose}>
    <section className="agenda-share-modal" onClick={(event) => event.stopPropagation()} aria-label="Compartilhar agenda">
      <header className="agenda-share-head">
        <div className="agenda-share-icon"><Mail size={20}/></div>
        <div><h2>Compartilhar agenda</h2><p>{shortDate.format(shareWeekStart)} — {shortDate.format(addDays(shareWeekStart, 5))}</p></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Fechar"><X size={18}/></button>
      </header>

      <div className="agenda-share-body">
        <div className="agenda-share-recipient-panel">
          <div className="agenda-share-section-title"><Users size={16}/><div><strong>Destinatários</strong><span>{selectedEmails.length} selecionado{selectedEmails.length === 1 ? '' : 's'}</span></div></div>
          <div className="agenda-share-search"><Search size={16}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Pesquisar colaborador ou e-mail" /></div>
          <div className="agenda-share-list">
            {loading ? <div className="agenda-share-empty">Carregando colaboradores...</div> : filteredRecipients.length === 0 ? <div className="agenda-share-empty">Nenhum colaborador encontrado.</div> : filteredRecipients.map((item) => {
              const selected = selectedEmails.includes(item.email);
              return <button type="button" className={`agenda-share-recipient ${selected ? 'selected' : ''}`} key={item.email} onClick={() => toggleRecipient(item.email)}>
                <span className="agenda-share-checkbox">{selected && <Check size={13}/>}</span>
                <span><strong>{item.name}</strong><small>{item.email}</small></span>
              </button>;
            })}
          </div>
          <div className="agenda-share-list-actions">
            <button type="button" onClick={() => setSelectedEmails(recipients.map((item) => item.email))}>Selecionar todos</button>
            <button type="button" onClick={() => setSelectedEmails([])}>Limpar</button>
          </div>
        </div>

        <div className="agenda-share-preview-panel">
          <div className="agenda-share-section-title"><div><strong>Prévia da agenda</strong><span>Somente técnico, cliente, cidade e tipo de atendimento.</span></div></div>
          <div className="agenda-share-preview">
            <div className="agenda-share-preview-brand"><strong>Agenda da semana</strong><span>{shortDate.format(shareWeekStart)} — {shortDate.format(addDays(shareWeekStart, 5))}</span></div>
            {rows.length === 0 ? <div className="agenda-share-empty agenda-share-empty-preview">Nenhum atendimento associado nesta semana.</div> : days.map((day) => {
              const dayRows = rows.filter((row) => row.date === isoDate(day));
              if (!dayRows.length) return null;
              return <div className="agenda-share-day" key={isoDate(day)}>
                <div className="agenda-share-day-title">{formatDay(day)}</div>
                <div className="agenda-share-table-head"><span>Técnico</span><span>Cliente</span><span>Cidade</span><span>Tipo</span></div>
                {dayRows.map((row, index) => <div className="agenda-share-table-row" key={`${row.date}-${row.technician}-${row.client}-${index}`}><strong>{row.technician}</strong><span>{row.client}</span><span>{row.city}</span><span>{row.reason}</span></div>)}
              </div>;
            })}
          </div>
        </div>
      </div>

      <footer className="agenda-share-footer">
        <div className="agenda-share-notice">{notice || 'A lista escolhida fica salva como padrão para a sua matrícula.'}</div>
        <button type="button" className="subtle-button" disabled={saving} onClick={() => { void saveDefault(); }}><Save size={15}/>{saving ? 'Salvando...' : 'Salvar padrão'}</button>
        <button type="button" className="primary-button" disabled={!selectedEmails.length || !rows.length || opening} onClick={() => { void openOutlook(); }}><ExternalLink size={15}/>{opening ? 'Preparando...' : 'Abrir Outlook'}</button>
      </footer>
    </section>
  </div>;
}
