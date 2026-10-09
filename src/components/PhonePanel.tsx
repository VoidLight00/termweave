import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import "./PhonePanel.css";

import { copyText } from "../lib/clipboard.ts";
import type { PhonePlan } from "../lib/phone.ts";
import { QrCode } from "./QrCode.tsx";
import { useT } from "../lib/i18n.ts";

const README_PHONE = "https://github.com/devswha/herdr-web-ui#on-your-phone";
const README_SAFETY = "https://github.com/devswha/herdr-web-ui#access-and-safety";

export interface PhonePanelProps {
  plan: PhonePlan;
  /** the server is still being asked */
  loading: boolean;
  onRefresh: () => void;
}

/** Settings → Phone: the address a phone can open, or the one step still missing on this PC. */
export function PhonePanel({ plan, loading, onRefresh }: PhonePanelProps) {
  const t = useT();
  return <div className="phone-panel">{loading && plan.kind !== "here" ? <p className="settings-hint" role="status">{t("Asking this PC about Tailscale…")}</p> : <Plan plan={plan} loading={loading} onRefresh={onRefresh} />}</div>;
}

function Plan({ plan, loading, onRefresh }: PhonePanelProps) {
  const t = useT();
  const checkAgain = <button type="button" className="btn" onClick={onRefresh} disabled={loading}><RefreshCw aria-hidden="true" />{t("Check again")}</button>;
  switch (plan.kind) {
    case "here":
    case "served":
      return (
        <>
          <Address url={plan.url} title={t(plan.kind === "here" ? "Open this address on your phone" : "Tailscale already serves this PC")} />
          <p className="settings-description">{t("Once it is open, install the app and tap the bell for alerts.")}</p>
          {plan.kind === "served" && <Sharing />}
        </>
      );
    case "command":
      return (
        <>
          <p className="settings-description">{t("In a terminal on this PC, publish the app to your tailnet. Only devices in your tailnet can open the address.")}</p>
          <Command command={plan.command} />
          {plan.url !== null && <p className="settings-description">{t("It will be at {url}.", { url: plan.url })}</p>}
          <div className="phone-actions">{checkAgain}</div>
          <Sharing />
        </>
      );
    case "stopped":
      return (
        <>
          <p className="settings-description">{t("Tailscale is on this PC but not connected. Run tailscale up there, then check again.")}</p>
          <div className="phone-actions">{checkAgain}</div>
        </>
      );
    case "missing":
      return (
        <>
          <p className="settings-description">{t("Tailscale is the shortest route: install it on this PC, run tailscale up, then check again. An SSH tunnel or your own HTTPS proxy work too.")}</p>
          <p className="settings-description"><a href="https://tailscale.com/download" target="_blank" rel="noreferrer">{t("Get Tailscale")}</a> · <a href={README_PHONE} target="_blank" rel="noreferrer">{t("Other routes")}</a></p>
          <div className="phone-actions">{checkAgain}</div>
        </>
      );
    default:
      return (
        <>
          <p className="settings-description">{t("This PC did not say how it can be reached.")} <a href={README_PHONE} target="_blank" rel="noreferrer">{t("Other routes")}</a></p>
          <div className="phone-actions">{checkAgain}</div>
        </>
      );
  }
}

function Address({ url, title }: { url: string; title: string }) {
  return (
    <div className="phone-address">
      <QrCode value={url} label={`QR code: ${url}`} />
      <div>
        <p className="settings-label">{title}</p>
        <p className="phone-url"><a href={url} target="_blank" rel="noreferrer">{url}</a></p>
      </div>
    </div>
  );
}

function Command({ command }: { command: string }) {
  const t = useT();
  const codeRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyText(command, codeRef.current))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="phone-command">
      <code ref={codeRef}>{command}</code>
      <button type="button" className="btn" onClick={() => void copy()}>{t(copied ? "Copied" : "Copy")}</button>
    </div>
  );
}

function Sharing() {
  const t = useT();
  return <p className="settings-hint">{t("Your own Tailscale devices get in as you; with an access token set, each asks for it once. Anyone else's device, or a LAN or public address, needs pairing: Devices, below.")} <a href={README_SAFETY} target="_blank" rel="noreferrer">{t("Access and safety")}</a></p>;
}
