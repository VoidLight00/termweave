import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { FrontendUpdateController, readDeployedBuildId, shouldAutoUpdate, type FrontendUpdateState } from "../lib/frontendUpdate.ts";
import { frontendInputPending, pageHasDrafts } from "../lib/frontendReloadSafety.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { terminalDraftReloadState } from "../lib/terminalDraft.ts";
import { messageQueues } from "../lib/messageQueue.ts";
import { useT } from "../lib/i18n.ts";
import "./FrontendControls.css";

/** Separate from native/server installation controls, available even while disconnected. */
export function FrontendControls() {
  const t = useT();
  const confirmation = useRef("");
  confirmation.current = t("Reload this page? Saved drafts stay, but unsaved form input and attachments may be lost. Terminal sessions keep running.");
  const controller = useRef<FrontendUpdateController | null>(null);
  const [state, setState] = useState<FrontendUpdateState>({ available: false, busy: false });
  const [notice, setNotice] = useState(false);
  useEffect(() => {
    let approvedDrafts: string | null = null;
    const allowReload = (recheck = false) => {
      const terminalDraft = terminalDraftReloadState();
      if (terminalDraft.pending || frontendInputPending() || composerDrafts.hasPendingInput() || messageQueues.hasPendingInput()
        || document.querySelector('[aria-busy="true"]')) { setNotice(true); return false; }
      const drafts = terminalDraft.drafts || composerDrafts.hasDrafts() || messageQueues.hasDrafts() || pageHasDrafts(document);
      const signature = JSON.stringify([...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input")].map(input => input.value));
      if (recheck && approvedDrafts === signature) return true;
      if (!drafts || window.confirm(confirmation.current)) { approvedDrafts = signature; return true; }
      return false;
    };
    const model = new FrontendUpdateController({
      currentId: document.querySelector<HTMLMetaElement>('meta[name="frontend-build-id"]')?.content ?? null,
      readDeployedId: readDeployedBuildId,
      registration: async () => "serviceWorker" in navigator ? navigator.serviceWorker.getRegistration() : undefined,
      onControllerChange: listener => {
        navigator.serviceWorker.addEventListener("controllerchange", listener);
        return () => navigator.serviceWorker.removeEventListener("controllerchange", listener);
      },
      allowReload,
      reload: () => window.location.reload(),
    }, setState);
    controller.current = model;
    // A deploy is applied without a click once the page is idle and holds nothing unsent (phone, tab, Mac app).
    let lastInput = Date.now();
    const touched = () => { lastInput = Date.now(); };
    const inputEvents = ["keydown", "pointerdown", "touchstart", "compositionstart", "input", "wheel"] as const;
    for (const name of inputEvents) window.addEventListener(name, touched, { capture: true, passive: true });
    const quiet = () => {
      const terminalDraft = terminalDraftReloadState();
      return !(terminalDraft.pending || terminalDraft.drafts || frontendInputPending() || composerDrafts.hasPendingInput() || messageQueues.hasPendingInput()
        || composerDrafts.hasDrafts() || messageQueues.hasDrafts() || pageHasDrafts(document) || document.querySelector('[aria-busy="true"]'));
    };
    const autoUpdate = () => {
      if (document.visibilityState === "hidden") return;
      if (shouldAutoUpdate({ ...model.state, idleMs: Date.now() - lastInput, quiet: quiet() })) void model.update();
    };
    const check = () => { if (document.visibilityState !== "hidden") void model.check().then(autoUpdate); };
    check();
    const timer = setInterval(check, 30_000);
    const autoTimer = setInterval(autoUpdate, 5_000);
    window.addEventListener("online", check);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer); clearInterval(autoTimer); model.dispose(); controller.current = null;
      for (const name of inputEvents) window.removeEventListener(name, touched, { capture: true });
      window.removeEventListener("online", check); window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return <div className="frontend-controls" role="group" aria-label={t("Web app controls")}>
    <a className="btn" href="/tmux" target="_blank" rel="noopener noreferrer">tmux</a>
    {state.available && <button type="button" className="btn frontend-update" disabled={state.busy}
      aria-label={t("Update web app")} title={t("Use the already deployed web app. Does not install server or native updates.")}
      onClick={() => { setNotice(false); void controller.current?.update(); }}>{t("Update web app")}</button>}
    <button type="button" className="icon-button frontend-refresh" disabled={state.busy}
      aria-label={t("Refresh page")} title={t("Reload this web page. Terminal sessions keep running.")}
      onClick={() => { setNotice(false); controller.current?.refresh(); }}><RefreshCw aria-hidden="true" /><span>{t("Refresh page")}</span></button>
    {notice && <span className="frontend-reload-note" role="status">{t("Input is still being sent. Please wait, then try again.")}</span>}
  </div>;
}
