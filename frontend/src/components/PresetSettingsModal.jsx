import React, { useState } from "react";

function PresetSettingsModal({ preset, onClose, onSave }){
  const [local, setLocal] = useState(preset);
  const [relayApiKey, setRelayApiKey] = useState(() => {
    try { return localStorage.getItem('relayApiKey') || '' } catch { return '' }
  });
  const [relayPcId, setRelayPcId] = useState(() => {
    try { return localStorage.getItem('relayPcId') || '' } catch { return '' }
  });
  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-lg border border-gray-200 p-4">
        <div className="flex items-center mb-3">
          <h2 className="text-lg font-semibold">Preset Settings</h2>
          <button onClick={onClose} className="ml-auto text-sm text-gray-600 underline">Close</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-gray-700 mb-1">Collect: Tag prefix before date</label>
            <input value={local.collectPrefix} onChange={(e)=>setLocal({...local, collectPrefix: e.target.value})} className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
            <p className="text-xs text-gray-500 mt-1">Resulting tag: "{local.collectPrefix || 'cod'} DD/MM/YY"</p>
          </div>
          <div>
            <label className="block text-sm text-gray-700 mb-1">Collect: Exclude tag</label>
            <input value={local.collectExcludeTag} onChange={(e)=>setLocal({...local, collectExcludeTag: e.target.value})} className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
          </div>
          <div>
            <label className="block text-sm text-gray-700 mb-1">Verification: Include tag</label>
            <input value={local.verificationIncludeTag} onChange={(e)=>setLocal({...local, verificationIncludeTag: e.target.value})} className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
          </div>
          <div className="pt-2 border-t border-gray-200">
            <label className="block text-sm font-semibold text-gray-800 mb-1">Relay settings (browser only)</label>
            <label className="block text-xs text-gray-600 mb-1">API Key</label>
            <input value={relayApiKey} onChange={(e)=>setRelayApiKey(e.target.value)} placeholder="Set to your Cloud Run API_KEY" className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
            <label className="block text-xs text-gray-600 mt-2 mb-1">PC ID</label>
            <input value={relayPcId} onChange={(e)=>setRelayPcId(e.target.value)} placeholder="pc-lab-1" className="w-full border border-gray-300 rounded px-2 py-1 text-sm" />
            <p className="text-xs text-gray-500 mt-1">Saved privately in this browser. Used if app wasn’t rebuilt with keys.</p>
          </div>
        </div>
        <div className="mt-4 flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-1 rounded border text-sm">Cancel</button>
          <button onClick={() => { try { localStorage.setItem('relayApiKey', relayApiKey || ''); localStorage.setItem('relayPcId', relayPcId || ''); } catch {} onSave(local); }} className="px-3 py-1 rounded bg-blue-600 text-white text-sm">Save</button>
        </div>
      </div>
    </div>
  );
}

export default React.memo(PresetSettingsModal);


