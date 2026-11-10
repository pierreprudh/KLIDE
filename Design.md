---
version: alpha
name: Klide
description: "A light-grey and white design system: #F5F6F7 chrome, #FFFFFF content, charcoal text and a quiet sage accent. Atkinson Hyperlegible for UI and Monaspace Neon for code. Rounded groups, generous spacing and soft borders define the interface. No beige or cream UI surfaces."

seo:
  title: "Klide Design System — Light Grey + White + Charcoal + Sage"
  metaDescription: "Klide uses light-grey chrome, white content, rounded panels and a quiet sage accent throughout the app."
  highlights:
    - "Light-grey chrome (#F5F6F7) and white content (#FFFFFF) throughout all light themes; no beige or cream UI backgrounds"
    - "Soft sage green accent (#5A7B4C) — quiet, organic, distinct from the AI-tool-default blue"
    - "Opacity-driven grays — every tonal shade derives from #1c1c1c at 4%, 40%, 82%, 83% transparency"
    - "Soft cool-grey borders, subtle panel shadows and fine row dividers"
    - "Rounded grouped panels (20px) and controls (12px); pill-shaped switches"
  tags:
    - "AI & LLM Platforms"
    - "Developer Tools & IDEs"
  lastUpdated: "2026-11-10"
  author:
    name: "Pierre Prudhomme"
  opening: |
    Klide uses a cool light-grey (#F5F6F7) foundation for chrome, rails and sidebars, with white (#FFFFFF) content, editor, terminal and panel surfaces. The palette applies across all light themes, including menus, welcome screens, viewers and Settings. Beige, cream, parchment and warm off-white UI backgrounds are not part of the design system. Dark themes keep their own dark surfaces; user content, artwork, service logos, syntax and status colours keep their meaning.

    Near-black charcoal carries text, Atkinson Hyperlegible carries the UI, and Monaspace Neon carries code. A quiet sage accent identifies interactive states. Related settings sit in rounded groups with 20px corners, 12px controls, generous row spacing, fine dividers and subtle shadows. Use chevrons when they clarify dropdowns or expandable content; reserve full arrows for directional navigation.

    To change the system, update this file and the implementation in `src/styles/tokens.css`, `src/theme.ts` and any native editor or terminal palette. `CONTEXT.md` and `CLAUDE.md` carry the same approved guidelines.
  related:
    - href: "src/styles/tokens.css"
      title: "The implementation"
      description: "All tokens below are realised as CSS custom properties in tokens.css. Each variable name appears in the Keys column so you can grep the codebase for the exact token."
    - href: "src/theme.ts"
      title: "Theme registry"
      description: "Theme metadata (name, description, isDark, swatches) and the per-theme overrides. Klide Light is the default; the other themes layer on top of the same token names."
  questions:
    - id: "primary-color"
      title: "What is Klide's primary brand color?"
      answer: "Klide uses light-grey chrome (#F5F6F7), white content (#FFFFFF), charcoal text and a soft sage accent (#5A7B4C). Accents identify interaction and semantic information; backgrounds stay neutral."
    - id: "typography"
      title: "What typography does Klide use?"
      answer: "Klide runs Atkinson Hyperlegible for the UI surface and Monaspace Neon for code. Atkinson is a humanist sans-serif designed by the Braille Institute for low-vision readers — generous x-height, open apertures, slightly rounded terminals. The type scale runs 12px (xs) → 24px (xxl) in 5 steps. There is no display weight: emphasis is carried by color and size, not by weight variation."
    - id: "opacity-grays"
      title: "Why does Klide derive grays from opacity instead of hex values?"
      answer: "The foundation uses cool light grey (#F5F6F7), white (#FFFFFF) and cool-grey borders (#E4E7EB). Charcoal opacity stops provide coherent hover fills and text hierarchies without beige or cream tints."
    - id: "shape-language"
      title: "What is Klide's shape language?"
      answer: "Related settings use 20px rounded groups and 12px rounded controls, with generous spacing, fine dividers and subtle shadows. Compact utility elements can use the smaller radius tokens. Switches stay pill-shaped. Chevrons are functional dropdown or disclosure affordances; full arrows convey directional navigation."
    - id: "use-in-project"
      title: "Can I use this DESIGN.md to drive changes in the app?"
      answer: "Yes — this file is the source of truth. To change a color, spacing value, or radius, edit the value here AND in `src/styles/tokens.css`. The tokens.css file is the actual implementation; this file is the human-readable spec. Every variable has a Key in the tokens table below so you can grep for it."

# ─────────────────────────────────────────────────────────────────────────────
# TOKENS — edit these, then mirror the change in src/styles/tokens.css.
# ─────────────────────────────────────────────────────────────────────────────

colors:
  # Foundation — shared across the app's light themes
  chrome:  "#F5F6F7"   # Rails, sidebars and app chrome (--bg)
  surface: "#FFFFFF"   # Content, editor, terminal and panels
  border:  "#E4E7EB"   # Cool-neutral dividers and outlines
  # Tonal axis (every gray is the same charcoal at different transparency)
  charcoal:        "#1c1c1c"   # Primary text, headings, dark CTA fills
  charcoal-83:     "rgba(28, 28, 28, 0.83)"   # Strong secondary text
  charcoal-82:     "rgba(28, 28, 28, 0.82)"   # Body copy
  charcoal-40:     "rgba(28, 28, 28, 0.40)"   # Interactive borders, button outlines
  charcoal-4:      "rgba(28, 28, 28, 0.04)"   # Subtle hover backgrounds, micro-tints
  muted:           "#5f5f5d"   # Secondary text, descriptions, captions
  # Accent (soft sage — chosen to avoid the AI-blue convention)
  accent:         "#5A7B4C"   # Primary interactive accent
  accent-soft:    "rgba(90, 123, 76, 0.12)"   # Subtle accent tint
  accent-hover:   "#6B8E5A"   # Accent on hover (slightly brighter). Every theme must set this:
                              # one that only sets `accent` inherits this sage and flashes green on hover.
                              # Themes without a hand-tuned value derive it — color-mix(accent 88%, fg-strong).
  # Status
  success:        "#5A7B4C"   # Same as accent — quiet and consistent
  warning:        "#B5832E"   # Warm amber, not red
  danger:         "#A8514A"   # Muted brick, not bright red
  # Inset shadow signature (for dark CTAs)
  inset-highlight: "rgba(255, 255, 255, 0.20)"   # Top-edge white line
  inset-ring:      "rgba(0, 0, 0, 0.20)"          # Dark ring around the button
  inset-drop:      "rgba(0, 0, 0, 0.05)"          # Soft 1px drop shadow

  # Keys that components import today (kept as aliases so the refactor
  # doesn't have to touch every component at once):
  #   --bg            → chrome
  #   --bg-elevated   → surface
  #   --bg-hover      → charcoal-4
  #   --bg-selected   → accent-soft
  #   --fg-strong     → charcoal
  #   --fg            → charcoal-82
  #   --fg-subtle     → muted
  #   --fg-dim        → decorative/disabled tint; meaningful secondary text uses --fg-subtle
  #   --border        → border
  #   --border-strong → charcoal-40
  #   --accent        → accent
  #   --accent-soft   → accent-soft

  # Readable secondary information: sidebar timestamps and enabled, unselected
  # Mission Control tabs use --fg-subtle (4.5:1 on page/elevated surfaces).

typography:
  font-ui:   '"Atkinson Hyperlegible", -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", Inter, system-ui, sans-serif'
  font-mono: '"Monaspace Neon", "Monaspace Argon", "Monaspace", "SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace'
  fs-xs:   12px   # Captions, tertiary labels
  fs-base: 13px   # Body, list items, default UI
  fs-md:   14px   # Secondary text, descriptions
  fs-lg:   16px   # Primary text, buttons
  fs-xl:   18px   # Section headers in panels
  fs-xxl:  24px   # Page-level headers, hero numbers
  # No display weight. Emphasis is carried by color (charcoal vs muted) and
  # size, not by weight variation. Atkinson Hyperlegible is single-weight.

rounded:
  micro:       4px   # Pills, toggles, status dots
  standard:    6px   # Buttons, inputs, navigation
  comfortable: 8px   # Compact cards, dividers
  card:        12px  # Standard cards, image containers
  container:   16px  # Footer sections, large panels (rare)
  settings-panel:   20px  # Rounded settings groups
  settings-control: 12px  # Settings buttons, inputs and selects
  full:        9999px  # Pill-shaped switches and icon toggles

spacing:
  xs:   8px
  sm:   10px
  md:   12px
  base: 16px
  lg:   24px
  xl:   32px
  xxl:  40px

# Layout sizes — these are app-level chrome dimensions, not generic spacing.
sizes:
  activity-bar: 44px
  sidebar:      240px
  ai-panel:     360px
  tab-strip:    34px
  status-bar:   22px
  terminal:     220px

motion:
  ease-out:    "cubic-bezier(0.22, 1, 0.36, 1)"   # Standard exit
  ease-soft:   "cubic-bezier(0.32, 0.72, 0, 1)"  # Softer, more dramatic
  fast:        120ms   # Color/border transitions
  medium:      180ms   # Sizing, opacity
  slow:        240ms   # Layout shifts
  slower:      360ms   # Text cross-fades — a word giving way to another

elevation:
  # Klide's depth system is intentionally shallow. Borders do the work.
  none:   "none"
  inset:  "rgba(255, 255, 255, 0.20) 0px 0.5px 0px 0px inset, rgba(0, 0, 0, 0.20) 0px 0px 0px 0.5px inset, rgba(0, 0, 0, 0.05) 0px 1px 2px 0px"
  focus:  "rgba(0, 0, 0, 0.10) 0px 0px 0px 3px"   # Soft diffused focus ring
  panel:  "0 1px 1px rgba(28, 28, 28, 0.025), 0 10px 34px rgba(28, 28, 28, 0.055), 0 32px 90px rgba(28, 28, 28, 0.040)"

components:
  button-primary:
    backgroundColor: "{colors.charcoal}"
    textColor: "{colors.surface}"
    typography: "{typography.fs-lg}"
    rounded: "{rounded.standard}"
    padding: 8px 16px
    shadow: "{elevation.inset}"   # The signature multi-layer inset
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.charcoal}"
    typography: "{typography.fs-lg}"
    rounded: "{rounded.standard}"
    padding: 8px 16px
    border: "1px solid {colors.charcoal-40}"
  button-secondary:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.charcoal}"
    typography: "{typography.fs-lg}"
    rounded: "{rounded.standard}"
    padding: 8px 16px
  button-pill-icon:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.charcoal}"
    rounded: "{rounded.full}"
    shadow: "{elevation.inset}"
    opacity: 0.85
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.charcoal}"
    typography: "{typography.fs-lg}"
    rounded: "{rounded.card}"
    border: "1px solid {colors.border}"
  card-featured:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.charcoal}"
    rounded: "{rounded.container}"
    border: "1px solid {colors.border}"
  card-compact:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.charcoal}"
    rounded: "{rounded.comfortable}"
    border: "1px solid {colors.border}"
  text-input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.charcoal}"
    typography: "{typography.fs-base}"
    rounded: "{rounded.standard}"
    border: "1px solid {colors.border}"
    placeholderColor: "{colors.muted}"
    focusRing: "0 0 0 3px {colors.accent-soft}"
  nav-link:
    backgroundColor: transparent
    textColor: "{colors.charcoal}"
    typography: "{typography.fs-md}"
  link:
    textColor: "{colors.accent}"
    typography: "{typography.fs-base}"
    textDecoration: underline
  ai-chat-input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.charcoal}"
    typography: "{typography.fs-base}"
    rounded: "{rounded.card}"
    border: "1px solid {colors.border}"
  tool-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.charcoal}"
    typography: "{typography.fs-base}"
    rounded: "{rounded.comfortable}"
    border: "1px solid {colors.border}"
  thinking-card:
    backgroundColor: "color-mix(in srgb, {colors.chrome} 70%, transparent)"
    textColor: "{colors.muted}"
    typography: "{typography.fs-xs}"
    rounded: "{rounded.comfortable}"
    border: "1px solid {colors.border}"

