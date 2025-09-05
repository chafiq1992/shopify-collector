// Simple client for your local Windows print receiver
const BASE = import.meta.env.VITE_LOCAL_PRINT_URL || "http://127.0.0.1:8787";
const SECRET = import.meta.env.VITE_LOCAL_PRINT_SECRET || "";

export type PrintOrdersResponse = {
  ok: boolean;
  results?: { order: string; printed: boolean }[];
  error?: string;
};

export async function printOrdersLocally(orderNames: string[], copies = 1): Promise<PrintOrdersResponse> {
  const orders = orderNames.map(n => String(n).replace(/^#/, ""));

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 6000);

  try {
    const r = await fetch(`${BASE}/print/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(SECRET ? { "x-secret": SECRET } : {})
      },
      body: JSON.stringify({ orders, copies }),
      mode: "cors",
      signal: ctrl.signal
    });
    clearTimeout(timeout);

    const data = await r.json();
    if (!r.ok) return { ok: false, error: data?.error || r.statusText };
    return { ok: true, results: data.results };
  } catch (err: any) {
    clearTimeout(timeout);
    return { ok: false, error: err?.name === "AbortError" ? "Local print agent timed out" : String(err) };
  }
}


