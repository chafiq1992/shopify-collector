// Simple client for your local Windows print receiver
import { createPrintRequestId, sendLocalOrders } from './printSubmission.js';
const BASE = import.meta.env.VITE_LOCAL_PRINT_URL || "http://127.0.0.1:8787";
const SECRET = import.meta.env.VITE_LOCAL_PRINT_SECRET || "";

export type PrintOrdersResponse = {
  ok: boolean;
  results?: { order: string; printed: boolean }[];
  error?: string;
};

export async function printOrdersLocally(orderNames: string[], copies = 1, store?: string, requestId = createPrintRequestId()): Promise<PrintOrdersResponse> {
  const orders = orderNames.map(n => String(n).replace(/^#/, ""));

  return sendLocalOrders({
    base: BASE,
    headers: {
      "Content-Type": "application/json",
      ...(SECRET ? { "x-secret": SECRET } : {}),
    },
    body: JSON.stringify({ orders, copies, request_id: requestId, ...(store ? { store } : {}) }),
  });
}


