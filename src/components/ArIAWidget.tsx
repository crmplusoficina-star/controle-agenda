import { useRef, useState } from 'react';
import { Bot, GripHorizontal, Maximize2, Minimize2, Send, X } from 'lucide-react';
import './aria-widget.css';

export function ArIAWidget() {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState('');
  const [position, setPosition] = useState({ x: 22, y: 22 });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('button,input,textarea')) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: position.x, originY: position.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextX = Math.max(8, Math.min(window.innerWidth - 80, drag.originX - (event.clientX - drag.startX)));
    const nextY = Math.max(8, Math.min(window.innerHeight - 80, drag.originY - (event.clientY - drag.startY)));
    setPosition({ x: nextX, y: nextY });
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setText('');
  }

  if (!open) {
    return (
      <button className="aria-orb" style={{ right: position.x, bottom: position.y }} onClick={() => setOpen(true)} aria-label="Abrir ArIA">
        <Bot size={20} />
        <span>ArIA</span>
      </button>
    );
  }

  return (
    <section
      className={`aria-widget ${expanded ? 'expanded' : ''}`}
      style={{ right: position.x, bottom: position.y }}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <header className="aria-head">
        <div className="aria-title"><span className="aria-avatar"><Bot size={18}/></span><div><strong>ArIA</strong><small>Assistente · Groq</small></div></div>
        <div className="aria-actions">
          <button type="button" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? 'Reduzir ArIA' : 'Expandir ArIA'}>{expanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button>
          <button type="button" onClick={() => setOpen(false)} aria-label="Fechar ArIA"><X size={16}/></button>
        </div>
      </header>
      <div className="aria-drag-hint"><GripHorizontal size={15}/> arraste pelo topo</div>
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
