import { Check, ChevronDown, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

type Item = { value: string; label: string };

export function CheckboxMultiSelect({
  label,
  items,
  selected,
  onChange,
  allLabel = 'Todos',
  compact = false,
}: {
  label?: string;
  items: Item[];
  selected: string[];
  onChange: (values: string[]) => void;
  allLabel?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const summary = useMemo(() => {
    if (!selected.length) return allLabel;
    if (selected.length === 1) return items.find((item) => item.value === selected[0])?.label || selected[0];
    return `${selected.length} selecionados`;
  }, [allLabel, items, selected]);

  function toggle(value: string) {
    if (selected.includes(value)) onChange(selected.filter((item) => item !== value));
    else onChange([...selected, value]);
  }

  return <div className={`multi-select ${compact ? 'compact' : ''}`} ref={rootRef}>
    <button type="button" className="multi-select-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      {label && <span>{label}</span>}
      <strong>{summary}</strong>
      <ChevronDown size={15}/>
    </button>
    {open && <div className="multi-select-menu">
      <div className="multi-select-menu-head">
        <strong>{label || 'Filtrar'}</strong>
        {selected.length > 0 && <button type="button" onClick={() => onChange([])}><X size={13}/> Limpar</button>}
      </div>
      <button type="button" className={`multi-select-option all ${selected.length === 0 ? 'selected' : ''}`} onClick={() => onChange([])}>
        <span className="check-box">{selected.length === 0 && <Check size={12}/>}</span>
        <span>{allLabel}</span>
      </button>
      <div className="multi-select-options">
        {items.map((item) => {
          const checked = selected.includes(item.value);
          return <button type="button" className={`multi-select-option ${checked ? 'selected' : ''}`} key={item.value} onClick={() => toggle(item.value)}>
            <span className="check-box">{checked && <Check size={12}/>}</span>
            <span>{item.label}</span>
          </button>;
        })}
      </div>
    </div>}
  </div>;
}
