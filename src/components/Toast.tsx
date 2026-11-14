import { useEffect, useState } from 'react';
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

function dismiss(id: number) {
  if (!items.some((t) => t.id === id)) return;
  items = items.filter((t) => t.id !== id);
  emit();
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

export function ToastHost({ lang = 'en' }: { lang?: Language }) {
  const list = useToasts();
  if (!list.length) return null;
  return (
    <div className="toast-host" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast-item toast-${t.tone}`}>
          <span>{toastText(t, lang)}</span>
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
        </div>
      ))}
    </div>
  );
}
