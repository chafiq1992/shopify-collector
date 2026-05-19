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

function paletteFor(type) {
  switch (type) {
    case "success": return "bg-emerald-600 border-emerald-700";
    case "error":   return "bg-rose-600 border-rose-700";
    case "warn":    return "bg-amber-500 border-amber-600";
    default:        return "bg-slate-800 border-slate-900";
  }
}

function iconFor(type) {
  switch (type) {
    case "success": return "✓";
    case "error":   return "!";
    case "warn":    return "!";
    default:        return "•";
  }
}

export function ToastStack({ toasts, onDismiss }) {
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="fixed top-4 right-4 z-[60] flex flex-col gap-2 pointer-events-none max-w-[calc(100vw-2rem)]"
    >
      <style>{`@keyframes toastIn{from{opacity:0;transform:translateY(-6px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}.confirmation-toast{animation:toastIn .18s ease-out both}`}</style>
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onDismiss?.(t.id)}
          className={`confirmation-toast pointer-events-auto cursor-pointer text-left text-white text-sm px-3 py-2 rounded-lg shadow-lg border ${paletteFor(t.type)} max-w-sm flex items-center gap-2 active:scale-[0.98] transition-transform`}
          title="Click to dismiss"
        >
          <span
            aria-hidden
            className={`inline-flex items-center justify-center w-5 h-5 rounded-full bg-white/20 text-[11px] font-bold shrink-0`}
          >{iconFor(t.type)}</span>
          <span className="flex-1 leading-tight">{t.message}</span>
        </button>
      ))}
    </div>
  );
}
