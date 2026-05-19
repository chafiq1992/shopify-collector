// Capture a DOM node to a PNG and (best-effort) copy it to the system clipboard.
// Uses html-to-image, lazy-loaded so the page bundle doesn't pay for it unless used.

export async function copyNodeAsPng(node, { pixelRatio = 2, filenameHint = "order-label" } = {}) {
  if (!node) throw new Error("nothing to capture");
  const { toBlob } = await import("html-to-image");
  // `cacheBust` re-fetches images so cross-origin tainting is less likely to throw.
  const blob = await toBlob(node, {
    pixelRatio,
    cacheBust: true,
    backgroundColor: "#ffffff",
    skipFonts: false,
  });
  if (!blob) throw new Error("capture produced no blob");

  // Try writing the image to the system clipboard.
  let clipboardOk = false;
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      clipboardOk = true;
    }
  } catch {
    clipboardOk = false;
  }

  // Always offer a download as a fallback (and to confirm the image was generated even
  // if the browser blocks the clipboard write).
  const url = URL.createObjectURL(blob);
  return { blob, url, clipboardOk, filename: `${filenameHint}.png` };
}

export function triggerDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "label.png";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try { document.body.removeChild(a); } catch {}
    try { URL.revokeObjectURL(url); } catch {}
  }, 1500);
}
