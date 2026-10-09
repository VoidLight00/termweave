import { forwardRef, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ChevronDown, Terminal } from "lucide-react";

import type { AgentKind } from "../../shared/protocol.ts";
import { AgentMark } from "./AgentMark.tsx";

/** The shell entry is a program name like the agents beside it, so it stays in English. */
const SHELL_LABEL = "Shell";

export interface AgentPickerProps {
  agents: AgentKind[];
  /** the chosen kind; "" is a plain shell */
  value: string;
  disabled?: boolean;
  labelledBy: string;
  onChange: (kind: string) => void;
}

function OptionMark({ kind }: { kind: string }) {
  return kind ? <AgentMark agent={kind} size={16} /> : <span className="agent-picker-shell"><Terminal aria-hidden="true" /></span>;
}

/**
 * A select whose rows carry each agent's mark: a native <option> cannot hold an icon.
 * The marks are the inline SVGs the sidebar already renders, so the list costs nothing extra.
 */
export const AgentPicker = forwardRef<HTMLButtonElement, AgentPickerProps>(function AgentPicker({ agents, value, disabled, labelledBy, onChange }, ref) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<CSSProperties>({});
  const options: AgentKind[] = [{ kind: "", label: SHELL_LABEL }, ...agents];
  const selectedIndex = Math.max(0, options.findIndex((option) => option.kind === value));
  const selected = options[selectedIndex]!;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onMove = (event: Event): void => {
      if (!(event.target instanceof Node && rootRef.current?.contains(event.target))) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  const show = (): void => {
    // fixed to the trigger, so the modal body's scroll box does not clip the list
    const rect = rootRef.current!.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 16;
    const up = below < 160 && rect.top > below;
    const room = up ? rect.top - 16 : below;
    setPlace({
      left: rect.left,
      width: rect.width,
      maxHeight: Math.min(320, room),
      ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    });
    setActive(selectedIndex);
    setOpen(true);
  };

  const choose = (index: number): void => {
    onChange(options[index]!.kind);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const last = options.length - 1;
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        show();
      }
      return;
    }
    if (event.key === "Escape") {
      // cancel: close the list only, not the dialog around it
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Tab") {
      // a select-only combobox takes the row it is on as focus moves on, as a native select does
      choose(active);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(last, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : last);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(active);
    }
  };

  return (
    <div className="agent-picker" ref={rootRef}>
      <button
        ref={ref}
        type="button"
        className="select agent-picker-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={labelledBy}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <OptionMark kind={selected.kind} />
        <span className="agent-picker-label">{selected.label}</span>
        <ChevronDown className="agent-picker-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div id={listId} className="menu agent-picker-menu" role="listbox" aria-labelledby={labelledBy} style={place}>
          {options.map((option, index) => (
            <div
              id={`${listId}-${index}`}
              key={option.kind || "shell"}
              className="menu-item"
              role="option"
              aria-selected={index === selectedIndex}
              data-active={index === active || undefined}
              onPointerEnter={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <OptionMark kind={option.kind} />
              <span className="menu-item-main">{option.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
