// "Where it runs" — which Machine a new Focus conversation starts on
// (docs/REMOTE_MACHINES.md, Q6). The menu itself is Focus's own InlineMenu, the
// same dropdown as the agent picker beside it: This Mac, then each Remote
// machine from ~/.klide/machines.json, plus an Add a machine action.
// This module is the logic behind that menu.
//
// It behaves like the environment switch in the Claude and Codex apps: each
// project remembers where it last started, readiness is checked in the
// background when the start stage appears (`machineStatus.ts`), and nothing
// waits on a check. A machine whose last check failed stays in the menu; picking
// it raises a notification with the reason and a setup action instead of
// choosing it. Picking a Remote machine puts the conversation on Claude Code —
// the one CLI the first slice runs there.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { MachineIcon, NewTaskIcon, ThisMacIcon } from "../icons";
import { machineLabel, machinesList, subscribeMachines, REMOTE_PROVIDER, type Machine } from "../ipc/machines";
import { restoreStartStageMachine, setStartStageMachine, startStageMachine, subscribeStartStageMachine } from "../conversationMachines";
import { lastKnownStatus, machineStatusCheck, machineStatusVersion, refreshMachineStatus, subscribeMachineStatus } from "../machineStatus";
import { pushToast } from "../toast";

/** The menu value for this Mac (a Remote machine's value is its id). */
export const THIS_MAC = "__this-mac__";

export function useStartStageMachine(): string | null {
  return useSyncExternalStore(subscribeStartStageMachine, startStageMachine, startStageMachine);
}

export type WhereItRunsMenu = {
  display: string;
  leading: ReactNode;
  options: { label: string; value: string; icon: ReactNode; dimmed?: boolean; resolve?: { title: string; run: () => void; showArrow?: boolean } }[];
  selected: string;
  onSelect: (value: string | number | undefined) => void;
};

/** Always available, including the first connection before any machines exist. */
export function useWhereItRuns({
  workspaceRoot,
  provider,
  onProviderChange,
  onAddMachine,
  onOpenMachineSettings,
}: {
  workspaceRoot: string | null;
  provider: string;
  onProviderChange: (provider: string) => void;
  onAddMachine: () => void;
  onOpenMachineSettings: () => void;
}): WhereItRunsMenu {
  const machine = useStartStageMachine();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loaded, setLoaded] = useState(false);
  useSyncExternalStore(subscribeMachineStatus, machineStatusVersion, machineStatusVersion);

  useEffect(() => {
    let live = true;
    const reload = () => { void machinesList().then((list) => { if (live) { setMachines(list); setLoaded(true); } }).catch(() => {}); };
    reload();
    const unsubscribe = subscribeMachines(reload);
    return () => { live = false; unsubscribe(); };
  }, []);

  // Each project opens on the Machine it last started on. A remembered Remote
  // machine brings its agent with it — it only runs Claude Code.
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const onProviderChangeRef = useRef(onProviderChange);
  onProviderChangeRef.current = onProviderChange;
  useEffect(() => {
    restoreStartStageMachine(workspaceRoot);
    if (startStageMachine() && providerRef.current !== REMOTE_PROVIDER) onProviderChangeRef.current(REMOTE_PROVIDER);
  }, [workspaceRoot]);

  // Choosing another agent while on a Remote machine is choosing this Mac —
  // only a *change* away from Claude Code counts, not a mismatch mid-restore.
  const prevProvider = useRef(provider);
  useEffect(() => {
    const was = prevProvider.current;
    prevProvider.current = provider;
    if (was === REMOTE_PROVIDER && provider !== REMOTE_PROVIDER && startStageMachine()) {
      setStartStageMachine(null, workspaceRoot);
    }
  }, [provider, workspaceRoot]);

  // A machine that left the store is no longer a choice.
  useEffect(() => {
    if (loaded && machine && !machines.some((m) => m.id === machine)) setStartStageMachine(null, workspaceRoot);
  }, [loaded, machine, machines, workspaceRoot]);

  // Readiness ahead of time, so the menu never waits on SSH.
  useEffect(() => {
    for (const m of machines) refreshMachineStatus(m.id, workspaceRoot);
  }, [machines, workspaceRoot]);

  const chosen = machines.find((m) => m.id === machine);

  const blockedReason = (m: Machine): { why: string } | null => {
    const check = machineStatusCheck(m.id, workspaceRoot);
    if (check?.state === "failed") return { why: check.error };
    const status = lastKnownStatus(check);
    if (!status || status.ready) return null;
    return { why: status.caption };
  };

  return {
    display: chosen ? machineLabel(chosen) : "This Mac",
    leading: chosen ? <MachineIcon size={13} /> : <ThisMacIcon size={13} />,
    options: [
      { label: "This Mac", value: THIS_MAC, icon: <ThisMacIcon size={14} /> },
      // A machine that can't be picked is only dimmed; the why comes as a toast.
      ...machines.map((m) => ({
        label: machineLabel(m),
        value: m.id,
        icon: <MachineIcon size={14} />,
        dimmed: blockedReason(m) !== null,
      })),
      { label: "Add a machine", value: "action:add-machine", icon: <NewTaskIcon size={14} />, resolve: { title: "Add an SSH machine", run: onAddMachine, showArrow: false } },
    ],
    selected: chosen ? chosen.id : THIS_MAC,
    onSelect: (value) => {
      if (value === THIS_MAC || value === undefined) {
        setStartStageMachine(null, workspaceRoot);
        return;
      }
      const target = machines.find((m) => m.id === value);
      if (!target) return;
      const blocked = blockedReason(target);
      if (blocked) {
        // Ask again so the next pick sees a fresh answer once it's fixed.
        refreshMachineStatus(target.id, workspaceRoot, { force: true });
        pushToast(`${machineLabel(target)}: ${blocked.why}`, {
          tone: "warn",
          duration: 8000,
          action: { label: "Set up machine", run: onOpenMachineSettings },
        });
        return;
      }
      setStartStageMachine(target.id, workspaceRoot);
      if (provider !== REMOTE_PROVIDER) onProviderChange(REMOTE_PROVIDER);
    },
  };
}
