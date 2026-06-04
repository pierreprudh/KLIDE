---
version: alpha
name: Klide
description: A warm, parchment-toned design system anchored on a bone cream canvas (#f7f4ed) and Atkinson Hyperlegible (UI) + Monaspace Neon (code). The neutral scale is derived from a single charcoal hex (#1c1c1c) modulated at opacity stops — every tonal shade is technically the same hue, just more or less transparent. Borders replace drop-shadows as the primary containment mechanism. The accent is a soft sage green (#5A7B4C) — not blue, on purpose.

seo:
  title: "Klide Design System — Bone (#f7f4ed) + Charcoal (#1c1c1c) + Sage (#5A7B4C)"
  metaDescription: "Klide's design system as a DESIGN.md file. Bone cream canvas, opacity-based charcoal grays, soft sage accent. For React, Tauri, and AI tools."
  highlights:
    - "Bone cream canvas (#f7f4ed) — a deliberate warm cream, not white, not beige; the foundation of every surface"
    - "Soft sage green accent (#5A7B4C) — quiet, organic, distinct from the AI-tool-default blue"
    - "Opacity-driven grays — every tonal shade derives from #1c1c1c at 4%, 40%, 82%, 83% transparency"
    - "Borders, not drop-shadows, for containment — 1px #1c1c1c@4% hairlines define cards; the system caps at one inset shadow on dark CTAs"
    - "Restrained 4-tier radius scale (4, 6, 8, 12) — no 9999px pills except for icon toggles"
  tags:
    - "AI & LLM Platforms"
    - "Developer Tools & IDEs"
  lastUpdated: "2026-06-04"
  author:
    name: "Pierre Prudhomme"
  opening: |
    Klide's design system is built on warmth through restraint. The page floor is a bone cream (#f7f4ed) — not white, not beige, a deliberate hand-selected tone that immediately separates the product from the cold-dark conventions of most editor-style apps. Text is near-black charcoal (#1c1c1c) rather than pure black. Atkinson Hyperlegible carries the UI warmth — a humanist typeface designed for readability, with open apertures and organic curves that contrast with the geometric sans-serifs most AI tools default to. Monaspace Neon carries the code surface.

    This page packages the full system into a single DESIGN.md file. Inside: a cream-and-charcoal palette where every gray is the same hex (#1c1c1c) at different opacity stops, a 6-step type scale running on Atkinson Hyperlegible (UI) and Monaspace Neon (code), a 4-tier radius scale from 4px micro to 12px card, and a component inventory covering buttons, cards, inputs, navigation, AI chat, and tool cards. The format follows the Google Labs DESIGN.md spec — machine-readable tokens alongside human prose.

    To change the system: edit this file, then mirror the changes in `src/styles/tokens.css`. Every CSS variable in `tokens.css` has a counterpart in this file, so changes propagate together.
  related:
    - href: "src/styles/tokens.css"
      title: "The implementation"
      description: "All tokens below are realised as CSS custom properties in tokens.css. Each variable name appears in the Keys column so you can grep the codebase for the exact token."
    - href: "src/theme.ts"
      title: "Theme registry"
      description: "Theme metadata (name, description, isDark, swatches) and the per-theme overrides. The bone light theme is the default; the other themes layer on top of the same token names."
  questions:
    - id: "primary-color"
      title: "What is Klide's primary brand color?"
      answer: "Klide's accent is a soft sage green (#5A7B4C) — quiet, organic, and distinct from the blue every AI tool defaults to. The brand's primary surface is a bone cream (#f7f4ed) that acts as both page background and card surface, paired with a near-black charcoal (#1c1c1c) for text and dark CTA fills. The only chromatic moment is the sage accent for interactive states."
    - id: "typography"
      title: "What typography does Klide use?"
      answer: "Klide runs Atkinson Hyperlegible for the UI surface and Monaspace Neon for code. Atkinson is a humanist sans-serif designed by the Braille Institute for low-vision readers — generous x-height, open apertures, slightly rounded terminals. The type scale runs 12px (xs) → 24px (xxl) in 5 steps. There is no display weight: emphasis is carried by color and size, not by weight variation."
    - id: "opacity-grays"
      title: "Why does Klide derive grays from opacity instead of hex values?"
      answer: "Every gray in the system is the same charcoal (#1c1c1c) rendered at varying transparency levels — 0.04, 0.4, 0.82, 0.83. This creates a tonal coherence that's nearly impossible to achieve with arbitrary hex values, because every shade shares the exact same hue. Subtle hover backgrounds, body copy, and interactive borders all sit on the same warm tonal axis."
    - id: "shape-language"
      title: "What is Klide's shape language?"
      answer: "Four radius tiers: 4px micro for tiny interactive elements (pills, toggles), 6px standard for buttons and inputs, 8px comfortable for compact cards, and 12px for standard cards. No 16px containers and no 9999px pills in the core system — those are reserved for specific contexts (footer surfaces and icon toggles). Cards rely on 1px borders instead of drop-shadows for containment."
    - id: "use-in-project"
      title: "Can I use this DESIGN.md to drive changes in the app?"
      answer: "Yes — this file is the source of truth. To change a color, spacing value, or radius, edit the value here AND in `src/styles/tokens.css`. The tokens.css file is the actual implementation; this file is the human-readable spec. Every variable has a Key in the tokens table below so you can grep for it."

# ─────────────────────────────────────────────────────────────────────────────
# TOKENS — edit these, then mirror the change in src/styles/tokens.css.
# ─────────────────────────────────────────────────────────────────────────────

colors:
  # Foundation
  bone:        "#f7f4ed"   # Page surface, card surface — the warm cream
  bone-light:  "#fcfbf8"   # Off-white, dark CTA text, subtle highlights
  bone-border: "#eceae4"   # Card borders, dividers, image outlines
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
  accent-hover:   "#6B8E5A"   # Accent on hover (slightly brighter)
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
  #   --bg            → bone
  #   --bg-elevated   → bone-border
  #   --bg-hover      → charcoal-4
  #   --bg-selected   → accent-soft
  #   --fg-strong     → charcoal
  #   --fg            → charcoal-82
  #   --fg-subtle     → muted
  #   --fg-dim        → muted (slightly faded)
  #   --border        → bone-border
  #   --border-strong → charcoal-40
  #   --accent        → accent
  #   --accent-soft   → accent-soft

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
  full:        9999px  # Reserved for icon toggles only

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

elevation:
  # Klide's depth system is intentionally shallow. Borders do the work.
  none:   "none"
  inset:  "rgba(255, 255, 255, 0.20) 0px 0.5px 0px 0px inset, rgba(0, 0, 0, 0.20) 0px 0px 0px 0.5px inset, rgba(0, 0, 0, 0.05) 0px 1px 2px 0px"
  focus:  "rgba(0, 0, 0, 0.10) 0px 0px 0px 3px"   # Soft diffused focus ring
  panel:  "0 1px 1px rgba(28, 28, 28, 0.025), 0 10px 34px rgba(28, 28, 28, 0.055), 0 32px 90px rgba(28, 28, 28, 0.040)"

components:
  button-primary:
    backgroundColor: "{colors.charcoal}"
    textColor: "{colors.bone-light}"
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
  button-cream:
    backgroundColor: "{colors.bone}"
    textColor: "{colors.charcoal}"
    typography: "{typography.fs-lg}"
    rounded: "{rounded.standard}"
    padding: 8px 16px
  button-pill-icon:
    backgroundColor: "{colors.bone}"
    textColor: "{colors.charcoal}"
    rounded: "{rounded.full}"
    shadow: "{elevation.inset}"
    opacity: 0.85
  card:
    backgroundColor: "{colors.bone}"
    textColor: "{colors.charcoal}"
    typography: "{typography.fs-lg}"
    rounded: "{rounded.card}"
    border: "1px solid {colors.bone-border}"
  card-featured:
    backgroundColor: "{colors.bone}"
    textColor: "{colors.charcoal}"
    rounded: "{rounded.container}"
    border: "1px solid {colors.bone-border}"
  card-compact:
    backgroundColor: "{colors.bone}"
    textColor: "{colors.charcoal}"
    rounded: "{rounded.comfortable}"
    border: "1px solid {colors.bone-border}"
  text-input:
    backgroundColor: "{colors.bone-light}"
    textColor: "{colors.charcoal}"
    typography: "{typography.fs-base}"
    rounded: "{rounded.standard}"
    border: "1px solid {colors.bone-border}"
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
    backgroundColor: "{colors.bone-light}"
    textColor: "{colors.charcoal}"
    typography: "{typography.fs-base}"
    rounded: "{rounded.card}"
    border: "1px solid {colors.bone-border}"
  tool-card:
    backgroundColor: "{colors.bone}"
    textColor: "{colors.charcoal}"
    typography: "{typography.fs-base}"
    rounded: "{rounded.comfortable}"
    border: "1px solid {colors.bone-border}"
  thinking-card:
    backgroundColor: "color-mix(in srgb, {colors.bone} 70%, transparent)"
    textColor: "{colors.muted}"
    typography: "{typography.fs-xs}"
    rounded: "{rounded.comfortable}"
    border: "1px solid {colors.bone-border}"

# ─────────────────────────────────────────────────────────────────────────────
# THEMES — the light "Bone" theme is the default. Other themes layer on top
# of the same token names. To add a theme, add it here AND in src/theme.ts.
# ─────────────────────────────────────────────────────────────────────────────

themes:
  - id: bone
    name: "Bone"
    description: "Warm parchment cream with a soft sage accent. The default Klide identity — quiet, organic, distinct from AI-blue."
    isDark: false
    swatches: ["#f7f4ed", "#eceae4", "#5A7B4C", "#1c1c1c"]
  - id: klide-light
    name: "Klide Light"
    description: "Earlier warm-quiet theme. Kept for users who prefer the original look."
    isDark: false
    swatches: ["#FBFBFA", "#F4F4F2", "#4263EB", "#555552"]
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
    swatches: ["#FFFFFF", "#F6F8FA", "#0969DA", "#24292F"]
  - id: solarized-dark
    name: "Solarized Dark"
    description: "Muted blue-green terminal energy for long sessions."
    isDark: true
    swatches: ["#002B36", "#073642", "#B58900", "#93A1A1"]

# ─────────────────────────────────────────────────────────────────────────────
# PRINCIPLES
# ─────────────────────────────────────────────────────────────────────────────

principles:
  - "Bone over white. Cream is the foundation — #f7f4ed, not #FFFFFF. The warmth is the point."
  - "Sage over blue. The accent is a soft sage green (#5A7B4C) — every AI tool defaults to blue; we don't."
  - "Charcoal over black. Text is #1c1c1c, not #000. The slight off-black reads as organic, not digital."
  - "Opacity grays over hex grays. Every gray is the same charcoal at a different transparency. Tonal coherence is automatic."
  - "Borders over shadows. 1px #1c1c1c@4% hairlines define cards. The system caps at one inset shadow on dark CTAs."
  - "Atkinson over Inter. Humanist, not geometric. Open apertures. Rounded terminals. Built for reading."
  - "Monaspace over JetBrains. Code gets a different typeface. Same warmth, but mechanical."
  - "No display weight. Atkinson Hyperlegible is single-weight. Emphasis is color and size, not weight."

# ─────────────────────────────────────────────────────────────────────────────
# KNOWN GAPS
# ─────────────────────────────────────────────────────────────────────────────

known_gaps:
  - "Dark bone variant — the default system is light. A dark bone variant (charcoal canvas, bone-light text, sage accent) is planned but not implemented."
  - "Loading / skeleton states — not yet tokenized."
  - "Form input error states — focus ring is documented, but validation error styles are not."
  - "Decorative gradients — hero, footer, and onboarding use subtle warm gradients; stops are described qualitatively, not numerically."
