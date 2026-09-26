"use client";

/**
 * Shared UI primitives.
 *
 * One chip, one empty state, one icon button, one popover — so density and
 * spacing stay identical across panels. All colour comes from tokens in
 * app/globals.css.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Square, SquareCheck } from "lucide-react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** A specialist role label. Plain mono text; roles are not colour-coded. */
export function RoleChip({
  role,
  label,
  className,
}: {
  role: string;
  label?: string;
  className?: string;
}) {
  return <span className={cx("vb-role", className)}>{label ?? role}</span>;
}

/** Status dot. Blinks while `live`. */
export function Dot({
  color = "var(--vb-text-dim)",
  live = false,
  size = 6,
}: {
  color?: string;
  live?: boolean;
  size?: number;
}) {
  return (
    <span
      className={cx("inline-block shrink-0 rounded-full", live && "vb-pulse")}
      style={{ width: size, height: size, background: color }}
      aria-hidden
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      className="inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-[3px] border px-1 font-mono text-[10.5px]"
      style={{
        borderColor: "var(--vb-line)",
        background: "var(--vb-fill)",
        color: "var(--vb-text-dim)",
      }}
    >
      {children}
    </kbd>
  );
}

export function PanelHeader({
  title,
  actions,
  icon,
}: {
  title: string;
  actions?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div
      className="flex h-[30px] shrink-0 items-center gap-1.5 border-b pl-3 pr-1.5"
      style={{ borderColor: "var(--vb-line)" }}
    >
      {icon && <span style={{ color: "var(--vb-text-dim)" }}>{icon}</span>}
      <span className="vb-label">{title}</span>
      <div className="flex-1" />
      {actions}
    </div>
  );
}

export function IconButton({
  onClick,
  title,
  children,
  active = false,
  disabled = false,
  tone = "default",
}: {
  onClick?: () => void;
  title: string;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  tone?: "default" | "danger" | "accent";
}) {
  const toneColor =
    tone === "danger" ? "var(--vb-rose)" : tone === "accent" ? "var(--vb-accent)" : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active || undefined}
      disabled={disabled}
      className={cx(
        "inline-flex size-[22px] shrink-0 items-center justify-center rounded-[3px]",
        "hover:bg-[var(--vb-hover)] disabled:cursor-not-allowed disabled:opacity-40",
        active && "bg-[var(--vb-active)]",
      )}
      style={{ color: toneColor ?? (active ? "var(--vb-text-hi)" : "var(--vb-text-dim)") }}
    >
      {children}
    </button>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  /** Accepted for call-site compatibility; empty states render no icon. */
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-4">
      <p className="text-[12.5px]" style={{ color: "var(--vb-text-mid)" }}>
        {title}
      </p>
      {body && (
        <p className="max-w-[320px] text-[12px] leading-relaxed" style={{ color: "var(--vb-text-dim)" }}>
          {body}
        </p>
      )}
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}

/** Monospace number with a label. */
export function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: string;
  title?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <span className="text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
        {label}
      </span>
      <span
        className="font-mono text-[12.5px] tabular-nums"
        style={{ color: tone ?? "var(--vb-text-hi)" }}
      >
        {value}
      </span>
    </div>
  );
}

/** Compact +adds −removes pair. */
export function DiffCounts({ adds, removes }: { adds: number; removes: number }) {
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums">
      {adds > 0 && <span style={{ color: "var(--vb-add)" }}>+{adds}</span>}
      {adds > 0 && removes > 0 && " "}
      {removes > 0 && <span style={{ color: "var(--vb-del)" }}>−{removes}</span>}
      {adds === 0 && removes === 0 && <span style={{ color: "var(--vb-text-faint)" }}>0</span>}
    </span>
  );
}

