import React from "react";

function ProfilePickerModal({ profiles, current, onClose, onSelect }){
  const keys = Object.keys(profiles);
  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-lg border border-gray-200 p-4">
        <div className="flex items-center mb-3">
          <h2 className="text-lg font-semibold">Choose profile</h2>
          <button onClick={onClose} className="ml-auto text-sm text-gray-600 underline">Close</button>
        </div>
        <div className="space-y-2">
          {keys.map(k => {
            const p = profiles[k];
            const active = current && current.id === p.id;
            return (
              <button key={k} onClick={()=>onSelect(p)} className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl border ${active ? 'border-blue-600 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                <span className="inline-flex w-8 h-8 items-center justify-center rounded-full bg-blue-600 text-white text-sm font-semibold">{p.label.slice(0,1).toUpperCase()}</span>
                <div className="text-left">
                  <div className="text-sm font-semibold">{p.label}</div>
                  <div className="text-xs text-gray-500 truncate">Custom filter applied</div>
                </div>
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex justify-end">
          <button onClick={()=>onSelect(null)} className="px-3 py-1 rounded-xl border border-gray-300 text-sm">Use default view</button>
        </div>
      </div>
    </div>
  );
}

export default React.memo(ProfilePickerModal);


