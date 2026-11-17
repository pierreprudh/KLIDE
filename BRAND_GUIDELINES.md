# Klide — brand and interface guidelines

Reference draft · 17 November 2026

## Decisions

- Name: **Klide**.
- Interface: **San Francisco on macOS**, selected through the native system font stack.
- Wordmark: **Inter**, independent of the interface font. Keep the existing monospace code face.
- Preserve the app's existing light and dark themes, layouts, components, spacing and behavior.
- Deep Sea and the other palette explorations are rejected as replacements for the app themes.
- Logo placement is deferred. Pierre will add it later. Preserve the supplied symbol as the source; do not redraw it or introduce replacements.

These decisions supersede the previous palette recommendations and screenshots. The research previews were temporary. The applied production change is native system typography for the UI and Inter for the wordmark; the existing theme colors, layout geometry and logo placement are preserved.

## Product character

Klide brings the code editor, terminals, coding agents, compatible model choices and change review into one workspace. Its visual character is calm, clear and capable.

Use real product views to explain the product. Describe supported behavior precisely. Do not claim universal model compatibility, universal background execution or that every workflow remains on the Mac.

Suggested descriptor: **One workspace for your coding agents.** This remains proposed copy.

## Color — preserve current themes

Use semantic tokens from `src/styles/tokens.css`, rather than placing raw hex colors in components. Keep all existing theme variants; the following values document Klide Light and the existing Midnight dark foundation, rather than creating a new theme.

| Role | Klide Light | Existing Midnight dark foundation |
| --- | --- | --- |
| Chrome / background | `#F5F6F7` | `#11110F` |
| Elevated content / panels | `#FFFFFF` | `#171715` |
| Strong text | `#1C1C1C` | `#F0EFE9` |
| Secondary text | `#5F5F5D` | `#8D8B84` |
| Border | `#E4E7EB` | `#292824` |
| Accent | `#5A7B4C` | `#8EA2FF` |
| Accent field | `rgba(90,123,76,0.12)` | `#242B45` |
| Primary control | Charcoal with white text | Light foreground with dark text |

Exact tokens and theme-specific overrides in source remain authoritative. In particular, editor, terminal, theme thumbnails and content surfaces have their own intentional values. Preserve them rather than imposing one background on every surface. Theme metadata thumbnails can differ from the detailed CSS token values.

### Color rules

- Light chrome stays cool grey, with white content. Do not add cream, beige or parchment surfaces.
- Existing dark themes keep their established dark surfaces and accents. Do not replace them with navy or blue-tinted panels.
- Use accents sparingly for interactions and selected states.
- Preserve semantic success, warning, error and diff colors. Keep provider logos and user content in their own colors.
- Use readable text tokens on their actual surfaces. Do not reuse a decorative or disabled tint for necessary information.
- A selected-state fill is not a sufficient keyboard focus indicator; verify focus separately.

## Typography — San Francisco UI, Inter wordmark

The UI uses `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", system-ui, sans-serif`, which selects San Francisco on macOS. Other platforms use their native system fallback. Do not bundle or redistribute the Apple system font.

The wordmark has a separate `--font-brand` token: `"Inter", var(--font-ui)`. Inter remains locally bundled for branding and offline use. Changing the interface font must not change the wordmark.

Keep the existing product type scale as the starting point:

| Role | Size | Weight |
| --- | --- | --- |
| Compact supporting text | 12px | 400 |
| Standard interface text | 13px | 400 |
| Readable body / controls | 14px | 400 or 500 |
| Subheading | 16–18px | 500 |
| Page heading | 24px | 600 |

These role/weight assignments are interface specifications; existing component hierarchy and context take precedence over blindly applying a table. Welcome and marketing display headings can remain larger where the existing layout calls for it.

Use 400 for regular copy, 500 for labels and restrained emphasis, and 600 for headings. Keep sentence case, natural letter spacing for small text and comfortable line heights. Do not introduce multiple display families.

Retain Monaspace Neon or the user's selected monospace face for code and terminals. When changing typography, check text wrapping, button width, dropdowns, headings, accents and keyboard labels at actual app sizes.

## Layout and spacing

Preserve the real application's composition: Workspace rail, Welcome split layout and pixel nature scene, Focus transcript/composer/result panels, Workbench editor and terminal, and grouped Settings. Do not substitute generic dashboard layouts for these surfaces in brand previews.

Existing Settings specifications:

- Grouped panels: **20px corner radius**.
- Controls: **12px corner radius**.
- Rows: approximately **24px padding and gaps**.
- Toggles: pill shaped.
- Fine dividers and restrained shadows.
- Section headings outside their panel.
- Page titles stand alone; add a subtitle only when useful.

For new compositions, use the proposed spacing steps **4, 8, 12, 16, 24, 32, 48, 64, 96px**. Reuse shared component spacing before introducing new measurements. Related information stays together; unrelated sections get more space.

## Controls and states

- Reuse production controls and icons.
- Give the state-relevant primary action a clear hierarchy.
- Keep chevrons functional for menus/disclosure; use full arrows for directional navigation.
- Prefer clear action labels when an icon alone is ambiguous.
- Keep keyboard access, visible focus, accessible names and expanded states.
- Use words or icons alongside color for waiting, running, failed and review states.

## Logo — placement deferred

The app and logo do not need the same typeface. **The interface uses San Francisco on macOS; the wordmark stays in Inter.** The existing Welcome text wordmark uses the separate brand token. A different wordmark face would require a later design decision. Symbol integration remains deferred.

The supplied `Group 16.png` remains the logo reference. A byte-for-byte copy is kept at `docs/brand/assets/klide-symbol-original.png`.

Do not redraw, regularize, rotate, distort or replace the symbol. Do not add it to the app during this stage. Keep the existing text branding in Inter until Pierre supplies the ready symbol and placement.

Clear space, lockup proportions, minimum sizes and vector export specifications remain unfinalized. Earlier numeric logo rules were exploration proposals, not approved requirements. Establish them against the final artwork when logo integration begins.

## Imagery

The supplied cloud and moon banners remain marketing references. Atmospheric artwork may support editorial covers and launch communications. It does not dictate the product's light or dark palette.

Preserve the existing Welcome pixel-art nature scene. Use actual rendered application components for UI previews. Clearly identify sample data and preview-only styling.

## Voice

Direct, calm and specific. Lead with what happened or what the person can do next.

- “Review changes.”
- “Choose an agent and a compatible model.”
- “Needs your approval.”
- Describe a failure and offer a relevant next action.

Avoid invented performance claims, superlatives and vague AI promises.

## Current status and next work

The existing light and dark application themes are retained. The Deep Sea previews are discarded. San Francisco is selected through the native UI font stack, while Inter is locally bundled and applied to the wordmark. Logo integration remains deferred.

Future work should verify real layouts and preserve existing theme behavior. No production changes are authorized merely by a screenshot or a palette study.

## Source references

- `src/styles/tokens.css`: implemented colors, typography variables and surfaces.
- `src/theme.ts`: theme registry, swatches and editor/terminal theme definitions.
- `src/components/settings/settings.css`: panel/control shapes and row spacing.
- `src/main.tsx`: current font imports.
- `README.md` and `CONTEXT.md`: product purpose and supported behavior.
- User direction in this chat: San Francisco for the app, Inter for the wordmark, existing light/dark themes, original symbol integration later.

If older project prose conflicts with these latest brand decisions, preserve the user's latest direction and reconcile documentation during implementation.
