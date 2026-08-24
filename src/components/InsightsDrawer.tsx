import { Lightbulb } from 'lucide-react';
import { Drawer } from './Drawer';
import type { Insight } from '../types';

export function InsightsDrawer({ open, insights, onClose, onFeedback }: { open: boolean; insights: Insight[]; onClose: () => void; onFeedback: (id: string, status: 'viewed'|'ignored'|'useful') => void }) {
  return <Drawer open={open} title="Insights" subtitle="Sugestões, não ordens. Se não houver nada útil, fica vazio." onClose={onClose}><div className="insight-list">{insights.length === 0 ? <div className="empty-insights"><Lightbulb size={22}/><strong>Nenhum insight agora</strong><p>A IA não precisa inventar uma sugestão para justificar a existência dela.</p></div> : insights.map((item) => <article className="insight-item" key={item.id}><div className="insight-type">{item.insight_type}</div><h3>{item.title}</h3><p>{item.message}</p><div className="insight-actions"><button onClick={() => onFeedback(item.id, 'useful')}>Útil</button><button onClick={() => onFeedback(item.id, 'ignored')}>Ignorar</button></div></article>)}</div></Drawer>;
}
