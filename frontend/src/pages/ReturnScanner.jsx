import React, { useEffect, useRef, useState } from "react";
import { authFetch, authHeaders, loadAuth, clearAuth } from "../lib/auth";

/**
 * ReturnScanner page — barcode-based return order scanner.
 *
 * Mimics the return scanner flow from order-scanner-1 but integrated into the
 * main Order Collector app with per-user authentication and Shopify GraphQL
 * order lookup via the backend.
 */

// Lazy-import html5-qrcode to keep bundle splitting clean
let Html5Qrcode = null;
let Html5QrcodeSupportedFormats = null;

async function ensureQrLib() {
  if (!Html5Qrcode) {
    const mod = await import("html5-qrcode");
    Html5Qrcode = mod.Html5Qrcode;
    Html5QrcodeSupportedFormats = mod.Html5QrcodeSupportedFormats;
  }
}

function isIOS() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  return (
    /iPad|iPhone|iPod/i.test(ua) ||
    (platform === "MacIntel" &&
      typeof navigator.maxTouchPoints === "number" &&
      navigator.maxTouchPoints > 1)
  );
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Status icon helper
function statusIcon(result) {
  if (!result) return "";
  if (result.includes("✅")) return "✅";
  if (result.includes("⚠️")) return "⚠️";
  if (result.includes("❌")) return "❌";
  if (result.includes("⏳")) return "⏳";
  return "";
}

// Audio feedback
const audioCtx =
  typeof AudioContext !== "undefined"
    ? new AudioContext()
    : typeof webkitAudioContext !== "undefined"
    ? new webkitAudioContext()
    : null;

function playTone(freq, dur, type = "sine") {
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  } catch {}
}

function playSuccessSound() {
  playTone(880, 0.12);
  setTimeout(() => playTone(1320, 0.15), 120);
}
function playErrorSound() {
  playTone(220, 0.25, "square");
}

