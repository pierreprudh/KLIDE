// Whether any Remote machine is configured — the start stage only makes room
// for "Where it runs" when there is somewhere else to run.
import { useEffect, useState } from "react";
import { machinesList } from "../ipc/machines";

let cached: boolean | null = null;

export function useHasMachines(): boolean {
  const [has, setHas] = useState(cached ?? false);
  useEffect(() => {
    let live = true;
    machinesList()
      .then((list) => { cached = list.length > 0; if (live) setHas(cached); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return has;
}
