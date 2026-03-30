"""
Invoice PDF parser using LLM (GPT-4o-mini) for structured data extraction.

Handles large invoices (800+ rows) by chunking the PDF text by pages
and processing chunks in parallel with separate LLM calls.

Flow:
  1. Extract raw text from PDF using PyMuPDF (fitz), page by page
  2. Group pages into chunks (~8 pages each)
  3. Send each chunk to GPT-4o-mini in parallel
  4. Merge all extracted rows + deduplicate
  5. Return clean JSON with invoice header + all shipment rows
"""

import os
import re
import json
import logging
import asyncio
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# PDF text extraction (PyMuPDF / fitz)
# ---------------------------------------------------------------------------

def extract_pages_text(file_bytes: bytes) -> List[Tuple[int, str]]:
    """
    Extract text from each page of a PDF.
    Returns list of (page_number, page_text) tuples.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        raise RuntimeError("PyMuPDF is not installed. Add 'PyMuPDF' to requirements.txt.")

    doc = fitz.open(stream=file_bytes, filetype="pdf")
    pages: List[Tuple[int, str]] = []
    for page_num in range(doc.page_count):
        page = doc.load_page(page_num)
        text = page.get_text("text", sort=True)
        if text and text.strip():
            # Compress whitespace to reduce token count
            lines = [l.strip() for l in text.strip().splitlines()]
            lines = [l for l in lines if l]
            compressed = "\n".join(lines)
            pages.append((page_num + 1, compressed))
    doc.close()
    return pages


def extract_text_from_pdf(file_bytes: bytes) -> str:
    """Extract all text from a PDF as a single string (legacy compat)."""
    pages = extract_pages_text(file_bytes)
    parts = [f"--- PAGE {pn} ---\n{text}" for pn, text in pages]
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------

PAGES_PER_CHUNK = 2  # ~10-20 rows per page × 2 pages = ~20-40 rows per chunk (reliable LLM extraction)


def chunk_pages(pages: List[Tuple[int, str]], pages_per_chunk: int = PAGES_PER_CHUNK) -> List[str]:
    """Group pages into text chunks for parallel LLM processing."""
    chunks: List[str] = []
    for i in range(0, len(pages), pages_per_chunk):
        batch = pages[i:i + pages_per_chunk]
        parts = [f"--- PAGE {pn} ---\n{text}" for pn, text in batch]
        chunks.append("\n\n".join(parts))
    return chunks


# ---------------------------------------------------------------------------
# LLM prompts
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are an expert at extracting structured data from delivery company invoices (Morocco).

You will receive raw text extracted from part of a PDF invoice (possibly just a few pages). Your job is to:
1. Auto-detect which delivery company issued the invoice (e.g. Lionex, 12Livery, Metalivraison, IBEX, Pal Express, YFD, Livré24, Oscario, or other).
2. Extract invoice-level metadata IF visible in this chunk (invoice number, date, totals). Use null if not visible.
3. Extract EVERY shipment row from the table in this chunk.

CRITICAL — DUAL-CODE ROWS (YFD invoices):
Some delivery companies (notably YFD) show TWO codes per shipment row:
  - A delivery company tracking code like "YFD-10032026-7577862" (this is YFD's internal tracking code)
  - A merchant/Shopify code like "7-133416" (this is the merchant's code — the number after the dash is the Shopify order number)
These two codes belong to the SAME shipment row — do NOT create two separate rows for them.
When both codes are present:
  - Use the "7-XXXXX" code as the "sendCode" (e.g. "7-133416")
  - Extract the order number from the "7-XXXXX" code (e.g. "133416")
  - Store the YFD tracking code in the "yfdCode" field (e.g. "YFD-10032026-7577862")

IMPORTANT FIELD DEFINITIONS:
- "sendCode": The merchant/Shopify tracking code (e.g. "7-127130", "7-58537_RMB"). For YFD invoices, this is the "7-XXXXX" code, NOT the "YFD-DDMMYYYY-NNNNNNN" code.
- "yfdCode": (YFD invoices only) The YFD tracking code like "YFD-10032026-7577862". Set to null for non-YFD invoices.
- "orderNumber": The numeric part after the dash in the sendCode (e.g. "127130" from "7-127130"). This is the Shopify order number. NEVER extract this from a YFD tracking code.
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
- If a field is not available, use null.
- Extract ALL rows visible in this text chunk. Do not skip any.
- Do NOT include summary/total rows from the bottom of tables.
- Be thorough — every row with a sendCode pattern like "7-XXXXX" must be extracted.
- NEVER create two separate rows for what is actually one shipment with two codes (YFD code + merchant code).

Return ONLY valid JSON, no markdown fences, no explanation."""