/** Segmented control: 22px, hairline border, active segment filled. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "sm",
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div
      role="radiogroup"
      className="inline-flex shrink-0 items-stretch rounded-[3px] border p-px"
      style={{ borderColor: "var(--vb-line)" }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cx(
              "whitespace-nowrap rounded-[2px] px-2 font-medium",
              size === "sm" ? "h-[20px] text-[11.5px]" : "h-[22px] text-[12px]",
              !active && "hover:bg-[var(--vb-hover)]",
            )}
            style={
              active
                ? { background: "var(--vb-active)", color: "var(--vb-text-hi)" }
                : { color: "var(--vb-text-dim)" }
            }
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A settings row: label and hint on the left, the control on the right. */
export function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div
      className="flex min-h-[44px] flex-col items-start gap-2 border-b py-2 @xl:flex-row @xl:items-center @xl:gap-6"
      style={{ borderColor: "var(--vb-line)" }}
    >
      <div className="min-w-0 @xl:flex-1">
        <p className="text-[12.5px]" style={{ color: "var(--vb-text)" }}>
          {label}
        </p>
        {hint && (
          <p className="mt-0.5 text-[12px] leading-snug" style={{ color: "var(--vb-text-dim)" }}>
            {hint}
          </p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A two-state switch, flat, 18px. */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="flex h-[18px] w-[30px] items-center rounded-[3px] border p-[2px]"
      style={{
        borderColor: checked ? "var(--vb-accent)" : "var(--vb-line-strong)",
        background: checked ? "var(--vb-accent)" : "var(--vb-bg-input)",
      }}
    >
      <span
        className="size-3 rounded-[2px]"
        style={{
          transform: checked ? "translateX(12px)" : "none",
          background: checked ? "var(--vb-accent-fg)" : "var(--vb-text-dim)",
        }}
      />
    </button>
  );
}

/**
 * A quiet checkbox: the todo-list square, a label, no fill. Used for
 * option toggles where a switch or an accent-filled chip would shout.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  title,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-[3px] px-1 text-[12px] hover:bg-[var(--vb-hover)] disabled:cursor-not-allowed disabled:opacity-45"
      style={{ color: checked ? "var(--vb-text-hi)" : "var(--vb-text-mid)" }}
    >
      {checked ? (
        <SquareCheck className="size-3.5 shrink-0" style={{ color: "var(--vb-text-hi)" }} />
      ) : (
        <Square className="size-3.5 shrink-0" style={{ color: "var(--vb-text-faint)" }} />
      )}
      {label}
    </button>
  );
}

/** Click-to-open popover menu anchored to a small trigger button. */
export function Popover({
  label,
  icon,
  title,
  children,
  width = 260,
  placement = "top",
  align = "left",
  chevron = true,
}: {
  label: ReactNode;
  icon?: ReactNode;
  title: string;
  children: (close: () => void) => ReactNode;
  width?: number;
  placement?: "top" | "bottom";
  align?: "left" | "right";
  chevron?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-[22px] items-center gap-1 rounded-[3px] px-1.5 text-[11.5px] hover:bg-[var(--vb-hover)]"
        style={{ color: "var(--vb-text-dim)" }}
      >
        {icon}
        <span className="max-w-[140px] truncate">{label}</span>
        {chevron && <ChevronDown className="size-3 opacity-70" />}
      </button>
      {open && (
        <div
          role="menu"
          className={cx(
            "vb-pop absolute z-50 py-1",
            placement === "top" ? "bottom-[calc(100%+4px)]" : "top-[calc(100%+4px)]",
            align === "left" ? "left-0" : "right-0",
          )}
          style={{ width }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  active,
  onClick,
  title,
  hint,
  trailing,
  disabled = false,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  hint?: string;
  trailing?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "flex w-full items-start gap-2 px-2.5 py-1 text-left",
        !disabled && "hover:bg-[var(--vb-hover)]",
        disabled && "cursor-not-allowed opacity-45",
      )}
    >
      <span
        className="mt-[5px] size-[5px] shrink-0 rounded-full"
        style={{ background: active ? "var(--vb-accent)" : "transparent" }}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12px]" style={{ color: "var(--vb-text-hi)" }}>
            {title}
          </span>
          {trailing}
        </span>
        {hint && (
          <span className="block text-[11px] leading-snug" style={{ color: "var(--vb-text-dim)" }}>
            {hint}
          </span>
        )}
      </span>
    </button>
  );
}

/** Truncate a path from the left, keeping the filename readable. */
export function truncatePath(path: string, max = 34): string {
  if (path.length <= max) return path;
  const segments = path.split("/");
  const file = segments[segments.length - 1];
  if (file.length >= max - 2) return `…${file.slice(-(max - 1))}`;
  let out = file;
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const next = `${segments[i]}/${out}`;
    if (next.length > max - 2) break;
    out = next;
  }
  return `…/${out}`;
}

/** Split a path into directory and basename, for "name  dir" rows. */
export function splitPath(path: string): { name: string; dir: string } {
  const index = path.lastIndexOf("/");
  if (index === -1) return { name: path, dir: "" };
  return { name: path.slice(index + 1), dir: path.slice(0, index) };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatAgo(at: number | string): string {
  const t = typeof at === "string" ? Date.parse(at) : at;
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}
