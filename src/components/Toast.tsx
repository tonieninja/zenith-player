import { useEffect, useState } from 'react';

export type ToastTone = 'info' | 'error' | 'success';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
}

type Listener = (items: ToastItem[]) => void;

let seq = 1;
let items: ToastItem[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(items);
}

function dismiss(id: number) {
  if (!items.some((t) => t.id === id)) return;
  items = items.filter((t) => t.id !== id);
  emit();
}

export function pushToast(
  message: string,
  tone: ToastTone = 'info',
  ms = 3200,
  action?: ToastAction
) {
  // the same message already on screen (eg. several failed skips in a row): don't stack it
  if (!message || items.some((t) => t.message === message && t.tone === tone)) return;
  const id = seq++;
  items = [...items, { id, message, tone, action }].slice(-4);
  emit();
  window.setTimeout(() => dismiss(id), action ? Math.max(ms, 6000) : ms);
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
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                dismiss(t.id);
                t.action?.onClick();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
