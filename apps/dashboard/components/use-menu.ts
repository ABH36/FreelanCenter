'use client';
/**
 * Menu behaviour people expect (P2 S10, acceptance C-4): Escape and a click outside close it, focus returns to the
 * button on Escape, and opening one menu closes any other.
 */
import { type RefObject, useEffect, useId } from 'react';

const EVENT = 'dashboard:menu-open';

export function useMenu(
  open: boolean,
  setOpen: (open: boolean) => void,
  root: RefObject<HTMLElement | null>,
  button: RefObject<HTMLElement | null>,
) {
  const id = useId();
  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onOther = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener(EVENT, onOther);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener(EVENT, onOther);
    };
  }, [open, setOpen, root, button, id]);
}
