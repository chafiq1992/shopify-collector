import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { StickyNote, Image as ImageIcon, ClipboardList, ChevronRight, Check, Copy, X } from 'lucide-react';
import { expandOrderUnits } from '../lib/orderUnits.js';

function tagTone(tag) {
  const value = String(tag).toLowerCase();
  if (value === 'out') return 'is-danger';
  if (['pc', 'collected'].includes(value)) return 'is-success';
  if (['urgent', 'en att b'].includes(value)) return 'is-warning';
  return '';
}

function DetailsDialog({ title, children, onClose }) {
  const dialogRef = useRef(null);
  useEffect(() => { dialogRef.current?.showModal(); }, []);
  return createPortal(
    <dialog ref={dialogRef} className="collector-details" aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}>
      <div className="collector-details-heading"><h2>{title}</h2><button type="button" aria-label="Close details" onClick={onClose}><X size={16} /></button></div>
      {children}
    </dialog>, document.body,
  );
}

function OrderCard({ order, selectedOut, onToggleVariant, position, total, selectedForPrint, onToggleSelectOrder, onCopyProductId, onEditTag }) {
  const [pidModal, setPidModal] = useState(null);
  const [details, setDetails] = useState(null);
  const pidInputRef = useRef(null);
  const pressTimerRef = useRef(null);
  const variants = useMemo(() => expandOrderUnits(order.variants || []).filter(variant => variant.status === 'unfulfilled'), [order.variants]);
  const tags = order.tags || [];
  useEffect(() => () => clearTimeout(pressTimerRef.current), []);
  useEffect(() => { if (pidModal) { pidInputRef.current?.focus(); pidInputRef.current?.select(); } }, [pidModal]);
  function clearPress() { clearTimeout(pressTimerRef.current); }
  function startPress(pid) { clearPress(); if (pid) pressTimerRef.current = setTimeout(() => setPidModal(pid), 520); }
  function editTag(tag) { setDetails(null); onEditTag?.(order, tag); }

  return (
    <section className={`collector-order${selectedForPrint ? ' is-selected' : ''}`} aria-label={`Order ${order.number}`}>
      <div className="collector-order-heading">
        <div className="collector-order-identity">
          <label><input aria-label={`Select order ${order.number}`} type="checkbox" checked={!!selectedForPrint} onChange={onToggleSelectOrder} /><strong>{order.number}</strong></label>
          <span className="collector-customer" title={order.customer}>{order.customer}</span>
          <span className="collector-position">{position}<span> / {total}</span></span>
        </div>
        {tags.length > 0 && <div className="collector-order-tags" aria-label="Order tags">
          {tags.slice(0, 4).map(tag => <button type="button" key={tag} className={`collector-tag ${tagTone(tag)}`} title={`Change tag ${tag}`} onClick={() => editTag(tag)}>{tag}</button>)}
          {tags.length > 4 && <button type="button" className="collector-tag" onClick={() => setDetails('tags')}>+{tags.length - 4} tags</button>}
        </div>}
      </div>

      <div className="collector-gallery">
        <div className="collector-gallery-caption"><span>{variants.length} item{variants.length === 1 ? '' : 's'}</span>{variants.length > 1 && <span>Swipe items <ChevronRight size={11} /></span>}</div>
        <div className="collector-items" aria-label="Items to collect" tabIndex={0}>
          {variants.map((variant, index) => {
            const selected = selectedOut.has(variant.id);
            const pending = variant.pending_purchase_orders || [];
            return (
              <article key={variant.displayKey} className={`collector-item${selected ? ' is-out' : ''}`}>
                <div className="collector-photo" onContextMenu={event => event.preventDefault()} onPointerDown={() => startPress(variant.product_id)} onPointerUp={clearPress} onPointerLeave={clearPress} onPointerCancel={clearPress} onPointerMove={clearPress}>
                  {variant.image ? <img src={variant.image} alt={variant.title || variant.sku || 'Product'} loading={index === 0 ? 'eager' : 'lazy'} decoding="async" draggable={false} /> : <ImageIcon className="collector-image-placeholder" />}
                  <div className="collector-stock-badges">
                    {pending.length > 0 && <span className="collector-po" title={`Pending purchase order: ${pending.map(po => po.number).join(', ')}`}><ClipboardList size={11} /> Pending PO{pending.length > 1 ? ` · ${pending.length}` : ''}</span>}
                    {typeof variant.on_hand_quantity === 'number' && <span className="collector-stock">On hand <b>{variant.on_hand_quantity}</b></span>}
                  </div>
                </div>
                <div className="collector-item-info">
                  <div className="collector-sku-row"><button type="button" className="collector-sku-details" aria-label={`View details for ${variant.sku || 'this item'}`} onClick={() => setDetails({ variant })}><strong title={variant.sku}>{variant.sku || 'No SKU'}</strong></button><span>{variant.unitCount > 1 ? `${variant.unitIndex + 1} of ${variant.unitCount}` : '1 item'}</span>{variant.product_id && <button type="button" aria-label="Copy product ID" title="Copy product ID" onClick={() => setPidModal(variant.product_id)}><Copy size={12} /></button>}</div>
                  <div className="collector-variant-row"><button type="button" className="collector-variant-details" title={variant.title} onClick={() => setDetails({ variant })}>{variant.title || 'Product'}</button><button type="button" className={`collector-out-toggle${selected ? ' is-active' : ''}`} onClick={() => onToggleVariant(variant.id)} aria-pressed={selected} title="OUT selection applies to this order line">{selected && <Check size={11} />}OUT</button></div>
                </div>
              </article>
            );
          })}
          {variants.length === 0 && <p className="collector-empty">No unfulfilled items in this order.</p>}
        </div>
      </div>

      <button type="button" className="collector-note" aria-label="Read order note" onClick={() => setDetails('note')}><StickyNote size={12} />{order.shipping_city && <b>{order.shipping_city}</b>}<span>{order.note || 'No notes'}</span><ChevronRight size={12} /></button>
      {details && <DetailsDialog title={details === 'tags' ? `Order ${order.number} · Tags` : details === 'note' ? `Order ${order.number} · Note` : 'Variant details'} onClose={() => setDetails(null)}>{details === 'tags' ? <div className="collector-all-tags">{tags.map(tag => <button type="button" key={tag} className={`collector-tag ${tagTone(tag)}`} onClick={() => editTag(tag)}>{tag}</button>)}</div> : details === 'note' ? <p className="collector-full-note">{order.shipping_city && <b>{order.shipping_city}<br /></b>}{order.note || 'No notes'}</p> : <dl className="collector-variant-facts">
        <dt>SKU</dt><dd>{details.variant.sku || 'No SKU'}</dd>
        {details.variant.product_title && <><dt>Product</dt><dd>{details.variant.product_title}</dd></>}
        <dt>Variant</dt><dd>{details.variant.title || 'Product'}</dd>
        {details.variant.color && <><dt>Color</dt><dd>{details.variant.color}</dd></>}
        {details.variant.size && <><dt>Size</dt><dd>{details.variant.size}</dd></>}
        <dt>Item</dt><dd>{details.variant.unitIndex + 1} of {details.variant.unitCount}</dd>
      </dl>}</DetailsDialog>}
      {pidModal && <DetailsDialog title="Copy product ID" onClose={() => setPidModal(null)}><div className="collector-copy-row"><input aria-label="Product ID" ref={pidInputRef} readOnly value={String(pidModal)} /><button type="button" onClick={() => { onCopyProductId?.(pidModal); setPidModal(null); }}>Copy</button></div></DetailsDialog>}
    </section>
  );
}

export default React.memo(OrderCard);
