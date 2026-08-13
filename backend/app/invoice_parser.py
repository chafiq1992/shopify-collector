"""Delivery-invoice parsing and normalization.

Known carrier PDF layouts and Livre24 spreadsheet exports are parsed
deterministically so every shipment row and amount can be reconciled. Unknown
PDF layouts retain the chunked OpenAI fallback.
"""

import os
import re
import json
import logging
import asyncio
import csv
import html
import io
import unicodedata
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
# Deterministic parsers for known invoice layouts
# ---------------------------------------------------------------------------

_STATUS_TOKEN_RE = r"(?:Livr\S*|Refus\S*)"
_MERCHANT_CODE_PATTERN = r"\d{1,3}-\d{4,8}(?:_[A-Za-z0-9-]+)?"
_YFD_TRACKING_PATTERN = r"YFD-\d{8}-\d+"
_OSC_TRACKING_PATTERN = r"OSC-\d{8}-\d+"
_DATE_PATTERN = r"\d{4}-\d{2}-\d{2}"

def _normalize_invoice_text(text: str) -> str:
    cleaned = (text or "").replace("\x00", " ").replace("\u00a0", " ")
    # Remove page footers only when they occupy a complete line. The previous
    # broad pattern also erased digits from valid codes followed by product
    # variants such as "9-86146 / 37".
    cleaned = re.sub(r"(?m)^\s*\d+\s*/\s*\d+\s*$", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


def _normalize_company_key(text: str) -> str:
    raw = (text or "").strip().lower()
    raw = raw.replace("é", "e").replace("è", "e").replace("ê", "e")
    return "".join(
        char for char in unicodedata.normalize("NFKD", raw)
        if not unicodedata.combining(char)
    )


def _normalize_status(status: str) -> str:
    key = _normalize_company_key(status)
    if key.startswith("livr"):
        return "Livré"
    if key.startswith("refus"):
        return "Refusé"
    return (status or "").strip()


def _extract_order_number(send_code: str) -> str:
    code = str(send_code or "").strip()
    if "-" not in code:
        return ""
    return "".join(ch for ch in code.split("-", 1)[1] if ch.isdigit())


def _extract_named_value(text: str, label: str) -> Optional[str]:
    m = re.search(rf"{re.escape(label)}\s*:?\s*(.+?)(?=\s+[A-Z][^:]*\s*:|$)", text, re.IGNORECASE)
    if not m:
        return None
    value = (m.group(1) or "").strip()
    return value or None


def _extract_count(text: str, label: str) -> Optional[int]:
    m = re.search(rf"{re.escape(label)}\s*:?\s*(\d+)", text, re.IGNORECASE)
    if not m:
        return None
    try:
        return int(m.group(1))
    except Exception:
        return None


def _extract_amount(text: str, label: str) -> Optional[float]:
    label_pattern = re.escape(label).replace(r"\ ", r"\s+")
    if _normalize_company_key(label) == "frais":
        label_pattern = rf"(?<!Autres\s){label_pattern}"
    forward = re.findall(
        rf"\b{label_pattern}\b\s*:?\s*(-?\d+(?:[.,]\d+)?)\s*DH",
        text,
        re.IGNORECASE,
    )
    if forward:
        return _safe_float(forward[-1])
    reverse = re.findall(
        rf"(-?\d+(?:[.,]\d+)?)\s*(?:DH\s*)?\b{label_pattern}\b(?:\s*DH)?",
        text,
        re.IGNORECASE,
    )
    return _safe_float(reverse[-1]) if reverse else None


def _extract_invoice_metadata(text: str, company: str) -> Dict[str, Any]:
    parsed = _base_invoice_result(company)
    m_invoice = re.search(
        r"(?:Facture(?:\s+client\s+N\S*)?|Invoice)\s*:?\s*([A-Z]{2,5}-[A-Za-z0-9-]+)",
        text,
        re.IGNORECASE,
    )
    m_date = re.search(
        r"\bDate\s*:?\s*(\d{2}/\d{2}/\d{4}|\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)",
        text,
        re.IGNORECASE,
    )
    parsed["invoiceNumber"] = m_invoice.group(1).strip() if m_invoice else None
    parsed["invoiceDate"] = m_date.group(1).strip() if m_date else None
    m_merchant = re.search(
        r"\bClient\s*:\s*(.+?)(?=\s+(?:Facture|Nom\s+de\s+client|T[ée]l[ée]phone|Date)\s*:|$)",
        text,
        re.IGNORECASE,
    )
    parsed["merchant"] = re.sub(r"\s+", " ", m_merchant.group(1)).strip() if m_merchant else None
    parsed["totalBrut"] = _extract_amount(text, "Total Brut")
    parsed["totalNet"] = _extract_amount(text, "Total Net")
    parsed["totalFees"] = _extract_amount(text, "Frais TTC")
    if parsed["totalFees"] is None:
        parsed["totalFees"] = _extract_amount(text, "Frais")
    for label in ("Charges supplémentaires", "Charges supplementaires", "Autres frais"):
        additional_fees = _extract_amount(text, label)
        if additional_fees is not None:
            parsed["totalAdditionalFees"] = additional_fees
            break
    parsed["_expectedRowCount"] = _extract_count(text, "Nombre de colis")
    if parsed["_expectedRowCount"] is None:
        parsed["_expectedRowCount"] = _extract_count(text, "Colis")
    return parsed


def _detect_company(text: str) -> Optional[str]:
    key = _normalize_company_key(text)
    candidates = (
        ("12livery", "12Livery"),
        ("livre24", "Livre24"),
        ("livre 24", "Livre24"),
        ("lionex", "Lionex"),
        ("pal express", "Pal Express"),
        ("oscario", "Oscario"),
        ("ibex", "IBEX"),
        ("your fast delivery", "YFD"),
        ("yfd-", "YFD"),
        ("fast delivery", "Fast"),
        ("fast", "Fast"),
        ("run speed delivery", "Casa"),
        ("runspeed.ma", "Casa"),
    )
    for marker, company in candidates:
        if marker in key:
            return company
    return None


def _row_from_segment(
    send_code: str,
    segment: str,
    *,
    company: str,
    carrier_code: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    status_match = re.search(_STATUS_TOKEN_RE, segment, re.IGNORECASE)
    if not status_match:
        return None

    after_status = segment[status_match.end():]
    first_amount_start: Optional[int] = None
    if company in {"Lionex", "Casa"}:
        lionex_amounts = re.search(
            r"(-?\d+(?:[.,]\d+)?)(?:\s*DH)?\s+(-?\d+(?:[.,]\d+)?)\s*DH\s+(-?\d+(?:[.,]\d+)?)\s*DH\b",
            after_status,
            re.IGNORECASE,
        )
        if not lionex_amounts:
            return None
        crbt = _safe_float(lionex_amounts.group(1))
        fees = _safe_float(lionex_amounts.group(2))
        first_amount_start = lionex_amounts.start(1)
    else:
        money_matches = list(re.finditer(r"(-?\d+(?:[.,]\d+)?)\s*DH\b", after_status, re.IGNORECASE))
        if len(money_matches) < 2:
            return None
        crbt = _safe_float(money_matches[0].group(1))
        fees = _safe_float(money_matches[1].group(1))
        first_amount_start = money_matches[0].start()
    if crbt is None or fees is None:
        return None

    dates = re.findall(_DATE_PATTERN, segment)
    phones = re.findall(r"\b0\d{9}\b", segment)

    city: Optional[str] = None
    city_text = after_status[:first_amount_start]
    if company == "Pal Express" and dates:
        date_match = re.search(_DATE_PATTERN, segment)
        city_text = segment[:date_match.start()] if date_match else city_text
    city_text = re.sub(r"\b0\d{9}\b", " ", city_text)
    city_text = re.sub(r"\b\d+\b", " ", city_text)
    city_text = re.sub(r"\s+", " ", city_text).strip(" -")
    if city_text:
        city = city_text[:120]

    status = _normalize_status(status_match.group(0))
    if _normalize_company_key(status).startswith("refus"):
        crbt = 0.0

    return {
        "sendCode": send_code,
        "yfdCode": carrier_code if company == "YFD" else None,
        "orderNumber": _extract_order_number(send_code),
        "status": status,
        "city": city,
        "phone": phones[0] if phones else None,
        "crbt": crbt,
        "fees": fees,
        "total": crbt - fees,
        "pickupDate": dates[0] if len(dates) >= 2 else None,
        "deliveryDate": dates[1] if len(dates) >= 2 else (dates[0] if dates else None),
    }


def _base_invoice_result(company: str) -> Dict[str, Any]:
    return {
        "company": company,
        "merchant": None,
        "invoiceNumber": None,
        "invoiceDate": None,
        "totalBrut": None,
        "totalNet": None,
        "totalFees": None,
        "totalAdditionalFees": None,
        "_expectedRowCount": None,
        "rows": [],
    }


def _parse_yfd_invoice(text: str) -> Optional[Dict[str, Any]]:
    return _parse_mpdf_carrier_invoice(text, "YFD", _YFD_TRACKING_PATTERN)


def _parse_twelve_livery_invoice(text: str) -> Optional[Dict[str, Any]]:
    if "12livery" not in _normalize_company_key(text):
        return None
    return _parse_tcpdf_invoice(text)


def _parse_mpdf_carrier_invoice(
    text: str,
    company: str,
    tracking_pattern: str,
) -> Optional[Dict[str, Any]]:
    tracking_matches = list(re.finditer(rf"\b({tracking_pattern})\b", text, re.IGNORECASE))
    if not tracking_matches:
        return None

    parsed = _extract_invoice_metadata(text, company)
    seen_codes = set()
    for index, tracking_match in enumerate(tracking_matches):
        segment_end = tracking_matches[index + 1].start() if index + 1 < len(tracking_matches) else len(text)
        segment = text[tracking_match.end():segment_end]
        send_match = re.search(rf"\b({_MERCHANT_CODE_PATTERN})\b", segment, re.IGNORECASE)
        if not send_match:
            continue
        send_code = send_match.group(1).strip()
        if send_code in seen_codes:
            continue
        row = _row_from_segment(
            send_code,
            segment,
            company=company,
            carrier_code=tracking_match.group(1).strip(),
        )
        if row:
            seen_codes.add(send_code)
            parsed["rows"].append(row)
    return parsed if parsed["rows"] else None


def _parse_oscario_invoice(text: str) -> Optional[Dict[str, Any]]:
    return _parse_mpdf_carrier_invoice(text, "Oscario", _OSC_TRACKING_PATTERN)


def _parse_tcpdf_invoice(text: str) -> Optional[Dict[str, Any]]:
    company = _detect_company(text)
    if company not in {"12Livery", "IBEX", "Lionex", "Pal Express", "Fast", "Casa"}:
        return None

    parsed = _extract_invoice_metadata(text, company)
    code_matches = list(re.finditer(rf"\b({_MERCHANT_CODE_PATTERN})\b", text, re.IGNORECASE))
    seen_codes = set()
    for index, code_match in enumerate(code_matches):
        send_code = code_match.group(1).strip()
        if send_code in seen_codes:
            continue
        segment_end = code_matches[index + 1].start() if index + 1 < len(code_matches) else len(text)
        segment = text[code_match.end():segment_end]
        row = _row_from_segment(send_code, segment, company=company)
        if row:
            seen_codes.add(send_code)
            parsed["rows"].append(row)
    return parsed if parsed["rows"] else None


def _parse_invoice_deterministically(pages: List[Tuple[int, str]]) -> Optional[Dict[str, Any]]:
    text = _normalize_invoice_text(" ".join(page_text for _, page_text in (pages or [])))
    if not text:
        return None

    for parser in (_parse_yfd_invoice, _parse_oscario_invoice, _parse_tcpdf_invoice):
        parsed = parser(text)
        if parsed and parsed.get("rows"):
            normalized = _normalize_llm_response(parsed)
            normalized["_expectedRowCount"] = parsed.get("_expectedRowCount")
            return normalized
    return None


def _deterministic_parse_is_complete(parsed: Optional[Dict[str, Any]]) -> bool:
    if not parsed:
        return False
    rows = parsed.get("rows") or []
    expected = parsed.get("_expectedRowCount")
    if expected is None:
        return len(rows) > 0
    return len(rows) >= int(expected)


def _strip_html_cell(value: str) -> str:
    value = re.sub(r"<br\s*/?>", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def _parse_html_grid(raw_bytes: bytes) -> List[List[str]]:
    decoded = raw_bytes.decode("utf-8-sig", errors="replace")
    grid: List[List[str]] = []
    for row_html in re.findall(r"<tr\b[^>]*>(.*?)</tr>", decoded, re.IGNORECASE | re.DOTALL):
        cells = [
            _strip_html_cell(cell)
            for _, cell in re.findall(
                r"<(th|td)\b[^>]*>(.*?)</\1>",
                row_html,
                re.IGNORECASE | re.DOTALL,
            )
        ]
        if cells:
            grid.append(cells)
    return grid


def _parse_csv_grid(raw_bytes: bytes) -> List[List[str]]:
    decoded = raw_bytes.decode("utf-8-sig", errors="replace")
    sample = decoded[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    return [[str(cell).strip() for cell in row] for row in csv.reader(io.StringIO(decoded), dialect)]


def _cell_amount(value: Any) -> Optional[float]:
    match = re.search(r"-?\d+(?:[.,]\d+)?", str(value or ""))
    return _safe_float(match.group(0)) if match else None


def parse_invoice_spreadsheet(file_bytes: bytes, filename: str) -> Dict[str, Any]:
    """Parse delivery-invoice HTML/XLS or CSV exports without an LLM."""
    stripped = file_bytes.lstrip()
    suffix = os.path.splitext(filename or "")[1].lower()
    if stripped.startswith(b"<"):
        grid = _parse_html_grid(file_bytes)
    elif suffix in {".csv", ".tsv"}:
        grid = _parse_csv_grid(file_bytes)
    else:
        raise ValueError("Unsupported spreadsheet invoice format; export it as HTML .xls or CSV")

    if len(grid) < 2:
        raise ValueError("No invoice table found in spreadsheet")

    headers = [_normalize_company_key(cell) for cell in grid[0]]

    def column(*names: str) -> Optional[int]:
        normalized_names = {_normalize_company_key(name) for name in names}
        for idx, header in enumerate(headers):
            if header in normalized_names:
                return idx
        return None

    send_idx = column("ID Intern", "Code d'envoi", "Code envoi", "Reference", "Référence")
    carrier_idx = column("Code", "Tracking", "Code colis")
    phone_idx = column("Telephone", "Téléphone", "Phone")
    city_idx = column("Ville", "City")
    status_idx = column("Etat", "État", "Status", "Statut")
    crbt_idx = column("CRBT", "Montant")
    fees_idx = column("Frais", "Fees")
    if send_idx is None or crbt_idx is None or status_idx is None:
        raise ValueError("Spreadsheet is missing order code, status, or CRBT columns")

    company = "Unknown"
    rows: List[Dict[str, Any]] = []
    totals: Dict[str, Optional[float]] = {"brut": None, "fees": None, "additional": None, "net": None}
    for cells in grid[1:]:
        padded = cells + [""] * max(0, len(headers) - len(cells))
        send_code = padded[send_idx].strip() if send_idx < len(padded) else ""
        status_text = padded[status_idx].strip() if status_idx < len(padded) else ""
        status_key = _normalize_company_key(status_text)

        if not re.fullmatch(_MERCHANT_CODE_PATTERN, send_code, re.IGNORECASE):
            summary_amount = _cell_amount(padded[crbt_idx] if crbt_idx < len(padded) else "")
            if status_key == "total brut":
                totals["brut"] = summary_amount
            elif status_key in {"frais", "frais ttc"}:
                totals["fees"] = summary_amount
            elif status_key in {"charges supplementaires", "autres frais"}:
                totals["additional"] = summary_amount
            elif status_key == "total net":
                totals["net"] = summary_amount
            continue

        carrier_code = padded[carrier_idx].strip() if carrier_idx is not None and carrier_idx < len(padded) else ""
        if carrier_code.upper().startswith("L24-"):
            company = "Livre24"
        crbt = _cell_amount(padded[crbt_idx])
        fees = _cell_amount(padded[fees_idx]) if fees_idx is not None and fees_idx < len(padded) else None
        normalized_status = _normalize_status(status_text)
        if _normalize_company_key(normalized_status).startswith("refus"):
            crbt = 0.0
        rows.append({
            "sendCode": send_code,
            "yfdCode": None,
            "orderNumber": _extract_order_number(send_code),
            "status": normalized_status,
            "city": padded[city_idx].strip() or None if city_idx is not None and city_idx < len(padded) else None,
            "phone": padded[phone_idx].strip() or None if phone_idx is not None and phone_idx < len(padded) else None,
            "crbt": crbt,
            "fees": fees,
            "total": crbt - fees if crbt is not None and fees is not None else None,
            "pickupDate": None,
            "deliveryDate": None,
        })

    if not rows:
        raise ValueError("No invoice shipment rows found in spreadsheet")

    stem = os.path.splitext(os.path.basename(filename or ""))[0]
    date_match = re.search(r"(?:^|-)FC-?(\d{2})(\d{2})(\d{4})(?:-|$)", f"-{stem}-", re.IGNORECASE)
    invoice_date = None
    if date_match:
        invoice_date = f"{date_match.group(1)}/{date_match.group(2)}/{date_match.group(3)}"
    result = {
        "company": company,
        "merchant": None,
        "invoiceNumber": stem or None,
        "invoiceDate": invoice_date,
        "totalBrut": totals["brut"],
        "totalNet": totals["net"],
        "totalFees": totals["fees"],
        "totalAdditionalFees": totals["additional"],
        "rows": rows,
    }
    return _normalize_llm_response(result)


# ---------------------------------------------------------------------------
# LLM prompts
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are an expert at extracting structured data from delivery company invoices (Morocco).

You will receive raw text extracted from part of a PDF invoice (possibly just a few pages). Your job is to:
1. Auto-detect which delivery company issued the invoice (e.g. Lionex, 12Livery, Metalivraison, IBEX, Pal Express, YFD, Livré24, Oscario, or other).
2. Extract the invoice merchant/client account shown beside labels such as "Client:".
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
  "merchant": "<invoice Client value or null>",
  "invoiceNumber": "<invoice number or null>",
  "invoiceDate": "<invoice date as string or null>",
  "totalBrut": <total brut/gross amount as number or null>,
  "totalNet": <total net amount as number or null>,
  "totalFees": <total fees amount as number or null>,
  "totalAdditionalFees": <additional/other fees amount as number or null>,
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
    if not pages:
        return {"company": "Unknown", "rows": []}

    deterministic = _parse_invoice_deterministically(pages)
    if _deterministic_parse_is_complete(deterministic):
        logger.info(
            "Using deterministic invoice parser for %s with %d rows",
            deterministic.get("company"),
            len(deterministic.get("rows") or []),
        )
        deterministic.pop("_expectedRowCount", None)
        return deterministic

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

    if deterministic and len(deterministic.get("rows") or []) > len(merged.get("rows") or []):
        logger.warning(
            "Falling back to deterministic parse result for %s because it produced more rows (%d vs %d)",
            deterministic.get("company"),
            len(deterministic.get("rows") or []),
            len(merged.get("rows") or []),
        )
        deterministic.pop("_expectedRowCount", None)
        if merged.get("_errors"):
            deterministic["_errors"] = merged["_errors"]
        return deterministic

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
        "merchant": None,
        "invoiceNumber": None,
        "invoiceDate": None,
        "totalBrut": None,
        "totalNet": None,
        "totalFees": None,
        "totalAdditionalFees": None,
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
        if not merged["merchant"] and chunk_data.get("merchant"):
            merged["merchant"] = chunk_data["merchant"]
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
        if merged["totalAdditionalFees"] is None and chunk_data.get("totalAdditionalFees") is not None:
            merged["totalAdditionalFees"] = chunk_data["totalAdditionalFees"]

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
        "merchant": str(data.get("merchant") or "").strip() or None,
        "invoiceNumber": data.get("invoiceNumber") or None,
        "invoiceDate": data.get("invoiceDate") or None,
        "totalBrut": _safe_float(data.get("totalBrut")),
        "totalNet": _safe_float(data.get("totalNet")),
        "totalFees": _safe_float(data.get("totalFees")),
        "totalAdditionalFees": _safe_float(data.get("totalAdditionalFees")),
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
