import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, Mail, Search, Users, X } from 'lucide-react';
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
  serial: string;
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

function buildAgendaSvg(weekStart: Date, rows: ShareRow[], branchLabel: string) {
  const days = Array.from({ length: 6 }, (_, index) => addDays(weekStart, index));
  const rowsByDate = new Map(days.map((day) => [isoDate(day), rows.filter((row) => row.date === isoDate(day))]));
  const visibleDays = days.filter((day) => (rowsByDate.get(isoDate(day)) || []).length > 0);

  const margin = 30;
  const gap = 16;
  const cardWidth = 310;
  const titleHeight = 108;
  const dayHeaderHeight = 42;
  const itemHeight = 104;
  const cardPadding = 12;
  const footerHeight = 34;
  const visibleCount = Math.max(visibleDays.length, 1);
  const width = Math.max(1400, margin * 2 + visibleCount * cardWidth + Math.max(0, visibleCount - 1) * gap);
  const contentWidth = width - margin * 2;
  const tallestRows = Math.max(1, ...visibleDays.map((day) => (rowsByDate.get(isoDate(day)) || []).length));
  const cardsHeight = dayHeaderHeight + cardPadding * 2 + tallestRows * itemHeight;
  const height = margin + titleHeight + 18 + cardsHeight + footerHeight + margin;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    `<rect x="${margin}" y="${margin}" width="${contentWidth}" height="${titleHeight}" rx="18" fill="#101827"/>`,
    `<text x="${margin + 24}" y="${margin + 35}" font-family="Arial, sans-serif" font-size="26" font-weight="700" fill="#ffffff">Agenda da semana</text>`,
    `<text x="${margin + 24}" y="${margin + 65}" font-family="Arial, sans-serif" font-size="16" font-weight="700" fill="#e2e8f0">Filial: ${escapeXml(branchLabel)}</text>`,
    `<text x="${margin + 24}" y="${margin + 91}" font-family="Arial, sans-serif" font-size="16" fill="#cbd5e1">${escapeXml(shortDate.format(weekStart))} — ${escapeXml(shortDate.format(addDays(weekStart, 5)))}</text>`,
  ];

  const cardsTop = margin + titleHeight + 18;

  visibleDays.forEach((day, dayIndex) => {
    const dayRows = rowsByDate.get(isoDate(day)) || [];
    const x = margin + dayIndex * (cardWidth + gap);
    const cardHeight = dayHeaderHeight + cardPadding * 2 + dayRows.length * itemHeight;

    parts.push(`<rect x="${x}" y="${cardsTop}" width="${cardWidth}" height="${cardHeight}" rx="14" fill="#f8fafc" stroke="#dbe3ee"/>`);
    parts.push(`<rect x="${x}" y="${cardsTop}" width="${cardWidth}" height="${dayHeaderHeight}" rx="14" fill="#eff4fb"/>`);
    parts.push(`<text x="${x + 16}" y="${cardsTop + 27}" font-family="Arial, sans-serif" font-size="16" font-weight="700" fill="#172033">${escapeXml(formatDay(day))}</text>`);

    dayRows.forEach((row, index) => {
      const itemY = cardsTop + dayHeaderHeight + cardPadding + index * itemHeight;
      parts.push(`<rect x="${x + 10}" y="${itemY}" width="${cardWidth - 20}" height="${itemHeight - 8}" rx="10" fill="#ffffff" stroke="#e7edf4"/>`);
      parts.push(`<text x="${x + 22}" y="${itemY + 21}" font-family="Arial, sans-serif" font-size="15" font-weight="700" fill="#172033">${escapeXml(cut(row.technician, 22))}</text>`);
      parts.push(`<text x="${x + 22}" y="${itemY + 42}" font-family="Arial, sans-serif" font-size="14" fill="#334155">${escapeXml(cut(row.client, 34))}</text>`);
      parts.push(`<text x="${x + 22}" y="${itemY + 61}" font-family="Arial, sans-serif" font-size="12.5" fill="#64748b">${escapeXml(cut(row.city, 28))}</text>`);
      parts.push(`<text x="${x + 22}" y="${itemY + 79}" font-family="Arial, sans-serif" font-size="12.5" fill="#475569">${escapeXml(cut(row.reason, 31))}</text>`);
      parts.push(`<text x="${x + 22}" y="${itemY + 95}" font-family="Arial, sans-serif" font-size="11.5" fill="#64748b">${escapeXml(cut(row.serial, 31))}</text>`);
    });
  });

  parts.push(`<text x="${margin}" y="${height - 18}" font-family="Arial, sans-serif" font-size="12" fill="#94a3b8">Gerado pela Agenda Técnica</text>`);
  parts.push('</svg>');
  return { svg: parts.join(''), width, height };
}

