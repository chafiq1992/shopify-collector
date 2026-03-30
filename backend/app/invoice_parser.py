"""
Invoice PDF parser using LLM (GPT-4o-mini) for structured data extraction.

Flow:
  1. Extract raw text from PDF using PyMuPDF (fitz)
  2. Send text to GPT-4o-mini with a structured extraction prompt
  3. Return clean JSON with invoice header + shipment rows
"""

import os
import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# PDF text extraction (PyMuPDF / fitz)
# ---------------------------------------------------------------------------

def extract_text_from_pdf(file_bytes: bytes) -> str:
    """Extract text from a PDF buffer, preserving spatial layout per page."""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        raise RuntimeError("PyMuPDF is not installed. Add 'PyMuPDF' to requirements.txt.")

    doc = fitz.open(stream=file_bytes, filetype="pdf")
    pages_text: List[str] = []
    for page_num in range(doc.page_count):
        page = doc.load_page(page_num)
        # Use "text" extraction with sort=True to preserve reading order
        text = page.get_text("text", sort=True)
        if text and text.strip():
            pages_text.append(f"--- PAGE {page_num + 1} ---\n{text.strip()}")
    doc.close()
    return "\n\n".join(pages_text)


# ---------------------------------------------------------------------------
# LLM-based invoice parsing
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are an expert at extracting structured data from delivery company invoices (Morocco).

You will receive raw text extracted from a PDF invoice. Your job is to:
1. Auto-detect which delivery company issued the invoice (e.g. Lionex, 12Livery, Metalivraison, IBEX, Pal Express, YFD, Livré24, Oscario, or other).
2. Extract invoice-level metadata (invoice number, date, totals).
3. Extract every shipment row from the table.

IMPORTANT FIELD DEFINITIONS:
- "sendCode": The shipment tracking code (e.g. "7-127130", "7-58537_RMB"). Usually in a column called "Code d'envoi".
- "orderNumber": The numeric part after the dash in the sendCode (e.g. "127130" from "7-127130"). This is the Shopify order number.
- "status": Delivery status. Normalize to exactly "Livré" (delivered) or "Refusé" (refused/returned). Nothing else.
- "city": The delivery city (e.g. "CASABLANCA", "SIDI BENNOUR").
- "phone": Customer phone number if present (e.g. "0612345678").
- "crbt": CRBT amount in DH (Cash on delivery - the total the delivery company collected from the customer). This is the gross amount BEFORE deducting fees.
- "fees": Delivery fees/commission in DH charged by the delivery company.
- "total": Net amount = crbt - fees. This is what the delivery company owes back to the merchant.
- "pickupDate": Date the package was picked up (ISO format YYYY-MM-DD if available).
- "deliveryDate": Date the package was delivered (ISO format YYYY-MM-DD if available).

RULES:
- For "Refusé" (refused) shipments, crbt should be 0 (no cash was collected), but still extract the fees.
- All monetary amounts should be plain numbers (no currency symbols).
- If a field is not available in the PDF, use null.
- Extract ALL rows from ALL pages of the invoice. Do not skip any.
- The invoice may contain summary/total rows at the bottom - do NOT include those as shipment rows.

Return ONLY valid JSON, no markdown fences, no explanation."""

_USER_PROMPT_TEMPLATE = """Extract structured data from this delivery company invoice.

Return JSON in exactly this format:
{{
  "company": "<auto-detected company name>",
  "invoiceNumber": "<invoice number or null>",
  "invoiceDate": "<invoice date as string or null>",
  "totalBrut": <total brut/gross amount as number or null>,
  "totalNet": <total net amount as number or null>,
  "totalFees": <total fees amount as number or null>,
  "rows": [
    {{
      "sendCode": "<tracking code>",
      "orderNumber": "<order number extracted from sendCode>",
      "status": "<Livré or Refusé>",
      "city": "<city name or null>",
      "phone": "<phone or null>",
      "crbt": <number or null>,
      "fees": <number or null>,
      "total": <number or null>,
      "pickupDate": "<YYYY-MM-DD or null>",
      "deliveryDate": "<YYYY-MM-DD or null>"
    }}
  ]
}}

