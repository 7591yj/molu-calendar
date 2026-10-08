import { useEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import { CATEGORIES, STATUSES, remainingLabel } from "../lib/calendar.ts";
import { cx } from "../lib/cx.ts";
import type { FeedEvent } from "../lib/feed.ts";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./Icon.tsx";

export function categoryStyle(
  event: Pick<FeedEvent, "category">,
): CSSProperties {
  return { "--event-color": CATEGORIES[event.category].color } as CSSProperties;
}

export const button =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-transparent px-3.5 py-2 text-md font-semibold whitespace-nowrap transition-colors [&_.icon]:size-4";
export const primaryButton = `${button} bg-blue text-white hover:bg-blue-strong`;
export const quietButton = `${button} border-control bg-surface text-blue hover:bg-hover`;
export const smallButton = "min-h-[34px]! px-[11px]! py-[5px]! text-sm!";
export const iconButton =
  "inline-grid size-9 place-items-center rounded-lg text-muted transition-colors hover:bg-hover-strong hover:text-blue aria-pressed:text-bookmark";

export function Count({ n, className }: { n: number; className?: string }) {
  return (
    <span className={cx("numeric text-2xs/[1.2] text-subtle", className)}>
      {n}건
    </span>
  );
}

export function SectionTitle({
  children,
  count,
  id,
  className,
}: {
  children: ReactNode;
  count?: number;
  id?: string;
  className?: string;
}) {
  return (
    <h3
      id={id}
      className={cx(
        "flex items-baseline gap-1.5 font-display text-sm/[1.4] font-medium text-blue",
        className,
      )}
    >
      {children}
      {count !== undefined && <Count n={count} />}
    </h3>
  );
}

export function Diamond() {
  return (
    <span
      className="size-[7px] shrink-0 rotate-45 rounded-[1.5px] bg-(--event-color,var(--color-blue))"
      aria-hidden="true"
    />
  );
}

const plainTag =
  "inline-flex items-center gap-1.5 font-medium text-muted before:text-subtle before:content-['·']";

export function TagLine({
  event,
  status = false,
  children,
}: {
  event: FeedEvent;
  status?: boolean;
  children?: ReactNode;
}) {
  const category = CATEGORIES[event.category].label;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs/[1.45]">
      <span className="inline-flex items-center gap-1.5 font-semibold text-(--event-ink)">
        <Diamond />
        {category}
      </span>
      {event.label && event.label !== category && (
        <span className={plainTag}>{event.label}</span>
      )}
      {event.tags?.map((tag) => (
        <span key={tag} className={plainTag}>
          {tag}
        </span>
      ))}
      {status && event.status !== "confirmed" && (
        <span className={cx(plainTag, "font-semibold text-warn")}>
          {STATUSES[event.status]}
        </span>
      )}
      {children}
    </span>
  );
}

export function Countdown({
  event,
  now,
  className,
  compact = false,
}: {
  event: FeedEvent;
  now: number;
  className?: string;
  compact?: boolean;
}) {
  const label = remainingLabel(event, now);
  if (!label) return null;
  return (
    <span
      className={cx(
        "inline-flex items-center numeric text-2xs/[1.3] whitespace-nowrap",
        /D-\d/.test(label) ? "text-muted" : "text-danger",
        className,
      )}
      title={compact ? label : undefined}
    >
      {compact ? (label.match(/D-\d+/)?.[0] ?? "D-day") : label}
    </span>
  );
}

export function Dialog({
  open,
  onClose,
  label,
  icon,
  labelledBy,
  actions,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  icon?: IconName;
  labelledBy: string;
  actions?: ReactNode;
  className: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    if (!open && element?.open) element.close();
  }, [open]);
  const close = () => dialog.current?.close();

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- backdrop clicks dismiss; Escape and the close button handle keyboard dismissal
    <dialog
      ref={dialog}
      className={className}
      aria-labelledby={labelledBy}
      onClose={onClose}
      onClick={(click) => {
        if (click.target === dialog.current) close();
      }}
    >
      {open && (
        <div className="straight-top relative flex max-h-[calc(100dvh-32px)] flex-col overflow-hidden rounded-lg bg-surface pt-1 shadow-dialog">
          <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-line py-2 pr-2.5 pl-6 max-sm:min-h-12 max-sm:py-1 max-sm:pr-1.5 max-sm:pl-4">
            <span className="flex items-center gap-2 text-sm font-semibold text-blue [&_.icon]:size-4">
              {icon && <Icon name={icon} />}
              {label}
            </span>
            <div className="flex gap-0.5">
              {actions}
              <button
                type="button"
                className={iconButton}
                onClick={close}
                aria-label="닫기"
              >
                <Icon name="close" />
              </button>
            </div>
          </header>
          <div className="scroll-thin overflow-y-auto overscroll-contain px-6 pt-5 pb-6 max-sm:px-4 max-sm:pt-4 max-sm:pb-5">
            {children}
          </div>
        </div>
      )}
    </dialog>
  );
}

export const dialogHeading =
  "font-display text-xl/[1.45] font-medium text-ink wrap-anywhere text-balance max-sm:text-[20px]";
export const dialogLead = "mt-1.5 max-w-[65ch] text-md/[1.7] text-body";
