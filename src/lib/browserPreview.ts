export interface PreviewContext { appUrl: string; machineId: string }
export type PreviewTarget = { ok: true; url: string; canFrame: boolean; reason: string; loopback: boolean } | { ok: false; error: string };
export const PREVIEW_SANDBOX = "allow-scripts";
export const FRAME_NOTICE = "preview-frame-notice";

export function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\./.test(hostname);
}

/** Pure client policy. No network probe, host lookup, cookie forwarding or server proxy. */
export function validatePreviewUrl(input: string, context: PreviewContext): PreviewTarget {
  const text = input.trim();
  if (!/^https?:\/\//i.test(text) || /[\u0000- \u007f\\]/.test(text))
    return { ok: false, error: "preview-url-format" };
  let url: URL, app: URL;
  try { url = new URL(text); app = new URL(context.appUrl); }
  catch { return { ok: false, error: "preview-url-invalid" }; }
  if (url.username || url.password) return { ok: false, error: "preview-credentials" };
  const loopback = isLoopback(url.hostname);
  const reason = url.hostname === app.hostname || url.port === "7317"
    ? "preview-same-host"
    : app.protocol === "https:" && url.protocol === "http:"
      ? "preview-mixed-content"
      : loopback && (context.machineId !== "local" || !isLoopback(app.hostname))
        ? "preview-local-device"
        : "";
  return { ok: true, url: url.href, canFrame: !reason, reason, loopback };
}

/** Deliberately unavailable on phones/remote UI: 'local' identifies the server, not this device. */
export function developmentPortUrl(port: string, context: PreviewContext): PreviewTarget {
  let app: URL;
  try { app = new URL(context.appUrl); } catch { return { ok: false, error: "preview-host-invalid" }; }
  if (context.machineId !== "local" || !isLoopback(app.hostname))
    return { ok: false, error: "preview-port-local-only" };
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535 || Number(port) === 7317 || Number(port) === Number(app.port))
    return { ok: false, error: "preview-port-invalid" };
  return validatePreviewUrl(`http://${app.hostname}:${Number(port)}/`, context);
}