export default function ReturnScanner() {
  const auth = loadAuth();
  const readerRef = useRef(null);
  const scannerRef = useRef(null);
  const recentCodesRef = useRef(new Map());

  const [tab, setTab] = useState("scan"); // scan | history
  const [scanning, setScanning] = useState(false);
  const [showStart, setShowStart] = useState(true);
  const [showAgain, setShowAgain] = useState(false);
  const [result, setResult] = useState("");
  const [resultClass, setResultClass] = useState("");
  const [cameraDebug, setCameraDebug] = useState("");
  const [tapToPlayHint, setTapToPlayHint] = useState(false);
  const [toast, setToast] = useState("");

  // Session list (today's scans, stored in localStorage)
  const [sessionScans, setSessionScans] = useState(() => {
    try {
      const raw = localStorage.getItem("returnScannerSession");
      const list = JSON.parse(raw || "[]");
      const today = todayISO();
      return list.filter((o) => o.ts && o.ts.startsWith(today));
    } catch {
      return [];
    }
  });

  // Manual add
  const [showManual, setShowManual] = useState(false);
  const [manualOrder, setManualOrder] = useState("");

  // History tab
  const [historyRows, setHistoryRows] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyDateStart, setHistoryDateStart] = useState(todayISO());
  const [historyDateEnd, setHistoryDateEnd] = useState("");

  useEffect(() => {
    localStorage.setItem("returnScannerSession", JSON.stringify(sessionScans));
  }, [sessionScans]);

  useEffect(() => {
    if (tab === "history") fetchHistory();
  }, [tab, historyDateStart, historyDateEnd]);

  // Stop scanner when switching tabs
  useEffect(() => {
    const qr = scannerRef.current;
    if (!qr) return;
    (async () => {
      try {
        if (qr.isScanning) await qr.stop();
      } catch {}
      try {
        qr.clear();
      } catch {}
      scannerRef.current = null;
      setScanning(false);
      setShowStart(true);
      setShowAgain(false);
    })();
  }, [tab]);

  function hideLibraryInfo() {
    const root = readerRef.current;
    if (!root) return;
    const infoIcon = root.querySelector('img[alt="Info icon"]');
    if (infoIcon) infoIcon.remove();
    root.querySelectorAll("div").forEach((d) => {
      if (d.textContent && d.textContent.includes("Powered by")) d.remove();
    });
  }

  async function startScanner() {
    await ensureQrLib();
    setResult("");
    setResultClass("");
    setScanning(true);
    setShowStart(false);
    setShowAgain(false);
    setCameraDebug("");
    setTapToPlayHint(false);
    setToast("Starting camera...");
    setTimeout(() => setToast(""), 1200);

    let qr = scannerRef.current;
    const ios = isIOS();
    const config = {
      fps: ios ? 12 : 25,
      qrbox: (vw, vh) => ({ width: vw * 0.8, height: vh * 0.8 }),
      experimentalFeatures: { useBarCodeDetectorIfSupported: !ios },
      formatsToSupport: [
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.ITF,
        Html5QrcodeSupportedFormats.QR_CODE,
        Html5QrcodeSupportedFormats.PDF_417,
      ],
      disableFlip: true,
      aspectRatio: 1.0,
    };

    const onScan = (code) => {
      const now = Date.now();
      const last = recentCodesRef.current.get(code) || 0;
      if (now - last < 2000) return;
      recentCodesRef.current.set(code, now);
      if (navigator.vibrate) navigator.vibrate(60);
      setResult("⏳ Processing scan...");

      if (scannerRef.current) {
        scannerRef.current
          .stop()
          .then(() => {
            setScanning(false);
            setShowAgain(true);
          })
          .catch(() => {
            setScanning(false);
            setShowAgain(true);
          });
      } else {
        setScanning(false);
        setShowAgain(true);
      }

      addToSession({
        result: "⏳ Processing",
        order: code,
        store: "",
        fulfillment: "",
        status: "",
        financial: "",
        ts: new Date().toISOString(),
      });
      processReturnScan(code);
    };

    const handleStartError = (err) => {
      if (qr) {
        qr.stop().catch(() => {});
        qr.clear();
      }
      const isHttps =
        window.location.protocol === "https:" ||
        window.location.hostname === "localhost";
      const errMsg = err ? String(err) : "";
      const msg = isHttps
        ? `Camera failed to start${errMsg ? `: ${errMsg}` : ""}`
        : "Camera requires HTTPS";
      setResult(`❌ Error: ${msg}`);
      setResultClass("rs-result-error");
      playErrorSound();
      setCameraDebug(msg);
      setScanning(false);
      setShowStart(true);
    };

    const applyIosVideoAttrs = () => {
      const root = readerRef.current;
      if (!root) return;
      const vid = root.querySelector("video");
      if (!vid) return;
      vid.setAttribute("playsinline", "true");
      vid.setAttribute("webkit-playsinline", "true");
      vid.setAttribute("autoplay", "true");
      vid.setAttribute("muted", "true");
      try {
        vid.playsInline = true;
      } catch {}
      vid.muted = true;
      vid.autoplay = true;
      vid.play?.().catch?.(() => {});
    };

    const verifyVideo = () => {
      const startedAt = Date.now();
      const tick = () => {
        const root = readerRef.current;
        if (!root) return;
        const vid = root.querySelector("video");
        applyIosVideoAttrs();
        if (vid && (vid.paused || vid.readyState < 2))
          setTapToPlayHint(true);
        const ok =
          !!vid &&
          (vid.readyState >= 2 ||
            (vid.srcObject &&
              vid.srcObject.getTracks &&
              vid.srcObject.getTracks().length > 0) ||
            vid.currentTime > 0);
        if (ok) {
          setTapToPlayHint(false);
          return;
        }
        if (Date.now() - startedAt > 8000) {
          setCameraDebug("Camera started but preview is not playing. Tap inside the camera box once.");
          return;
        }
        setTimeout(tick, 250);
      };
      setTimeout(tick, 250);
    };

    const startNew = () => {
      const startWith = (camera) =>
        qr
          .start(camera, config, onScan, () => {})
          .then(() => {
            hideLibraryInfo();
            applyIosVideoAttrs();
            verifyVideo();
          });

      startWith({ facingMode: "environment" })
        .catch(async () => {
          try {
            await startWith({ facingMode: { ideal: "environment" } });
            return;
          } catch {}
          try {
            const cams = await Html5Qrcode.getCameras();
            const back =
              [...(cams || [])]
                .reverse()
                .find((c) =>
                  /back|rear|environment/i.test(c.label || "")
                ) || (cams || [])[cams.length - 1];
            if (back?.id) return startWith(back.id);
          } catch {}
          throw new Error("start_failed");
        })
        .catch(handleStartError);
    };

    if (!qr) {
      qr = new Html5Qrcode(readerRef.current.id);
      scannerRef.current = qr;
      startNew();
    } else {
      try {
        if (qr.isScanning) return;
        startNew();
      } catch {
        startNew();
      }
    }
  }

  async function processReturnScan(barcode) {
    try {
      const resp = await authFetch("/api/return-scan", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ barcode }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        const msg = data?.detail || "Return scan failed";
        setResult(`❌ Error: ${msg}`);
        setResultClass("rs-result-error");
        playErrorSound();
        return;
      }
      updateScanUI(data);
    } catch {
      setResult("❌ Error: Network error");
      setResultClass("rs-result-error");
      playErrorSound();
    }
  }

  function updateScanUI(data) {
    const { result: res, order, store, fulfillment, status, financial, ts } = data;
    setResult(`${statusIcon(res)} ${res}`);
    setResultClass(
      res.includes("✅")
        ? "rs-result-success"
        : res.includes("⚠️")
        ? "rs-result-warning"
        : "rs-result-error"
    );
    if (res.includes("✅")) playSuccessSound();
    else playErrorSound();

    setSessionScans((prev) => {
      if (prev.length && (prev[0].result || "").startsWith("⏳")) {
        const [, ...rest] = prev;
        return [
          { result: res, order, store, fulfillment, status, financial, ts },
          ...rest,
        ].slice(0, 50);
      }
      return [
        { result: res, order, store, fulfillment, status, financial, ts },
        ...prev,
      ].slice(0, 50);
    });
  }

  function addToSession(item) {
    setSessionScans((prev) => [item, ...prev].slice(0, 50));
  }

  async function handleManualAdd() {
    if (!manualOrder.trim()) return;
    try {
      const resp = await authFetch("/api/return-scans/manual", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ order_name: manualOrder.trim() }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setToast(data?.detail || "Failed to add return");
        setTimeout(() => setToast(""), 2000);
        return;
      }
      setShowManual(false);
      setManualOrder("");
      setToast("Added return ✓");
      setTimeout(() => setToast(""), 1500);

      const resText = data.result || "✅ Found";
      setResult(`${statusIcon(resText)} ${resText}`);
      setResultClass(
        resText.includes("✅")
          ? "rs-result-success"
          : resText.includes("⚠️")
          ? "rs-result-warning"
          : "rs-result-error"
      );
      setSessionScans((prev) =>
        [
          {
            result: resText,
            order: data.order_name || manualOrder,
            store: data.store || "",
            fulfillment: data.fulfillment || "",
            status: data.status || "",
            financial: data.financial || "",
            ts: data.ts || new Date().toISOString(),
          },
          ...prev,
        ].slice(0, 50)
      );
    } catch {
      setToast("Failed to add return");
      setTimeout(() => setToast(""), 2000);
    }
  }

  async function fetchHistory() {
    setHistoryLoading(true);
    try {
      const start = historyDateStart;
      const end = historyDateEnd || historyDateStart;
      const params = new URLSearchParams({ start, end });
      const res = await authFetch(`/api/return-scans?${params.toString()}`, {
        headers: authHeaders({ Accept: "application/json" }),
      });
      if (!res.ok) {
        setHistoryRows([]);
        return;
      }
      const js = await res.json();
      setHistoryRows(js.rows || []);
    } catch {
      setHistoryRows([]);
    } finally {
      setHistoryLoading(false);
    }
  }

  function navigate(path) {
    try {
      history.pushState(null, "", path);
      try {
        window.dispatchEvent(new PopStateEvent("popstate"));
      } catch {}
    } catch {
      try {
        location.href = path;
      } catch {}
    }
  }

  // ---- Styles ----
  const styles = {
    page: {
      minHeight: "100vh",
      width: "100%",
      background: "linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)",
      color: "#e2e8f0",
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
    },
    header: {
      position: "sticky",
      top: 0,
      zIndex: 30,
      background: "rgba(15, 23, 42, 0.85)",
      backdropFilter: "blur(12px)",
      borderBottom: "1px solid rgba(148, 163, 184, 0.12)",
      padding: "12px 16px",
    },
    headerRow: {
      maxWidth: 600,
      margin: "0 auto",
      display: "flex",
      alignItems: "center",
      gap: 12,
    },
    title: {
      fontSize: 18,
      fontWeight: 700,
      background: "linear-gradient(90deg, #38bdf8, #818cf8)",
      WebkitBackgroundClip: "text",
      WebkitTextFillColor: "transparent",
    },
    navBtn: {
      marginLeft: "auto",
      padding: "6px 14px",
      borderRadius: 20,
      border: "1px solid rgba(148, 163, 184, 0.2)",
      background: "rgba(30, 41, 59, 0.6)",
      color: "#94a3b8",
      fontSize: 12,
      fontWeight: 500,
      cursor: "pointer",
    },
    tabBar: {
      maxWidth: 600,
      margin: "0 auto",
      display: "flex",
      gap: 0,
      padding: "0 16px",
    },
    tab: (active) => ({
      flex: 1,
      padding: "10px 0",
      textAlign: "center",
      fontSize: 13,
      fontWeight: 600,
      cursor: "pointer",
      borderBottom: active
        ? "2px solid #38bdf8"
        : "2px solid transparent",
      color: active ? "#38bdf8" : "#64748b",
      background: "transparent",
      border: "none",
      borderBottomWidth: 2,
      borderBottomStyle: "solid",
      borderBottomColor: active ? "#38bdf8" : "transparent",
      transition: "all 0.2s",
    }),
    main: {
      maxWidth: 600,
      margin: "0 auto",
      padding: "16px",
    },
    scanArea: {
      borderRadius: 16,
      overflow: "hidden",
      background: "#020617",
      marginBottom: 16,
      minHeight: 200,
    },
    resultBox: (cls) => ({
      padding: "12px 16px",
      borderRadius: 12,
      marginBottom: 12,
      fontSize: 15,
      fontWeight: 600,
      textAlign: "center",
      background:
        cls === "rs-result-success"
          ? "rgba(34, 197, 94, 0.15)"
          : cls === "rs-result-warning"
          ? "rgba(234, 179, 8, 0.15)"
          : cls === "rs-result-error"
          ? "rgba(239, 68, 68, 0.15)"
          : "rgba(148, 163, 184, 0.1)",
      color:
        cls === "rs-result-success"
          ? "#4ade80"
          : cls === "rs-result-warning"
          ? "#facc15"
          : cls === "rs-result-error"
          ? "#f87171"
          : "#94a3b8",
      border: `1px solid ${
        cls === "rs-result-success"
          ? "rgba(34, 197, 94, 0.3)"
          : cls === "rs-result-warning"
          ? "rgba(234, 179, 8, 0.3)"
          : cls === "rs-result-error"
          ? "rgba(239, 68, 68, 0.3)"
          : "rgba(148, 163, 184, 0.15)"
      }`,
    }),
    scanBtn: {
      width: "100%",
      padding: "14px 0",
      borderRadius: 14,
      border: "none",
      cursor: "pointer",
      fontSize: 15,
      fontWeight: 700,
      background: "linear-gradient(135deg, #2563eb, #7c3aed)",
      color: "#fff",
      boxShadow: "0 4px 20px rgba(37, 99, 235, 0.25)",
      marginBottom: 10,
      transition: "transform 0.15s, box-shadow 0.15s",
    },
    manualBtn: {
      width: "100%",
      padding: "12px 0",
      borderRadius: 12,
      border: "1px solid rgba(148, 163, 184, 0.2)",
      background: "rgba(30, 41, 59, 0.5)",
      color: "#94a3b8",
      fontSize: 13,
      fontWeight: 600,
      cursor: "pointer",
      marginBottom: 16,
    },
    sessionCard: (res) => ({
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "10px 12px",
      borderRadius: 10,
      marginBottom: 6,
      background: "rgba(30, 41, 59, 0.5)",
      border: `1px solid ${
        (res || "").includes("✅")
          ? "rgba(34, 197, 94, 0.2)"
          : (res || "").includes("❌")
          ? "rgba(239, 68, 68, 0.15)"
          : "rgba(148, 163, 184, 0.1)"
      }`,
    }),
    toast: {
      position: "fixed",
      bottom: 24,
      left: "50%",
      transform: "translateX(-50%)",
      background: "#1e293b",
      color: "#e2e8f0",
      padding: "10px 20px",
      borderRadius: 12,
      fontSize: 13,
      fontWeight: 600,
      boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      zIndex: 100,
      border: "1px solid rgba(148, 163, 184, 0.15)",
    },
    table: {
      width: "100%",
      borderCollapse: "separate",
      borderSpacing: 0,
      fontSize: 12,
      background: "rgba(30, 41, 59, 0.4)",
      borderRadius: 12,
      overflow: "hidden",
      border: "1px solid rgba(148, 163, 184, 0.1)",
    },
    th: {
      textAlign: "left",
      padding: "10px 8px",
      fontSize: 11,
      fontWeight: 600,
      textTransform: "uppercase",
      letterSpacing: "0.05em",
      color: "#64748b",
      background: "rgba(15, 23, 42, 0.5)",
      borderBottom: "1px solid rgba(148, 163, 184, 0.1)",
    },
    td: {
      padding: "8px",
      borderBottom: "1px solid rgba(148, 163, 184, 0.06)",
      color: "#cbd5e1",
    },
    modalOverlay: {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.6)",
      backdropFilter: "blur(4px)",
      zIndex: 50,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
    },
    modalCard: {
      width: "100%",
      maxWidth: 400,
      background: "#1e293b",
      borderRadius: 16,
      padding: 24,
      border: "1px solid rgba(148, 163, 184, 0.15)",
      boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
    },
    input: {
      width: "100%",
      padding: "10px 12px",
      borderRadius: 10,
      border: "1px solid rgba(148, 163, 184, 0.2)",
      background: "rgba(15, 23, 42, 0.8)",
      color: "#e2e8f0",
      fontSize: 14,
      outline: "none",
      boxSizing: "border-box",
    },
    dateInput: {
      padding: "8px 10px",
      borderRadius: 8,
      border: "1px solid rgba(148, 163, 184, 0.2)",
      background: "rgba(15, 23, 42, 0.8)",
      color: "#e2e8f0",
      fontSize: 13,
      outline: "none",
    },
  };

  return (
    <div style={styles.page}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerRow}>
          <div style={styles.title}>↩️ Return Scanner</div>
          {auth?.user && (
            <span
              style={{
                fontSize: 11,
                color: "#64748b",
                maxWidth: 120,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {auth.user.name || auth.user.email}
            </span>
          )}
          <button style={styles.navBtn} onClick={() => navigate("/")}>
            ← Collector
          </button>
        </div>
        <div style={styles.tabBar}>
          <button
            style={styles.tab(tab === "scan")}
            onClick={() => setTab("scan")}
          >
            📷 Scan
          </button>
          <button
            style={styles.tab(tab === "history")}
            onClick={() => setTab("history")}
          >
            📋 History{tab === "history" ? ` (${historyRows.length})` : ""}
          </button>
        </div>
      </header>

      {toast && <div style={styles.toast}>{toast}</div>}

      {/* Scan Tab */}
      {tab === "scan" && (
        <div style={styles.main}>
          {/* Camera / Scanner */}
          <div
            id="rs-reader"
            ref={readerRef}
            style={styles.scanArea}
            onClick={() => {
              const vid = readerRef.current?.querySelector?.("video");
              if (vid) {
                try {
                  vid.play?.().catch?.(() => {});
                } catch {}
              }
            }}
          />
          {tapToPlayHint && (
            <div
              style={{
                marginBottom: 8,
                color: "#94a3b8",
                fontSize: 13,
                textAlign: "center",
              }}
            >
              If the camera is blank:{" "}
              <strong>tap inside the camera box once</strong>.
            </div>
          )}
          {cameraDebug && (
            <div
              style={{
                color: "#facc15",
                background: "rgba(234,179,8,0.08)",
                padding: "6px 12px",
                borderRadius: 8,
                marginBottom: 8,
                fontSize: 12,
              }}
            >
              <strong>Camera:</strong> {cameraDebug}
            </div>
          )}

          {/* Result */}
          {result && (
            <div style={styles.resultBox(resultClass)}>{result}</div>
          )}

          {/* Buttons */}
          {showStart && (
            <button
              style={styles.scanBtn}
              onClick={startScanner}
              onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.97)")}
              onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
            >
              📷 Start Scanner
            </button>
          )}
          {showAgain && (
            <button
              style={{
                ...styles.scanBtn,
                background: "linear-gradient(135deg, #059669, #0d9488)",
                boxShadow: "0 4px 20px rgba(5, 150, 105, 0.25)",
              }}
              onClick={startScanner}
            >
              🔄 Scan Again
            </button>
          )}
          <button
            style={styles.manualBtn}
            onClick={() => setShowManual(true)}
          >
            ➕ Add Manually
          </button>

          {/* Session List */}
          {sessionScans.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#64748b",
                  marginBottom: 6,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                Today's scans ({sessionScans.length})
              </div>
              {sessionScans.map((o, i) => (
                <div key={i} style={styles.sessionCard(o.result)}>
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 700,
                      color: "#f1f5f9",
                      minWidth: 64,
                    }}
                  >
                    {o.order}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: "#94a3b8" }}>
                      {o.store
                        ? o.store.toUpperCase()
                        : ""}
                      {o.fulfillment
                        ? ` · ${o.fulfillment}`
                        : ""}
                      {o.financial ? ` · ${o.financial}` : ""}
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: (o.result || "").includes("✅")
                        ? "#4ade80"
                        : (o.result || "").includes("❌")
                        ? "#f87171"
                        : "#facc15",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {statusIcon(o.result)}{" "}
                    {(o.result || "").replace(/^[✅❌⚠️⏳]\s*/, "")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* History Tab */}
      {tab === "history" && (
        <div style={styles.main}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <input
              type="date"
              value={historyDateStart}
              onChange={(e) => setHistoryDateStart(e.target.value)}
              style={styles.dateInput}
            />
            <input
              type="date"
              value={historyDateEnd}
              onChange={(e) => setHistoryDateEnd(e.target.value)}
              placeholder="End date"
              style={styles.dateInput}
            />
            <button
              onClick={fetchHistory}
              disabled={historyLoading}
              style={{
                ...styles.navBtn,
                marginLeft: 0,
                color: "#38bdf8",
                borderColor: "rgba(56, 189, 248, 0.3)",
              }}
            >
              {historyLoading ? "Loading…" : "🔄 Refresh"}
            </button>
            <div
              style={{
                marginLeft: "auto",
                fontSize: 13,
                fontWeight: 700,
                color: "#94a3b8",
              }}
            >
              Returns: {historyRows.length}
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Order #</th>
                  <th style={styles.th}>Store</th>
                  <th style={styles.th}>Fulfillment</th>
                  <th style={styles.th}>Financial</th>
                  <th style={styles.th}>Result</th>
                  <th style={styles.th}>Time</th>
                </tr>
              </thead>
              <tbody>
                {historyRows.map((o, i) => (
                  <tr key={i}>
                    <td style={{ ...styles.td, fontWeight: 700, color: "#f1f5f9" }}>
                      {o.order_name || o.order}
                    </td>
                    <td style={styles.td}>
                      {(o.store || "").toUpperCase()}
                    </td>
                    <td style={styles.td}>{o.fulfillment || ""}</td>
                    <td style={styles.td}>{o.financial || ""}</td>
                    <td
                      style={{
                        ...styles.td,
                        color: (o.result || "").includes("✅")
                          ? "#4ade80"
                          : (o.result || "").includes("❌")
                          ? "#f87171"
                          : "#facc15",
                        fontWeight: 600,
                      }}
                    >
                      {o.result || ""}
                    </td>
                    <td style={{ ...styles.td, fontSize: 11, color: "#64748b" }}>
                      {(o.ts || "")
                        .replace("T", " ")
                        .slice(0, 19)}
                    </td>
                  </tr>
                ))}
                {historyRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      style={{
                        ...styles.td,
                        textAlign: "center",
                        color: "#475569",
                        padding: 24,
                      }}
                    >
                      {historyLoading ? "Loading…" : "No return scans found for this date range."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Manual Add Modal */}
      {showManual && (
        <div style={styles.modalOverlay} onClick={() => setShowManual(false)}>
          <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                marginBottom: 12,
                color: "#f1f5f9",
              }}
            >
              ➕ Add Return Manually
            </div>
            <input
              style={styles.input}
              type="text"
              placeholder="Order number (e.g. 123456 or #123456)"
              value={manualOrder}
              onChange={(e) => setManualOrder(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleManualAdd()}
              autoFocus
            />
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button
                onClick={() => setShowManual(false)}
                style={{
                  flex: 1,
                  padding: "10px 0",
                  borderRadius: 10,
                  border: "1px solid rgba(148, 163, 184, 0.2)",
                  background: "transparent",
                  color: "#94a3b8",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleManualAdd}
                style={{
                  flex: 1,
                  padding: "10px 0",
                  borderRadius: 10,
                  border: "none",
                  background: "linear-gradient(135deg, #2563eb, #7c3aed)",
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
