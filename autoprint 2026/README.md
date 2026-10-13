# Windows Print Receiver (Shopify Orders + PDFs)

Local HTTP service for **automatic, silent** printing on Windows.

- POST a **PDF** (file or URL) → prints silently to your Windows printer.
- POST **order numbers** → fetches from Shopify Admin, renders your **Liquid** template, converts to PDF, prints silently.

## Quick start
1) Ensure **Python 3.10+** is installed and available on PATH.
2) Unzip this folder, then:
```bat
copy config.example.yaml config.yaml
notepad config.yaml
```
3) Start the agent:
```bat
start_agent.bat
```
Service runs on **http://127.0.0.1:8787**.

## Print from another PC (local LAN relay)
You have 2 choices:

### Option A (recommended): run the agent ONLY on the printer PC, and print to it over LAN
- **Printer PC** (the PC with the printer connected):
  - In `config.yaml` set:
    - `host: 0.0.0.0`
    - `port: 8787` (or any)
    - `shared_secret: "YOUR_SECRET"` (recommended)
    - `print_mode: "local"`
  - Start the agent (`start_agent.bat`)
  - Allow it in Windows Firewall (Private network)
- **Other PCs**:
  - When printing, call the printer PC directly, for example:
    - `http://PRINTER_PC_IP:8787/print/pdf`
    - `http://PRINTER_PC_IP:8787/print/orders`
  - If you set `shared_secret`, add header: `X-Secret: YOUR_SECRET`

### Option B: install/run the agent on EVERY PC, but forward printing to the printer PC
This keeps your workflow unchanged (each PC still prints to `http://127.0.0.1:8787`), but the job is automatically forwarded.
- **Printer PC** `config.yaml`:
  - `host: 0.0.0.0`
  - `shared_secret: "YOUR_SECRET"`
  - `print_mode: "local"`
- **Other PCs** `config.yaml`:
  - `host: 127.0.0.1`
  - `shared_secret: ""` (optional; set it if you want to protect the local endpoint too)
  - `print_mode: "forward"`
  - `forward_to_url: "http://PRINTER_PC_IP:8787"`
  - `forward_secret: "YOUR_SECRET"`

## Example calls
- Print a PDF URL:
```bat
curl -X POST http://127.0.0.1:8787/print/pdf -H "Content-Type: application/json" -d "{\"pdf_url\":\"https://example.com/label.pdf\",\"copies\":1}"
```
- Upload a PDF:
```bat
curl -X POST http://127.0.0.1:8787/print/pdf-upload -F "file=@C:\\path\\to\\label.pdf" -F "copies=1"
```
- Print Shopify orders by number:
```bat
curl -X POST http://127.0.0.1:8787/print/orders -H "Content-Type: application/json" -d "{\"orders\":[\"1001\",\"1002\"],\"copies\":1}"
```

## Notes
- Install SumatraPDF separately and set `sumatra_path` to its executable, or preserve the existing `tools/SumatraPDF` installation when applying a source update.
- Create a shortcut to `start_agent.bat` in your **Startup** folder to auto-start on login.

## Printing reliability and speed (2026.10.13)

- Use the updated collector with this agent: it uses `/renew` to keep long batches leased. Only one poller runs per installation, and jobs are never pulled again while the batch is still running.
- Relay jobs have durable spool receipts in `state/print-jobs.sqlite3`. A failed acknowledgement or agent restart does not print submitted pages again. A later chunk failing before printing retries only unfinished chunks, using the original chunk plan.
- Interrupted or failed Sumatra submissions are held for manual review, because some pages may already have entered the printer. Check the printer and collector queue before explicitly reprinting the missing labels. A successful response means accepted by Sumatra/spooler; it does not confirm physical output.
- Local `/print/orders` clients should send a stable `request_id` for every retry of one print action. Relay forwarding clients can send `job_id`. Keep the same order list, copies, store and printer for that ID; use a new ID for an intentional reprint. Forwarding preserves these fields. Anonymous requests cannot be safely deduplicated.
- Sumatra receives the exact copy count using its documented [`-print-settings "Nx"` syntax](https://www.sumatrapdfreader.org/docs/Command-line-arguments), including `1x`. Each PDF is submitted once, rather than starting Sumatra once per copy.
- Keep `max_orders_per_batch: 0` to render one PDF for the entire selection. `post_print_delay_seconds: 0` removes the extra pause after submission. Existing config files can keep their old value, so change it explicitly if a delay is unnecessary for your driver. Shopify request throttling and image-loading time are preserved.
- Every label gets its own template body layout. HTML conversions use isolated browser profiles so parallel conversions cannot reuse a desktop browser or each other's PDF output.

Run regression tests without contacting Shopify or a printer:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

`tests/render_qa_fixture.py` additionally renders 30 synthetic labels per template through Edge/Chrome without submitting them to a printer. Run it from the repository root with the agent Python environment. It writes PDFs under `tmp/print-label-qa`; fixtures embed remote images locally and include QR codes and alternating exchange warnings.