_USER_PROMPT_TEMPLATE = """Extract structured data from this chunk of a delivery company invoice.

Return JSON in exactly this format:
{{
  "company": "<auto-detected company name or null if not visible>",
  "invoiceNumber": "<invoice number or null>",
  "invoiceDate": "<invoice date as string or null>",
  "totalBrut": <total brut/gross amount as number or null>,
  "totalNet": <total net amount as number or null>,
  "totalFees": <total fees amount as number or null>,
  "rows": [
    {{
      "sendCode": "<merchant tracking code, e.g. 7-133416>",
      "yfdCode": "<YFD tracking code if present, e.g. YFD-10032026-7577862, or null>",
      "orderNumber": "<order number from sendCode, e.g. 133416>",
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

--- INVOICE TEXT (CHUNK) START ---
{pdf_text}
--- INVOICE TEXT (CHUNK) END ---"""


# ---------------------------------------------------------------------------
# LLM call (single chunk)
# ---------------------------------------------------------------------------

LLM_REQUEST_TIMEOUT = 180  # seconds per OpenAI API call
LLM_MAX_RETRIES = 2       # retry up to 2 times on transient failures
LLM_RETRY_BASE_DELAY = 3  # seconds (exponential backoff base)


async def _call_llm_for_chunk(
    chunk_text: str,
    chunk_index: int,
    total_chunks: int,
    *,
    api_key: str,
) -> Dict[str, Any]:
    """Process a single text chunk with GPT-4o-mini (with retry on timeout)."""
    from openai import AsyncOpenAI
    import httpx

    client = AsyncOpenAI(
        api_key=api_key,
        timeout=httpx.Timeout(LLM_REQUEST_TIMEOUT, connect=30.0),
        max_retries=0,  # we handle retries ourselves for better logging
    )
    user_msg = _USER_PROMPT_TEMPLATE.format(pdf_text=chunk_text)

    last_error = None
    for attempt in range(1 + LLM_MAX_RETRIES):
        try:
            if attempt > 0:
                delay = LLM_RETRY_BASE_DELAY * (2 ** (attempt - 1))
                logger.info("Retrying chunk %d/%d (attempt %d) after %.1fs delay",
                            chunk_index + 1, total_chunks, attempt + 1, delay)
                await asyncio.sleep(delay)

            response = await client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": user_msg},
                ],
                temperature=0.0,
                response_format={"type": "json_object"},
            )

            raw = (response.choices[0].message.content or "").strip()

            try:
                data = json.loads(raw)
            except json.JSONDecodeError as e:
                logger.error("LLM returned invalid JSON for chunk %d: %s", chunk_index + 1, e)
                return {"rows": [], "error": f"Invalid JSON from chunk {chunk_index + 1}"}

            return data

        except Exception as e:
            last_error = e
            err_name = type(e).__name__
            logger.warning("OpenAI API call failed for chunk %d/%d (attempt %d): [%s] %s",
                           chunk_index + 1, total_chunks, attempt + 1, err_name, e)
            # Only retry on timeout / connection errors
            is_retryable = any(kw in str(type(e).__name__).lower() for kw in ("timeout", "connect", "api"))
            is_retryable = is_retryable or "timed out" in str(e).lower() or "timeout" in str(e).lower()
            if not is_retryable:
                break

    logger.error("OpenAI API call permanently failed for chunk %d/%d after %d attempts: %s",
                 chunk_index + 1, total_chunks, 1 + LLM_MAX_RETRIES, last_error)
    return {"rows": [], "error": f"LLM failed on chunk {chunk_index + 1}: {last_error}"}


