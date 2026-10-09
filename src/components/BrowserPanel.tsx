import { useT } from "../lib/i18n.ts";
import { useEffect, useId, useRef, useState } from "react";
import { developmentPortUrl, FRAME_NOTICE, PREVIEW_SANDBOX, validatePreviewUrl, type PreviewTarget } from "../lib/browserPreview.ts";
import "./BrowserPanel.css";

interface Props { machineId: string }
/** Separate view only: never creates, moves, hides or closes a terminal pane. */
function previewText(id: string, t: ReturnType<typeof useT>): string {
  switch (id) {
    case "preview-frame-notice": return t("Open in a new tab if blank or refused. Frame policies are not bypassed; load does not prove display.");
    case "preview-url-format": return t("Enter a full HTTP or HTTPS URL without spaces or control characters.");
    case "preview-url-invalid": return t("Enter a valid web address.");
    case "preview-credentials": return t("URLs containing credentials are not allowed.");
    case "preview-same-host": return t("Same host or application port cannot be embedded. Open a new tab.");
    case "preview-mixed-content": return t("HTTP embedding from HTTPS is blocked. Open a new tab.");
    case "preview-local-device": return t("localhost is this browser device, not the selected remote PC.");
    case "preview-host-invalid": return t("The current host could not be identified.");
    case "preview-port-local-only": return t("Port assistance is local-loopback only. Enter an explicit private forwarding URL for remote PCs.");
    case "preview-port-invalid": return t("Enter a development port from 1024 to 65535, excluding app ports.");
    default: return id;
  }
}
export function BrowserPanel({ machineId }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [port, setPort] = useState("");
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const context = { appUrl: window.location.href, machineId };
  const credentiallessSupported = "credentialless" in HTMLIFrameElement.prototype;
  const reset = () => { setTarget(null); setFrameUrl(null); };
  const close = () => { setOpen(false); setFrameUrl(null); toggle.current?.focus(); };
  useEffect(() => { setAddress(""); setPort(""); setTarget(null); setFrameUrl(null); setOpen(false); }, [machineId]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  const validate = () => { setFrameUrl(null); setTarget(validatePreviewUrl(address, context)); };
  const preview = () => {
    const checked = validatePreviewUrl(address, context);
    setTarget(checked);
    setFrameUrl(credentiallessSupported && checked.ok && checked.canFrame ? checked.url : null);
  };
  const devPort = () => {
    const checked = developmentPortUrl(port, context);
    setFrameUrl(null); setTarget(checked);
    if (checked.ok) setAddress(checked.url);
  };
  return <section className="browser-preview" aria-label={t("Web preview")} data-preview-machine={machineId}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l" && open) {
        event.preventDefault(); event.stopPropagation(); input.current?.focus(); input.current?.select();
      }
    }}>
    <button ref={toggle} type="button" aria-expanded={open} aria-controls={id} onClick={() => open ? close() : setOpen(true)}>{t("Web preview")} {open ? t("Collapse") : t("Open")}</button>
    {open && <div id={id} className="browser-preview-body">
      <p><code>{machineId}</code>: {t("Addresses open directly in this browser. localhost is this device, not the selected remote PC.")}</p>
      <form className="browser-preview-address" onSubmit={event => { event.preventDefault(); validate(); }}>
        <label htmlFor={`${id}-url`}>{t("Web address")}</label>
        <input ref={input} id={`${id}-url`} type="text" inputMode="url" autoComplete="off" spellCheck={false} value={address}
          placeholder="https://example.com/" onChange={event => { setAddress(event.target.value); reset(); }} />
        <button type="submit">{t("Check address")}</button>
      </form>
      <div className="browser-preview-port">
        <label htmlFor={`${id}-port`}>{t("Local development port")}</label>
        <input id={`${id}-port`} type="text" inputMode="numeric" value={port} onChange={event => setPort(event.target.value)} />
        <button type="button" onClick={devPort}>{t("Create port URL")}</button>
      </div>
      {target && (!target.ok ? <p role="alert">{previewText(target.error, t)}</p> : <>
        <p>{previewText(target.reason, t) || t("Restricted embedding may limit authentication, forms and application features.")}</p>
        <div className="browser-preview-actions">
          <a href={target.url} target="_blank" rel="noopener noreferrer">{t("Open in new tab")}</a>
          <button type="button" disabled={!target.canFrame || !credentiallessSupported} onClick={preview}>{t("Try restricted embedded view")}</button>
          {frameUrl && <button type="button" onClick={() => setFrameUrl(null)}>{t("Stop embedded view")}</button>}
        </div>
      </>)}
      <p className="browser-preview-notice">{previewText(FRAME_NOTICE, t)} {t("Embedded pages handle their own shortcuts. Use Tab to return to address tools.")}</p>
      {!credentiallessSupported && <p>{t("Credentialless embedding is unsupported. Open a new tab.")}</p>}
      {frameUrl && <iframe {...{ credentialless: "" }} title={t("Restricted web preview")} src={frameUrl} sandbox={PREVIEW_SANDBOX} referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'" />}
    </div>}
  </section>;
}
