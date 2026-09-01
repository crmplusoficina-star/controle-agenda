import { ArrowLeft, ArrowRight, Check, FastForward, Bot } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../session';
import { supabase } from '../lib/supabase';
import './tutorial.css';

type TutorialTarget = { selector: string };
type TutorialStep = { title: string; text: string; target?: TutorialTarget; action?: string };
type TargetRect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

const images = ['/aria/aria-1.png','/aria/aria-2.png','/aria/aria-3.png','/aria/aria-4.png'] as const;
const steps: TutorialStep[] = [
  { title: 'Boas-vindas', text: 'Olá, [nome]! Eu sou a ArIA e vou te auxiliar na programação dos atendimentos, com rotas, ideias e outras informações importantes.' },
  { title: 'Tela de Agenda', text: 'Esta é a sua agenda de atendimentos. Aqui, você organiza seu cronograma e pode alternar entre as visões semanal e mensal, além de visualizar suas filiais e demais unidades.', target: { selector: '[data-tutorial="nav-agenda"]' }, action: 'Clique em Agenda no menu lateral para continuar.' },
  { title: 'Agenda · filiais e técnicos', text: 'Você também pode selecionar outras filiais, adicionar um técnico já cadastrado ou cadastrar um novo técnico.' },
  { title: 'Tela de Retenção', text: 'Aqui você consulta o histórico de atendimentos dos últimos 5 anos. Cada círculo e cor representa o período desde o último atendimento, conforme indicado na legenda.', target: { selector: '[data-tutorial="nav-retencao"]' }, action: 'Agora clique em Retenção no menu lateral.' },
  { title: 'Filtros da Retenção', text: 'Nas colunas, você pode aplicar filtros, selecionar mais de um item, digitar para pesquisar, confirmar a seleção ou limpar o filtro.', target: { selector: '.retention-head-cell:first-child .column-head-button' }, action: 'Clique no cabeçalho Cliente para abrir um filtro.' },
  { title: 'Visualização por mapa', text: 'Você também pode visualizar essas informações pelo mapa.', target: { selector: '.retention-view-switch button:nth-child(2)' }, action: 'Clique em Mapa para trocar a visualização.' },
  { title: 'Mapa de Retenção', text: 'No canto superior, a legenda mostra o significado de cada ícone e cor exibidos no mapa.' },
  { title: 'Rotas dos técnicos', text: 'Cada agendamento também aparece no mapa, de acordo com a localização cadastrada do cliente. A rota do técnico será exibida e, ao passar o cursor sobre o trajeto, você poderá visualizar a distância em quilômetros e o tempo estimado entre um cliente e outro.' },
  { title: 'Corrigir localização', text: 'Caso a localização cadastrada não corresponda à realidade, você pode ativar o modo de edição e arrastar o cliente para a posição correta. Depois, é possível desfazer, cancelar ou confirmar a alteração.' },
  { title: 'Registrar contato pelo mapa', text: 'Pelo mapa, clique no ícone do cliente e depois em Follow-up. Não é necessário preencher nenhuma informação nesse momento: basta salvar para adicionar o cliente à sua lista de prospecção.' },
  { title: 'Registrar contato pela lista', text: 'Você também pode voltar para a visualização em lista e pesquisar pelo nome do cliente ou pela cidade. Depois, clique em Criar tratativa e salve para adicionar o cliente aos contatos de prospecção.', target: { selector: '.retention-view-switch button:nth-child(1)' }, action: 'Clique em Lista para voltar aos clientes.' },
  { title: 'Tela de Follow-up', text: 'Na aba Em andamento, você encontra os clientes selecionados para prospecção por meio da opção Criar tratativa.', target: { selector: '[data-tutorial="nav-followup"]' }, action: 'Clique em Follow-up no menu lateral.' },
  { title: 'Etapa da oportunidade', text: 'Na coluna Etapa, você visualiza o status atual de cada oportunidade. Clique sobre o status para acessar os detalhes da oportunidade.' },
  { title: 'Atualizações da oportunidade', text: 'Os status são atualizados automaticamente conforme as informações são preenchidas. Você também pode adicionar observações e informar o valor da oportunidade.' },
  { title: 'Programar o próximo contato', text: 'Também é possível organizar uma agenda para entrar em contato com o cliente ou programar futuras visitas.' },
  { title: 'Agenda de Follow-up', text: 'Aqui você visualiza os clientes e as datas programadas para contato ou visita. Também pode adicionar informações e lembretes.', target: { selector: '.followup-tabs button:nth-child(2)' }, action: 'Clique em Agenda para ver os próximos contatos.' },
  { title: 'Histórico de vendas', text: 'Após uma oportunidade ser marcada como Venda ganha ou Venda perdida, ela é enviada automaticamente para o Histórico de vendas, onde você poderá consultar e filtrar as informações.', target: { selector: '.followup-tabs button:nth-child(3)' }, action: 'Clique em Histórico de vendas para conhecer essa área.' },
  { title: 'Ajuda da ArIA', text: 'Sempre que tiver alguma dúvida, clique no ícone da ArIA e fale comigo. Posso explicar novamente uma funcionalidade ou te levar diretamente até ela.' },
];

