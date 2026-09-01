import { ArrowLeft, ArrowRight, Check, FastForward, Bot } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../session';
import { useEmbeddedImages } from '../lib/ariaImages';
import exp1 from '../tutorial/exp1';
import exp2 from '../tutorial/exp2';
import exp3 from '../tutorial/exp3';
import exp4 from '../tutorial/exp4';
import { supabase } from '../lib/supabase';
import './tutorial.css';

type TutorialStep = {
  title: string;
  text: string;
  screen?: 'agenda' | 'retencao-lista' | 'retencao-mapa' | 'followup-ativo' | 'followup-agenda' | 'followup-historico';
};

const embeddedImages = [exp1, exp2, exp3, exp4] as const;

const steps: TutorialStep[] = [
  { title: 'Boas-vindas', text: 'Olá, [nome]! Eu sou a ArIA e vou te auxiliar na programação dos atendimentos, com rotas, ideias e outras informações importantes.' },
  { title: 'Tela de Agenda', text: 'Esta é a sua agenda de atendimentos. Aqui, você organiza seu cronograma e pode alternar entre as visões semanal e mensal, além de visualizar suas filiais e demais unidades.', screen: 'agenda' },
  { title: 'Agenda · filiais e técnicos', text: 'Você também pode selecionar outras filiais, adicionar um técnico já cadastrado ou cadastrar um novo técnico.', screen: 'agenda' },
  { title: 'Tela de Retenção', text: 'Aqui você consulta o histórico de atendimentos dos últimos 5 anos. Cada círculo e cor representa o período desde o último atendimento, conforme indicado na legenda. Clique em um ícone para visualizar os clientes daquele período.', screen: 'retencao-lista' },
  { title: 'Filtros da Retenção', text: 'Nas colunas, você pode aplicar filtros, selecionar mais de um item, digitar para pesquisar, confirmar a seleção ou limpar o filtro.', screen: 'retencao-lista' },
  { title: 'Visualização por mapa', text: 'Você também pode visualizar essas informações pelo mapa.', screen: 'retencao-mapa' },
  { title: 'Mapa de Retenção', text: 'No canto superior, a legenda mostra o significado de cada ícone e cor exibidos no mapa.', screen: 'retencao-mapa' },
  { title: 'Rotas dos técnicos', text: 'Cada agendamento também aparece no mapa, de acordo com a localização cadastrada do cliente. A rota do técnico será exibida e, ao passar o cursor sobre o trajeto, você poderá visualizar a distância em quilômetros e o tempo estimado entre um cliente e outro.', screen: 'retencao-mapa' },
  { title: 'Corrigir localização', text: 'Caso a localização cadastrada não corresponda à realidade, você pode ativar o modo de edição e arrastar o cliente para a posição correta. Depois, é possível desfazer, cancelar ou confirmar a alteração.', screen: 'retencao-mapa' },
  { title: 'Registrar contato pelo mapa', text: 'Pelo mapa, clique no ícone do cliente e depois em Follow-up. Não é necessário preencher nenhuma informação nesse momento: basta salvar para adicionar o cliente à sua lista de prospecção.', screen: 'retencao-mapa' },
  { title: 'Registrar contato pela lista', text: 'Você também pode voltar para a visualização em lista e pesquisar pelo nome do cliente ou pela cidade. Depois, clique em Criar tratativa e salve para adicionar o cliente aos contatos de prospecção.', screen: 'retencao-lista' },
  { title: 'Tela de Follow-up', text: 'Na aba Em andamento, você encontra os clientes selecionados para prospecção por meio da opção Criar tratativa.', screen: 'followup-ativo' },
  { title: 'Etapa da oportunidade', text: 'Na coluna Etapa, você visualiza o status atual de cada oportunidade. Clique sobre o status para acessar os detalhes da oportunidade.', screen: 'followup-ativo' },
  { title: 'Atualizações da oportunidade', text: 'Os status são atualizados automaticamente conforme as informações são preenchidas. Você também pode adicionar observações e informar o valor da oportunidade.', screen: 'followup-ativo' },
  { title: 'Programar o próximo contato', text: 'Também é possível organizar uma agenda para entrar em contato com o cliente ou programar futuras visitas.', screen: 'followup-ativo' },
  { title: 'Agenda de Follow-up', text: 'Aqui você visualiza os clientes e as datas programadas para contato ou visita. Também pode adicionar informações e lembretes.', screen: 'followup-agenda' },
  { title: 'Histórico de vendas', text: 'Após uma oportunidade ser marcada como Venda ganha ou Venda perdida, ela é enviada automaticamente para o Histórico de vendas, onde você poderá consultar e filtrar as informações.', screen: 'followup-historico' },
  { title: 'Ajuda da ArIA', text: 'Sempre que tiver alguma dúvida, clique no ícone da ArIA e fale comigo. Posso explicar novamente uma funcionalidade ou te levar diretamente até ela.' },
];

