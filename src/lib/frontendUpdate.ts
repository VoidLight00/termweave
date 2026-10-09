export interface FrontendUpdateState { available: boolean; busy: boolean }
export interface FrontendUpdateEnvironment {
  currentId: string | null;
  readDeployedId: () => Promise<string | null>;
  registration: () => Promise<ServiceWorkerRegistration | undefined>;
  onControllerChange: (listener: () => void) => () => void;
  allowReload: (recheck?: boolean) => boolean;
  reload: () => void;
}
export function buildIdFromHtml(html: string): string | null {
  const match = /<meta\s+name="frontend-build-id"\s+content="([a-f0-9]{64})"\s*\/?\s*>/i.exec(html);
  return match?.[1]?.toLowerCase() ?? null;
}
export async function readDeployedBuildId(): Promise<string | null> {
  if (!navigator.onLine) return null;
  const response = await fetch(`/?frontend-build-check=${Date.now()}`, {
    cache: "no-store", credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(8000),
    headers: { Accept: "text/html" },
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return null;
  return buildIdFromHtml(await response.text());
}
function waitForInstalled(worker: ServiceWorker): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      if (worker.state !== "installed" && worker.state !== "activated" && worker.state !== "redundant") return;
      clearTimeout(timer); worker.removeEventListener("statechange", finish);
      if (worker.state === "redundant") reject(new Error("Worker install failed")); else resolve();
    };
    const timer = setTimeout(() => {
      worker.removeEventListener("statechange", finish); reject(new Error("Worker install timed out"));
    }, 10_000);
    worker.addEventListener("statechange", finish); finish();
  });
}
/** Detection never navigates, clears storage, or touches the native update API. */
export class FrontendUpdateController {
  state: FrontendUpdateState = { available: false, busy: false };
  private checking = false;
  private stopped = false;
  private reloaded = false;
  private cancelActivation: (() => void) | null = null;
  constructor(private env: FrontendUpdateEnvironment, private changed: (state: FrontendUpdateState) => void) {}
  private set(next: FrontendUpdateState): void {
    if (this.stopped || next.available === this.state.available && next.busy === this.state.busy) return;
    this.state = next; this.changed(next);
  }
  async check(): Promise<void> {
    if (this.checking || this.stopped || !this.env.currentId) return;
    this.checking = true;
    try {
      const deployed = await this.env.readDeployedId();
      this.set({ ...this.state, available: !!deployed && deployed !== this.env.currentId });
    } catch { this.set({ ...this.state, available: false }); }
    finally { this.checking = false; }
  }
  refresh(): void { if (!this.state.busy && this.env.allowReload()) this.reloadOnce(); }
  private reloadOnce(): void {
    if (this.reloaded || this.stopped) return;
    this.reloaded = true; this.env.reload();
  }
  async update(): Promise<void> {
    if (!this.state.available || this.state.busy || this.reloaded || !this.env.allowReload()) return;
    this.set({ ...this.state, busy: true });
    try {
      // Recheck before activation: a failed/offline check must not reload an old cached shell.
      const deployed = await this.env.readDeployedId();
      if (!deployed || deployed === this.env.currentId) { this.set({ available: false, busy: false }); return; }
      const registration = await this.env.registration();
      if (registration && !registration.waiting) await registration.update();
      if (registration?.installing) await waitForInstalled(registration.installing);
      if (this.stopped) return;
      const waiting = registration?.waiting;
      if (!waiting) {
        if (this.env.allowReload(true)) this.reloadOnce();
        this.set({ ...this.state, busy: false }); return;
      }
      // Register before posting; only this user click authorizes a single reload.
      let done = false;
      const finish = (activate: boolean) => {
        if (done) return; done = true;
        clearTimeout(timer); remove(); this.cancelActivation = null;
        if (activate && this.env.allowReload(true)) this.reloadOnce();
        this.set({ ...this.state, busy: false });
      };
      const remove = this.env.onControllerChange(() => finish(true));
      const timer = setTimeout(() => finish(false), 10_000);
      this.cancelActivation = () => finish(false);
      waiting.postMessage({ type: "SKIP_WAITING" });
    } catch { this.cancelActivation?.(); this.set({ ...this.state, busy: false }); }
  }
  dispose(): void { this.stopped = true; this.cancelActivation?.(); }
}

/** Idle time before a detected deploy is applied without a click (phone, browser tab, Mac app). */
export const AUTO_UPDATE_IDLE_MS = 5_000;
/**
 * Apply a deployed web app by itself only when nothing could be lost: an update is available, no update
 * is running, the person has not touched the page for AUTO_UPDATE_IDLE_MS, and there is no draft or
 * pending input. Anything else keeps the manual Update button.
 */
export function shouldAutoUpdate(input: { available: boolean; busy: boolean; idleMs: number; quiet: boolean }): boolean {
  return input.available && !input.busy && input.quiet && input.idleMs >= AUTO_UPDATE_IDLE_MS;
}
