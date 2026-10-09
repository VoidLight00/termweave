import { useRef, useState } from "react";
import type { HerdrPane } from "../../shared/protocol.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { terminalLink } from "../lib/terminalAddress.ts";

export function TerminalAddress({ pane, machineId }: { pane: HerdrPane; machineId: string }) {
  const t = useT();
  const link = terminalLink(window.location.href, machineId, pane.pane_id);
  const paneInput = useRef<HTMLInputElement>(null);
  const idInput = useRef<HTMLInputElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<"copied" | "manual" | null>(null);
  const copy = async (value: string, input: HTMLInputElement | null) => {
    setMessage(await copyText(value, input) ? "copied" : "manual");
  };
  return <details className="dock-address">
    <summary>{t("Terminal address")}</summary>
    <label>{t("Pane ID")}<input data-address="pane" ref={paneInput} aria-label={t("Pane ID")} readOnly value={pane.pane_id} /></label>
    <button type="button" data-copy="pane" onClick={() => void copy(pane.pane_id, paneInput.current)}>{t("Copy pane ID")}</button>
    <label>{t("Terminal ID")}<input data-address="terminal" ref={idInput} aria-label={t("Terminal ID")} readOnly value={pane.terminal_id} /></label>
    <button type="button" disabled={!pane.terminal_id} data-copy="terminal" onClick={() => void copy(pane.terminal_id, idInput.current)}>{t("Copy terminal ID")}</button>
    <label>{t("Terminal link")}<input data-address="link" ref={linkInput} aria-label={t("Terminal link")} readOnly value={link} /></label>
    <button type="button" data-copy="link" onClick={() => void copy(link, linkInput.current)}>{t("Copy terminal link")}</button>
    <p>{t("This link requires access to this PC. Copy it again after moving the terminal.")}</p>
    {message && <p role="status">{message === "copied" ? t("Address copied") : t("Copy unavailable. The address is selected; copy it manually.")}</p>}
  </details>;
}
