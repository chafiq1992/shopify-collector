import React, { useEffect, useId, useRef } from "react";
import { CUSTOMER_FIELD_LABELS } from "../lib/requiredOrderCustomer";

export default function RequiredCustomerNotice({ missing, onCorrect }) {
  const button = useRef(null);
  const title = useId();
  const description = useId();
  useEffect(() => {
    button.current?.focus();
    const onKey = (event) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === "Escape") button.current?.click();
        else button.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/50 p-4" onMouseDown={(event) => event.stopPropagation()}>
    <div role="alertdialog" aria-modal="true" aria-labelledby={title} aria-describedby={description} className="w-full max-w-md rounded-2xl border border-rose-200 bg-white p-5 shadow-2xl">
      <h2 id={title} className="text-base font-bold text-rose-800">Customer information required</h2>
      <div id={description} className="mt-2 text-sm text-slate-700">
        <p>The order has not been created. Complete the highlighted fields:</p>
        <ul className="mt-3 list-disc space-y-1 pl-5">{Object.keys(missing).filter((key) => missing[key]).map((key) => <li key={key}>{CUSTOMER_FIELD_LABELS[key]}</li>)}</ul>
        <p className="mt-3 text-xs text-slate-500">One customer name and one shipping address are enough. A second name and apartment details are optional.</p>
      </div>
      <button ref={button} type="button" onClick={onCorrect} className="mt-5 h-11 w-full rounded-xl bg-rose-700 px-4 text-sm font-semibold text-white hover:bg-rose-800">Correct customer information</button>
    </div>
  </div>;
}
