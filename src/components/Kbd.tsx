import { keysFor, type ShortcutId } from "../shortcuts";

// The one way keycaps render. Grown from `.klide-kbd` (tokens.css); replaces
// the per-component Keycap/KeyCap copies so every chord looks identical in
// the cheatsheet, tooltips, and empty-state launchers.

export function Kbd({ keys }: { keys: string[] }) {
  return (
    <span style={{ display: "inline-flex", gap: 3, flexShrink: 0 }}>
      {keys.map((k, i) => (
        <kbd key={i} className="klide-kbd" style={{ marginLeft: 0 }}>
          {k}
        </kbd>
      ))}
    </span>
  );
}

/** Keycaps for a registered shortcut — `<KbdFor id="go-to-file" />`. */
export function KbdFor({ id }: { id: ShortcutId }) {
  return <Kbd keys={keysFor(id)} />;
}
