import { ArrowDown, ArrowUp, Check, Filter, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import '../features/retention.css';

export function foldText(value: string | null | undefined) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

const MENU_WIDTH = 248;

export function ColumnFilterHeader({ label, sortDirection, onSort, filter, setFilter, options, selected, setSelected }: {
  label: string;
  sortDirection: 'asc' | 'desc' | null;
  onSort: (direction: 'asc' | 'desc') => void;
  filter: string;
  setFilter: (value: string) => void;
  options: string[];
  selected: string[];
  setSelected: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const hasFilter = Boolean(filter || selected.length);
  const visibleOptions = options.filter((option) => !filter || foldText(option).includes(foldText(filter))).slice(0, 120);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const closeOnOutside = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close();
    };
    const closeOnScroll = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', closeOnOutside);
    window.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      window.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  function toggle() {
    if (!open && rootRef.current) {
      // posição fixa para o menu não ser cortado pelo overflow da tabela
      const rect = rootRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left - 8, window.innerWidth - MENU_WIDTH - 8));
      setStyle({ position: 'fixed', top: rect.bottom + 4, left, right: 'auto', margin: 0, width: MENU_WIDTH });
    }
    setOpen((value) => !value);
  }

  return <div className="retention-head-cell" ref={rootRef}>
    <button className={`column-head-button ${hasFilter ? 'has-filter' : ''}`} type="button" onClick={toggle}>
      <span>{label}</span>
      {sortDirection ? (sortDirection === 'asc' ? <ArrowUp size={13}/> : <ArrowDown size={13}/>) : <Filter size={13}/>}
      {selected.length > 0 && <b className="column-filter-count">{selected.length}</b>}
    </button>
    {open && <div className="column-menu" style={style}>
      <div className="column-menu-title">{label}</div>
      <div className="column-sort-actions">
        <button type="button" onClick={() => onSort('asc')}><ArrowUp size={14}/> A → Z</button>
        <button type="button" onClick={() => onSort('desc')}><ArrowDown size={14}/> Z → A</button>
      </div>
      <label className="column-filter-field"><span>Filtrar</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Digite para filtrar" autoFocus/></label>
      <div className="column-option-caption">Selecionar um ou mais</div>
      <div className="column-option-list">
        {visibleOptions.length ? visibleOptions.map((option) => {
          const checked = selected.includes(option);
          return <button type="button" className={checked ? 'selected' : ''} key={option} onClick={() => setSelected(checked ? selected.filter((item) => item !== option) : [...selected, option])}>
            <span className="column-option-check">{checked && <Check size={12}/>}</span><span>{option}</span>
          </button>;
        }) : <div className="column-option-empty">Nenhuma opção encontrada</div>}
      </div>
      <div className="column-filter-actions">
        <button className="clear-column-filter" type="button" onClick={() => { setFilter(''); setSelected([]); }}><X size={13}/> Limpar filtro</button>
        <button className="clear-column-filter" type="button" onClick={() => setOpen(false)}><Check size={13}/> Confirmar</button>
      </div>
    </div>}
  </div>;
}
