import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

// Small, dependency-free motion helpers for list-heavy pages. Everything honours
// `prefers-reduced-motion` and uses the Web Animations API so React-managed
// classNames are never touched.

function reducedMotion() {
  try {
    return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

// Number that counts smoothly to its new value and gives a short "bump" when it
// changes, so agents notice a count moving without having to watch it.
export function AnimatedNumber({ value, duration = 500, className = "" }) {
  const target = Number(value) || 0;
  const [shown, setShown] = useState(target);
  const fromRef = useRef(target);
  const spanRef = useRef(null);

  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return undefined;
    fromRef.current = target;
    if (reducedMotion()) {
      setShown(target);
      return undefined;
    }
    try {
      spanRef.current?.animate(
        [{ transform: "scale(1)" }, { transform: "scale(1.14)" }, { transform: "scale(1)" }],
        { duration: 420, easing: EASE_OUT },
      );
    } catch {}
    let raf = 0;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(from + (target - from) * eased));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return (
    <span ref={spanRef} className={`inline-block tabular-nums ${className}`}>
      {shown}
    </span>
  );
}

// Keep rows that just left `items` on screen for `ms` so they can play an exit
// animation in place, instead of vanishing and making the list jump. Returns
// `[{ item, leaving }]`. A change of `resetKey` (new page, filter or store)
// means the list was replaced wholesale, so nothing lingers.
export function useDepartingList(items, getKey, { ms = 260, resetKey = "", maxDeparting = 12 } = {}) {
  const [, forceRender] = useState(0);
  const state = useRef({ prev: items, resetKey, departing: new Map() });
  const s = state.current;

  if (s.resetKey !== resetKey) {
    s.resetKey = resetKey;
    s.prev = items;
    s.departing = new Map();
  } else if (s.prev !== items) {
    const nextKeys = new Set(items.map(getKey));
    const gone = [];
    s.prev.forEach((item, index) => {
      const key = getKey(item);
      if (!nextKeys.has(key) && !s.departing.has(key)) gone.push({ key, item, index });
    });
    for (const key of [...s.departing.keys()]) {
      if (nextKeys.has(key)) s.departing.delete(key);
    }
    // A mass removal is a refresh, not something the agent did row by row.
    if (gone.length <= maxDeparting && !reducedMotion()) {
      const until = Date.now() + ms;
      for (const g of gone) s.departing.set(g.key, { item: g.item, index: g.index, until });
    }
    s.prev = items;
  }

  const pending = s.departing.size;
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setTimeout(() => {
      const now = Date.now();
      for (const [key, d] of s.departing) if (d.until <= now) s.departing.delete(key);
      forceRender((n) => n + 1);
    }, ms);
    return () => clearTimeout(timer);
  });

  const out = items.map((item) => ({ item, leaving: false }));
  [...s.departing.values()]
    .sort((a, b) => a.index - b.index)
    .forEach((d) => out.splice(Math.min(d.index, out.length), 0, { item: d.item, leaving: true }));
  return out;
}

// FLIP list animation: children marked with `data-flip-key` glide from their old
// position to the new one whenever the set of keys changes, and newly arrived
// rows fade in with a soft highlight. `resetKey` changes play a gentle staggered
// entrance instead (a new page or filter).
export function useFlipList(containerRef, keySignature, resetKey = "") {
  const positions = useRef(new Map());
  const lastSignature = useRef(null);
  const lastReset = useRef(resetKey);

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const rootTop = root.getBoundingClientRect().top;
    const nodes = root.querySelectorAll("[data-flip-key]");
    const next = new Map();
    const firstRun = lastSignature.current === null;
    // Nothing was on screen before (first load, or an empty list filling up):
    // that's an entrance, not "new rows arrived".
    const replaced = lastReset.current !== resetKey || positions.current.size === 0;
    const changed = lastSignature.current !== keySignature;
    const animate = !firstRun && changed && !reducedMotion();
    let entering = 0;

    nodes.forEach((node) => {
      const key = node.getAttribute("data-flip-key");
      const top = node.getBoundingClientRect().top - rootTop;
      next.set(key, top);
      if (!animate) return;
      const before = positions.current.get(key);
      try {
        if (replaced) {
          if (entering < 14) {
            node.animate(
              [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
              { duration: 260, delay: entering * 22, easing: EASE_OUT, fill: "backwards" },
            );
          }
          entering += 1;
        } else if (before == null) {
          node.animate(
            [
              { opacity: 0, transform: "translateY(-8px)", backgroundColor: "rgb(224 231 255)" },
              { opacity: 1, transform: "none", backgroundColor: "rgb(238 242 255)", offset: 0.35 },
              { opacity: 1, transform: "none" },
            ],
            { duration: 1400, easing: EASE_OUT },
          );
        } else if (Math.abs(before - top) > 1) {
          node.animate(
            [{ transform: `translateY(${before - top}px)` }, { transform: "none" }],
            { duration: 320, easing: EASE_OUT },
          );
        }
      } catch {}
    });

    positions.current = next;
    lastSignature.current = keySignature;
    lastReset.current = resetKey;
  });
}
