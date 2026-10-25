import { useEffect, useRef, type ReactNode } from "react";

type ReviewDrawerProps = {
  open: boolean;
  wide?: boolean;
  onClose: () => void;
  labelledBy: string;
  children: ReactNode;
  fallbackFocusId?: string;
  preferFallbackFocus?: boolean;
};

export function ReviewDrawer({ wide = false, open, onClose, labelledBy, children, fallbackFocusId, preferFallbackFocus = false }: ReviewDrawerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  const preferFallback = useRef(preferFallbackFocus);
  useEffect(() => { preferFallback.current = preferFallbackFocus; }, [preferFallbackFocus]);

  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;

    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();

    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
      if (!preferFallback.current && opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true });
      else if (fallbackFocusId) document.getElementById(fallbackFocusId)?.focus({ preventScroll: true });
      // React may remove the opener after native dialog focus restoration.
      requestAnimationFrame(() => {
        if (fallbackFocusId && document.activeElement === document.body) {
          document.getElementById(fallbackFocusId)?.focus({ preventScroll: true });
        }
      });
    };
  }, [open, fallbackFocusId]);

  const outside = (element: HTMLDialogElement, x: number, y: number) => {
    const bounds = element.getBoundingClientRect();
    return x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom;
  };

  return (
    <dialog
      ref={dialog}
      className={`review-drawer ${wide ? "case-drawer" : ""}`}
      aria-labelledby={labelledBy}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={(event) => {
        // Strict Mode may queue a close event before immediately reopening.
        if (open && !event.currentTarget.open) onClose();
      }}
      onPointerDown={(event) => {
        backdropPress.current = event.target === event.currentTarget && outside(event.currentTarget, event.clientX, event.clientY);
      }}
      onClick={(event) => {
        if (backdropPress.current && event.target === event.currentTarget && outside(event.currentTarget, event.clientX, event.clientY)) onClose();
        backdropPress.current = false;
      }}
    >
      <button type="button" className="drawer-close" aria-label="Close review" onClick={onClose}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
      {children}
    </dialog>
  );
}