# ─────────────────────────────────────────────────────────────────────────────
# THEMES — Klide Light is the default; light variants share the grey/white
# foundation described above. Other themes layer on top of the same token names.
# To add a theme, add it here AND in src/theme.ts.
# ─────────────────────────────────────────────────────────────────────────────

themes:
  - id: klide-light
    name: "Klide Light"
    description: "Light-grey chrome, white content and a soft sage accent."
    isDark: false
    swatches: ["#F5F6F7", "#FFFFFF", "#5A7B4C", "#1c1c1c"]
  - id: sage-garden
    name: "Sage Garden"
    description: "Klide Light with cool ink and a greyer sage — one shade crisper."
    isDark: false
    swatches: ["#F5F6F7", "#FFFFFF", "#7C9082", "#1A1F2E"]
  - id: sage-garden-dark
    name: "Sage Garden Dark"
    description: "Warm near-black under cool light, with the accent back on sage."
    isDark: true
    swatches: ["#131512", "#191C18", "#8FAA97", "#C3C8C4"]
  - id: cursor-dark
    name: "Midnight"
    description: "Soft black surfaces with a blue-violet accent."
    isDark: true
    swatches: ["#11110F", "#1B1B18", "#8EA2FF", "#C8C6BE"]
  - id: vscode-dark
    name: "VS Code Dark"
    description: "Classic editor contrast with familiar blue selection."
    isDark: true
    swatches: ["#1E1E1E", "#252526", "#007ACC", "#CCCCCC"]
  - id: github-light
    name: "GitHub Light"
    description: "Clean white workspace with crisp blue UI states."
    isDark: false
    swatches: ["#F5F6F7", "#FFFFFF", "#0969DA", "#24292F"]
  - id: cerulean
    name: "Cerulean"
    description: "Light-grey chrome and white content, with blue reserved for highlighted states. Shared neutral surfaces across the app."
    isDark: false
    swatches: ["#F5F6F7", "#FFFFFF", "#2596BE", "#1C1B18"]
  - id: solarized-dark
    name: "Solarized Dark"
    description: "Muted blue-green terminal energy for long sessions."
    isDark: true
    swatches: ["#002B36", "#073642", "#B58900", "#93A1A1"]

