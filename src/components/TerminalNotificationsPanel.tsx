import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Inbox, X } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { clearTerminalNotifications, listTerminalNotifications, readTerminalNotification, resolveTerminalNotification } from "../lib/terminalNotifications.ts";
import type { NotificationTarget, TerminalNotificationList } from "../../shared/terminal-notifications.ts";
import "./TerminalNotificationsPanel.css";

type Props = { readOnly: boolean; onSelect: (target: NotificationTarget) => void };
/** Separate from OS alert permission: this local inbox is available without push permission. */
export function TerminalNotificationCenter({ readOnly, onSelect }: Props) {
  const t = useT(); const [open, setOpen] = useState(false);
  return <><button className="icon-button" aria-label={t("Terminal inbox")} title={t("Terminal inbox")} onClick={() => setOpen(true)}><Inbox size={16} /></button>{open && <TerminalNotificationsPanel readOnly={readOnly} onSelect={onSelect} onClose={() => setOpen(false)} />}</>;
}
export function TerminalNotificationsPanel({ readOnly, onSelect, onClose }: Props & { onClose: () => void }) {
  const t = useT(); const id = useId(); const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<TerminalNotificationList | null>(null); const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0); const [pending, setPending] = useState(false); const [unavailable, setUnavailable] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false); const busy = useRef(false); const action = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const surface = dialog.current; surface?.showModal();
    return () => { surface?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => () => action.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const next = await listTerminalNotifications(controller.signal); if (!controller.signal.aborted) { setData(next); setError(false); } }
      catch { if (!controller.signal.aborted) setError(true); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void load(), 5000); }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [revision]);
  const act = async (kind: "select" | "read" | "clear", notificationId = 0) => {
    if (busy.current || (readOnly && kind !== "select")) return;
    busy.current = true; setPending(true); setUnavailable(false);
    const controller = new AbortController(); action.current = controller;
    try {
      if (kind === "select") {
        const target = await resolveTerminalNotification(notificationId, controller.signal);
        if (!controller.signal.aborted) { onSelect(target); onClose(); }
      } else {
        if (kind === "clear") await clearTerminalNotifications(controller.signal);
        else await readTerminalNotification(notificationId, controller.signal);
        if (!controller.signal.aborted) { setConfirmClear(false); setRevision(value => value + 1); }
      }
    } catch { if (!controller.signal.aborted) { if (kind === "select") setUnavailable(true); else setError(true); } }
    finally { busy.current = false; if (!controller.signal.aborted) setPending(false); }
  };
  return createPortal(<dialog ref={dialog} className="terminal-inbox" aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2 id={id}>{t("Terminal inbox")}</h2><button className="icon-button" aria-label={t("Close")} onClick={onClose} autoFocus><X size={18} /></button></header>
    <div className="terminal-inbox-body">
      <p>{t("Messages from terminal programs. Messages do not confirm task completion.")}</p>
      {data?.sourceStatus === "unavailable" && <p role="status">{t("Live terminal notifications are unavailable on this runtime. Saved messages remain visible.")}</p>}
      {error && <p role="status">{t("Could not refresh the inbox. Previously loaded messages may be out of date.")}</p>}
      {unavailable && <p role="status">{t("The terminal could not be verified. Refresh the inbox before trying again.")}</p>}
      {!data && !error && <p role="status">{t("Loading…")}</p>}
      {data && <><div className="terminal-inbox-actions"><span>{t("{count} unread messages", { count: data.unread })}</span><button className="btn" disabled={pending} onClick={() => setRevision(value => value + 1)}>{t("Refresh")}</button></div>
        {data.items.length === 0 ? <p>{t("No terminal messages yet.")}</p> : <ol>{data.items.map(item => <li key={item.id}>
          <div className="terminal-inbox-meta"><span>{item.target ? `P${item.target.paneNumber}` : t("Terminal unavailable")}</span><time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString()}</time>{!item.read && <span>{t("Unread")}</span>}</div>
          <h3>{item.title}</h3>{item.body && <p className="terminal-inbox-message">{item.body}</p>}
          <div className="terminal-inbox-actions"><button className="btn" disabled={pending || !item.target} onClick={() => void act("select", item.id)}>{t("View terminal")}</button>{!readOnly && !item.read && <button className="btn" disabled={pending} onClick={() => void act("read", item.id)}>{t("Mark as read")}</button>}</div>
        </li>)}</ol>}
        {!readOnly && data.items.length > 0 && <div className="terminal-inbox-clear">{confirmClear ? <><p>{t("Clear the shared inbox? Terminal processes will keep running.")}</p><div className="terminal-inbox-actions"><button className="btn" disabled={pending} onClick={() => void act("clear")}>{t("Clear inbox")}</button><button className="btn" disabled={pending} onClick={() => setConfirmClear(false)}>{t("Cancel")}</button></div></> : <button className="btn" disabled={pending} onClick={() => setConfirmClear(true)}>{t("Clear inbox")}</button>}</div>}
      </>}
    </div>
  </dialog>, document.body);
}
