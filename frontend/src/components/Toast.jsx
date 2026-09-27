import React, { useEffect, useRef, useState } from "react";

// Lightweight toast notifications. No external deps — just position-fixed cards in the
// top-right, auto-dismissed after a TTL, dismissable by click.

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  const timersRef = useRef(new Map());

  function clearTimer(id) {
    const t = timersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
  }

  function dismiss(id) {
    clearTimer(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  function push(message, type = "info", ttl = 3000) {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    const timer = setTimeout(() => dismiss(id), Math.max(800, ttl));
    timersRef.current.set(id, timer);
    return id;
  }

  useEffect(() => () => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current.clear();
  }, []);

  return [toasts, push, dismiss];
}

const TOAST_STYLES = {
  success: { accent: "bg-emerald-500", icon: "bg-emerald-100 text-emerald-700", glyph: "✓" },
  error:   { accent: "bg-rose-500",    icon: "bg-rose-100 text-rose-700",       glyph: "!" },
  warn:    { accent: "bg-amber-500",   icon: "bg-amber-100 text-amber-700",     glyph: "!" },
  info:    { accent: "bg-indigo-500",  icon: "bg-indigo-100 text-indigo-700",   glyph: "i" },
};

export function ToastStack({ toasts, onDismiss }) {
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="fixed top-3 right-3 sm:top-4 sm:right-4 z-[80] flex flex-col items-end gap-2 pointer-events-none w-[min(24rem,calc(100vw-1.5rem))]"
    >
      {toasts.map((t) => {
        const style = TOAST_STYLES[t.type] || TOAST_STYLES.info;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onDismiss?.(t.id)}
            className="cf-toast pointer-events-auto relative w-full overflow-hidden text-left text-sm text-slate-800 bg-white/95 backdrop-blur rounded-xl shadow-lg shadow-slate-900/10 ring-1 ring-slate-900/5 pl-4 pr-3 py-2.5 flex items-center gap-2.5 active:scale-[0.98] transition-transform"
            title="Click to dismiss"
          >
            <span aria-hidden className={`absolute left-0 inset-y-0 w-1 ${style.accent}`} />
            <span
              aria-hidden
              className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold shrink-0 ${style.icon}`}
            >{style.glyph}</span>
            <span className="flex-1 leading-snug font-medium">{t.message}</span>
          </button>
        );
      })}
    </div>
  );
}
