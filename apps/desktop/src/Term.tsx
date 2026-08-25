import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { GLOSSARY, termUrl, type TermId } from "./glossary";

const CARD_WIDTH = 300;
const MARGIN = 12;
const OPEN_DELAY = 130;
const CLOSE_DELAY = 120; // long enough to move the pointer into the card

type Placement = { left: number; top: number; above: boolean };

/**
 * A term the user can hover for a one-paragraph explanation, with a link into
 * the matching section of the fundamentals post.
 *
 * The card renders into a portal at the document root. Terms appear inside
 * rounded `overflow-hidden` containers that would clip it, and inside <p> and
 * <label> elements that cannot legally contain it.
 */
export default function Term({
  id,
  children,
  className = "",
}: {
  id: TermId;
  children: React.ReactNode;
  className?: string;
}) {
  const entry = GLOSSARY[id];
  const anchorRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<number>();
  const [place, setPlace] = useState<Placement | null>(null);

  const clear = () => window.clearTimeout(timer.current);

  const position = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(
      Math.max(MARGIN, r.left),
      window.innerWidth - CARD_WIDTH - MARGIN,
    );
    // Flip above when the bottom half of the window can't hold the card.
    const above = r.bottom + 190 > window.innerHeight;
    setPlace({ left, top: above ? r.top - 8 : r.bottom + 8, above });
  }, []);

  const open = useCallback(() => {
    clear();
    timer.current = window.setTimeout(position, OPEN_DELAY);
  }, [position]);

  const close = useCallback((immediate = false) => {
    clear();
    if (immediate) setPlace(null);
    else timer.current = window.setTimeout(() => setPlace(null), CLOSE_DELAY);
  }, []);

  useEffect(() => () => clear(), []);

  useEffect(() => {
    if (!place) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    const onScroll = () => close(true);
    window.addEventListener("keydown", onKey);
    // Capture: the scroll happens on inner containers, not just the window.
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [place, close]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-describedby={place ? `term-${id}` : undefined}
        onPointerEnter={open}
        onPointerLeave={() => close()}
        onFocus={position}
        onBlur={() => close(true)}
        onClick={(e) => {
          // Some triggers sit inside a <label>, which would otherwise forward
          // the click to its form control.
          e.preventDefault();
          if (place) close(true);
          else position();
        }}
        className={`cursor-help underline decoration-neutral-400 decoration-dotted underline-offset-[3px] hover:decoration-neutral-600 dark:decoration-neutral-600 dark:hover:decoration-neutral-400 ${className}`}
      >
        {children}
      </button>

      {place &&
        createPortal(
          <div
            id={`term-${id}`}
            role="tooltip"
            onPointerEnter={clear}
            onPointerLeave={() => close()}
            style={{
              left: place.left,
              top: place.top,
              width: CARD_WIDTH,
              transform: place.above ? "translateY(-100%)" : undefined,
            }}
            className="fixed z-50 rounded-xl border border-neutral-200 bg-white p-3.5 shadow-lg shadow-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900 dark:shadow-black/40"
          >
            <div className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
              {entry.title}
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-neutral-600 dark:text-neutral-400">
              {entry.brief}
            </p>
            <button
              type="button"
              onClick={() => {
                close(true);
                invoke("open_external", { url: termUrl(id) }).catch(() => {});
              }}
              className="mt-2.5 text-[12.5px] font-medium text-emerald-700 hover:underline dark:text-emerald-500"
            >
              Learn more →
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
