import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * The window's own title bar: a draggable strip the page content sits under.
 *
 * On macOS the shell keeps its native traffic lights and floats them over this
 * strip (`titleBarStyle: Overlay`), so nothing is drawn here. Everywhere else
 * the system frame is removed during setup and the minimize/close pair below
 * stands in for it. Which case applies is read back from the window instead of
 * inferred from the user agent, so the two can't disagree.
 *
 * Double-clicking the strip still toggles maximize — Tauri handles that for any
 * drag region, which keeps the shortcut we don't give a button.
 *
 * The bar is 40px, so keep it in sync with `trafficLightPosition` in
 * tauri.conf.json if it changes: tao resizes the button container but never
 * moves the buttons vertically inside it, so the y that lands is `config.y - 9`.
 * Centering a 12pt button in this bar wants 14pt, hence the 23 there, not 14.
 */
export default function TitleBar() {
  const [decorated, setDecorated] = useState<boolean | null>(null);

  useEffect(() => {
    getCurrentWindow()
      .isDecorated()
      .then(setDecorated)
      // Assume the OS is drawing them rather than risk a window with no controls.
      .catch(() => setDecorated(true));
  }, []);

  return (
    <div
      data-tauri-drag-region="deep"
      className="sticky top-0 z-30 flex h-10 items-center justify-end bg-neutral-50/85 backdrop-blur-md dark:bg-neutral-950/85"
    >
      {decorated === false && (
        <>
          <ControlButton label="Minimize" onClick={() => getCurrentWindow().minimize()}>
            <path d="M1.5 6h9" />
          </ControlButton>
          <ControlButton label="Close" danger onClick={() => getCurrentWindow().close()}>
            <path d="M2 2l8 8M10 2l-8 8" />
          </ControlButton>
        </>
      )}
    </div>
  );
}

function ControlButton({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-full w-[46px] items-center justify-center text-neutral-500 transition-colors dark:text-neutral-400 ${
        danger
          ? "hover:bg-[#c42b1c] hover:text-white"
          : "hover:bg-neutral-200/80 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      }`}
    >
      <svg
        aria-hidden
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      >
        {children}
      </svg>
    </button>
  );
}
