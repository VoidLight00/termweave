import { useEffect, useRef, useState } from "react";
import { LockKeyhole, Send } from "lucide-react";
import { validSecret } from "../../shared/secret-prompt.ts";
import { useT } from "../lib/i18n.ts";
import type { SubmitResult } from "../lib/ws.ts";
import "./SecretInput.css";

/** A DOM-only value: no drafts, queue, React state or retry copy of the secret. */
export function SecretInput({ prompt, onSend, onCancel }: {
  prompt: string;
  onSend: (value: string) => Promise<SubmitResult> | null;
  onCancel: () => void;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    alive.current = true;
    const clear = () => { if (input.current) input.current.value = ""; };
    const hidden = () => { if (document.hidden) clear(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", clear);
    return () => { alive.current = false; clear(); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", clear); };
  }, []);
  return <form className="secret-input" onSubmit={(event) => {
    event.preventDefault();
    if (busy.current || !input.current) return;
    let value = input.current.value;
    input.current.value = "";
    if (!validSecret(value)) { setError(t("Enter a single-line password or PIN.")); return; }
    busy.current = true; setPending(true); setError(null);
    const result = onSend(value);
    value = "";
    void Promise.resolve(result).then((result) => {
      if (!alive.current) return;
      if (!result?.ok) setError(result?.code === "unsupported" ? t("Update this PC to use masked input.") : t("Check the terminal before entering the secret again."));
    }, () => { if (alive.current) setError(t("Check the terminal before entering the secret again.")); }).finally(() => {
      busy.current = false;
      if (alive.current) setPending(false);
    });
  }}>
    <label className="secret-input-label"><LockKeyhole size={16} aria-hidden="true" /> {prompt}
      <input ref={input} className="input" type="password" aria-label={t("Password or PIN")} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={4096} disabled={pending}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }} />
    </label>
    <p className="secret-input-note">{t("Sent directly to this terminal. Never saved as a draft or queued.")}</p>
    <div className="secret-input-actions">
      <button type="submit" className="btn btn-primary" disabled={pending}><Send size={14} aria-hidden="true" /> {t("Send")}</button>
      <button type="button" className="btn" disabled={pending} onClick={() => { if (input.current) input.current.value = ""; onCancel(); }}>{t("Cancel")}</button>
    </div>
    {error && <p className="secret-input-error" role="status">{error}</p>}
  </form>;
}