--- INVOICE TEXT START ---
{pdf_text}
--- INVOICE TEXT END ---"""


async def parse_invoice_with_llm(pdf_text: str, *, api_key: Optional[str] = None) -> Dict[str, Any]:
    """
    Send extracted PDF text to GPT-4o-mini and get structured invoice data back.
    """
    try:
        from openai import AsyncOpenAI
    except ImportError:
        raise RuntimeError("openai package is not installed. Add 'openai>=1.30.0' to requirements.txt.")

    key = api_key or os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise ValueError("OPENAI_API_KEY is not set. Configure it in your environment.")

    client = AsyncOpenAI(api_key=key)

    # Truncate very long PDFs to avoid token limits (GPT-4o-mini has 128k context)
    # A typical invoice is 2-10 pages, well under the limit.
    max_chars = 120_000
    text = pdf_text[:max_chars] if len(pdf_text) > max_chars else pdf_text

    user_msg = _USER_PROMPT_TEMPLATE.format(pdf_text=text)

    try:
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.0,
            response_format={"type": "json_object"},
            timeout=120,
        )
    except Exception as e:
        logger.error("OpenAI API call failed: %s", e)
        raise RuntimeError(f"LLM extraction failed: {e}")

    raw = (response.choices[0].message.content or "").strip()

    # Parse the JSON response
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        logger.error("LLM returned invalid JSON: %s\nRaw: %s", e, raw[:500])
        raise RuntimeError(f"LLM returned invalid JSON: {e}")

    # Validate and normalize the response
    return _normalize_llm_response(data)


def _normalize_llm_response(data: Dict[str, Any]) -> Dict[str, Any]:
    """Ensure the LLM response has the expected shape and types."""
    result = {
        "company": str(data.get("company") or "Unknown"),
        "invoiceNumber": data.get("invoiceNumber") or None,
        "invoiceDate": data.get("invoiceDate") or None,
        "totalBrut": _safe_float(data.get("totalBrut")),
        "totalNet": _safe_float(data.get("totalNet")),
        "totalFees": _safe_float(data.get("totalFees")),
        "rows": [],
    }

    for row in (data.get("rows") or []):
        if not isinstance(row, dict):
            continue
        send_code = str(row.get("sendCode") or "").strip()
        if not send_code:
            continue

        # Extract order number from sendCode if LLM didn't provide it
        order_number = str(row.get("orderNumber") or "").strip()
        if not order_number and "-" in send_code:
            parts = send_code.split("-", 1)
            if len(parts) == 2:
                # Take only digits from the second part
                digits = "".join(c for c in parts[1] if c.isdigit())
                order_number = digits

        status_raw = str(row.get("status") or "").strip()
        status = ""
        if status_raw.lower().startswith("livr"):
            status = "Livré"
        elif status_raw.lower().startswith("refus"):
            status = "Refusé"

        result["rows"].append({
            "sendCode": send_code,
            "orderNumber": order_number,
            "status": status,
            "city": str(row.get("city") or "").strip() or None,
            "phone": str(row.get("phone") or "").strip() or None,
            "crbt": _safe_float(row.get("crbt")),
            "fees": _safe_float(row.get("fees")),
            "total": _safe_float(row.get("total")),
            "pickupDate": str(row.get("pickupDate") or "").strip() or None,
            "deliveryDate": str(row.get("deliveryDate") or "").strip() or None,
        })

    return result


def _safe_float(val: Any) -> Optional[float]:
    """Convert a value to float, returning None on failure."""
    if val is None:
        return None
    try:
        s = str(val).replace(",", ".").strip()
        if not s or s.lower() == "null" or s.lower() == "none":
            return None
        f = float(s)
        return f if f == f else None  # NaN check
    except (ValueError, TypeError):
        return None
