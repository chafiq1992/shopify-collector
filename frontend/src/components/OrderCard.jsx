import React, { useEffect, useMemo, useRef, useState } from "react";
import { StickyNote, Image as ImageIcon, ClipboardList, ChevronRight, Check, Copy } from "lucide-react";
import { expandOrderUnits } from "../lib/orderUnits.js";

function tagPillClasses(tag) {
  const t = String(tag || '').toLowerCase();
  if (t === 'out') return 'bg-red-50 text-red-700 border-red-200';
  if (t === 'pc' || t === 'collected') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (['urgent', 'en att b'].includes(t)) return 'bg-amber-50 text-amber-800 border-amber-200';
  if (t === 'btis') return 'bg-violet-50 text-violet-700 border-violet-200';
  return 'bg-slate-50 text-slate-600 border-slate-200';
}

function OrderCard({ order, selectedOut, onToggleVariant, position, total, selectedForPrint, onToggleSelectOrder, onCopyProductId, onEditTag }) {
  const [pidModal, setPidModal] = useState(null);
  const pidInputRef = useRef(null);
  const pressTimerRef = useRef(null);
  const variants = useMemo(() => expandOrderUnits(order.variants || []).filter(v => v.status === 'unfulfilled'), [order.variants]);

  useEffect(() => () => clearTimeout(pressTimerRef.current), []);
  useEffect(() => {
    if (pidModal) { pidInputRef.current?.focus(); pidInputRef.current?.select(); }
  }, [pidModal]);

  function clearPress() { clearTimeout(pressTimerRef.current); }
  function startPress(pid) {
    clearPress();
    if (pid) pressTimerRef.current = setTimeout(() => setPidModal(pid), 520);
  }

  return (
    <section className={`min-w-0 overflow-hidden rounded-2xl border bg-white shadow-sm transition-colors ${selectedForPrint ? 'border-blue-300 ring-2 ring-blue-100' : 'border-slate-200'}`} aria-label={`Order ${order.number}`}>
      <div className="border-b border-slate-100 px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <label className="flex shrink-0 cursor-pointer items-center gap-2.5">
            <input aria-label={`Select order ${order.number}`} type="checkbox" className="h-5 w-5 rounded accent-blue-600" checked={!!selectedForPrint} onChange={onToggleSelectOrder} />
            <span className="text-base font-bold tracking-tight text-slate-900">{order.number}</span>
          </label>
          {order.customer && <span className="min-w-0 truncate text-sm text-slate-500" title={order.customer}>{order.customer}</span>}
          <span className="ml-auto shrink-0 rounded-md bg-slate-100 px-2 py-1 text-[11px] font-semibold tabular-nums text-slate-500">{position} / {total}</span>
        </div>
        {(order.tags || []).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1" aria-label="Order tags">
            {order.tags.map(tag => (
              <button type="button" key={tag} onClick={() => onEditTag?.(order, tag)} title={`Change tag ${tag}`} className={`max-w-full break-words rounded-md border px-2 py-1 text-[11px] font-medium leading-tight transition-colors hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 ${tagPillClasses(tag)}`}>{tag}</button>
            ))}
          </div>
        )}
      </div>

      <div className="px-3 pt-3 sm:px-4">
        <div className="mb-2 flex items-center justify-between text-[11px] text-slate-500">
          <span><span className="font-semibold text-slate-700">{variants.length}</span> item{variants.length === 1 ? '' : 's'} to collect</span>
          {variants.length > 1 && <span className="inline-flex items-center gap-1">Swipe to check each item <ChevronRight className="h-3 w-3" /></span>}
        </div>
        <div className="collector-items flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain pb-3" aria-label="Items to collect" tabIndex={0}>
          {variants.map((v, i) => {
            const selected = selectedOut.has(v.id);
            const pending = v.pending_purchase_orders || [];
            return (
              <article key={v.displayKey} className={`collector-item min-w-0 shrink-0 snap-start overflow-hidden rounded-xl border ${selected ? 'border-red-400 ring-2 ring-inset ring-red-100' : 'border-slate-200'}`}>
                <div className="relative aspect-[4/5] overflow-hidden bg-slate-50 sm:aspect-[4/3]" style={{ WebkitTouchCallout: 'none', userSelect: 'none' }} onContextMenu={e => e.preventDefault()} onPointerDown={() => startPress(v.product_id)} onPointerUp={clearPress} onPointerLeave={clearPress} onPointerCancel={clearPress} onPointerMove={clearPress}>
                  {v.image ? <img src={v.image} alt={v.title || v.sku || 'Product'} loading={i === 0 ? 'eager' : 'lazy'} decoding="async" draggable={false} className="h-full w-full object-contain" /> : <div className="flex h-full items-center justify-center text-slate-300"><ImageIcon className="h-12 w-12" /></div>}
                  <div className="pointer-events-none absolute left-2 top-2 flex max-w-[calc(100%-1rem)] flex-col items-start gap-1">
                    {pending.length > 0 && <span title={`Pending purchase order: ${pending.map(po => po.number).join(', ')}`} className="pointer-events-auto inline-flex max-w-full items-center gap-1 rounded-md border border-amber-200 bg-amber-50/95 px-2 py-1 text-[10px] font-bold text-amber-900 shadow-sm"><ClipboardList className="h-3.5 w-3.5 shrink-0" /><span className="truncate">Pending PO{pending.length > 1 ? ` · ${pending.length}` : ''}</span></span>}
                    {typeof v.on_hand_quantity === 'number' && <span className="rounded-md bg-slate-900/80 px-2 py-1 text-[10px] font-semibold text-white shadow-sm">On hand: {v.on_hand_quantity}</span>}
                  </div>
                </div>
                <div className="space-y-2 p-2.5">
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="min-w-0 break-all rounded-md border border-amber-200 bg-amber-50 px-2 py-1 font-mono text-xs font-bold text-amber-900">{v.sku || 'No SKU'}</span>
                    <span className="shrink-0 text-[10px] font-semibold tabular-nums text-slate-500">{v.unitCount > 1 ? `Item ${v.unitIndex + 1} / ${v.unitCount}` : '1 item'}</span>
                  </div>
                  <p className="min-h-[2rem] break-words text-xs leading-4 text-slate-600">{v.title || 'Product'}</p>
                  <div className="flex items-center gap-2 border-t border-slate-100 pt-2">
                    <button type="button" onClick={() => onToggleVariant(v.id)} aria-pressed={selected} title="OUT selection applies to this order line" className={`inline-flex min-h-8 flex-1 items-center justify-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold ${selected ? 'border-red-600 bg-red-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-red-300 hover:text-red-700'}`}>{selected && <Check className="h-3 w-3" />}{selected ? 'Selected OUT' : 'Select OUT'}</button>
                    {v.product_id && <button type="button" aria-label="Copy product ID" title="Copy product ID" onClick={() => setPidModal(v.product_id)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><Copy className="h-3.5 w-3.5" /></button>}
                  </div>
                </div>
              </article>
            );
          })}
          {variants.length === 0 && <p className="py-8 text-sm text-slate-500">No unfulfilled items in this order.</p>}
        </div>
      </div>

      <div className="flex min-w-0 items-start gap-2 border-t border-slate-100 bg-slate-50/70 px-3 py-2.5 text-xs text-slate-500 sm:px-4">
        <StickyNote className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p className="min-w-0 break-words leading-5">{order.shipping_city && <span className="mr-2 font-semibold text-slate-700">{order.shipping_city}</span>}{order.note || 'No notes'}</p>
      </div>

      {pidModal && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label="Copy product ID" onKeyDown={e => { if (e.key === 'Escape') setPidModal(null); }}>
        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
          <h2 className="font-semibold text-slate-900">Copy product ID</h2>
          <div className="mt-3 flex gap-2"><input ref={pidInputRef} readOnly value={String(pidModal)} className="min-w-0 flex-1 select-text rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-sm" /><button type="button" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white" onClick={() => { onCopyProductId?.(pidModal); setPidModal(null); }}>Copy</button></div>
          <div className="mt-3 flex justify-end"><button type="button" className="rounded-lg border px-4 py-2 text-sm" onClick={() => setPidModal(null)}>Close</button></div>
        </div>
      </div>}
    </section>
  );
}

export default React.memo(OrderCard);

