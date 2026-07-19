export type Unlisten = () => void;

/** Own asynchronous event registrations for one React effect lifetime.
 * Registrations that settle after disposal are immediately unregistered. */
export function createListenerScope() {
  let disposed = false;
  const unlisteners = new Set<Unlisten>();

  function add(registration: Promise<Unlisten>): void {
    void registration
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlisteners.add(unlisten);
      })
      .catch(() => {
        // A missing Tauri event source is non-fatal (for example in browser preview).
      });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const unlisten of unlisteners) unlisten();
    unlisteners.clear();
  }

  return { add, dispose };
}
