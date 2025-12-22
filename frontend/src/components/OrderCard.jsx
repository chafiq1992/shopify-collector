import React, { useEffect, useRef, useState } from "react";
import { StickyNote, Image as ImageIcon } from "lucide-react";

function tagPillClasses(tag){
  const t = String(tag || '').toLowerCase();
  if (t === 'out') return 'bg-red-100 text-red-700 ring-red-200';
  if (t === 'pc' || t === 'collected') return 'bg-green-100 text-green-700 ring-green-200';
  if (t === 'urgent') return 'bg-amber-100 text-amber-700 ring-amber-200';
  if (t === 'btis') return 'bg-purple-100 text-purple-700 ring-purple-200';
  if (t === 'en att b') return 'bg-amber-100 text-amber-700 ring-amber-200';
  return 'bg-gray-100 text-gray-700 ring-gray-200';
}

function OrderCard({ order, selectedOut, onToggleVariant, onMarkCollected, onMarkOut, onPrev, onNext, position, total, selectedForPrint, onToggleSelectOrder, onCopyProductId }){
  const [pidModal, setPidModal] = useState({ open: false, pid: null });
  const pidInputRef = useRef(null);
  const pressTimerRef = useRef(null);

  useEffect(() => {
    if (!pidModal?.open) return;
    try {
      const t = setTimeout(() => {
        try { pidInputRef.current?.focus?.(); } catch {}
        try { pidInputRef.current?.select?.(); } catch {}
      }, 0);
      return () => clearTimeout(t);
    } catch {}
  }, [pidModal?.open]);

  function clearPress(){
    try { if (pressTimerRef.current) clearTimeout(pressTimerRef.current); } catch {}
    pressTimerRef.current = null;
  }

  function startPress(pid){
    try { if (pressTimerRef.current) clearTimeout(pressTimerRef.current); } catch {}
    pressTimerRef.current = setTimeout(() => {
      setPidModal({ open: true, pid });
      pressTimerRef.current = null;
    }, 520);
  }

  return (
    <div className="rounded-2xl shadow-sm border border-gray-200 bg-white overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-gray-50">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" className="w-4 h-4 accent-blue-600" checked={!!selectedForPrint} onChange={onToggleSelectOrder} />
          <span className="text-sm font-semibold">{order.number}</span>
        </label>
        {order.customer && <span className="text-sm text-gray-500">· {order.customer}</span>}
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {(order.tags || []).map(t => (
            <span key={t} className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ring-1 ring-inset ${tagPillClasses(t)}`}>{t}</span>
          ))}
        </div>
      </div>

      <div className="p-3">
        <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-2">
          {(() => {
            const normalizedVariants = (order.variants || []).map(v => {
              const rawStatus = (v.status ?? '').toString();
              const statusLower = rawStatus.toLowerCase();
              const normalizedStatus = statusLower.includes('removed')
                ? 'removed'
                : statusLower.includes('unfulfilled')
                  ? 'unfulfilled'
                  : statusLower.includes('fulfilled')
                    ? 'fulfilled'
                    : (rawStatus ? statusLower : '');
              const normalizedLabel = normalizedStatus
                ? normalizedStatus.slice(0,1).toUpperCase() + normalizedStatus.slice(1)
                : '';
              return { ...v, __normalizedStatus: normalizedStatus, __normalizedLabel: normalizedLabel };
            });
            const variantsForDisplay = normalizedVariants.filter(v => v.__normalizedStatus === 'unfulfilled');
            return variantsForDisplay.map((v, i) => {
              const pid = v.product_id;
              return (
              <div key={v.id || i} className={`min-w-[210px] sm:min-w-[240px] snap-start group relative rounded-2xl overflow-hidden border ${selectedOut.has(v.id) ? "border-red-500 ring-2 ring-red-300" : "border-gray-200"}`}>
                <div
                  className="aspect-[3/2] sm:aspect-[4/3] bg-gray-100 flex items-center justify-center overflow-hidden"
                  style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" }}
                  onContextMenu={(e)=>{ try { e.preventDefault(); } catch {} }}
                  onMouseDown={(e)=>{ if (!pid) return; try { e.preventDefault(); } catch {}; startPress(pid); }}
                  onMouseUp={clearPress}
                  onMouseLeave={clearPress}
                  onTouchStart={(e)=>{ if (!pid) return; try { e.preventDefault(); } catch {}; startPress(pid); }}
                  onTouchEnd={clearPress}
                  onTouchCancel={clearPress}
                >
                  {v.image ? (
                    <img src={v.image} alt={v.sku || ""} loading="lazy" className="w-full h-full object-cover" />
                  ) : (
                    <div className="flex items-center justify-center w-full h-full text-gray-400"><ImageIcon className="w-8 h-8"/></div>
                  )}
                </div>
                {v.__normalizedStatus && (
                  <div className="absolute top-2 left-2 flex flex-col gap-1">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium shadow
                      ${v.__normalizedStatus === 'fulfilled' ? 'bg-green-600 text-white' : v.__normalizedStatus === 'removed' ? 'bg-gray-500 text-white' : v.__normalizedStatus === 'unfulfilled' ? 'bg-amber-500 text-white' : 'bg-gray-200 text-gray-800'}`}
                    >{v.__normalizedLabel}</span>
                    {typeof v.inventory_quantity === "number" && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium shadow bg-black/70 text-white backdrop-blur">
                        On hand: {v.inventory_quantity}
                      </span>
                    )}
                  </div>
                )}
                <div className="p-1.5 flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wide text-gray-500">SKU</span>
                  <span className="font-mono text-[11px] bg-gray-50 px-2 py-0.5 rounded border border-gray-200">{v.sku}</span>
                  {v.title && <span className="text-[11px] text-gray-700 flex-1 whitespace-normal break-words">· {v.title}</span>}
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-gray-500">Qty</span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-red-600 text-white text-xs font-semibold">{v.qty}</span>
                </div>
                <button
                  onClick={()=>onToggleVariant(v.id)}
                  className={`absolute top-2 right-2 px-2 py-1 rounded-full text-xs font-medium shadow ${selectedOut.has(v.id) ? "bg-red-600 text-white" : "bg-white text-gray-800"}`}
                  aria-pressed={selectedOut.has(v.id)}
                  title={selectedOut.has(v.id) ? "Selected as OUT" : "Mark this variant as missing"}
                >
                  {selectedOut.has(v.id) ? "OUT" : "Select OUT"}
                </button>
              </div>
              );
            });
          })()}
        </div>
      </div>

      {pidModal?.open && (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-lg border border-gray-200 p-4">
            <div className="text-sm font-semibold text-gray-900">Copy Product ID</div>
            <div className="text-xs text-gray-500 mt-1">Tap “Copy” (works on iPhone Safari). You can also select the text.</div>
            <div className="mt-3 flex gap-2">
              <input
                ref={pidInputRef}
                readOnly
                value={pidModal.pid ? String(pidModal.pid) : ""}
                className="flex-1 font-mono text-sm border border-gray-300 rounded-lg px-3 py-2 bg-gray-50 select-text"
              />
              <button
                type="button"
                className="shrink-0 px-4 py-2 rounded-lg bg-gray-900 text-white text-sm font-semibold active:scale-[.98] touch-manipulation"
                onClick={()=>{ try { onCopyProductId && onCopyProductId(pidModal.pid); } catch {}; setPidModal({ open: false, pid: null }); }}
              >
                Copy
              </button>
            </div>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-50"
                onClick={()=>setPidModal({ open: false, pid: null })}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="px-3 pb-2 flex items-center gap-2 text-xs text-gray-600">
        <StickyNote className="w-4 h-4"/>
        {order.shipping_city && <span>{order.shipping_city}</span>}
        <span className="truncate">{order.note || "No notes"}</span>
        <span className="ml-auto inline-flex items-center px-2 py-0.5 rounded-full bg-blue-600 text-white text-[11px] font-semibold">
          {position}/{total}
        </span>
      </div>
    </div>
  );
}

export default React.memo(OrderCard);


