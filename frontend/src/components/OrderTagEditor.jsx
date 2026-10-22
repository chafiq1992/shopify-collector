import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Tag, X } from 'lucide-react';
import { authFetch, authHeaders } from '../lib/auth';

export default function OrderTagEditor({ order, tag, store, suggestions = [], onSaved, onReconciled, onClose }) {
  const dialogRef = useRef(null);
  const [value, setValue] = useState(tag);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false);
  useEffect(() => { dialogRef.current?.showModal(); }, []);

  async function save(event) {
    event.preventDefault();
    if (savingRef.current) return;
    const next = value.trim();
    if (!next || next.toLowerCase() === tag.toLowerCase() || next.includes(',') || next.length > 40) return;
    savingRef.current = true;
    setBusy(true);
    setError('');
    try {
      const res = await authFetch(`/api/orders/${encodeURIComponent(order.id)}/replace-tag?store=${encodeURIComponent(store)}`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ old_tag: tag, new_tag: next, source: 'collector' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        if (Array.isArray(data.tags)) onReconciled?.(order.id, data.tags);
        throw new Error(typeof data.detail === 'string' ? data.detail : `Could not change tag (${res.status}). Please retry.`);
      }
      onSaved(order.id, tag, next, data);
      onClose();
    } catch (err) {
      setError(err.message || 'Could not change tag. Please retry.');
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }

  const options = [...new Set(suggestions)].filter(t => t.toLowerCase() !== tag.toLowerCase() && t.length <= 40);
  return createPortal(
    <dialog ref={dialogRef} aria-labelledby="tag-editor-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }} className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-900/40">
      <form onSubmit={save} className="p-5">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-blue-50 p-2 text-blue-600"><Tag className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1"><h2 id="tag-editor-title" className="font-bold">Change order tag</h2><p className="mt-0.5 text-xs text-slate-500">Order {order.number}</p></div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close tag editor" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-40"><X className="h-5 w-5" /></button>
        </div>
        <p className="mt-4 break-words text-sm text-slate-500">Current tag: <span className="font-semibold text-slate-700">{tag}</span></p>
        <label htmlFor="replacement-tag" className="mb-1 mt-4 block text-xs font-semibold text-slate-700">New tag</label>
        <input autoFocus id="replacement-tag" list="collector-tag-options" value={value} onChange={e => setValue(e.target.value)} disabled={busy} maxLength={40} required className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-base outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
        <datalist id="collector-tag-options">{options.map(t => <option key={t} value={t} />)}</datalist>
        {value.includes(',') && <p className="mt-2 text-xs text-amber-700">Enter one tag without commas.</p>}
        {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className="min-h-11 rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold">Cancel</button><button disabled={busy || !value.trim() || value.trim().toLowerCase() === tag.toLowerCase() || value.includes(',')} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy && <Loader2 className="h-4 w-4 animate-spin" />}{busy ? 'Saving…' : 'Save tag'}</button></div>
      </form>
    </dialog>, document.body,
  );
}
