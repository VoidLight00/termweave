import { useEffect, useId, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from "react";
import { Clock, RefreshCw, TriangleAlert } from "lucide-react";

import "./UsageMeters.css";

import type { ProviderUsage, UsageWindow } from "../../shared/protocol.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useSettings, type UsageCount } from "../lib/settings.ts";
import { formatPercent, formatResetIn, HIGH_PERCENT, meterPercent, meterText, orderProviders, PROVIDER_MARK, PROVIDER_NAME, tightestWindow, usageName, useUsage, windowLabel, formatResetAt, formatResetShort, leftLevel } from "../lib/usage.ts";
import { AgentMark } from "./AgentMark.tsx";

/** chips the strip beside Settings holds before the rest fold into "+N" */
const MAX_CHIPS = 4;

function level(window: UsageWindow | null): string {
  return window !== null && window.used_percent >= HIGH_PERCENT ? " is-high" : "";
}

/** Why the numbers shown are old or missing; null while they are fresh. */
function problemText(t: Translate, usage: ProviderUsage): string | null {
  const name = PROVIDER_NAME[usage.id];
  return usage.problem === "expired" ? t("Sign-in expired. Open {name} to renew it.", { name })
    : usage.problem === "rate_limited" ? t("{name} asked to slow down. These are the last numbers.", { name })
    : usage.problem === "failed" ? t("{name} could not be reached.", { name })
    : usage.problem === "locked" ? t("The server cannot open the keychain holding this sign-in.")
    : null;
}

/** An expired sign-in or an unreachable provider is an error; slowed down or locked, the last numbers stand. */
function isError(usage: ProviderUsage): boolean {
  return usage.problem === "expired" || usage.problem === "failed";
}

function Chip({ usage, count }: { usage: ProviderUsage; count: UsageCount }) {
  const window = tightestWindow(usage);
  return (
    <span className={`usage-chip${level(window)}${usage.problem ? " has-problem" : ""}`}>
      <AgentMark agent={PROVIDER_MARK[usage.id]} size={14} />
      <span className="usage-chip-value">{window ? formatPercent(meterPercent(window, count)) : "—"}</span>
      <span className="usage-chip-bar" style={{ "--fill": `${window ? meterPercent(window, count) : 0}%` } as CSSProperties} />
    </span>
  );
}

function Provider({ usage, now, count }: { usage: ProviderUsage; now: number; count: UsageCount }) {
  const t = useT();
  const name = PROVIDER_NAME[usage.id];
  const problem = problemText(t, usage);
  return (
    <section className="usage-provider" aria-label={usageName(usage)}>
      <header className="usage-provider-head">
        <AgentMark agent={PROVIDER_MARK[usage.id]} size={16} />
        <span className="usage-provider-name">{name}</span>
        {usage.plan && <span className="usage-plan">{usage.plan}</span>}
        {usage.account && <span className="usage-account" title={usage.account}>{usage.account}</span>}
      </header>
      {problem && <p className={`usage-note${isError(usage) ? " is-problem" : ""}`}>{problem}</p>}
      {usage.windows.map((window, index) => {
        const reset = formatResetIn(window.resets_at, now);
        const value = meterPercent(window, count);
        return (
          <div key={index} className={`usage-row${level(window)}`}>
            <span className="usage-row-label">{windowLabel(window)}</span>
            {reset && <span className="usage-row-reset">{t("Resets in {time}", { time: reset })}</span>}
            <span className="usage-row-value">{meterText(window, count)}</span>
            <span className="usage-bar" role="meter" aria-label={windowLabel(window)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={meterText(window, count)}>
              {/* a sliver above 0 still shows as a bar, not a dot */}
              <span style={{ width: value > 0 ? `max(4px, ${value}%)` : 0 }} />
            </span>
          </div>
        );
      })}
      {usage.windows.length === 0 && !problem && <p className="usage-note">{t("No limits reported")}</p>}
    </section>
  );
}

/**
 * The plan limits of the subscriptions signed in on the server's PC, beside Settings: per
 * provider its logo and the limit closest to running out; the whole strip opens every limit
 * with its reset time.
 */
export function UsageMeters() {
  const t = useT();
  const { settings } = useSettings();
  const footer = settings.showUsage && settings.usagePlacement === "footer";
  const { report, loading, refresh } = useUsage(footer);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLButtonElement>(null);

  // moved to the top of the list, the popover closes: its clock and listener go with it
  useEffect(() => { if (!footer) setOpen(false); }, [footer]);
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      clearInterval(tick);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  // Escape and focus belong to the meters only while focus is in them: other dialogs keep theirs
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    setOpen(false);
    stripRef.current?.focus();
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  };

  const count = settings.usageCount;
  // an account hidden in Settings is left out of the strip and the popover alike
  const shown = report ? orderProviders(report.providers, settings.usageOrder).filter((usage) => !settings.usageHidden.includes(usage.key)) : [];
  if (!footer || shown.length === 0) return null;
  const folded = shown.length > MAX_CHIPS ? shown.length - (MAX_CHIPS - 1) : 0;
  const chips = folded > 0 ? shown.slice(0, MAX_CHIPS - 1) : shown;
  const summary = shown.map((usage) => {
    const window = tightestWindow(usage);
    return `${usageName(usage)} ${window ? meterText(window, count) : "—"}`;
  }).join(", ");

  return (
    <div className="usage" ref={rootRef} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={stripRef}
        type="button"
        className="usage-strip"
        aria-expanded={open}
        aria-label={`${t("Subscription usage")}: ${summary}`}
        title={summary}
        onClick={() => setOpen(!open)}
      >
        {chips.map((usage) => <Chip key={usage.key} usage={usage} count={count} />)}
        {folded > 0 && <span className="usage-more">+{folded}</span>}
      </button>
      {open && (
        <div className="usage-popover" role="dialog" aria-label={t("Subscription usage")}>
          <header className="usage-popover-head">
            <span>{t("Subscription usage")}</span>
            {/* busy, not disabled: a disabled button drops focus, and Escape with it */}
            <button type="button" className="icon-button" aria-label={t("Refresh")} title={t("Refresh")} aria-busy={loading} onClick={() => { if (!loading) refresh(); }}>
              <RefreshCw aria-hidden="true" className={loading ? "is-spinning" : undefined} />
            </button>
          </header>
          {shown.map((usage) => <Provider key={usage.key} usage={usage} now={now} count={count} />)}
        </div>
      )}
    </div>
  );
}

/**
 * The plan meters as a panel at the top of the sidebar (Settings → Plan limits → Where): one
 * row per account with its logo, plan, the limit closest to running out and when it resets.
 * The panel opens every limit, as the strip's popover does.
 */
export function UsagePanel() {
  const t = useT();
  const { settings } = useSettings();
  const top = settings.showUsage && settings.usagePlacement === "top";
  const { report, loading, refresh } = useUsage(top);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const detailId = useId();
  useEffect(() => {
    if (!top) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, [top]);

  const count = settings.usageCount;
  const shown = report ? orderProviders(report.providers, settings.usageOrder).filter((usage) => !settings.usageHidden.includes(usage.key)) : [];
  if (!top || shown.length === 0) return null;
  return (
    <section className="usage-panel" aria-label={t("Subscription usage")}>
      <button type="button" className="usage-panel-rows" aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={() => setOpen(!open)}>
        {shown.map((usage) => {
          const window = tightestWindow(usage);
          const value = window ? meterPercent(window, count) : 0;
          const reset = window ? formatResetShort(window.resets_at, now) : null;
          const resetAt = window && reset !== null ? formatResetAt(window.resets_at, now) : null;
          const problem = problemText(t, usage);
          // two accounts of one provider are told apart by the account; one alone needs no address
          const twin = shown.some((other) => other !== usage && other.id === usage.id);
          return (
            <span key={usage.key} className={`usage-panel-row${level(window)}${window ? ` is-left-${leftLevel(window)}` : ""}${usage.problem ? " has-problem" : ""}`}>
              <AgentMark agent={PROVIDER_MARK[usage.id]} size={16} />
              <span className="usage-panel-name">
                {PROVIDER_NAME[usage.id]}
                {usage.plan && <span className="usage-plan" title={usage.plan}>{usage.plan}</span>}
                {twin && usage.account && <span className="usage-account" title={usage.account}>{usage.account}</span>}
              </span>
              {/* the number large; whether it counts what is used or what is left, small under it */}
              <span className="usage-panel-value" aria-label={window ? meterText(window, count) : undefined}>
                <span className="usage-panel-percent">{window ? formatPercent(meterPercent(window, count)) : "—"}</span>
                {window && <span className="usage-panel-count">{t(count === "left" ? "left" : "used")}</span>}
              </span>
              <span className="usage-bar" aria-hidden="true"><span style={{ width: value > 0 ? `max(4px, ${value}%)` : 0 }} /></span>
              {window && (
                <span className="usage-panel-window" title={reset ? t("Resets in {time}", { time: reset }) : undefined}>
                  {windowLabel(window)}{reset ? ` · ${reset}` : ""}{resetAt ? ` (${resetAt})` : ""}
                </span>
              )}
              {/* the chip beside Settings only dims; the row has room to say why */}
              {problem && (
                <span className={`usage-panel-problem${isError(usage) ? " is-problem" : ""}`}>
                  {isError(usage) ? <TriangleAlert aria-hidden="true" /> : <Clock aria-hidden="true" />}
                  {problem}
                </span>
              )}
            </span>
          );
        })}
      </button>
      {open && (
        <div id={detailId} className="usage-panel-detail">
          <header className="usage-popover-head">
            <span>{t("Subscription usage")}</span>
            <button type="button" className="icon-button" aria-label={t("Refresh")} title={t("Refresh")} aria-busy={loading} onClick={() => { if (!loading) refresh(); }}>
              <RefreshCw aria-hidden="true" className={loading ? "is-spinning" : undefined} />
            </button>
          </header>
          {shown.map((usage) => <Provider key={usage.key} usage={usage} now={now} count={count} />)}
        </div>
      )}
    </section>
  );
}
