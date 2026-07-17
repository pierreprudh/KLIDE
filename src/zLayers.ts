// Single source of truth for app-level stacking order.
//
// Only overlays that compete in the *root* stacking context belong here —
// things portalled to <body> or mounted full-screen at the App root. Local
// stacking (a sticky list header above its own rows, panel chrome above panel
// content, a drag ghost inside its own modal) stays as small local z-indices
// in the component; it never escapes its own stacking context, so it does not
// need to coordinate with this scale.
//
// Why the big gaps: floating panels don't get a fixed z — a focused panel
// rides at `Z.panel + <its focus order>`, and that order climbs by one every
// time a panel is focused (see usePanelLayout). So the panel *band* grows
// upward without bound over a session. Every tier above it is therefore placed
// far enough up that the panel band can't realistically reach it (you'd need
// ~99,000 focus events to climb from `panel` into `popover`). This is the
// regression that bit us once: panels used to sit at ~10–30, popovers at 200;
// when panels were bumped to 1000+ the body-portalled menus (still at 200)
// silently fell *behind* their own panel.
export const Z = {
  /** Floating panels. A focused panel = `panel + <focus order>`; the band
   *  climbs as panels are focused, so keep every tier below well clear. */
  panel: 1_000,
  /** Docked chrome — the free layout's docked editor pane and the explorer
   *  drawer. Persistent surfaces that must stay above the climbing
   *  floating-panel band (a dock the panels can hide behind is "in the
   *  back", the thing docks exist to prevent) but below transient chrome. */
  dock: 80_000,
  /** The activity rail — its expand/collapse pebble straddles the rail's
   *  right edge, exactly where the explorer drawer slides in, so the rail
   *  must sit one tier above the docks. */
  rail: 85_000,
  /** The race "ask both" bar — persistent workbench chrome that must stay
   *  above the floating-panel band (which climbs with focus events) but
   *  below every popover/menu. */
  raceBar: 90_000,
  /** Composer menus, model picker, command palette — must float above any
   *  panel, including the one they belong to. */
  popover: 100_000,
  /** Full-screen modal dialogs (Memory, Skills, Profile, Worktrees, diff
   *  review). Above panels and popovers. */
  modal: 200_000,
  /** A dialog opened on top of another modal — e.g. the add-endpoint sheet
   *  over the Settings view. */
  modalRaised: 210_000,
  /** Action-result toasts — float above panels/modals/menus so an outcome is
   *  never hidden behind the surface that triggered it. Below context menus and
   *  tooltips, which are even more transient. */
  toast: 880_000,
  /** Right-click menus and transient top-level pickers — above everything. */
  contextMenu: 900_000,
  /** Hover/focus tooltips. The most ephemeral hint — sits above all of the
   *  above so a tooltip on a modal, popover, or menu item is never occluded. */
  tooltip: 950_000,
} as const;
