import { useRef, useState } from 'react';
import { Bot, GripHorizontal, Maximize2, Minimize2, Send, X } from 'lucide-react';
import './aria-widget.css';

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
};

export function ArIAWidget() {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState('');
  const [position, setPosition] = useState({ x: 22, y: 22 });
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);

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
    const width = open ? (expanded ? 470 : 340) : 96;
    const height = open ? 300 : 48;
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

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setText('');
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
        <div className="aria-title"><span className="aria-avatar"><Bot size={18}/></span><div><strong>ArIA</strong><small>Assistente · Groq</small></div></div>
        <div className="aria-actions">
          <button type="button" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? 'Reduzir ArIA' : 'Expandir ArIA'}>{expanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button>
          <button type="button" onClick={() => setOpen(false)} aria-label="Fechar ArIA"><X size={16}/></button>
        </div>
      </header>
      <div className="aria-drag-hint"><GripHorizontal size={15}/> segure o topo e arraste</div>
      <div className="aria-body">
        <div className="aria-message">Olá. Sou a <strong>ArIA</strong>. Este é o esboço da assistente; a configuração e as instruções do Groq serão adicionadas depois.</div>
      </div>
      <form className="aria-input" onSubmit={submit}>
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Digite uma mensagem para ArIA..." />
        <button type="submit" disabled={!text.trim()} aria-label="Enviar mensagem"><Send size={17}/></button>
      </form>
    </section>
  );
}
