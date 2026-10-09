import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import "@xterm/xterm/css/xterm.css";
import type { TmuxPaneState } from "../../shared/tmux.ts";
import { terminalTheme, useSettings } from "../lib/settings.ts";
import { terminalFontStack } from "../lib/fontFamily.ts";
import { useT } from "../lib/i18n.ts";

export function TmuxScreen({ target }: { target: TmuxPaneState }) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const { settings, resolvedTheme } = useSettings();
  const initial = useRef(target); initial.current = target;
  const [retry, setRetry] = useState(0);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    setConnected(false);
    let disposed = false;
    const term = new Terminal({ allowProposedApi: true, cursorBlink: true, fontSize: settings.terminalFontSize,
      fontFamily: terminalFontStack(settings.terminalFontFamily), theme: terminalTheme(resolvedTheme, settings.palette, settings), scrollback: 10000 });
    terminal.current = term;
    const fit = new FitAddon(); term.loadAddon(fit);
    const unicode = new UnicodeGraphemesAddon(); term.loadAddon(unicode); term.unicode.activeVersion = "15-graphemes";
    term.open(host.current); fit.fit();
    const address = initial.current;
    const params = new URLSearchParams({ socket: address.socket, generation: address.generation, paneId: address.paneId, sessionId: address.sessionId });
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/tmux/terminal?${params}`);
    let ready = false; let readOnly = true;
    const send = (message: unknown) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 65536) { socket.close(4008, "Input transport stalled"); return; }
      socket.send(JSON.stringify(message));
    };
    const resize = () => { if (disposed) return; fit.fit(); if (ready && !readOnly) send({type:"resize",cols:term.cols,rows:term.rows}); };
    const observer = new ResizeObserver(resize); observer.observe(host.current);
    socket.onmessage = event => {
      if (disposed) return;
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "ready") { ready = true; readOnly = message.readOnly; setConnected(true); resize(); term.focus(); }
        else if (message.type === "output" && typeof message.data === "string")
          term.write(message.data, () => { if (!disposed) send({type:"ack", id:message.id, offset:message.offset}); });
        else socket.close(1008, "Invalid terminal message");
      } catch { socket.close(1008, "Invalid terminal message"); }
    };
    socket.onclose = () => { ready = false; if (!disposed) setConnected(false); };
    socket.onerror = () => { if (!disposed) setConnected(false); };
    const input = term.onData(data => { if (ready && !readOnly) send({type:"input",data}); });
    // Detach only. tmux owns shell lifetime and redraws on the next connection.
    return () => { disposed = true; observer.disconnect(); input.dispose(); socket.close(); term.dispose(); terminal.current = null; };
  }, [target.socket, target.generation, target.sessionId, retry, settings.terminalFontSize, settings.terminalFontFamily, settings.palette, resolvedTheme]);
  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = terminalTheme(resolvedTheme, settings.palette, settings);
  }, [resolvedTheme, settings.palette, settings.appearancePreset, settings.customColors]);
  return <section className="tmux-screen" aria-label={t("tmux terminal")}>
    <div className="tmux-screen-status" role="status">{t(connected ? "Connected to tmux" : "tmux disconnected")}
      {!connected && <button className="btn" onClick={() => setRetry(n => n + 1)}>{t("Reconnect tmux")}</button>}
    </div>
    <div ref={host} className="tmux-screen-host" />
  </section>;
}
