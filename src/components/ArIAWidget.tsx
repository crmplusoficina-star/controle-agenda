import { useRef, useState } from 'react';
import { Bot, GripHorizontal, Maximize2, Minimize2, Send, X } from 'lucide-react';
import { useSession } from '../session';
import { answerArIA, isArIACorrection, type ArIAAction } from '../lib/ariaBrain';
import { answerSmartArIA, learnCorrectionResilient, markArIASuggestionDecision, type ArIAProspect } from '../lib/ariaSmart';
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

type RichArIAAction = ArIAAction & {
  operation?: 'prospect' | 'ignore';
  prospects?: ArIAProspect[];
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

function normalizedClientKey(clientName: string, branch: string) {
  const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  return `${fold(clientName)}|${fold(branch)}`;
}

export function ArIAWidget() {
  const { user } = useSession();
  const [avatarFailed, setAvatarFailed] = useState(false);
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
  const lastQuestionRef = useRef('');
  const lastAnswerRef = useRef('');

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

  function appendArIAMessage(message: string) {
    setMessages((current) => [...current, { id: nextId.current++, role: 'aria', text: message }]);
    scrollBottom();
  }

  async function runAction(action: ArIAAction) {
    const richAction = action as RichArIAAction;
    const prospects = richAction.prospects || [];

    if (richAction.operation === 'ignore' && prospects.length) {
      markArIASuggestionDecision(user, prospects, 'ignore');
      appendArIAMessage('Sugestão ignorada. Esses clientes não serão sugeridos novamente pelos próximos 30 dias.');
      return;
    }

    if (richAction.operation === 'prospect' && prospects.length) {
      if (busy) return;
      setBusy(true);
      try {
        const { data: openRows } = await supabase.from('followups').select('client_name,branch').neq('stage', 'encerrar').limit(2000);
        const openKeys = new Set((openRows || []).map((item: any) => normalizedClientKey(item.client_name || '', item.branch || '')));
        let created = 0;
        let alreadyOpen = 0;
        let failed = 0;

        for (const prospect of prospects) {
          const key = normalizedClientKey(prospect.client_name, prospect.branch);
          if (openKeys.has(key)) {
            alreadyOpen += 1;
            continue;
          }
          const { error } = await supabase.from('followups').insert({
            branch: prospect.branch,
            client_name: prospect.client_name,
            equipment_serial: null,
            stage: 'prospectar',
            next_followup_date: null,
            notes: 'Sugestão da ArIA',
            result: null,
            sale_kind: null,
            parts_value: null,
            services_value: null,
            estimated_value: null,
            created_by_matricula: user.matricula,
            created_by_name: user.name,
            updated_by_matricula: user.matricula,
            updated_by_name: user.name,
          });
          if (!error) {
            created += 1;
            openKeys.add(key);
          } else if (error.code === '23505') {
            alreadyOpen += 1;
          } else {
            failed += 1;
            console.error('aria_prospect_insert_failed', error);
          }
        }

        markArIASuggestionDecision(user, prospects, 'prospect');
        const details = [
          created ? `${created} adicionada(s)` : '',
          alreadyOpen ? `${alreadyOpen} já estava(m) em Follow-up` : '',
          failed ? `${failed} não pôde/puderam ser adicionada(s)` : '',
        ].filter(Boolean).join(' · ');
        appendArIAMessage(`Pronto. ${details || 'As sugestões foram processadas.'} Vou abrir o Follow-up em andamento.`);
        clickButton('Follow-up', '.sidebar');
        window.setTimeout(() => clickButton('Em andamento', '.followup-workspace'), 250);
      } finally {
        setBusy(false);
      }
      return;
    }

    if (action.tutorial) {
      window.dispatchEvent(new CustomEvent('aria:tutorial:start'));
      return;
    }
    if (!action.view) return;
    const labels: Record<string, string> = { inicio: 'Início', agenda: 'Agenda', retencao: 'Retenção', followup: 'Follow-up', dashboard: 'Dashboard' };
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
      let reply;
      if (isArIACorrection(value) && lastQuestionRef.current) {
        const learned = await learnCorrectionResilient(lastQuestionRef.current, lastAnswerRef.current, value, user);
        const applied = await answerSmartArIA(`${lastQuestionRef.current}. ${value}`, user);
        if (applied) {
          reply = {
            ...applied,
            text: `${learned.sharedSaved ? 'Entendi e registrei essa correção para pedidos semelhantes.' : 'Entendi e registrei essa correção neste dispositivo; vou considerar daqui em diante.'}\n\n${applied.text}`,
          };
        } else {
          reply = {
            text: learned.sharedSaved
              ? 'Entendi e registrei a correção para pedidos semelhantes. Vou usar essa orientação nas próximas interpretações.'
              : 'Entendi e guardei a correção neste dispositivo. O registro compartilhado está indisponível agora, mas não vou descartar o que você me ensinou nesta sessão.',
          };
        }
      } else {
        reply = await answerSmartArIA(value, user) || await answerArIA(value, user);
        lastQuestionRef.current = value;
        lastAnswerRef.current = reply.text;
      }

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

  const avatar = avatarFailed
    ? <span className="aria-avatar-fallback"><Bot size={18}/></span>
    : <img className="aria-avatar-image" src="/aria/aria-1.png" alt="ArIA" onError={() => setAvatarFailed(true)} />;

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
        <span className="aria-orb-avatar">{avatar}</span>
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
        <div className="aria-title"><span className="aria-avatar">{avatar}</span><div><strong>ArIA</strong><small>Assistente operacional</small></div></div>
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
            {message.actions.map((action, index) => <button type="button" key={`${action.label}-${index}`} onClick={() => void runAction(action)}>{action.label}</button>)}
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
