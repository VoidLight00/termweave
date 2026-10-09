import { useState } from "react";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { pushSupported, testDevicePush } from "../lib/push.ts";
import { useSettings } from "../lib/settings.ts";

type Result = Awaited<ReturnType<typeof testDevicePush>> | "failed" | "sending" | null;

export function PushTestControls({ onEnable }: { onEnable: () => Promise<boolean> }) {
  const { settings } = useSettings();
  const t = useT();
  const [result, setResult] = useState<Result>(null);
  const supported = pushSupported();
  const denied = globalThis.Notification?.permission === "denied";
  const busy = result === "sending";
  const enable = !settings.alertsOn || result === "missing" || result === "permission";

  const send = async (repair: boolean) => {
    setResult("sending");
    try {
      if (repair) setResult(await onEnable() ? "sent" : "failed");
      else setResult(await testDevicePush());
    } catch (error) {
      setResult(error instanceof ApiError && error.code === "subscription_not_found" ? "missing" : "failed");
    }
  };

  return (
    <>
      <div className="settings-row">
        <div><span className="settings-label">{t("Test notification")}</span><span className="settings-description">{t("Check whether this device can receive push alerts")}</span></div>
        <button type="button" className="btn" disabled={busy || !settings.alertsOn || !supported || denied} onClick={() => void send(false)}>{busy ? t("Sending…") : t("Send test")}</button>
      </div>
      <p className="settings-hint" role="status">
        {!supported || result === "unsupported" ? t("Push alerts need HTTPS or localhost, and on iPhone the home-screen app.")
          : denied ? t("Allow notifications in your browser settings, then try again.")
          : result === "sent" ? t("Test notification sent. Check this device for the alert.")
          : result === "missing" ? t("This device's push subscription is missing. Turn alerts on again.")
          : result === "permission" ? t("Allow notifications to test alerts on this device.")
          : result === "failed" ? t("Could not send the test notification. Try again.")
          : !settings.alertsOn ? t("Alerts off") : null}
      </p>
      {enable && supported && !denied && <div className="phone-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void send(true)}>{t("Turn alerts on again")}</button>
      </div>}
    </>
  );
}
