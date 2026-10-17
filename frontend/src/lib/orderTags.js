import { useEffect, useState } from "react";
import { authFetch } from "./auth.js";
import { isoToDDMMYY, todayDDMMYY, todayISO } from "./confirmationActions.js";

// Shopify rejects an order whose tags are longer than 40 characters, and a
// comma would split one tag into two.
export const TAG_MAX_LENGTH = 40;
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

export function cleanTag(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function splitTags(text) {
  return String(text ?? "").split(",").map(cleanTag).filter(Boolean);
}

export function tagProblem(tag) {
  return tag.length > TAG_MAX_LENGTH ? `"${tag.slice(0, 50)}" is longer than ${TAG_MAX_LENGTH} characters. Shorten it to add it.` : "";
}

export function hasTag(tags, tag) {
  const key = cleanTag(tag).toLowerCase();
  return tags.some((existing) => existing.toLowerCase() === key);
}

export function addTags(tags, values) {
  const next = [...tags];
  for (const value of values) if (value && !hasTag(next, value)) next.push(value);
  return next;
}

// Tags that start with the typed text come first, then tags with a word that
// starts with it, then tags containing it anywhere. Chosen tags are left out.
export function rankTagSuggestions(all, query, chosen = [], limit = 8) {
  const typed = cleanTag(query).toLowerCase();
  const pool = [];
  for (const tag of all) if (tag && !hasTag(chosen, tag) && !hasTag(pool, tag)) pool.push(tag);
  if (!typed) return pool.slice(0, limit);
  const starts = [], words = [], contains = [];
  for (const tag of pool) {
    const lower = tag.toLowerCase();
    if (lower.startsWith(typed)) starts.push(tag);
    else if (lower.split(/[\s_\-/.:]+/).some((word) => word.startsWith(typed))) words.push(tag);
    else if (lower.includes(typed)) contains.push(tag);
  }
  return [...starts, ...words, ...contains].slice(0, limit);
}

// Delivery-date tags agents add most often when confirming on the call.
export function codDateTags(now = new Date()) {
  return [`cod ${todayDDMMYY(now)}`, `cod ${isoToDDMMYY(todayISO(new Date(now.getTime() + 86_400_000)))}`];
}

export function fetchOrderTags(store) {
  const key = String(store || "").toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.promise;
  const promise = authFetch(`/api/agent/order-tags?${new URLSearchParams({ store })}`)
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Could not load tags (${res.status})`);
      return data.tags || [];
    });
  cache.set(key, { promise, expiresAt: Date.now() + CACHE_MS });
  promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
  return promise;
}

export function useOrderTags(store) {
  const [state, setState] = useState({ store, tags: [], loading: true, error: "" });
  useEffect(() => {
    let active = true;
    setState({ store, tags: [], loading: true, error: "" });
    fetchOrderTags(store)
      .then((tags) => { if (active) setState({ store, tags, loading: false, error: "" }); })
      .catch((error) => { if (active) setState({ store, tags: [], loading: false, error: error.message || "Could not load tags" }); });
    return () => { active = false; };
  }, [store]);
  return state.store === store ? state : { store, tags: [], loading: true, error: "" };
}