function clickButton(text: string, scope?: string) {
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return false;
  const buttons = Array.from(root.querySelectorAll('button')) as HTMLButtonElement[];
  const button = buttons.find((item) => item.textContent?.replace(/\s+/g, ' ').trim() === text)
    || buttons.find((item) => item.textContent?.replace(/\s+/g, ' ').trim().includes(text));
  if (!button) return false;
  button.click();
  return true;
}

function navigateTo(screen?: TutorialStep['screen']) {
  if (!screen) return;
  if (screen === 'agenda') {
    clickButton('Agenda', '.sidebar');
    return;
  }
  if (screen === 'retencao-lista' || screen === 'retencao-mapa') {
    clickButton('Retenção', '.sidebar');
    window.setTimeout(() => clickButton(screen === 'retencao-mapa' ? 'Mapa' : 'Lista', '.list-page'), 180);
    return;
  }
  clickButton('Follow-up', '.sidebar');
  window.setTimeout(() => {
    if (screen === 'followup-agenda') clickButton('Agenda', '.followup-workspace');
    else if (screen === 'followup-historico') clickButton('Histórico de vendas', '.followup-workspace');
    else clickButton('Em andamento', '.followup-workspace');
  }, 180);
}

export function TutorialOverlay() {
  const { user } = useSession();
  const images = useEmbeddedImages(embeddedImages);
  const storageKey = useMemo(() => `agenda-tecnica:tutorial-complete:v1:${user.matricula}`, [user.matricula]);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [failedImages, setFailedImages] = useState<Record<number, boolean>>({});

  useEffect(() => {
    const restart = () => {
      setIndex(0);
      setOpen(true);
    };
    window.addEventListener('aria:tutorial:start', restart);

    let cancelled = false;
    async function checkSeen() {
      const localSeen = window.localStorage.getItem(storageKey) === '1';
      if (localSeen) return;
      const { data } = await supabase.from('aria_user_state').select('tutorial_completed_at,tutorial_skipped_at').eq('matricula', user.matricula).maybeSingle();
      if (cancelled) return;
      if (data?.tutorial_completed_at || data?.tutorial_skipped_at) {
        window.localStorage.setItem(storageKey, '1');
        return;
      }
      window.setTimeout(() => {
        if (!cancelled) {
          setIndex(0);
          setOpen(true);
        }
      }, 650);
    }
    checkSeen();

    return () => {
      cancelled = true;
      window.removeEventListener('aria:tutorial:start', restart);
    };
  }, [storageKey, user.matricula]);

  useEffect(() => {
    if (open) navigateTo(steps[index]?.screen);
  }, [open, index]);

  if (!open) return null;
  const step = steps[index];
  const last = index === steps.length - 1;
  const first = index === 0;
  const text = step.text.replace('[nome]', user.name.split(' ')[0] || user.name);
  const imageIndex = index % images.length;

  async function persistFinished(skipped: boolean) {
    window.localStorage.setItem(storageKey, '1');
    const now = new Date().toISOString();
    await supabase.from('aria_user_state').upsert({
      matricula: user.matricula,
      tutorial_completed_at: skipped ? null : now,
      tutorial_skipped_at: skipped ? now : null,
      updated_at: now,
    }, { onConflict: 'matricula' });
  }

  async function finish(skipped = false) {
    setOpen(false);
    await persistFinished(skipped);
  }

  function repeat() {
    setIndex(0);
    navigateTo(steps[0].screen);
  }

  return <div className="tutorial-layer" role="dialog" aria-modal="true" aria-label="Tutorial da Agenda Técnica">
    <div className="tutorial-dim" />
    <section className={`tutorial-card tutorial-pos-${index % 3}`}>
      <div className="tutorial-aria-side">
        {!failedImages[imageIndex]
          ? <img src={images[imageIndex]} alt="ArIA" onError={() => setFailedImages((current) => ({ ...current, [imageIndex]: true }))} />
          : <div className="tutorial-aria-fallback"><Bot size={34}/><strong>ArIA</strong></div>}
        <span>ArIA</span>
      </div>
      <div className="tutorial-copy">
        <div className="tutorial-topline"><span>Passo {index + 1} de {steps.length}</span><button type="button" onClick={() => finish(true)}><FastForward size={14}/> Pular tutorial</button></div>
        <h2>{step.title}</h2>
        <p>{text}</p>
        <div className="tutorial-progress"><i style={{ width: `${((index + 1) / steps.length) * 100}%` }} /></div>
        <div className="tutorial-actions">
          {!first && !last && <button type="button" className="tutorial-secondary" onClick={() => setIndex((value) => Math.max(0, value - 1))}><ArrowLeft size={15}/> Voltar</button>}
          {!last && <button type="button" className="tutorial-primary" onClick={() => setIndex((value) => Math.min(steps.length - 1, value + 1))}>Avançar <ArrowRight size={15}/></button>}
          {last && <>
            <button type="button" className="tutorial-secondary" onClick={repeat}><ArrowLeft size={15}/> Repetir tutorial</button>
            <button type="button" className="tutorial-primary" onClick={() => finish(false)}><Check size={15}/> Finalizar tutorial</button>
          </>}
        </div>
      </div>
    </section>
  </div>;
}
