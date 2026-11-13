# Design mode

Design mode lets you review a local web app beside the conversation changing it.
It is implemented on `main`; the released app you download may predate it.

## Use it

1. Open a Workspace and a conversation. Press **⌘⇧D**, or choose **View: Design Mode** in the command palette. A completed UI change can also offer **Open in Design** on its result card.
2. Connect to the project's local HTTP dev server. The canvas offers detected local servers; you can enter the address yourself. If the project has a supported dev command, the empty canvas offers to run it and shows its startup output.
3. Use **Select** to inspect an element and preview text, spacing, radius, typography or colour changes. Available page tokens appear in the inspector. **Comment** pins feedback on an element; **Use** lets you interact with the page.
4. Try Fit, 1440, 900 or 390 viewport sizes. Review the collected changes and comments, undo unwanted previews, then send the review to the conversation that opened Design mode.
5. Kit receives one Work turn describing the review. Source changes go through the conversation's usual execution and review policy. Inspect the resulting diff and reload or use the dev server's hot reload to check it.

Preview changes affect the framed page only. They do not save source files;
reloading a page is not a way to persist them. Closing the dock keeps its
unsent review while its owning panel remains mounted; it is not durable storage.

## Scope

The canvas proxies a loopback HTTP dev server, injects an element picker, and
relays page facts through messages carrying a per-canvas token. The proxy binds
to 127.0.0.1 and forwards WebSocket upgrades for hot reload. It is not a general
internet browser or a Remote machine preview. The iframe displays a web page,
not the native Tauri window; a browser preview alone does not verify native
window behaviour, keychain access or operating-system integrations.

The developer screenshot/canary and writer/reviewer experiment is documented
separately in [Design agent plan](DESIGN_AGENT_PLAN.md) and
[experiment instructions](../scripts/design-feedback/EXPERIMENT.md). Its pending
quality and native verification gates are not automatically satisfied by Design
mode. Open proxy hardening work is tracked in the
[safety follow-ups](../TODO.md#safety-review-follow-ups--2026-11-10).

Implementation: `src/components/design/DesignMode.tsx`,
`src/components/design/designReview.ts`, `src/designNavigation.ts`,
`src-tauri/src/design_canvas.rs` and `src-tauri/src/design_agent.js`.
