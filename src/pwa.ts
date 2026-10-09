// Registers the service worker. navigator.serviceWorker only exists in secure
// contexts (https:// or localhost), so on a plain http:// LAN/tailnet IP this
// silently does nothing and the app still works uncached.
window.addEventListener("load", () => {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
    console.warn("service worker registration failed", err);
  });
});
