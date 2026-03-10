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
- SumatraPDF portable is bundled under `tools/SumatraPDF` and used automatically.
- Create a shortcut to `start_agent.bat` in your **Startup** folder to auto-start on login.
