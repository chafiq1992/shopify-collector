// Prefer explicit env; else use current origin so production Cloud Run works without extra config
import { authHeaders } from './auth';

const RELAY_BASE = (import.meta.env.VITE_PRINT_RELAY_URL as string) || (typeof window !== 'undefined' ? window.location.origin : "");

function getRelayApiKey(): string {
  const fromEnv = (import.meta.env.VITE_PRINT_RELAY_API_KEY as string) || "";
  if (fromEnv) return fromEnv;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem('relayApiKey') || "";
    }
  } catch {}
  return "";
}

const API_KEY = getRelayApiKey();
function getRelayPcId(): string {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const fromLs = window.localStorage.getItem('relayPcId');
      if (fromLs) return fromLs;
    }
  } catch {}
  return (import.meta.env.VITE_PRINT_RELAY_PC_ID as string) || 'pc-lab-1';
}

const DEFAULT_PC_ID = getRelayPcId();

export type EnqueueResponse = { ok: boolean; job_id?: string; queued?: number; error?: string };

type PublicConfig = { relayUrl?: string; relayApiKey?: string; relayPcId?: string };
let cachedConfig: PublicConfig | null = null;

async function getRelayConfig(): Promise<{ base: string; apiKey: string; pcId: string }>{
  // Start with env + localStorage fallbacks
  let base = RELAY_BASE || "";
  let apiKey = API_KEY || "";
  let pcId = DEFAULT_PC_ID || "";

  if (!cachedConfig) {
    try {
      const r = await fetch('/app-config.json', { cache: 'no-store' });
      if (r.ok) {
        cachedConfig = await r.json();
        // Optionally persist into localStorage for future loads
        try {
          if (cachedConfig?.relayApiKey) localStorage.setItem('relayApiKey', cachedConfig.relayApiKey);
          if (cachedConfig?.relayPcId) localStorage.setItem('relayPcId', cachedConfig.relayPcId);
        } catch {}
      } else {
        cachedConfig = {};
      }
    } catch { cachedConfig = {}; }
  }

  if (!base && cachedConfig?.relayUrl) base = cachedConfig.relayUrl;
  if (!apiKey && cachedConfig?.relayApiKey) apiKey = cachedConfig.relayApiKey;
  if (!pcId && cachedConfig?.relayPcId) pcId = cachedConfig.relayPcId;

  return { base, apiKey, pcId };
}

export async function enqueueOrdersToRelay(orders: string[], copies = 1, pcId?: string, store?: string): Promise<EnqueueResponse> {
  const cfg = await getRelayConfig();
  if (!cfg.base) return { ok: false, error: "Relay URL not configured" };
  const pc_id = pcId || cfg.pcId;
  if (!pc_id) return { ok: false, error: "pc_id not configured" };

  try {
    const body = JSON.stringify({ pc_id, orders, copies, ...(store ? { store } : {}) });

    // Prefer the authenticated app route so logged-in users do not depend on a browser-saved relay API key.
    const r = await fetch(`${cfg.base}/api/enqueue-orders`, {
      method: "POST",
      headers: {
        ...authHeaders({ "Content-Type": "application/json" }),
        ...(cfg.apiKey ? { "x-api-key": cfg.apiKey } : {}),
      },
      body,
      mode: "cors",
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, job_id: data.job_id, queued: data.queued };

    // Back-compat fallback for older backends that do not expose /api/enqueue-orders yet.
    const legacy = await fetch(`${cfg.base}/enqueue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { "x-api-key": cfg.apiKey } : {}),
      },
      body,
      mode: "cors",
    });
    const legacyData = await legacy.json().catch(() => ({}));
    if (!legacy.ok) return { ok: false, error: legacyData?.detail || data?.detail || legacy.statusText || r.statusText };
    return { ok: true, job_id: legacyData.job_id, queued: legacyData.queued };
  } catch (err: any) {
    return { ok: false, error: String(err) };
  }
}

export async function enqueueLabelToRelay(deliveryOrderId: string, store?: string): Promise<EnqueueResponse> {
  const cfg = await getRelayConfig();
  if (!cfg.base) return { ok: false, error: "Relay URL not configured" };

  try {
    const r = await fetch(`${cfg.base}/api/enqueue-label`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { "x-api-key": cfg.apiKey } : {}),
      },
      body: JSON.stringify({
        delivery_order_id: String(deliveryOrderId),
        ...(store ? { store } : {}),
      }),
      mode: "cors",
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: data?.detail || r.statusText };
    return { ok: true, job_id: data.job_id, queued: data.queued };
  } catch (err: any) {
    return { ok: false, error: String(err) };
  }
}

export function isRelayConfigured(): boolean {
  return !!RELAY_BASE;
}


