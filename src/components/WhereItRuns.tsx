// "Where it runs" — the Machine picker over the Focus composer's left edge
// (docs/REMOTE_MACHINES.md, Q6; prototype: preview/machine-picker.tsx).
//
// Before the first message: the Machine's name alone (`This Mac ▾` /
// `klide-box ▾`), a menu of This Mac and the Remote machines from
// ~/.klide/machines.json. It behaves like the environment switch in the Claude
// and Codex apps: it opens instantly, each project remembers where it last
// started, and nothing waits on a check before you can pick. Readiness is
// fetched in the background (`machineStatus.ts`) when the start stage appears;
// only a machine whose last check failed is dimmed, with the command that
// fixes it. Picking a Remote machine puts the conversation on Claude Code —
// the one CLI the first slice runs there. With no machine configured the
// picker draws nothing at all.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePortalMenu } from "../hooks/usePortalMenu";
import { MachineIcon, ThisMacIcon, CheckIcon, CopyIcon } from "../icons";
import { machineLabel, machinesList, REMOTE_PROVIDER, type Machine } from "../ipc/machines";
import { restoreStartStageMachine, setStartStageMachine, startStageMachine, subscribeStartStageMachine } from "../conversationMachines";
import { lastKnownStatus, machineStatusCheck, machineStatusVersion, refreshMachineStatus, subscribeMachineStatus } from "../machineStatus";
import { Z } from "../zLayers";

export function useStartStageMachine(): string | null {
  return useSyncExternalStore(subscribeStartStageMachine, startStageMachine, startStageMachine);
}

export function WhereItRuns({
  workspaceRoot,
  provider,
  onProviderChange,
}: {
  workspaceRoot: string | null;
  provider: string;
  onProviderChange: (provider: string) => void;
}) {
  const machine = useStartStageMachine();
  const [machines, setMachines] = useState<Machine[]>([]);
  useSyncExternalStore(subscribeMachineStatus, machineStatusVersion, machineStatusVersion);
  const menu = usePortalMenu<{ left: number; bottom: number }>({
    computePos: (r) => ({ left: Math.max(8, Math.round(r.left) - 4), bottom: Math.round(window.innerHeight - r.top + 8) }),
    closeOnOutsideClick: true,
  });

  useEffect(() => {
    let live = true;
    machinesList().then((list) => { if (live) setMachines(list); }).catch(() => {});
    return () => { live = false; };
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
    if (machine && machines.length > 0 && !machines.some((m) => m.id === machine)) setStartStageMachine(null, workspaceRoot);
  }, [machine, machines, workspaceRoot]);

  // Readiness ahead of time: when the start stage appears, and again when the
  // menu opens (a fresh answer is reused, so this costs nothing twice).
  useEffect(() => {
    for (const m of machines) refreshMachineStatus(m.id, workspaceRoot);
  }, [machines, workspaceRoot, menu.open]);

  if (machines.length === 0) return null;
  const chosen = machines.find((m) => m.id === machine);

  const chosenStatus = chosen ? lastKnownStatus(machineStatusCheck(chosen.id, workspaceRoot)) : null;
  const chosenUnready = !!chosenStatus && !chosenStatus.ready;

  const pick = (id: string | null) => {
    setStartStageMachine(id, workspaceRoot);
    if (id && provider !== REMOTE_PROVIDER) onProviderChange(REMOTE_PROVIDER);
    menu.close();
  };

  return (
    <div className="klide-where-it-runs">
      <button
        ref={menu.triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={menu.open}
        aria-label="Where it runs"
        title={chosen ? `Runs on ${machineLabel(chosen)}${chosenStatus ? ` — ${chosenStatus.caption}` : ""}` : "Where it runs"}
        data-warn={chosenUnready || undefined}
        onClick={() => (menu.open ? menu.close() : menu.openMenu())}
      >
        {chosen ? <MachineIcon size={13} /> : <ThisMacIcon size={13} />}
        <span>{chosen ? machineLabel(chosen) : "This Mac"}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden
          style={{ color: "var(--fg-dim)", transform: menu.open ? "rotate(180deg)" : "none", transition: "transform var(--motion-fast) var(--ease-out)" }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {menu.open && menu.pos && createPortal(
        <div
          ref={menu.menuRef}
          role="listbox"
          aria-label="Where it runs"
          className="picker-menu menu-glass klide-where-menu"
          style={{ position: "fixed", left: menu.pos.left, bottom: menu.pos.bottom, zIndex: Z.popover }}
        >
          <div className="klide-where-head">
            <div className="klide-where-title">Where it runs</div>
            <div className="klide-where-sub">This conversation's agent, shell and files</div>
          </div>
          <div style={{ padding: 5 }}>
            <Row
              icon={<ThisMacIcon size={15} />}
              title="This Mac"
              caption="Runs here, in the project you have open"
              selected={!machine}
              onClick={() => pick(null)}
            />
            <div className="klide-where-eyebrow">Remote machines</div>
            {machines.map((m) => {
              const check = machineStatusCheck(m.id, workspaceRoot);
              const status = lastKnownStatus(check);
              // Only a check that came back saying no blocks the pick; an
              // unanswered one never makes you wait.
              const blocked = check?.state === "failed" || (status !== null && !status.ready);
              const fix = blocked ? status?.facts.find((f) => f.fix && f.tone !== "ok" && f.tone !== "quiet")?.fix : undefined;
              const caption =
                check?.state === "failed" ? check.error
                : status ? (status.ready ? `Claude Code · ${status.caption}` : status.caption)
                : "Claude Code · checking…";
              return (
                <Row
                  key={m.id}
                  icon={<MachineIcon size={15} />}
                  title={machineLabel(m)}
                  caption={caption}
                  captionTone={blocked ? "warn" : undefined}
                  detail={status?.checkout ?? undefined}
                  fix={fix}
                  dimmed={blocked}
                  selected={machine === m.id}
                  onClick={() => !blocked && pick(m.id)}
                />
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function Row({
  icon,
  title,
  caption,
  captionTone,
  detail,
  fix,
  selected,
  dimmed,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  caption: string;
  captionTone?: "warn";
  detail?: string;
  fix?: string;
  selected?: boolean;
  dimmed?: boolean;
  onClick: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={dimmed || undefined}
      tabIndex={dimmed ? -1 : 0}
      className="klide-where-row"
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
    >
      <span className="klide-where-icon" style={{ opacity: dimmed ? 0.45 : 1 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="klide-where-row-title" data-dimmed={dimmed || undefined}>{title}</span>
        <span className="klide-where-caption" data-tone={captionTone}>{caption}</span>
        {detail && !fix && <span className="klide-where-caption">{detail}</span>}
        {fix && (
          <button
            type="button"
            className="klide-where-fix"
            title="Copy the command that fixes it"
            onClick={(e) => {
              e.stopPropagation();
              void navigator.clipboard?.writeText(fix);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }}
          >
            <span>{fix}</span>
            {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
          </button>
        )}
      </span>
      {selected && <span style={{ color: "var(--accent)", display: "flex" }}><CheckIcon size={13} /></span>}
    </div>
  );
}
