// "Where it runs" — the Machine picker over the Focus composer's left edge
// (docs/REMOTE_MACHINES.md, Q6; prototype: preview/machine-picker.tsx).
//
// Before the first message: the Machine's name alone (`This Mac ▾` /
// `klide-box ▾`), a menu of This Mac and the Remote machines from
// ~/.klide/machines.json. Each Remote machine is checked over SSH when the menu
// opens; one that isn't ready is dimmed, says why, and offers the command that
// fixes it. Picking a Remote machine puts the conversation on Claude Code —
// the one CLI the first slice runs there. With no machine configured the
// picker draws nothing at all.
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePortalMenu } from "../hooks/usePortalMenu";
import { MachineIcon, ThisMacIcon, CheckIcon, CopyIcon } from "../icons";
import { machineCheck, machineLabel, machinesList, REMOTE_PROVIDER, type Machine, type MachineStatus } from "../ipc/machines";
import { setStartStageMachine, startStageMachine, subscribeStartStageMachine } from "../conversationMachines";
import { Z } from "../zLayers";
import { errMessage } from "../errors";

type Check = { state: "checking" } | { state: "done"; status: MachineStatus } | { state: "failed"; error: string };

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
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const menu = usePortalMenu<{ left: number; bottom: number }>({
    computePos: (r) => ({ left: Math.max(8, Math.round(r.left) - 4), bottom: Math.round(window.innerHeight - r.top + 8) }),
    closeOnOutsideClick: true,
  });

  useEffect(() => {
    let live = true;
    machinesList().then((list) => { if (live) setMachines(list); }).catch(() => {});
    return () => { live = false; };
  }, []);

  // A Remote machine runs Claude Code only; another agent puts it back here.
  useEffect(() => {
    if (machine && provider !== REMOTE_PROVIDER) setStartStageMachine(null);
  }, [machine, provider]);
  // A machine that left the store is no longer a choice.
  useEffect(() => {
    if (machine && machines.length > 0 && !machines.some((m) => m.id === machine)) setStartStageMachine(null);
  }, [machine, machines]);

  // Check each machine when the menu opens — one SSH round trip each.
  useEffect(() => {
    if (!menu.open) return;
    let live = true;
    for (const m of machines) {
      setChecks((c) => ({ ...c, [m.id]: { state: "checking" } }));
      machineCheck(m.id, workspaceRoot)
        .then((status) => { if (live) setChecks((c) => ({ ...c, [m.id]: { state: "done", status } })); })
        .catch((e) => { if (live) setChecks((c) => ({ ...c, [m.id]: { state: "failed", error: errMessage(e) } })); });
    }
    return () => { live = false; };
  }, [menu.open, machines, workspaceRoot]);

  if (machines.length === 0) return null;
  const chosen = machines.find((m) => m.id === machine);

  const pick = (id: string | null) => {
    setStartStageMachine(id);
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
        title="Where it runs"
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
              const check = checks[m.id];
              const status = check?.state === "done" ? check.status : null;
              const ready = !!status?.ready;
              const fix = status?.facts.find((f) => f.fix && f.tone !== "ok" && f.tone !== "quiet")?.fix;
              const caption =
                !check || check.state === "checking" ? "Checking…"
                : check.state === "failed" ? check.error
                : ready ? `Claude Code · ${status!.caption}`
                : status!.caption;
              return (
                <Row
                  key={m.id}
                  icon={<MachineIcon size={15} />}
                  title={machineLabel(m)}
                  caption={caption}
                  captionTone={check?.state === "failed" || (status && !ready) ? "warn" : undefined}
                  detail={status?.checkout ?? undefined}
                  fix={ready ? undefined : fix}
                  dimmed={!ready}
                  selected={machine === m.id}
                  onClick={() => ready && pick(m.id)}
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
