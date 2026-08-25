import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { GLOSSARY, glossaryUrl, termUrl, type TermId } from "./glossary";

const CARD_WIDTH = 300;
const MARGIN = 12;
const OPEN_DELAY = 130;
const CLOSE_DELAY = 120; // long enough to move the pointer into the card

type Placement = { left: number; top: number; above: boolean };

/**
 * A term the user can hover for a one-paragraph explanation, with two ways out:
 * the section of the post that works it out, and the same term on the website
 * glossary — which lands on this entry with the whole vocabulary under it.
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

  const openExternal = useCallback(
    (url: string) => {
      close(true);
      invoke("open_external", { url }).catch(() => {});
    },
    [close],
  );

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
          // the click to its form control. Always open — never toggle: an
          // activation can fire focus (opens the card) and click in the same
          // gesture, and a toggle would close it in the same instant.
          e.preventDefault();
          position();
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
            <div className="mt-2.5 flex items-baseline justify-between gap-3 text-[12.5px]">
              <button
                type="button"
                onClick={() => openExternal(termUrl(id))}
                className="font-medium text-emerald-700 hover:underline dark:text-emerald-500"
              >
                Learn more →
              </button>
              <button
                type="button"
                onClick={() => openExternal(glossaryUrl(id))}
                className="text-neutral-400 hover:text-neutral-600 hover:underline dark:text-neutral-500 dark:hover:text-neutral-300"
              >
                Glossary
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
