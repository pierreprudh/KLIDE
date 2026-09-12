// The heavy surfaces, loaded when they first render rather than at first paint.
//
// Monaco is the largest chunk in the bundle (4.5 MB) and xterm the next (0.3 MB).
// Neither is needed to paint the Welcome screen or a Focus conversation, yet a
// static import anywhere in the entry graph — main.tsx used to import the
// Monaco setup directly; App imported EditorArea and TerminalPanel; AiPanel
// imported the delegate terminal — put both on the critical path of every
// launch. These wrappers are the same `lazy()` pattern App.tsx already uses for
// its overlays, with the Suspense boundary folded in so a call site stays a
// plain `<EditorArea />`. Each Monaco consumer imports `../monaco-setup` itself,
// so the loader is pointed at the bundled editor before the first `<Editor>`
// mounts, whichever surface asks first.
//
// `scripts/check-bundle-split.mjs` fails the build if either chunk creeps back
// onto the entry's modulepreload list.
import { lazy, Suspense, type ComponentProps } from "react";

const EditorAreaImpl = lazy(() => import("./EditorArea").then((m) => ({ default: m.EditorArea })));
const SpreadsheetViewerImpl = lazy(() => import("./SpreadsheetViewer").then((m) => ({ default: m.SpreadsheetViewer })));

export function SpreadsheetViewer(props: ComponentProps<typeof SpreadsheetViewerImpl>) {
  return <Suspense fallback={<div role="status" style={{ position: "fixed", right: 24, bottom: 24, zIndex: 9999 }}>Opening spreadsheet…</div>}><SpreadsheetViewerImpl {...props} /></Suspense>;
}
const TerminalPanelImpl = lazy(() => import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel })));
const DelegateTerminalSurfaceImpl = lazy(() =>
  import("./ai/DelegateTerminal").then((m) => ({ default: m.DelegateTerminalSurface })),
);
const DelegateConsoleImpl = lazy(() =>
  import("./ai/DelegateTerminal").then((m) => ({ default: m.DelegateConsole })),
);

// Type-only: erased at build time, so this does not pull EditorArea back in.
export type { EditorEmptyAction } from "./EditorArea";

/** The editor column keeps its box while the chunk loads — no layout jump. */
export function EditorArea(props: ComponentProps<typeof EditorAreaImpl>) {
  return (
    <Suspense fallback={<div style={{ flex: 1, minHeight: 0 }} />}>
      <EditorAreaImpl {...props} />
    </Suspense>
  );
}

export function TerminalPanel(props: ComponentProps<typeof TerminalPanelImpl>) {
  return (
    <Suspense fallback={null}>
      <TerminalPanelImpl {...props} />
    </Suspense>
  );
}

export function DelegateTerminalSurface(props: ComponentProps<typeof DelegateTerminalSurfaceImpl>) {
  return (
    <Suspense fallback={null}>
      <DelegateTerminalSurfaceImpl {...props} />
    </Suspense>
  );
}

export function DelegateConsole(props: ComponentProps<typeof DelegateConsoleImpl>) {
  return (
    <Suspense fallback={null}>
      <DelegateConsoleImpl {...props} />
    </Suspense>
  );
}
