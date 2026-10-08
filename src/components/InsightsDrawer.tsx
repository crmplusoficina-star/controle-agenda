import { EyeOff, Lightbulb } from 'lucide-react';
import { Drawer } from './Drawer';
import type { Insight } from '../types';

function uniqueInsights(insights: Insight[]) {
  const seen = new Set<string>();
  return insights.filter((item) => {
    const key = `${item.title}|${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function InsightsDrawer({ open, insights, onClose, onFeedback, onHideAll }: { open: boolean; insights: Insight[]; onClose: () => void; onFeedback: (id: string, status: 'viewed'|'ignored'|'useful') => void; onHideAll: () => void }) {
  const items = uniqueInsights(insights);
  const hideAll = items.length > 0 && <button type="button" className="subtle-button insight-hide-all" onClick={onHideAll}><EyeOff size={15}/> Ocultar todas</button>;
  return <Drawer open={open} title="Insights" subtitle="Sugestões, não ordens. Se não houver nada útil, fica vazio." onClose={onClose} headerAction={hideAll} belowTopbar>
    <div className="insight-list">
      {items.length === 0
        ? <div className="empty-insights"><Lightbulb size={22}/><strong>Nenhum insight agora</strong><p>A IA não precisa inventar uma sugestão para justificar a existência dela.</p></div>
        : items.map((item) => {
          const aria = Boolean(item.fingerprint?.startsWith('pend|'));
          return <article className={`insight-item${aria ? ' insight-aria' : ''}`} key={item.id}>
            {aria && <img className="insight-aria-avatar" src="/aria/aria-insight.webp" alt="ArIA" />}
            <div className="insight-body">
              <div className="insight-type">{aria ? 'ArIA · oportunidade' : item.insight_type}</div>
              <h3>{item.title.replace(/^ArIA: /, '')}</h3>
              <p>{item.message}</p>
              <div className="insight-actions"><button onClick={() => onFeedback(item.id, 'useful')}>Útil</button><button onClick={() => onFeedback(item.id, 'ignored')}>Ignorar</button></div>
            </div>
          </article>;
        })}
    </div>
  </Drawer>;
}
