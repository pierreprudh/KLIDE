import { useEffect, useState } from "react";
import { DELEGATE_IDS } from "../delegates";
import { readSubscriptionStatus } from "../ipc/aiProviders";

// Only a confirmed missing executable dims a row. Failed probes and a CLI
// that is installed but signed out keep their normal appearance.
export function useMissingDelegateClis(active = true, ids: readonly string[] = DELEGATE_IDS): ReadonlySet<string> {
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
  const key = ids.join("\n");
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const refresh = () => {
      void Promise.all(key.split("\n").filter(Boolean).map(async (id) => {
        try {
          return (await readSubscriptionStatus(id)).installed ? null : id;
        } catch {
          return null;
        }
      })).then((results) => {
        if (!cancelled) setMissing(new Set(results.filter((id): id is string => id !== null)));
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [active, key]);
  return missing;
}