function resolveTarget(target?: TutorialTarget) {
  return target ? document.querySelector(target.selector) as HTMLElement | null : null;
}
function rectFor(element: HTMLElement): TargetRect {
  const rect = element.getBoundingClientRect();
  const padding = 7;
  const left = Math.max(8, rect.left - padding);
  const top = Math.max(8, rect.top - padding);
  const right = Math.min(window.innerWidth - 8, rect.right + padding);
  const bottom = Math.min(window.innerHeight - 8, rect.bottom + padding);
  return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
function sameRect(a: TargetRect | null, b: TargetRect) {
  return Boolean(a && Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1);
}
function randomImagePlan() { return steps.map(() => Math.floor(Math.random() * images.length)); }
function guidedCardStyle(rect: TargetRect | null) {
  if (!rect || typeof window === 'undefined') return undefined;
  const targetOnRight = rect.left + rect.width / 2 > window.innerWidth / 2;
  const targetOnBottom = rect.top + rect.height / 2 > window.innerHeight / 2;
  return {
    left: targetOnRight ? 24 : 'auto',
    right: targetOnRight ? 'auto' : 24,
    top: targetOnBottom ? 24 : 'auto',
    bottom: targetOnBottom ? 'auto' : 24,
    transform: 'none',
  } as const;
}

const blockerStyle = { position: 'absolute' as const, zIndex: 0, background: 'rgba(15,23,42,.5)', backdropFilter: 'blur(1px)', pointerEvents: 'auto' as const };

export function TutorialOverlay() {
  const { user } = useSession();
  const storageKey = useMemo(() => `agenda-tecnica:tutorial-complete:v1:${user.matricula}`, [user.matricula]);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [failedImages, setFailedImages] = useState<Record<number, boolean>>({});
  const [imagePlan, setImagePlan] = useState<number[]>(randomImagePlan);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [targetMissing, setTargetMissing] = useState(false);

  useEffect(() => {
    const restart = () => { setIndex(0); setImagePlan(randomImagePlan()); setOpen(true); };
    window.addEventListener('aria:tutorial:start', restart);
    let cancelled = false;
    async function checkSeen() {
      const localSeen = window.localStorage.getItem(storageKey) === '1';
      if (localSeen) return;
      const { data } = await supabase.from('aria_user_state').select('tutorial_completed_at,tutorial_skipped_at').eq('matricula', user.matricula).maybeSingle();
      if (cancelled) return;
      if (data?.tutorial_completed_at || data?.tutorial_skipped_at) { window.localStorage.setItem(storageKey, '1'); return; }
      window.setTimeout(() => { if (!cancelled) { setIndex(0); setImagePlan(randomImagePlan()); setOpen(true); } }, 650);
    }
    void checkSeen();
    return () => { cancelled = true; window.removeEventListener('aria:tutorial:start', restart); };
  }, [storageKey, user.matricula]);

  const step = steps[index];

  useEffect(() => {
    if (!open || !step?.target) { setTargetRect(null); setTargetMissing(false); return; }
    let currentTarget: HTMLElement | null = null;
    let scrolled = false;
    let advancing = false;
    setTargetRect(null);
    setTargetMissing(false);

    const syncTarget = () => {
      const next = resolveTarget(step.target);
      if (next !== currentTarget) { currentTarget = next; scrolled = false; }
      if (!currentTarget) return;
      if (!scrolled) { currentTarget.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); scrolled = true; }
      const nextRect = rectFor(currentTarget);
      setTargetRect((current) => sameRect(current, nextRect) ? current : nextRect);
      setTargetMissing(false);
    };

    const captureClick = (event: MouseEvent) => {
      const target = resolveTarget(step.target);
      const clicked = event.target as Node | null;
      if (!target || !clicked || advancing) return;
      if (clicked === target || target.contains(clicked)) {
        advancing = true;
        window.setTimeout(() => setIndex((value) => Math.min(steps.length - 1, value + 1)), 140);
      }
    };

    syncTarget();
    document.addEventListener('click', captureClick, true);
    const interval = window.setInterval(syncTarget, 100);
    const missingTimer = window.setTimeout(() => { if (!resolveTarget(step.target)) setTargetMissing(true); }, 2500);
    return () => {
      document.removeEventListener('click', captureClick, true);
      window.clearInterval(interval);
      window.clearTimeout(missingTimer);
    };
  }, [open, index, step]);

  if (!open) return null;
  const last = index === steps.length - 1;
  const first = index === 0;
  const guided = Boolean(step.target);
  const text = step.text.replace('[nome]', user.name.split(' ')[0] || user.name);
  const imageIndex = imagePlan[index] ?? 0;

  async function persistFinished(skipped: boolean) {
    window.localStorage.setItem(storageKey, '1');
    const now = new Date().toISOString();
    await supabase.from('aria_user_state').upsert({ matricula: user.matricula, tutorial_completed_at: skipped ? null : now, tutorial_skipped_at: skipped ? now : null, updated_at: now }, { onConflict: 'matricula' });
  }
  async function finish(skipped = false) { setOpen(false); await persistFinished(skipped); }
  function repeat() { setIndex(0); setImagePlan(randomImagePlan()); }
  function manualAdvance() { setIndex((value) => Math.min(steps.length - 1, value + 1)); }

  return <div className={`tutorial-layer ${guided ? 'tutorial-guided' : ''}`} role="dialog" aria-modal="true" aria-label="Tutorial da Agenda Técnica">
    {guided && targetRect ? <>
      <div style={{ ...blockerStyle, left: 0, top: 0, right: 0, height: targetRect.top }} />
      <div style={{ ...blockerStyle, left: 0, top: targetRect.bottom, right: 0, bottom: 0 }} />
      <div style={{ ...blockerStyle, left: 0, top: targetRect.top, width: targetRect.left, height: targetRect.height }} />
      <div style={{ ...blockerStyle, left: targetRect.right, top: targetRect.top, right: 0, height: targetRect.height }} />
      <div style={{ position: 'absolute', zIndex: 1, left: targetRect.left, top: targetRect.top, width: targetRect.width, height: targetRect.height, border: '3px solid #0b63f6', borderRadius: 12, boxShadow: '0 0 0 5px rgba(11,99,246,.18), 0 12px 34px rgba(15,23,42,.24)', pointerEvents: 'none' }} />
    </> : <div className="tutorial-dim" />}

    <section className={`tutorial-card ${guided ? 'tutorial-card-guided' : `tutorial-pos-${index % 3}`}`} style={guided ? guidedCardStyle(targetRect) : undefined}>
      <div className="tutorial-aria-side">
        {!failedImages[imageIndex] ? <img src={images[imageIndex]} alt="ArIA" onError={() => setFailedImages((current) => ({ ...current, [imageIndex]: true }))} /> : <div className="tutorial-aria-fallback"><Bot size={34}/><strong>ArIA</strong></div>}
        <span>ArIA</span>
      </div>
      <div className="tutorial-copy">
        <div className="tutorial-topline"><span>Passo {index + 1} de {steps.length}</span><button type="button" onClick={() => finish(true)}><FastForward size={14}/> Pular tutorial</button></div>
        <h2>{step.title}</h2>
        <p>{text}</p>
        {guided && <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 15, padding: '11px 12px', border: `1px solid ${targetMissing ? '#fde68a' : '#bfdbfe'}`, borderRadius: 12, background: targetMissing ? '#fffbeb' : '#eff6ff', color: targetMissing ? '#92400e' : '#1e3a8a' }}>
          <ArrowRight size={16}/><div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}><strong style={{ fontSize: 13, lineHeight: 1.35 }}>{step.action}</strong><span style={{ fontSize: 11, lineHeight: 1.4, color: '#64748b' }}>{targetMissing ? 'Não encontrei esse controle nesta tela. Você pode continuar manualmente.' : 'O tutorial avança automaticamente depois do clique.'}</span></div>
        </div>}
        <div className="tutorial-progress"><i style={{ width: `${((index + 1) / steps.length) * 100}%` }} /></div>
        <div className="tutorial-actions">
          {!first && !last && <button type="button" className="tutorial-secondary" onClick={() => setIndex((value) => Math.max(0, value - 1))}><ArrowLeft size={15}/> Voltar</button>}
          {!last && (!guided || targetMissing) && <button type="button" className="tutorial-primary" onClick={manualAdvance}>{guided ? 'Continuar' : 'Avançar'} <ArrowRight size={15}/></button>}
          {last && <><button type="button" className="tutorial-secondary" onClick={repeat}><ArrowLeft size={15}/> Repetir tutorial</button><button type="button" className="tutorial-primary" onClick={() => finish(false)}><Check size={15}/> Finalizar tutorial</button></>}
        </div>
      </div>
    </section>
  </div>;
}
