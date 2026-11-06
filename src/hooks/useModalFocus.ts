import { useLayoutEffect, type RefObject } from "react";

const modals: HTMLElement[] = [];
const isolated = new Map<HTMLElement, boolean>();

function syncIsolation() {
  for (const [element, wasInert] of isolated) element.inert = wasInert;
  isolated.clear();
  // Walk outwards so this also works when a modal is mounted inside an app
  // subtree, or a nested modal has its own portal wrapper.
  let branch = modals[modals.length - 1];
  while (branch?.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of parent.children) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      if (sibling.matches('script, style, link, [role="tooltip"]')) continue;
      isolated.set(sibling, sibling.inert);
      sibling.inert = true;
    }
    if (parent === document.body) break;
    branch = parent;
  }
}

function tabbables(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]',
  )).filter(element => element.tabIndex >= 0 && !element.matches(":disabled")
    && !element.closest("[hidden], [inert]") && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== "hidden");
}

/** Own focus for the lifetime of an open modal, including stacked Libraries.
 *  Escape and unsaved-draft policy remain the dialog's responsibility. */
export function useModalFocus(ref: RefObject<HTMLElement | null>, open: boolean) {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!open || !root) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let lastFocused: HTMLElement | null = null;
    modals.push(root);
    syncIsolation();

    function ownsFocus() {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      return modals[modals.length - 1] === root && dialogs[dialogs.length - 1] === root;
    }
    function focusInside() {
      const items = tabbables(root!);
      const target = lastFocused && items.includes(lastFocused) ? lastFocused : items[0] ?? root!;
      target.focus({ preventScroll: true });
    }
    function onFocus(event: FocusEvent) {
      if (!ownsFocus()) return;
      if (event.target instanceof HTMLElement && root!.contains(event.target)) lastFocused = event.target;
      else focusInside();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Tab" || event.defaultPrevented || !ownsFocus()) return;
      const items = tabbables(root!);
      const active = document.activeElement;
      const at = items.findIndex(element => element === active);
      if (items.length === 0 || at < 0 || (event.shiftKey ? at === 0 : at === items.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? items[items.length - 1] ?? root! : items[0] ?? root!).focus();
      }
    }
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onKey);
    focusInside();
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onKey);
      const wasTop = modals[modals.length - 1] === root;
      const index = modals.indexOf(root);
      if (index >= 0) modals.splice(index, 1);
      syncIsolation();
      if (wasTop && opener?.isConnected && !opener.closest("[inert]")) opener.focus({ preventScroll: true });
    };
  }, [ref, open]);
}
