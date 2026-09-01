import { useRef, useState } from 'react';
import { Bot, GripHorizontal, Maximize2, Minimize2, Send, X } from 'lucide-react';
import { useSession } from '../session';
import { answerArIA, type ArIAAction } from '../lib/ariaBrain';
import './aria-widget.css';

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
};

type ChatMessage = {
  id: number;
  role: 'user' | 'aria';
  text: string;
  actions?: ArIAAction[];
};

function clickButton(text: string, scope?: string) {
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return false;
  const buttons = Array.from(root.querySelectorAll('button')) as HTMLButtonElement[];
  const wanted = text.toLowerCase();
  const button = buttons.find((item) => item.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() === wanted)
    || buttons.find((item) => item.textContent?.replace(/\s+/g, ' ').trim().toLowerCase().includes(wanted));
  if (!button) return false;
  button.click();
  return true;
}

export function ArIAWidget() {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState({ x: 22, y: 22 });
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 1, role: 'aria', text: `Olá, ${user.name.split(' ')[0] || user.name}. Sou a ArIA. Posso consultar Agenda, Retenção, histórico G4 e Follow-up. Pergunte “o que você consegue fazer?” para ver minhas capacidades.` },
  ]);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const nextId = useRef(2);
  const bodyRef = useRef<HTMLDivElement>(null);

  function beginDrag(event: React.PointerEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest('button,input,textarea')) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function beginOrbDrag(event: React.PointerEvent<HTMLButtonElement>) {
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    suppressClickRef.current = true;
    const width = open ? (expanded ? 500 : 370) : 96;
    const height = open ? (expanded ? 520 : 420) : 48;
    const nextX = Math.max(8, Math.min(window.innerWidth - Math.min(width, window.innerWidth - 16), drag.originX - dx));
    const nextY = Math.max(8, Math.min(window.innerHeight - Math.min(height, window.innerHeight - 16), drag.originY - dy));
    setPosition({ x: nextX, y: nextY });
  }

  function endDrag(event: React.PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (!drag.moved) suppressClickRef.current = false;
    else window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  }

  function openFromOrb() {
    if (suppressClickRef.current) return;
    setOpen(true);
  }

  function scrollBottom() {
    window.setTimeout(() => {
      if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }, 20);
  }

  function runAction(action: ArIAAction) {
    if (action.tutorial) {
      window.dispatchEvent(new CustomEvent('aria:tutorial:start'));
      return;
    }
    if (!action.view) return;
    const labels: Record<string, string> = { inicio: 'Início', agenda: 'Agenda', retencao: 'Retenção', followup: 'Follow-up' };
    clickButton(labels[action.view], '.sidebar');
    window.setTimeout(() => {
      if (action.view === 'retencao' && action.mode) clickButton(action.mode === 'map' ? 'Mapa' : 'Lista', '.list-page');
      if (action.view === 'followup' && action.tab) {
        if (action.tab === 'calendar') clickButton('Agenda', '.followup-workspace');
        else if (action.tab === 'history') clickButton('Histórico de vendas', '.followup-workspace');
        else clickButton('Em andamento', '.followup-workspace');
      }
    }, 220);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setText('');
    setMessages((current) => [...current, { id: nextId.current++, role: 'user', text: value }]);
    setBusy(true);
    scrollBottom();
    try {
      const reply = await answerArIA(value, user);
      setMessages((current) => [...current, { id: nextId.current++, role: 'aria', text: reply.text, actions: reply.actions }]);
      if (value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes('tutorial')) {
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('aria:tutorial:start')), 220);
      }
    } catch (error) {
      console.error('aria_answer_failed', error);
      setMessages((current) => [...current, { id: nextId.current++, role: 'aria', text: 'Não consegui consultar os dados agora. Tente novamente em instantes.' }]);
    } finally {
      setBusy(false);
      scrollBottom();
    }
  }

  if (!open) {
    return (
      <button
        className="aria-orb"
        style={{ right: position.x, bottom: position.y }}
        onPointerDown={beginOrbDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={openFromOrb}
        aria-label="Abrir ou arrastar ArIA"
        title="Clique para abrir · arraste para mover"
      >
        <Bot size={20} />
        <span>ArIA</span>
      </button>
    );
  }

  return (
    <section className={`aria-widget ${expanded ? 'expanded' : ''}`} style={{ right: position.x, bottom: position.y }}>
      <header
        className="aria-head"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="aria-title"><span className="aria-avatar"><Bot size={18}/></span><div><strong>ArIA</strong><small>Assistente operacional</small></div></div>
        <div className="aria-actions">
          <button type="button" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? 'Reduzir ArIA' : 'Expandir ArIA'}>{expanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button>
          <button type="button" onClick={() => setOpen(false)} aria-label="Fechar ArIA"><X size={16}/></button>
        </div>
      </header>
      <div className="aria-drag-hint"><GripHorizontal size={15}/> segure o topo e arraste</div>
      <div className="aria-body" ref={bodyRef}>
        {messages.map((message) => <div key={message.id} className={`aria-chat-row ${message.role}`}>
          <div className={`aria-message ${message.role}`}>{message.text.split('\n').map((line, index) => <span key={index}>{line || '\u00a0'}</span>)}</div>
          {message.role === 'aria' && message.actions?.length ? <div className="aria-context-actions">
            {message.actions.map((action, index) => <button type="button" key={`${action.label}-${index}`} onClick={() => runAction(action)}>{action.label}</button>)}
          </div> : null}
        </div>)}
        {busy && <div className="aria-chat-row aria"><div className="aria-message aria aria-thinking">Consultando o contexto do app…</div></div>}
      </div>
      <form className="aria-input" onSubmit={submit}>
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Pergunte sobre agenda, cliente ou follow-up..." />
        <button type="submit" disabled={!text.trim() || busy} aria-label="Enviar mensagem"><Send size={17}/></button>
      </form>
    </section>
  );
}