# ─────────────────────────────────────────────────────────────────────────────
# PRINCIPLES
# ─────────────────────────────────────────────────────────────────────────────

principles:
  - "Light grey and white throughout. Chrome is #F5F6F7; content is #FFFFFF. No beige, cream, parchment or warm off-white UI backgrounds."
  - "Sage over blue. The accent is a soft sage green (#5A7B4C) — every AI tool defaults to blue; we don't."
  - "Charcoal over black. Text is #1c1c1c, not #000. The slight off-black reads as organic, not digital."
  - "Opacity grays over hex grays. Every gray is the same charcoal at a different transparency. Tonal coherence is automatic."
  - "Soft borders and subtle shadows contain rounded groups. Keep dividers fine and spacing generous."
  - "Selection is a grey lift, not a colour. Picked rows in lists and menus (Explorer, Git Review files, Where it runs) fill with the text colour at ~10% and hover at ~5%, on 8px corners — never the accent."
  - "Atkinson over Inter. Humanist, not geometric. Open apertures. Rounded terminals. Built for reading."
  - "Monaspace over JetBrains. Code gets a different typeface. Same warmth, but mechanical."
  - "No display weight. Atkinson Hyperlegible is single-weight. Emphasis is color and size, not weight."

# ─────────────────────────────────────────────────────────────────────────────
# KNOWN GAPS
# ─────────────────────────────────────────────────────────────────────────────

known_gaps:
  - "Form input error states — focus ring is documented, but validation error styles are not."
  - "Decorative gradients — any chrome gradients must stay neutral grey/white in light themes; artwork retains its own palette."
  - "Chart tokens — --chart-1..7 ship in tokens.css but are not documented here."
  - "Context-window tokens (--ctx-messages, --ctx-tools, --ctx-system, --ctx-skills, --ctx-rules, --ctx-lens, --ctx-draft, --ctx-reply) are a sanctioned hue exception, like the git lanes: one soft pastel per kind of token so the 7px breakdown bar's segments can be told apart. Hovering a segment or row lights that kind and drops the others to low opacity. The context popover only — never UI chrome."
  - "Diff tokens are the one deliberate exception to the brand palette: classic code-review green/red (GitHub's #1A7F37 / #CF222E light, #3FB950 / #F85149 dark) so a diff reads the same as in every editor. --diff-add / --diff-remove colour signs, counts and edge markers; --diff-*-bg tints a changed line and --diff-*-word its changed span, both translucent so they sit on any surface."