# ---------------------------------------------------------------------------
# Main parser (chunked + parallel)
# ---------------------------------------------------------------------------

async def parse_invoice_with_llm(pdf_text: str, *, api_key: Optional[str] = None) -> Dict[str, Any]:
    """
    Parse invoice text using LLM. For small invoices, uses a single call.
    For large invoices, chunks by pages and processes in parallel.
    """
    try:
        from openai import AsyncOpenAI
    except ImportError:
        raise RuntimeError("openai package is not installed. Add 'openai>=1.30.0' to requirements.txt.")

    key = api_key or os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise ValueError("OPENAI_API_KEY is not set. Configure it in your environment.")

    # For legacy calls with pre-joined text, just use single-chunk
    return await _parse_chunked(pdf_text, api_key=key)


async def parse_invoice_from_pages(
    pages: List[Tuple[int, str]],
    *,
    api_key: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Parse invoice from page-level text. Chunks pages and processes in parallel.
    This is the preferred entry point for large PDFs.
    """
    try:
        from openai import AsyncOpenAI
    except ImportError:
        raise RuntimeError("openai package is not installed. Add 'openai>=1.30.0' to requirements.txt.")

    key = api_key or os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise ValueError("OPENAI_API_KEY is not set. Configure it in your environment.")

    chunks = chunk_pages(pages, PAGES_PER_CHUNK)
    if not chunks:
        return {"company": "Unknown", "rows": []}

    logger.info("Invoice has %d pages → %d chunks of ~%d pages each", len(pages), len(chunks), PAGES_PER_CHUNK)

    # Process all chunks in parallel (limit concurrency to avoid rate limits)
    sem = asyncio.Semaphore(5)

    async def _process(idx: int, text: str) -> Dict[str, Any]:
        async with sem:
            logger.info("Processing chunk %d/%d (%d chars)", idx + 1, len(chunks), len(text))
            return await _call_llm_for_chunk(text, idx, len(chunks), api_key=key)

    results = await asyncio.gather(*[_process(i, c) for i, c in enumerate(chunks)])

    # Merge results
    merged = _merge_chunk_results(results)

    # Post-processing: catch any 7-XXXXX codes the LLM missed
    _backfill_missing_codes(merged, pages)

    return merged


async def _parse_chunked(pdf_text: str, *, api_key: str) -> Dict[str, Any]:
    """Parse pre-joined text by re-splitting into page chunks."""
    # Re-split by page markers
    page_pattern = re.compile(r"--- PAGE (\d+) ---\n")
    parts = page_pattern.split(pdf_text)

    pages: List[Tuple[int, str]] = []
    i = 1
    while i < len(parts):
        try:
            page_num = int(parts[i])
            page_text = parts[i + 1].strip() if (i + 1) < len(parts) else ""
            if page_text:
                pages.append((page_num, page_text))
        except (ValueError, IndexError):
            pass
        i += 2

    if not pages:
        # Couldn't split — treat as single chunk
        pages = [(1, pdf_text)]

    return await parse_invoice_from_pages(pages, api_key=api_key)


def _merge_chunk_results(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Merge results from multiple chunk LLM calls into a single response."""
    merged = {
        "company": None,
        "invoiceNumber": None,
        "invoiceDate": None,
        "totalBrut": None,
        "totalNet": None,
        "totalFees": None,
        "rows": [],
    }

    seen_codes = set()
    errors: List[str] = []

    for chunk_data in results:
        if not isinstance(chunk_data, dict):
            continue

        # Collect errors
        if chunk_data.get("error"):
            errors.append(str(chunk_data["error"]))
            continue

        # Take metadata from the first chunk that has it
        if not merged["company"] and chunk_data.get("company"):
            merged["company"] = chunk_data["company"]
        if not merged["invoiceNumber"] and chunk_data.get("invoiceNumber"):
            merged["invoiceNumber"] = chunk_data["invoiceNumber"]
        if not merged["invoiceDate"] and chunk_data.get("invoiceDate"):
            merged["invoiceDate"] = chunk_data["invoiceDate"]
        if merged["totalBrut"] is None and chunk_data.get("totalBrut") is not None:
            merged["totalBrut"] = chunk_data["totalBrut"]
        if merged["totalNet"] is None and chunk_data.get("totalNet") is not None:
            merged["totalNet"] = chunk_data["totalNet"]
        if merged["totalFees"] is None and chunk_data.get("totalFees") is not None:
            merged["totalFees"] = chunk_data["totalFees"]

        # Merge rows (deduplicate by sendCode)
        for row in (chunk_data.get("rows") or []):
            if not isinstance(row, dict):
                continue
            code = str(row.get("sendCode") or "").strip()
            if not code:
                continue
            if code in seen_codes:
                continue
            seen_codes.add(code)
            merged["rows"].append(row)

    if errors:
        merged["_errors"] = errors

    merged["company"] = merged["company"] or "Unknown"

    # Normalize all rows
    return _normalize_llm_response(merged)


# ---------------------------------------------------------------------------
# Backfill: catch merchant codes the LLM missed
# ---------------------------------------------------------------------------

_MERCHANT_CODE_RE = re.compile(r'\b(7-\d{4,6})\b')

def _backfill_missing_codes(
    merged: Dict[str, Any],
    pages: List[Tuple[int, str]],
) -> None:
    """
    Scan raw page text for 7-XXXXX merchant codes that the LLM missed.
    Adds stub rows for any codes not already in the merged result.
    Modifies `merged` in place.
    """
    # Collect codes already extracted by the LLM
    existing_codes = set()
    for row in (merged.get("rows") or []):
        sc = str(row.get("sendCode") or "").strip()
        if sc:
            existing_codes.add(sc)

    # Scan all page text for merchant codes
    all_text = "\n".join(text for _, text in pages)
    found_in_pdf = set(_MERCHANT_CODE_RE.findall(all_text))

    missing = found_in_pdf - existing_codes
    if not missing:
        return

    logger.warning("LLM missed %d merchant codes — backfilling: %s", len(missing), sorted(missing))

    for code in sorted(missing):
        # Extract order number from the code
        parts = code.split("-", 1)
        order_number = parts[1] if len(parts) == 2 else ""

        merged["rows"].append({
            "sendCode": code,
            "yfdCode": None,
            "orderNumber": order_number,
            "status": "",
            "city": None,
            "phone": None,
            "crbt": None,
            "fees": None,
            "total": None,
            "pickupDate": None,
            "deliveryDate": None,
            "_backfilled": True,  # marker so frontend can flag these
        })


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

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

    if data.get("_errors"):
        result["_errors"] = data["_errors"]

    _YFD_PATTERN = re.compile(r'^YFD-\d{8}-\d+$', re.IGNORECASE)

    for row in (data.get("rows") or []):
        if not isinstance(row, dict):
            continue
        send_code = str(row.get("sendCode") or "").strip()
        yfd_code = str(row.get("yfdCode") or "").strip() or None

        # Defensive: if LLM put the YFD tracking code in sendCode, fix it
        if _YFD_PATTERN.match(send_code):
            # sendCode is actually a YFD code — swap if we have a merchant code elsewhere
            if yfd_code and not _YFD_PATTERN.match(yfd_code):
                # yfdCode has the merchant code — swap them
                send_code, yfd_code = yfd_code, send_code
            elif not yfd_code:
                # Move YFD code to yfdCode, sendCode becomes empty (will be skipped or use orderNumber)
                yfd_code = send_code
                send_code = ""

        if not send_code:
            continue

        # Extract order number from sendCode if LLM didn't provide it
        order_number = str(row.get("orderNumber") or "").strip()

        # Safety: if orderNumber looks like it came from a YFD code (7+ digits), clear it
        # Shopify order numbers are typically 5-6 digits
        if order_number and yfd_code and order_number in yfd_code:
            order_number = ""  # It was extracted from the YFD code, not the merchant code

        if not order_number and "-" in send_code:
            parts = send_code.split("-", 1)
            if len(parts) == 2:
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
            "yfdCode": yfd_code,
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