async function agendaPng(weekStart: Date, rows: ShareRow[], branchLabel: string) {
  const rendered = buildAgendaSvg(weekStart, rows, branchLabel);
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
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState('');
  const [showPasteTip, setShowPasteTip] = useState(false);
  const shareWeekStart = useMemo(() => startOfWeek(anchorDate), [anchorDate]);
  const weekDates = useMemo(() => new Set(Array.from({ length: 6 }, (_, index) => isoDate(addDays(shareWeekStart, index)))), [shareWeekStart]);
  const branchLabel = useMemo(() => {
    const names = Array.from(new Set(technicians.map((item) => String(item.branch || '').trim()).filter(Boolean)));
    return names.length ? names.join(', ') : 'Todas';
  }, [technicians]);

  const rows = useMemo<ShareRow[]>(() => {
    const techMap = new Map(technicians.map((item) => [item.id, item.name]));
    return appointments
      .filter((item) => weekDates.has(item.appointment_date) && techMap.has(item.technician_id) && Boolean(item.client_name?.trim()))
      .map((item) => ({
        date: item.appointment_date,
        technician: techMap.get(item.technician_id) || '',
        client: item.client_name?.trim() || '—',
        city: item.service_city || '—',
        reason: item.service_reason || '—',
        serial: item.equipment_serial || '—',
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
    setShowPasteTip(false);

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

  async function saveDefault() {
    const { error } = await supabase.from('agenda_share_user_defaults').upsert({
      matricula: user.matricula,
      recipient_emails: selectedEmails,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'matricula' });
    if (error) console.error('agenda_share_default_save_failed', error);
    return !error;
  }

  async function openOutlook() {
    if (!selectedEmails.length || !rows.length || opening) return;
    setOpening(true);
    setNotice('Preparando e copiando a agenda...');

    let copied = false;
    try {
      const png = await agendaPng(shareWeekStart, rows, branchLabel);
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

    const saved = await saveDefault();
    const period = `${shortDate.format(shareWeekStart)} a ${shortDate.format(addDays(shareWeekStart, 5))}`;
    const subject = `Agenda atualizada - ${branchLabel} - ${period}`;
    const regionalText = branchLabel === 'Todas' ? 'regional' : `regional ${branchLabel}`;
    const body = `Olá,\r\n\r\nCompartilho com vocês a agenda atualizada dos colaboradores da ${regionalText}.\r\n\r\nPeríodo: ${period}.\r\n`;
    const recipientsPath = selectedEmails.map((email) => encodeURIComponent(email)).join(';');
    const mailtoUrl = `mailto:${recipientsPath}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    setNotice(copied
      ? `${saved ? 'Destinatários salvos. ' : ''}Agenda copiada. Cole a imagem no Outlook ou pressione Ctrl+V.`
      : `${saved ? 'Destinatários salvos. ' : ''}A imagem da agenda foi baixada. Insira a imagem no e-mail antes de enviar.`);
    setShowPasteTip(copied);
    setOpening(false);

    window.setTimeout(() => {
      window.location.href = mailtoUrl;
    }, 120);
  }

  if (!open) return null;

  return <div className="agenda-share-layer" onClick={onClose}>
    <section className="agenda-share-modal" onClick={(event) => event.stopPropagation()} aria-label="Compartilhar agenda">
      <header className="agenda-share-head">
        <div className="agenda-share-icon"><Mail size={20}/></div>
        <div><h2>Compartilhar agenda</h2><p>Filial: {branchLabel} · {shortDate.format(shareWeekStart)} — {shortDate.format(addDays(shareWeekStart, 5))}</p></div>
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
          <div className="agenda-share-section-title"><div><strong>Prévia da agenda</strong><span>Técnico, cliente, cidade, tipo e série do equipamento.</span></div></div>
          <div className="agenda-share-preview">
            <div className="agenda-share-preview-brand"><strong>Agenda da semana · {branchLabel}</strong><span>{shortDate.format(shareWeekStart)} — {shortDate.format(addDays(shareWeekStart, 5))}</span></div>
            {rows.length === 0 ? <div className="agenda-share-empty agenda-share-empty-preview">Nenhum atendimento com cliente associado nesta semana.</div> : <div className="agenda-share-days-grid">
              {days.map((day) => {
                const dayRows = rows.filter((row) => row.date === isoDate(day));
                if (!dayRows.length) return null;
                return <div className="agenda-share-day-card" key={isoDate(day)}>
                  <div className="agenda-share-day-card-title">{formatDay(day)}</div>
                  <div className="agenda-share-day-card-list">
                    {dayRows.map((row, index) => <div className="agenda-share-day-card-item" key={`${row.date}-${row.technician}-${row.client}-${index}`}>
                      <strong>{row.technician}</strong>
                      <span>{row.client}</span>
                      <small>{row.city}</small>
                      <small>{row.reason}</small>
                      <small>{row.serial}</small>
                    </div>)}
                  </div>
                </div>;
              })}
            </div>}
          </div>
        </div>
      </div>

      <footer className="agenda-share-footer">
        <div className="agenda-share-notice">{notice || 'Ao abrir o Outlook, a seleção atual fica salva como padrão para a sua matrícula e a agenda é copiada para colar no e-mail.'}</div>
        <button type="button" className="primary-button" disabled={!selectedEmails.length || !rows.length || opening} onClick={() => { void openOutlook(); }}><ExternalLink size={15}/>{opening ? 'Preparando...' : 'Abrir Outlook'}</button>
      </footer>
    </section>

    {showPasteTip && <div className="agenda-share-tip-layer" onClick={() => setShowPasteTip(false)}>
      <div className="agenda-share-tip" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="icon-button" onClick={() => setShowPasteTip(false)} aria-label="Fechar aviso"><X size={16}/></button>
        <strong>Agenda copiada</strong>
        <p>Cole a imagem no e-mail ou pressione <b>Ctrl+V</b>.</p>
      </div>
    </div>}
  </div>;
}