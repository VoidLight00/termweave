import { useT } from "../lib/i18n.ts";
import { useState } from "react";
import { fetchPaneTranscript } from "../lib/api.ts";

/** Bounded literal search of the existing server transcript; no new package or shell command. */
export function TerminalSearch({ paneId, machineId }: { paneId: string | null; machineId: string }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const search = async () => {
    if (!paneId || !query || busy) return;
    setBusy(true); setError(false);
    try { const transcript = await fetchPaneTranscript(paneId, 2000, machineId); setText(transcript.text); }
    catch { setError(true); setText(null); }
    finally { setBusy(false); }
  };
  const lines = text?.split("\n").map((line, index) => ({ line, number: index + 1 })).filter(item => item.line.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  return <details className="dock-search"><summary>{t("Search terminal output")}</summary>
    <form onSubmit={event => { event.preventDefault(); void search(); }}>
      <input aria-label={t("Terminal search query")} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("Search recent 2,000 lines")} />
      <button type="submit" disabled={!paneId || !query || busy}>{busy ? t("Searching") : t("Search")}</button>
    </form>
    {error && <p role="alert">{t("Output could not be read. Check connection and permissions.")}</p>}
    {text !== null && <><p role="status">{t("{n} matches in recent 2,000 lines", { n: lines.length })}</p><pre>{lines.slice(0, 100).map(item => `${item.number}: ${item.line}`).join("\n")}</pre></>}
  </details>;
}
