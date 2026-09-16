import { useEffect, useState } from 'react';

export type ToastTone = 'info' | 'error' | 'success';

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

type Listener = (items: ToastItem[]) => void;

let seq = 1;
let items: ToastItem[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(items);
}

export function pushToast(message: string, tone: ToastTone = 'info', ms = 3200) {
  const id = seq++;
  items = [...items, { id, message, tone }].slice(-4);
  emit();
  window.setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, ms);
}

export function useToasts() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}

export function ToastHost() {
  const list = useToasts();
  if (!list.length) return null;
  return (
    <div className="toast-host" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast-item toast-${t.tone}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
