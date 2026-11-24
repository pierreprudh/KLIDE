import { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { usePortalMenu } from "../../hooks/usePortalMenu";
import { nativePermissionModes } from "../../agent/nativePermissions";
import { delegateLabel } from "../../delegates";
import { Z } from "../../zLayers";
import type { ProviderId } from "../../agent/types";
import { ProviderLogo } from "./icons";
import { NativePermissionIcon } from "./NativePermissionIcon";
import "./NativePermissionSelector.css";

export function NativePermissionSelector({ provider, value, onChange, disabled = false, compact = false }: {
  provider: ProviderId; value?: string; onChange: (mode: string | undefined) => void; disabled?: boolean; compact?: boolean;
}) {
  const modes = nativePermissionModes(provider);
  const selected = modes.find(mode => mode.id === (value ?? "")) ?? modes[0];
  const menuId = useId();
  const menu = usePortalMenu({
    computePos: rect => ({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)), bottom: window.innerHeight - rect.top + 8 }),
    closeOnOutsideClick: true,
  });
  useEffect(() => {
    if (menu.open) menu.menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [menu.open, menu.menuRef]);
  useEffect(() => { menu.close(); }, [provider, disabled, menu.close]);
  if (!selected) return null;
  const close = () => { menu.close(); menu.triggerRef.current?.focus(); };
  return <>
    <button ref={menu.triggerRef} type="button" className={`klide-native-permission-trigger${compact ? " is-compact" : ""}`}
      disabled={disabled} aria-label={`${delegateLabel(provider)} permissions: ${selected.label}`}
      aria-haspopup="menu" aria-expanded={menu.open} aria-controls={menu.open ? menuId : undefined}
      title={disabled ? "Permissions can be changed after this turn finishes" : `Change ${delegateLabel(provider)} permissions · ${selected.description}`}
      onClick={() => menu.open ? close() : menu.openMenu()}
      onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); menu.openMenu(); } }}>
      <NativePermissionIcon provider={provider} mode={selected.id} size={18} />
      {!compact && <span>{selected.label.replace(/^Default · /, "")}</span>}
      {!compact && <span aria-hidden="true" className="klide-native-permission-chevron">⌄</span>}
    </button>
    {menu.open && menu.pos && createPortal(
      <div ref={menu.menuRef} id={menuId} role="menu" aria-label={`${delegateLabel(provider)} native permissions`}
        className="klide-native-permission-menu" style={{ left: menu.pos.left, bottom: menu.pos.bottom, zIndex: Z.popover }}
        onKeyDown={event => {
          if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); close(); return; }
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
          items[next]?.focus();
        }}>
        <div className="klide-native-permission-heading"><ProviderLogo id={provider} size={19} /><span>{delegateLabel(provider)} permissions</span></div>
        <p>Native agent permissions · applies on the next turn</p>
        {modes.map(mode => <button key={mode.id} type="button" role="menuitemradio" aria-checked={mode.id === selected.id}
          className="klide-native-permission-option" onClick={() => { onChange(mode.id || undefined); close(); }}>
          <span className="klide-native-permission-option-content">
            {provider === "vibe" && <NativePermissionIcon provider={provider} mode={mode.id} />}
            <span><strong>{mode.label}</strong><small>{mode.description}</small></span>
          </span>
          <span aria-hidden="true">{mode.id === selected.id ? "✓" : ""}</span>
        </button>)}
      </div>, document.body)}
  </>;
}
