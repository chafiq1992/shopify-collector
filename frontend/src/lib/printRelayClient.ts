// Prefer explicit env; else use current origin so production Cloud Run works without extra config
const RELAY_BASE = (import.meta.env.VITE_PRINT_RELAY_URL as string) || (typeof window !== 'undefined' ? window.location.origin : "");
const API_KEY = import.meta.env.VITE_PRINT_RELAY_API_KEY || "";
const DEFAULT_PC_ID = import.meta.env.VITE_PRINT_RELAY_PC_ID || "";

export type EnqueueResponse = { ok: boolean; job_id?: string; queued?: number; error?: string };

export async function enqueueOrdersToRelay(orders: string[], copies = 1, pcId?: string): Promise<EnqueueResponse> {
  if (!RELAY_BASE) return { ok: false, error: "Relay URL not configured" };
  const pc_id = pcId || DEFAULT_PC_ID;
  if (!pc_id) return { ok: false, error: "pc_id not configured" };

  try {
    const r = await fetch(`${RELAY_BASE}/enqueue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { "x-api-key": API_KEY } : {}),
      },
      body: JSON.stringify({ pc_id, orders, copies }),
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


