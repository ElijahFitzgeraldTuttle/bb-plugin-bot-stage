import { useEffect, useId, useRef, useState } from "react";
import { setUiSize, UI_SIZE_MAX, UI_SIZE_MIN, UI_SIZE_STEP } from "../lib/ui-size";

export function Options({ workspace, details }: { workspace: number; details: number }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  return (
    <div className="bst-options" ref={root} onKeyDown={(event) => {
      if (event.key !== "Escape" || !open) return;
      event.stopPropagation();
      setOpen(false);
      toggle.current?.focus();
    }}>
      <button ref={toggle} type="button" className="bst-icon" aria-label="Bot Stage options"
        title="Bot Stage options" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}>
        <svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="13" cy="8" r="1.3" />
        </svg>
      </button>
      {open ? (
        <div id={id} className="bst-options-menu" role="group" aria-label="Bot Stage options">
          {([['workspace', 'Workspace size', workspace], ['details', 'Details size', details]] as const).map(([kind, label, size]) => (
            <div key={kind}>
              <div className="bst-size-label">
                <label htmlFor={`${id}-${kind}`}>{label}</label>
                <output htmlFor={`${id}-${kind}`}>{size}%</output>
              </div>
              <input id={`${id}-${kind}`} type="range" min={UI_SIZE_MIN} max={UI_SIZE_MAX} step={UI_SIZE_STEP}
                value={size} aria-valuetext={`${size}%`} onChange={(event) => setUiSize(kind, event.currentTarget.valueAsNumber)} />
            </div>
          ))}
          <button type="button" className="bst-size-reset" disabled={workspace === 100 && details === 100} onClick={() => {
            setUiSize('workspace', 100);
            setUiSize('details', 100);
          }}>
            Reset sizes
          </button>
        </div>
      ) : null}
    </div>
  );
}
