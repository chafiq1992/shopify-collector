import React, { useId, useMemo, useRef, useState } from "react";
import { Plus, Tag, X } from "lucide-react";
import { addTags, cleanTag, hasTag, rankTagSuggestions, splitTags, tagProblem } from "../lib/orderTags";

// Shopify-style tag field: typing lists matching store tags, Enter or a comma
// adds the typed tag, and chosen tags show as removable chips below the input.
export default function TagInput({
  value, onChange, suggestions = [], featured = [], disabled = false, loading = false,
  label = "Tags", name = "Tags", placeholder = "Find or create tags", hint, chipTone = "slate", inputClassName = "",
  autoFocus = false, openOnFocus = true, createLabel = "Add", createFirst = true,
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [problem, setProblem] = useState("");
  const inputRef = useRef(null);
  // Enter on an empty field only picks a suggestion the agent moved to.
  const navigated = useRef(false);
  const listId = useId();
  const typed = cleanTag(text.replace(/,/g, " "));
  const options = useMemo(() => {
    const ranked = rankTagSuggestions([...featured, ...suggestions], typed, value, 8);
    const existing = ranked.map((tag) => ({ tag }));
    if (!typed || hasTag(value, typed) || ranked.some((tag) => tag.toLowerCase() === typed.toLowerCase())) return existing;
    // Forms lead with the new tag; filters lead with tags orders already have.
    return createFirst ? [{ create: true, tag: typed }, ...existing] : [...existing, { create: true, tag: typed }];
  }, [featured, suggestions, typed, value, createFirst]);
  const highlighted = Math.min(active, Math.max(0, options.length - 1));

  function commit(values) {
    const tags = values.map(cleanTag).filter(Boolean);
    const invalid = tags.map(tagProblem).find(Boolean);
    if (invalid) { setProblem(invalid); return false; }
    setProblem("");
    onChange(addTags(value, tags));
    // Close the list so the chosen chips show; typing or a click reopens it.
    setText(""); setActive(0); setOpen(false);
    navigated.current = false;
    return true;
  }

  function onKeyDown(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      navigated.current = true;
      if (options.length) setActive((highlighted + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (open && options[highlighted] && (typed || navigated.current)) commit([options[highlighted].tag]);
      else if (typed) commit([typed]);
    } else if (event.key === "," && typed) {
      event.preventDefault();
      commit([typed]);
    } else if (event.key === "Escape" && open) {
      // Close only the suggestions, not the dialog around this field.
      event.stopPropagation();
      setOpen(false);
    }
  }

  function onPaste(event) {
    const pasted = event.clipboardData?.getData("text") || "";
    if (!pasted.includes(",")) return;
    event.preventDefault();
    commit(splitTags(`${text},${pasted}`));
  }

  const chip = chipTone === "rose" ? "bg-rose-50 text-rose-800 ring-rose-200" : "bg-slate-100 text-slate-800 ring-slate-200";
  return (
    <div className="block text-xs font-medium text-gray-700">
      {label && <label htmlFor={`${listId}-input`} className="mb-1 block">{label}</label>}
      <div className="relative">
        <Tag size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden />
        <input
          ref={inputRef}
          id={`${listId}-input`}
          aria-label={label ? undefined : name}
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-controls={listId}
          aria-activedescendant={open && options.length ? `${listId}-${highlighted}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          autoFocus={autoFocus}
          disabled={disabled}
          value={text}
          placeholder={placeholder}
          onChange={(event) => { setText(event.target.value); setOpen(true); setActive(0); setProblem(""); navigated.current = false; }}
          onFocus={() => { if (openOnFocus) setOpen(true); }}
          onClick={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className={`h-10 w-full rounded-lg border border-gray-300 bg-white pl-9 pr-3 text-sm font-normal outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 disabled:bg-gray-100 ${inputClassName}`}
        />
        {open && !disabled && (options.length > 0 || loading) && (
          <ul id={listId} role="listbox" aria-label={`${name} suggestions`} className="absolute inset-x-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
            {options.map((option, index) => (
              <li key={`${option.create ? "new" : "tag"}:${option.tag}`} id={`${listId}-${index}`} role="option" aria-selected={index === highlighted}
                onMouseDown={(event) => { event.preventDefault(); commit([option.tag]); inputRef.current?.focus(); }}
                onMouseEnter={() => setActive(index)}
                className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-normal ${index === highlighted ? "bg-indigo-50 text-indigo-900" : "text-gray-800"}`}>
                {option.create ? <><Plus size={14} className="shrink-0 text-indigo-600" aria-hidden /><span className="min-w-0 break-words">{createLabel} <strong className="font-semibold">{option.tag}</strong></span></> : <span className="min-w-0 break-words">{option.tag}</span>}
              </li>
            ))}
            {loading && !options.length && <li className="px-3 py-2 text-xs font-normal text-gray-500">Loading store tags…</li>}
          </ul>
        )}
      </div>
      {problem && <p role="alert" className="mt-1 text-xs font-normal text-rose-700">{problem}</p>}
      {hint && !problem && <p className="mt-1 text-[11px] font-normal text-gray-500">{hint}</p>}
      {value.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={`Chosen ${name.toLowerCase()}`}>
          {value.map((tag) => (
            <li key={tag} className={`inline-flex max-w-full items-center gap-1 rounded-md py-1 pl-2 pr-1 text-xs font-medium ring-1 ring-inset ${chip}`}>
              <span className="break-all">{tag}</span>
              <button type="button" disabled={disabled} onClick={() => onChange(value.filter((existing) => existing !== tag))} aria-label={`Remove tag ${tag}`} className="rounded p-0.5 opacity-70 hover:bg-black/5 hover:opacity-100 disabled:opacity-30"><X size={12} aria-hidden /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
