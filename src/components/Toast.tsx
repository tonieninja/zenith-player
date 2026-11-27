import { memo, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { translations, type Language } from '../i18n';

export type ToastTone = 'info' | 'error' | 'success';

export interface ToastAction {
  label: string;
  labelKey?: string;
  onClick: () => void;
}

export interface ToastI18n {
  key: string;
  vars?: Record<string, string>;
}

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
  i18n?: ToastI18n;
}

type Listener = (items: ToastItem[]) => void;

let seq = 1;
let items: ToastItem[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(items);
}

const timers = new Map<number, { handle: number; left: number; at: number }>();

function dismiss(id: number) {
  window.clearTimeout(timers.get(id)?.handle);
  timers.delete(id);
  if (!items.some((t) => t.id === id)) return;
  items = items.filter((t) => t.id !== id);
  emit();
}

function arm(id: number, ms: number) {
  timers.set(id, { handle: window.setTimeout(() => dismiss(id), ms), left: ms, at: Date.now() });
}

// najechanie albo fokus zatrzymuje odliczanie, żeby dało się doczytać i kliknąć akcję
function hold(id: number) {
  const t = timers.get(id);
  if (!t?.handle) return;
  window.clearTimeout(t.handle);
  timers.set(id, { handle: 0, left: t.left - (Date.now() - t.at), at: 0 });
}

function resume(id: number) {
  const t = timers.get(id);
  if (t && !t.handle) arm(id, Math.max(t.left, 1500));
}

// ok. 70 ms na znak; błędy i toasty z akcją co najmniej 6 s
export function toastLifetime(message: string, tone: ToastTone, ms: number, action?: boolean) {
  return Math.max(ms, message.length * 70, tone === 'error' || action ? 6000 : 0);
}

export function pushToast(
  message: string,
  tone: ToastTone = 'info',
  ms = 3200,
  action?: ToastAction,
  i18n?: ToastI18n
) {
  if (!message || items.some((t) => t.message === message && t.tone === tone)) return;
  const id = seq++;
  items = [...items, { id, message, tone, action, i18n }].slice(-4);
  emit();
  arm(id, toastLifetime(message, tone, ms, Boolean(action)));
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

function fill(template: string, vars?: Record<string, string>): string {
  if (!vars) return template;
  return Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), template);
}

function toastText(item: ToastItem, lang: Language): string {
  if (!item.i18n) return item.message;
  const table = translations[lang] as Record<string, string>;
  const template = table[item.i18n.key];
  return template ? fill(template, item.i18n.vars) : item.message;
}

function actionLabel(action: ToastAction, lang: Language): string {
  if (!action.labelKey) return action.label;
  const table = translations[lang] as Record<string, string>;
  return table[action.labelKey] || action.label;
}

// region aria-live stoi cały czas; dodany razem z pierwszym komunikatem czytniki ekranu często pomijają
export const ToastHost = memo(function ToastHost({ lang = 'en' }: { lang?: Language }) {
  const list = useToasts();
  return (
    <div className="toast-host" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          className={`toast-item toast-${t.tone}`}
          role={t.tone === 'error' ? 'alert' : undefined}
          onMouseEnter={() => hold(t.id)}
          onMouseLeave={(e) => {
            if (!e.currentTarget.contains(document.activeElement)) resume(t.id);
          }}
          onFocus={() => hold(t.id)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resume(t.id);
          }}
        >
          <span className="toast-text">{toastText(t, lang)}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                dismiss(t.id);
                t.action?.onClick();
              }}
            >
              {actionLabel(t.action, lang)}
            </button>
          )}
          <button
            type="button"
            className="toast-close"
            aria-label={translations[lang].winClose}
            title={translations[lang].winClose}
            onClick={() => dismiss(t.id)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
});
